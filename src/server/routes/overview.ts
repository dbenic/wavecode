import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { isAdmin } from '../users.js';
import { buildBoard, fixMarker } from '../overview.js';
import * as overlord from '../overlord.js';
import { canMutate } from '../users.js';
import { getDb, getRun, insertTask, resolveAgent } from '../db.js';
import { emit } from '../event-bus.js';
import * as taskDispatcher from '../task-dispatcher.js';
import * as leases from '../leases.js';
import { getFreezeByRun } from '../release-freezes.js';

/** The board (overview.ts) and the overlord's reports (overlord.ts). */
export function registerOverviewRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/overview', (c) => {
    const cfg = overlord.overlordConfig();
    return c.json({
      board: buildBoard(),
      report: overlord.getLatestReport(),
      overlord: { enabled: cfg.enabled, model: cfg.model, heartbeat_min: cfg.heartbeatMin, max_wakes_per_hour: cfg.maxWakesPerHour },
    });
  });

  app.get('/api/overview/reports', (c) => {
    const limit = Math.min(100, Number(c.req.query('limit') ?? 20) || 20);
    return c.json(overlord.listReports(limit));
  });

  // Chat with the overlord (any user who may mutate): answers from the board, history kept
  app.get('/api/overview/chat', (c) => c.json(overlord.listChat(Math.min(200, Number(c.req.query('limit') ?? 40) || 40))));

  app.post('/api/overview/chat', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json<{ message?: unknown }>().catch(() => ({} as { message?: unknown }));
    if (typeof body.message !== 'string') return c.json({ error: 'message is required' }, 400);
    const r = await overlord.chat(body.message, { id: user.id ?? null, name: user.name });
    if (!r.ok) return c.json({ error: r.error }, 503);
    return c.json(r.data, 201);
  });

  // Assign a fix: queue a task for an agent that carries the lane's SHA, so the board shows who is on it
  app.post('/api/overview/fixes/assign', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json<{ run_id?: unknown; agent_id?: unknown; note?: unknown }>().catch(() => ({} as Record<string, unknown>));
    if (typeof body.run_id !== 'string' || typeof body.agent_id !== 'string') return c.json({ error: 'run_id and agent_id are required' }, 400);
    const run = getRun(body.run_id);
    if (!run.ok) return c.json({ error: run.error }, 404);
    const freeze = getFreezeByRun(body.run_id);
    if (!freeze) return c.json({ error: 'Only a release freeze (a lane with an exact SHA) can be assigned as a fix' }, 400);
    const agent = resolveAgent(body.agent_id);
    if (!agent.ok) return c.json({ error: agent.error }, 404);
    const access = leases.checkAgentAccess(agent.data, user);
    if (!access.ok) return c.json({ error: access.error }, 403);
    const open = getDb().prepare("SELECT id, num FROM tasks WHERE prompt LIKE ? AND status IN ('pending','running','blocked') ORDER BY created_at DESC LIMIT 1")
      .get(`%${fixMarker(freeze.sha)}%`) as { id: string; num: number | null } | undefined;
    if (open) return c.json({ error: `A fix task is already open for ${freeze.sha.slice(0, 8)} (#${open.num ?? open.id})` }, 409);
    const what = freeze.verdict === 'needs-fixes' || freeze.verdict === 'reject' ? 'the review findings' : 'the failed release';
    const prompt = [
      `${fixMarker(freeze.sha)} Fix ${what} on lane ${freeze.lane ?? '?'}${freeze.desk ? ` (Desk #${freeze.desk})` : ''}, frozen at exact SHA ${freeze.sha}.`,
      freeze.verdict_path ? `Verdict: ${freeze.verdict_path}` : null,
      freeze.freeze_path ? `Freeze note: ${freeze.freeze_path}` : null,
      typeof body.note === 'string' && body.note.trim() ? `From ${user.name}: ${body.note.trim().slice(0, 1000)}` : null,
      'Address every finding, run the touched tests, then refreeze with a new freeze note and ask the same reviewer for a verdict on the new exact SHA (agent-operating-rules §3a).',
    ].filter(Boolean).join('\n');
    const task = insertTask({ prompt, agent_id: agent.data.id, priority: 1, ...(freeze.project ? { room: freeze.project } : {}), ...(freeze.reviewer_agent_id && freeze.reviewer_agent_id !== agent.data.id ? { reviewer: freeze.reviewer_agent_id } : {}) });
    if (!task.ok) return c.json({ error: task.error }, 400);
    emit('task.created', 'task', task.data.id, { agent_id: agent.data.id, prompt: prompt.slice(0, 300), fix_sha: freeze.sha, run_id: body.run_id, via: 'overview_fix' });
    setTimeout(() => taskDispatcher.dispatchNext(), 500);
    return c.json({ task: task.data, sha: freeze.sha, agent: { id: agent.data.id, name: agent.data.name } }, 201);
  });

  // Ask the overlord now (admin): bypasses the debounce, not the hourly cap unless force=true
  app.post('/api/overview/wake', async (c) => {
    const user = getActingUser(c);
    if (!isAdmin(user)) return c.json({ error: 'Forbidden: only an admin can wake the overlord' }, 403);
    const body = await c.req.json<{ force?: boolean }>().catch(() => ({} as { force?: boolean }));
    if (!overlord.overlordConfig().enabled) return c.json({ error: 'overlord.enabled is false' }, 400);
    const report = await overlord.wake(`manual:${user.name}`, { force: body.force === true });
    if (!report) return c.json({ error: 'No report: hourly cap reached, no LLM key, or the model answer could not be parsed (see the daemon log)' }, 503);
    return c.json(report, 201);
  });
}
