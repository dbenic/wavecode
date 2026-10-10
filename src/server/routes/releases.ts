import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { canMutate, isAdmin, isRestrictedUser } from '../users.js';
import * as releases from '../releases.js';
import * as reviewQueue from '../review-queue.js';

/** Releases as records (src/server/releases.ts, docs/peers.md "Releases"). */
export function registerReleaseRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/releases', (c) => {
    const target = c.req.query('target');
    const status = c.req.query('status');
    return c.json(releases.listReleases({
      project: c.req.query('project') || undefined,
      sha: c.req.query('sha') || undefined,
      target: target === 'staging' || target === 'production' ? target : undefined,
      status: status as releases.ReleaseStatus | undefined,
      limit: Math.min(500, Number(c.req.query('limit') ?? 200) || 200),
    }));
  });

  app.get('/api/releases/:id', (c) => {
    const r = releases.getRelease(c.req.param('id'));
    if (!r) return c.json({ error: 'Release not found' }, 404);
    return c.json(r);
  });

  // Deploy side: a peer box (restricted token) or a person here asks for a deploy
  app.post('/api/releases', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json<releases.IncomingRelease>().catch(() => ({} as releases.IncomingRelease));
    const fromPeer = isRestrictedUser(user);
    if (!fromPeer && body.target === 'production' && !isAdmin(user)) {
      return c.json({ error: 'Forbidden: a production release on this box is admin only' }, 403);
    }
    const r = releases.acceptRelease({ ...body, requested_by: fromPeer ? body.requested_by : user.name }, { userName: user.name, fromPeer });
    if (!r.ok) return c.json({ error: r.error }, 400);
    return c.json(r.data, 201);
  });

  // The deploy agent's outcome (report_release MCP tool, or any mutating token)
  app.post('/api/releases/:id/report', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json<{ status?: unknown; version?: unknown; sha?: unknown; note?: unknown }>().catch(() => ({} as Record<string, unknown>));
    const status = body.status;
    if (status !== 'deployed' && status !== 'failed' && status !== 'rejected') return c.json({ error: "status must be 'deployed', 'failed' or 'rejected'" }, 400);
    const r = releases.reportRelease(c.req.param('id'), {
      status,
      version: typeof body.version === 'string' ? body.version : null,
      sha: typeof body.sha === 'string' ? body.sha : null,
      note: typeof body.note === 'string' ? body.note : null,
    });
    if (!r.ok) return c.json({ error: r.error }, r.error.includes('not found') ? 404 : 400);
    return c.json(r.data);
  });

  // Requester side: stage a reviewed freeze (automated, no GO) — Promote stays the production GO
  app.post('/api/reviews/:runId/stage', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const r = await reviewQueue.stage(c.req.param('runId'));
    if (!r.ok) return c.json({ error: r.error }, 400);
    return c.json(r.data, 202);
  });
}
