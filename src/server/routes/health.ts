import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { isAdmin } from '../users.js';
import { perfSnapshot } from '../perf-monitor.js';
import { storageSnapshot } from '../event-retention.js';

/** Admin diagnostics: event-loop lag, child processes, job durations, table sizes. */
export function registerHealthRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/health/perf', (c) => {
    const user = getActingUser(c);
    if (!isAdmin(user)) return c.json({ error: 'Forbidden' }, 403);
    return c.json({ ...perfSnapshot(), storage: storageSnapshot() });
  });
}
