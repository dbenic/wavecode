import type { Context, Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import {
  getSyncNotice,
  pauseDeferredLanes,
  pauseSyncNotices,
  resumeDeferredLanes,
  resumeSyncNotices,
} from '../lane-sync-notices.js';
import { isAdmin } from '../users.js';

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

/** Admin pause and resume of behind-main notices. One lane, or a bulk form by agent and deferred desk. */
export function registerLaneRoutes(app: Hono<NodeAppEnv>): void {
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
  const lane = decodeLane(c.req.param('id') ?? '');
  if (!lane) return c.json({ error: 'lane must be a branch name (letters, digits, ., _, -)' }, 400);
  const reason = typeof body.reason === 'string' ? body.reason : '';
  const result = action === 'pause'
    ? pauseSyncNotices([lane], user.name, reason, user.id)
    : resumeSyncNotices([lane], user.name, reason, user.id);
  if (!result.ok) return c.json({ error: result.error }, 400);
  const row = getSyncNotice(lane);
  return c.json({
    lane,
    sync_notices_paused: row?.sync_notices_paused === 1,
    paused_by: row?.paused_by ?? null,
    paused_at: row?.paused_at ?? null,
    reason: row?.reason ?? null,
    affected: result.data,
  });
}

async function bulk(c: Context<NodeAppEnv>, action: 'pause' | 'resume') {
  const user = getActingUser(c);
  if (!isAdmin(user)) return c.json({ error: 'Forbidden: admin only' }, 403);
  const body = await readBody(c);
  if (!body) return c.json({ error: 'Malformed JSON body' }, 400);
  const agentId = typeof body.agent_id === 'string' ? body.agent_id.trim() : '';
  if (!agentId) return c.json({ error: 'agent_id is required' }, 400);
  if (!wantsDeferred(body.deferred)) return c.json({ error: 'deferred must be true' }, 400);
  const reason = typeof body.reason === 'string' ? body.reason : '';
  const result = action === 'pause'
    ? pauseDeferredLanes(agentId, user.name, reason, user.id)
    : resumeDeferredLanes(agentId, user.name, reason, user.id);
  if (!result.ok) {
    const status = result.error.includes('not found') ? 404 : 400;
    return c.json({ error: result.error }, status);
  }
  return c.json({ lanes: result.data });
}

function decodeLane(id: string): string | null {
  if (!id) return null;
  try {
    return decodeURIComponent(id);
  } catch {
    return null;
  }
}
