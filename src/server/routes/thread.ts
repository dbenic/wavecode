import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { isThreadKind, readThread, type ThreadKind } from '../thread.js';
import * as validate from '../validate.js';

export function registerThreadRoutes(app: Hono<NodeAppEnv>): void {
  /**
   * GET /api/thread?agent=<id|all>&owner=<user id>&kinds=run,verdict&attention=1&since=<cursor>&limit=&wait_ms=
   * Merged, typed feed (spec §4.1). Without `since` → the newest `limit`
   * items; with `since` → items after that cursor, long-polling up to
   * `wait_ms` when there are none yet.
   */
  app.get('/api/thread', async (c) => {
    const kindsParam = c.req.query('kinds');
    let kinds: ThreadKind[] | null = null;
    if (kindsParam) {
      const requested = kindsParam.split(',').map((k) => k.trim()).filter(Boolean);
      const unknown = requested.filter((k) => !isThreadKind(k));
      if (unknown.length > 0) return c.json({ error: `Unknown kinds: ${unknown.join(', ')}` }, 400);
      kinds = requested as ThreadKind[];
    }

    const sinceRaw = c.req.query('since');
    const since = sinceRaw === undefined || sinceRaw === ''
      ? null
      : validate.validateIntParam(sinceRaw, { min: 0, default: 0 });
    const limit = validate.validateIntParam(c.req.query('limit'), { min: 1, max: 500, default: 100 });
    const waitMs = validate.validateIntParam(c.req.query('wait_ms'), { min: 0, max: 60_000, default: 0 });
    const attention = c.req.query('attention');

    const query = {
      agentId: c.req.query('agent') ?? null,
      ownerId: c.req.query('owner') ?? null,
      kinds,
      attentionOnly: attention === '1' || attention === 'true',
      since,
      limit,
    };
    const viewer = getActingUser(c);

    const deadline = Date.now() + waitMs;
    for (;;) {
      const page = readThread(query, viewer);
      if (page.items.length > 0 || since === null || Date.now() >= deadline) {
        return c.json(page);
      }
      query.since = page.cursor;
      await new Promise((r) => setTimeout(r, 500));
    }
  });
}
