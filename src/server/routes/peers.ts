import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { canMutate, isAdmin } from '../users.js';
import { getAgent } from '../db.js';
import * as leases from '../leases.js';
import { askPeer, getPeerQuestion, listPeerQuestions, listPeers } from '../peers.js';
import * as fixtures from '../fixtures.js';

/** Questions to agents on other WaveCode instances (docs/peers.md). */
export function registerPeerRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/peers', (c) => c.json(listPeers()));

  // Questions are bound to the caller who asked: others see nothing (admins see all)
  app.get('/api/peers/questions', (c) => {
    const user = getActingUser(c);
    const status = c.req.query('status') ?? undefined;
    const all = listPeerQuestions({ status, limit: 200 });
    return c.json(isAdmin(user) ? all : all.filter((q) => q.actor_id === user.id));
  });

  app.get('/api/peers/questions/:id', (c) => {
    const user = getActingUser(c);
    const q = getPeerQuestion(c.req.param('id'));
    if (!q || (!isAdmin(user) && q.actor_id !== user.id)) return c.json({ error: 'Question not found' }, 404);
    return c.json(q);
  });

  // The peer's fixture library (sanitized files it offers for development) and the import of one file
  app.get('/api/peers/:peer/artifacts', async (c) => {
    const r = await fixtures.listPeerFixtures(c.req.param('peer'));
    if (!r.ok) return c.json({ error: r.error }, 502);
    return c.json(r.data);
  });

  app.post('/api/peers/:peer/artifacts/:id/import', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden: observers cannot import fixtures' }, 403);
    const body = await c.req.json<{ room?: unknown; desk?: unknown }>().catch(() => ({} as Record<string, unknown>));
    const r = await fixtures.importPeerFixture(c.req.param('peer'), c.req.param('id'), {
      room: typeof body.room === 'string' ? body.room : undefined,
      desk: typeof body.desk === 'string' ? body.desk : undefined,
      actorName: user.name,
    });
    if (!r.ok) return c.json({ error: r.error }, 502);
    return c.json(r.data, 201);
  });

  app.post('/api/peers/:peer/ask', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden: observers cannot ask peers' }, 403);
    const body = await c.req.json<{ agent?: unknown; question?: unknown; from_agent_id?: unknown }>().catch(() => ({} as Record<string, unknown>));
    if (typeof body.agent !== 'string' || !body.agent.trim()) return c.json({ error: 'agent is required (remote alias or name)' }, 400);
    if (typeof body.question !== 'string' || !body.question.trim()) return c.json({ error: 'question is required' }, 400);
    if (body.from_agent_id !== undefined && body.from_agent_id !== null && typeof body.from_agent_id !== 'string') {
      return c.json({ error: 'from_agent_id must be an agent id' }, 400);
    }
    // The answer is typed into from_agent_id: only an agent the caller may act on (never someone else's pane)
    let fromAgentId: string | null = user.via_seat ? user.seat_agent_id ?? null : null;
    if (typeof body.from_agent_id === 'string') {
      const target = getAgent(body.from_agent_id);
      if (!target.ok) return c.json({ error: 'from_agent_id: no such agent' }, 404);
      const access = leases.checkAgentAccess(target.data, user);
      if (!access.ok) return c.json({ error: `from_agent_id: ${access.error}` }, 403);
      fromAgentId = target.data.id;
    }
    const result = await askPeer({
      peer: c.req.param('peer'),
      agent: body.agent.trim(),
      question: body.question,
      fromAgentId,
      actorId: user.id,
      fromLabel: fromAgentId ? null : user.name,
    });
    if (!result.ok) return c.json({ error: result.error }, /Unknown peer|allows questions|No agent/.test(result.error) ? 404 : 502);
    return c.json(result.data, 202);
  });
}
