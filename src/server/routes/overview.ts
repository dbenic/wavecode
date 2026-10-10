import type { Hono } from 'hono';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import { isAdmin } from '../users.js';
import { buildBoard } from '../overview.js';
import * as overlord from '../overlord.js';

/** The board (overview.ts) and the overlord's reports (overlord.ts). */
export function registerOverviewRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/overview', (c) => {
    const cfg = overlord.overlordConfig();
    return c.json({
      board: buildBoard(),
      report: overlord.getLatestReport(),
      overlord: { enabled: cfg.enabled, model: cfg.model, heartbeat_min: cfg.heartbeatMin, max_wakes_per_hour: cfg.maxWakesPerHour },
    });
  });

  app.get('/api/overview/reports', (c) => {
    const limit = Math.min(100, Number(c.req.query('limit') ?? 20) || 20);
    return c.json(overlord.listReports(limit));
  });

  // Ask the overlord now (admin): bypasses the debounce, not the hourly cap unless force=true
  app.post('/api/overview/wake', async (c) => {
    const user = getActingUser(c);
    if (!isAdmin(user)) return c.json({ error: 'Forbidden: only an admin can wake the overlord' }, 403);
    const body = await c.req.json<{ force?: boolean }>().catch(() => ({} as { force?: boolean }));
    if (!overlord.overlordConfig().enabled) return c.json({ error: 'overlord.enabled is false' }, 400);
    const report = await overlord.wake(`manual:${user.name}`, { force: body.force === true });
    if (!report) return c.json({ error: 'No report: hourly cap reached, no LLM key, or the model answer could not be parsed (see the daemon log)' }, 503);
    return c.json(report, 201);
  });
}
