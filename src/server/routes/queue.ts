import type { Hono } from 'hono';
import type { NodeAppEnv } from '../auth.js';
import { queueSnapshot } from '../fable-queue.js';

/** Read-only Fable Queue snapshot. The collector fills it; this handler does not touch tmux or disk. */
export function registerQueueRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/queue', (c) => c.json(queueSnapshot()));
}
