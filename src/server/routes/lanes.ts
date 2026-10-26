import type { Context, Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import {
  applyLaneSyncNotices,
  canonicalLaneName,
  getSyncNotice,
  pauseDeferredLanes,
  resumeDeferredLanes,
  type SyncNoticeApply,
} from '../lane-sync-notices.js';
import { isAdmin } from '../users.js';
import { getConfig } from '../config.js';
import { laneHasNothingMainLacks, projectRepo, resolveMainRef, retireLane } from '../lane-main.js';
import { execFileAsync } from '../proc.js';

type Body = Record<string, unknown>;

async function readBody(c: Context<NodeAppEnv>): Promise<Body | null> {
  const type = c.req.header('content-type') ?? '';
  try {
    if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
      const body = await c.req.parseBody();
      if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
      return body as Body;
    }
    const body = await c.req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as Body;
  } catch {
    return null;
  }
}

function wantsDeferred(value: unknown): boolean {
  return value === true || value === 'true' || value === '1' || value === 'on';
}

/** Admin pause and resume of behind-main notices. One lane, a `lanes` list, or a deferred-agent filter. */
export function registerLaneRoutes(app: Hono<NodeAppEnv>): void {
  // Retire a lane whose work is all on main (git cherry empty): freezes closed as merged, no more pings. Admin. The branch stays.
  app.post('/api/lanes/:id/retire', async (c) => {
    const user = getActingUser(c);
    if (!isAdmin(user)) return c.json({ error: 'Only an admin may retire a lane' }, 403);
    const lane = canonicalLaneName(c.req.param('id'));
    if (!lane) return c.json({ error: 'invalid lane name' }, 400);
    const body = (await readBody(c)) ?? {};
    const projects = Object.keys(getConfig().projects ?? {});
    const project = typeof body.project === 'string' ? body.project : c.req.query('project') ?? (projects.length === 1 ? projects[0] : null);
    if (!project || !projects.includes(project)) return c.json({ error: `project is required (one of ${projects.join(', ') || 'none configured'})` }, 400);
    const repo = projectRepo(project);
    if (!repo) return c.json({ error: `project ${project} has no repo` }, 400);
    const mainRef = await resolveMainRef(repo, project);
    if (!mainRef) return c.json({ error: 'main not found' }, 400);
    const spec = `refs/remotes/${mainRef.includes('/') ? mainRef : `origin/${mainRef}`}`.replace(/^refs\/remotes\/refs\/remotes\//, 'refs/remotes/');
    const remote = spec.split('/')[2] ?? 'origin';
    try { await execFileAsync('git', ['-C', repo, 'fetch', '--quiet', remote, lane], { timeout: 30_000 }); } catch { /* use what is known */ }
    let tip: string | null = null;
    try { tip = (await execFileAsync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${lane}^{commit}`], { timeout: 10_000 })).trim(); } catch { tip = null; }
    if (!tip) return c.json({ error: `${lane} is not on ${remote}` }, 404);
    const nothing = await laneHasNothingMainLacks(repo, mainRef, tip);
    if (nothing === null) return c.json({ error: 'git cherry failed' }, 500);
    if (!nothing) return c.json({ error: `${lane} still has commits main lacks (git cherry ${mainRef} ${lane} is not empty); it merges through the queue, not retired` }, 409);
    const closed = retireLane(project, lane, tip, `retired by ${user.name}: git cherry ${mainRef} ${lane} is empty`);
    return c.json({ lane, project, tip, freezes_closed: closed, retired: true });
  });

  app.post('/api/lanes/sync-notices/pause', (c) => bulk(c, 'pause'));
  app.post('/api/lanes/sync-notices/resume', (c) => bulk(c, 'resume'));
  app.post('/api/lanes/:id/sync-notices/pause', (c) => one(c, 'pause'));
  app.post('/api/lanes/:id/sync-notices/resume', (c) => one(c, 'resume'));
}

async function one(c: Context<NodeAppEnv>, action: 'pause' | 'resume') {
  const user = getActingUser(c);
  if (!isAdmin(user)) return c.json({ error: 'Forbidden: admin only' }, 403);
  const body = await readBody(c);
  if (!body) return c.json({ error: 'Malformed JSON body' }, 400);
  const lane = laneFromParam(c.req.param('id') ?? '');
  if (!lane) {
    const shown = shownParam(c.req.param('id') ?? '');
    return c.json({ error: 'invalid lane name', results: [{ lane: shown, status: 'invalid' }] }, 400);
  }
  const reason = typeof body.reason === 'string' ? body.reason : '';
  const result = applyLaneSyncNotices(action, [lane], user.name, reason, user.id);
  if (!result.ok) return c.json({ error: result.error, results: result.results }, 400);
  return c.json(lanePayload(lane, result));
}

async function bulk(c: Context<NodeAppEnv>, action: 'pause' | 'resume') {
  const user = getActingUser(c);
  if (!isAdmin(user)) return c.json({ error: 'Forbidden: admin only' }, 403);
  const body = await readBody(c);
  if (!body) return c.json({ error: 'Malformed JSON body' }, 400);
  const reason = typeof body.reason === 'string' ? body.reason : '';
  const listed = laneList(body.lanes);
  const agentId = typeof body.agent_id === 'string' ? body.agent_id.trim() : '';
  if (listed && agentId) return c.json({ error: 'name lanes or pass agent_id and deferred, not both' }, 400);
  if (listed) {
    const result = applyLaneSyncNotices(action, listed, user.name, reason, user.id);
    if (!result.ok) return c.json({ error: result.error, results: result.results }, 400);
    return c.json({ lanes: result.lanes, results: result.results });
  }
  if (!agentId) return c.json({ error: 'agent_id is required' }, 400);
  if (!wantsDeferred(body.deferred)) return c.json({ error: 'deferred must be true' }, 400);
  const result = action === 'pause'
    ? pauseDeferredLanes(agentId, user.name, reason, user.id)
    : resumeDeferredLanes(agentId, user.name, reason, user.id);
  if (!result.ok) {
    const status = result.error.includes('not found') ? 404 : 400;
    return c.json({ error: result.error }, status);
  }
  return c.json({ lanes: result.data });
}

function laneList(value: unknown): string[] | null {
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? item : ''));
  if (typeof value === 'string' && value.trim()) return [value];
  return null;
}

function laneFromParam(id: string): string | null {
  const text = decodeParam(id);
  if (text == null) return null;
  return canonicalLaneName(text);
}

function shownParam(id: string): string {
  return decodeParam(id) ?? id;
}

function decodeParam(id: string): string | null {
  if (!id) return null;
  if (!id.includes('%')) return id;
  try {
    return decodeURIComponent(id);
  } catch {
    return null;
  }
}

function lanePayload(lane: string, result: Extract<SyncNoticeApply, { ok: true }>) {
  const row = getSyncNotice(lane);
  return {
    lane,
    sync_notices_paused: row?.sync_notices_paused === 1,
    paused_by: row?.paused_by ?? null,
    paused_at: row?.paused_at ?? null,
    reason: row?.reason ?? null,
    lanes: result.lanes,
    results: result.results,
  };
}
