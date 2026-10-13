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

  // Read-only. A box that forwards this project's releases proxies the deploy peer.
  // The local deployed row is not authoritative there. `source` is peer, health, or local.
  // `local=1` or `X-WaveCode-Proxied: 1` answers from this box only (one hop).
  app.get('/api/releases/staging-tip', async (c) => {
    const project = c.req.query('project')?.trim();
    if (!project) return c.json({ error: 'project is required' }, 400);
    const localOnly = c.req.query('local') === '1' || c.req.header('x-wavecode-proxied') === '1';
    return c.json(await releases.stagingTipPayload(project, { localOnly }));
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
    if (body.target === 'production') {
      if (fromPeer) {
        const allowed = releases.peerProductionAllowed(body);
        if (!allowed.ok) return c.json({ error: allowed.error }, 403);
      } else if (!isAdmin(user)) {
        return c.json({ error: `${releases.PRODUCTION_RELEASE_ADMIN_ONLY} (you are ${user.name}, ${user.role})` }, 403);
      }
    }
    const r = await releases.acceptRelease(
      { ...body, requested_by: fromPeer ? body.requested_by : user.name },
      { userName: user.name, fromPeer, actorIsAdmin: fromPeer ? body.requester_is_admin === true : isAdmin(user) },
    );
    if (!r.ok) return c.json({ error: r.error }, 400);
    return c.json(r.data, 201);
  });

  // A developer or admin marks a SHA Ready for prod (checked on staging)
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
    // Promote sends the production GO and is admin only. Stage needs each contained
    // lane's reviewer PASS, unless this composed candidate is already on staging
    // (the deploy agent deployed it) or the caller is an admin.
    if (action === 'promote' && !isAdmin(user)) {
      return c.json({ error: `${releases.PRODUCTION_RELEASE_ADMIN_ONLY} (you are ${user.name}, ${user.role})` }, 403);
    }
    const body = await c.req.json<{ project?: unknown }>().catch(() => ({} as { project?: unknown }));
    const project = typeof body.project === 'string' ? body.project : '';
    const name = decodeURIComponent(c.req.param('name'));
    const cand = listCandidates(project).find((x) => x.name === name);
    if (!cand) return c.json({ error: `No unreleased candidate '${name}' in project '${project}'` }, 404);
    const lanes = buildBoard().lanes.filter((l) => l.candidate === name);
    if (action === 'stage' && !isAdmin(user)) {
      const deployed = releases.listReleases({ sha: cand.tip, target: 'staging', limit: 10 }).some((r) => r.status === 'deployed');
      if (!deployed && lanes.some((l) => l.verdict !== 'pass')) {
        return c.json({ error: releases.STAGE_NEEDS_PASS }, 403);
      }
    }
    if (action === 'stage') {
      const { stageEligibility } = await import('../sha-stage-block.js');
      const eligible = await stageEligibility(cand.tip, project, { markStale: true });
      if (eligible.error) return c.json({ error: eligible.error }, 400);
    }
    const r = await releases.requestRelease({
      project, sha: cand.tip, lane: cand.name, target: action === 'promote' ? 'production' : 'staging',
      desk: null, reviewer: null, actorName: user.name, actorRole: user.role, actorIsAdmin: isAdmin(user), runId: null,
      note: lanes.length ? `contains: ${lanes.map((l) => `${l.desk ? `Desk #${l.desk} ` : ''}${l.sha.slice(0, 8)}`).join(', ')}` : null,
    });
    if (!r.ok) return c.json({ error: r.error }, 400);
    return c.json(r.data, 202);
  });

  // Ready for prod: a developer or admin confirms the feature works on staging (recorded with their name)
  app.post('/api/releases/:id/verify', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json<{ note?: unknown }>().catch(() => ({} as { note?: unknown }));
    const r = releases.verifyStaging(c.req.param('id'), { name: user.name }, typeof body.note === 'string' ? body.note : null);
    if (!r.ok) return c.json({ error: r.error }, r.error.includes('not found') ? 404 : 400);
    return c.json(r.data);
  });

  // An admin ends a stuck staging lock. A reason is required and is written to the audit.
  app.post('/api/releases/:id/clear', async (c) => {
    const user = getActingUser(c);
    if (!isAdmin(user)) return c.json({ error: 'Only an admin can clear a stuck staging request' }, 403);
    const body = await c.req.json<{ reason?: unknown }>().catch(() => ({} as { reason?: unknown }));
    const reason = typeof body.reason === 'string' ? body.reason : '';
    const r = releases.clearStuckRelease(c.req.param('id'), { name: user.name, id: user.id }, reason);
    if (!r.ok) return c.json({ error: r.error }, r.error.includes('not found') ? 404 : 400);
    return c.json(r.data);
  });

  // The deploy agent's outcome (report_release MCP tool, or any mutating token)
  app.post('/api/releases/:id/report', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const body = await c.req.json<{ status?: unknown; version?: unknown; sha?: unknown; note?: unknown; failed_step?: unknown }>().catch(() => ({} as Record<string, unknown>));
    const status = body.status;
    if (status !== 'deployed' && status !== 'failed' && status !== 'rejected') return c.json({ error: "status must be 'deployed', 'failed' or 'rejected'" }, 400);
    const r = releases.reportRelease(c.req.param('id'), {
      status,
      version: typeof body.version === 'string' ? body.version : null,
      sha: typeof body.sha === 'string' ? body.sha : null,
      note: typeof body.note === 'string' ? body.note : null,
      failed_step: typeof body.failed_step === 'string' ? body.failed_step : null,
    });
    if (!r.ok) return c.json({ error: r.error }, r.error.includes('not found') ? 404 : 400);
    return c.json(r.data);
  });

  // Requester side: stage a reviewed freeze (automated, no GO) — Promote stays the production GO
  app.post('/api/reviews/:runId/stage', async (c) => {
    const user = getActingUser(c);
    if (!canMutate(user)) return c.json({ error: 'Forbidden' }, 403);
    const r = await reviewQueue.stage(c.req.param('runId'), { actorIsAdmin: isAdmin(user) });
    if (!r.ok) return c.json({ error: r.error }, r.error === releases.STAGE_NEEDS_PASS ? 403 : 400);
    return c.json(r.data, 202);
  });
}
