import type { Hono } from 'hono';
import type { NodeAppEnv } from '../auth.js';
import { pollPortalOnce, portalState } from '../test-portal.js';

/** The daemon's copy of the countix-testing status portal (any signed-in user). */
export function registerTestPortalRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/tests/status', (c) => c.json(portalState()));
  // A manual refresh from the page; the poller keeps its own cadence.
  app.post('/api/tests/status/refresh', async (c) => {
    await pollPortalOnce();
    return c.json(portalState());
  });
}
