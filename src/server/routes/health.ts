import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { isAdmin } from '../users.js';
import { eventLoopLag } from '../event-loop.js';
import { perfSnapshot } from '../perf-monitor.js';
import { storageSnapshot } from '../event-retention.js';
import { gitMemoStats } from '../git-memo.js';

/** Admin diagnostics: event-loop lag, child processes, job durations, table sizes. */
export function registerHealthRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/health', (c) => {
    const lag = eventLoopLag();
    return c.json({ event_loop: { p99_ms: lag.p99_ms, max_ms: lag.max_ms } });
  });

  app.get('/api/health/perf', (c) => {
    const user = getActingUser(c);
    if (!isAdmin(user)) return c.json({ error: 'Forbidden' }, 403);
    return c.json({ ...perfSnapshot(), storage: storageSnapshot(), git_memo: gitMemoStats() });
  });
}
