import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { canMutate, isAdmin, isRestrictedUser } from '../users.js';
import * as releases from '../releases.js';
import * as reviewQueue from '../review-queue.js';
import { listCandidates } from '../release-freezes.js';
import { buildBoard } from '../overview.js';

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

  // Who did what: requests, verifications, rejects, deployer outcomes
  app.get('/api/releases/audit', (c) => c.json(releases.auditTrail(Math.min(500, Number(c.req.query('limit') ?? 200) || 200))));

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

  // A person confirms a SHA (a lane or a whole candidate) works on staging
  app.post('/api/releases/verify', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json<{ sha?: unknown; project?: unknown; note?: unknown }>().catch(() => ({} as Record<string, unknown>));
    if (typeof body.sha !== 'string') return c.json({ error: 'sha is required' }, 400);
    const r = releases.verifySha(body.sha, typeof body.project === 'string' ? body.project : null, { name: user.name }, typeof body.note === 'string' ? body.note : null);
    if (!r.ok) return c.json({ error: r.error }, 400);
    return c.json(r.data);
  });

  // A composed candidate (projects.<p>.candidate_refs) is the unit of production: stage its tip, or send the GO for it
  app.post('/api/releases/candidates/:name/:action', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const action = c.req.param('action');
    if (action !== 'stage' && action !== 'promote') return c.json({ error: "action must be 'stage' or 'promote'" }, 400);
    const body = await c.req.json<{ project?: unknown }>().catch(() => ({} as { project?: unknown }));
    const project = typeof body.project === 'string' ? body.project : '';
    const name = decodeURIComponent(c.req.param('name'));
    const cand = listCandidates(project).find((x) => x.name === name);
    if (!cand) return c.json({ error: `No unreleased candidate '${name}' in project '${project}'` }, 404);
    const lanes = buildBoard().lanes.filter((l) => l.candidate === name);
    const r = await releases.requestRelease({
      project, sha: cand.tip, lane: cand.name, target: action === 'promote' ? 'production' : 'staging',
      desk: null, reviewer: null, actorName: user.name, runId: null,
      note: lanes.length ? `contains: ${lanes.map((l) => `${l.desk ? `Desk #${l.desk} ` : ''}${l.sha.slice(0, 8)}`).join(', ')}` : null,
    });
    if (!r.ok) return c.json({ error: r.error }, 400);
    return c.json(r.data, 202);
  });

  // A person confirms the feature works on staging (recorded with their name)
  app.post('/api/releases/:id/verify', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json<{ note?: unknown }>().catch(() => ({} as { note?: unknown }));
    const r = releases.verifyStaging(c.req.param('id'), { name: user.name }, typeof body.note === 'string' ? body.note : null);
    if (!r.ok) return c.json({ error: r.error }, r.error.includes('not found') ? 404 : 400);
    return c.json(r.data);
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
