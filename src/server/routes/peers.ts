import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { canMutate } from '../users.js';
import { askPeer, getPeerQuestion, listPeerQuestions, listPeers } from '../peers.js';

/** Questions to agents on other WaveCode instances (docs/peers.md). */
export function registerPeerRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/peers', (c) => c.json(listPeers()));

  app.get('/api/peers/questions', (c) => {
    const status = c.req.query('status') ?? undefined;
    return c.json(listPeerQuestions({ status }));
  });

  app.get('/api/peers/questions/:id', (c) => {
    const q = getPeerQuestion(c.req.param('id'));
    return q ? c.json(q) : c.json({ error: 'Question not found' }, 404);
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
    // A seat asking on its own behalf gets the answer typed back into its pane
    const fromAgentId = typeof body.from_agent_id === 'string' ? body.from_agent_id : user.via_seat ? user.seat_agent_id ?? null : null;
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
