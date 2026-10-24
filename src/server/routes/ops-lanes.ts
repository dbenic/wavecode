import type { Hono } from 'hono';
import type { NodeAppEnv } from '../auth.js';
import { opsLanesSnapshot } from '../ops-lanes.js';

/** Read-only Ops lanes snapshot. The collector fills it; this handler does not touch the disk. */
export function registerOpsLaneRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/ops-lanes', (c) => c.json(opsLanesSnapshot()));
}
