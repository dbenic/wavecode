import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { assignFixTask, pageAttention, readOverviewSnapshot, reconcileOverview } from '../overview.js';
import * as overlord from '../overlord.js';
import { canMutate, isAdmin } from '../users.js';
import { purgeStalePendingReviews } from '../review-purge.js';

/** The board (overview.ts) and the overlord's reports (overlord.ts). */
export function registerOverviewRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/overview', (c) => {
    const cfg = overlord.overlordConfig();
    const page = Number(c.req.query('attention_page') ?? 1) || 1;
    return c.json({
      board: pageAttention(readOverviewSnapshot(), page),
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
    const made = assignFixTask({
      runId: body.run_id,
      agentId: body.agent_id,
      note: typeof body.note === 'string' ? body.note : null,
      user,
      via: 'overview_fix',
      enforceLease: true,
    });
    if (!made.ok) {
      const status = made.status === 403 || made.status === 404 || made.status === 409 ? made.status : 400;
      return c.json({ error: made.error }, status);
    }
    void reconcileOverview().catch(() => { /* the assignment is stored; the next reconcile fills the snapshot */ });
    return c.json({ task: made.task, sha: made.sha, agent: made.agent }, 201);
  });

  // Abandon pending review runs older than 7 days that nobody reviewed. Rows stay.
  app.post('/api/overview/reviews/purge', async (c) => {
    const user = getActingUser(c);
    if (!isAdmin(user)) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json<{ days?: unknown; dry_run?: unknown }>().catch(() => ({} as { days?: unknown; dry_run?: unknown }));
    const days = body.days === undefined ? 7 : Number(body.days);
    if (!Number.isFinite(days) || days < 1) return c.json({ error: 'days must be a positive number' }, 400);
    const result = purgeStalePendingReviews({ days, dryRun: body.dry_run === true });
    return c.json({ abandoned: result.abandoned.length, ids: result.abandoned, dry_run: result.dry_run, days: result.days });
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
