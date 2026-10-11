import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { canMutate, isRestrictedUser } from '../users.js';
import * as desk from '../product-desk.js';
import { getDb, insertTask, resolveAgent } from '../db.js';
import { emit } from '../event-bus.js';
import * as taskDispatcher from '../task-dispatcher.js';
import * as leases from '../leases.js';

/** Product Desk read into WaveCode (src/server/product-desk.ts). */
export function registerDeskRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/desk', async (c) => {
    if (isRestrictedUser(getActingUser(c))) return c.json({ error: 'Forbidden' }, 403);
    const cfg = desk.deskConfig();
    if (!cfg.enabled) return c.json({ enabled: false, items: [], state: desk.deskState() });
    const r = await desk.listDesk({ all: c.req.query('all') === '1', force: c.req.query('refresh') === '1' });
    if (!r.ok) return c.json({ enabled: true, items: [], state: desk.deskState(), error: r.error }, 502);
    return c.json({ enabled: true, items: r.data, state: desk.deskState() });
  });

  app.get('/api/desk/:id', async (c) => {
    if (isRestrictedUser(getActingUser(c))) return c.json({ error: 'Forbidden' }, 403);
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
    const r = await desk.getDeskDetail(id);
    if (!r.ok) return c.json({ error: r.error }, 502);
    return c.json(r.data);
  });

  // A person views one retained original: streamed through, stored nowhere, recorded with the viewer's name
  app.get('/api/desk/files/:fileId', async (c) => {
    const user = getActingUser(c);
    if (isRestrictedUser(user)) return c.json({ error: 'Forbidden' }, 403);
    const r = await desk.openDeskFile(c.req.param('fileId'));
    if (!r.ok) return c.json({ error: r.error }, r.error.includes('invalid') ? 400 : 502);
    emit('desk.file_viewed', 'desk', c.req.param('fileId'), { by: user.name }, user.id ?? null);
    return new Response(r.data.body, {
      headers: {
        'Content-Type': r.data.contentType,
        ...(r.data.disposition ? { 'Content-Disposition': r.data.disposition } : {}),
        'Cache-Control': 'no-store',
      },
    });
  });

  // Hand a desk request to an agent as a WaveCode task (carries [desk <id>]; the agent fetches the card and files itself)
  app.post('/api/desk/:id/task', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'invalid id' }, 400);
    const body = await c.req.json<{ agent_id?: unknown; note?: unknown; reviewer?: unknown }>().catch(() => ({} as Record<string, unknown>));
    if (typeof body.agent_id !== 'string' || !body.agent_id.trim()) return c.json({ error: 'agent_id is required' }, 400);
    const agent = resolveAgent(body.agent_id.trim());
    if (!agent.ok) return c.json({ error: agent.error }, 404);
    const access = leases.checkAgentAccess(agent.data, user);
    if (!access.ok) return c.json({ error: access.error }, 403);
    const open = getDb().prepare("SELECT id, num FROM tasks WHERE prompt LIKE ? AND status IN ('pending','running','blocked') ORDER BY created_at DESC LIMIT 1")
      .get(`%${desk.deskTaskMarker(id)}%`) as { id: string; num: number | null } | undefined;
    if (open) return c.json({ error: `A task for desk #${id} is already open (#${open.num ?? open.id})` }, 409);
    const detail = await desk.getDeskDetail(id);
    if (!detail.ok) return c.json({ error: detail.error }, 502);
    let reviewerId: string | null = null;
    if (typeof body.reviewer === 'string' && body.reviewer.trim()) {
      const rv = resolveAgent(body.reviewer.trim());
      if (!rv.ok) return c.json({ error: `Reviewer not found: ${body.reviewer}` }, 400);
      if (rv.data.id === agent.data.id) return c.json({ error: 'The reviewer cannot be the agent doing the task' }, 400);
      reviewerId = rv.data.id;
    }
    const prompt = desk.taskPromptFor(detail.data, typeof body.note === 'string' ? body.note.trim() || null : null);
    const project = desk.deskConfig().project;
    const task = insertTask({ prompt, agent_id: agent.data.id, priority: 1, ...(project ? { room: project } : {}), ...(reviewerId ? { reviewer: reviewerId } : {}) });
    if (!task.ok) return c.json({ error: task.error }, 400);
    emit('task.created', 'task', task.data.id, { agent_id: agent.data.id, prompt: prompt.slice(0, 300), desk_id: id, via: 'product_desk' });
    setTimeout(() => { void taskDispatcher.dispatchNext().catch(() => { /* dispatcher logs */ }); }, 500);
    return c.json({ task: task.data, desk_id: id, agent: { id: agent.data.id, name: agent.data.name } }, 201);
  });
}
