import type { Hono } from 'hono';
import type { NodeAppEnv } from '../auth.js';
import { getConfig } from '../config.js';
import { checkGateStatus, parseRequire } from '../gate-status.js';

/**
 * `GET /api/gate-status/:sha?project=<p>&require=quick,api` — the one checker. Every reader
 * (deploy scripts through `wavecode gate-status`, agents, the UI) gets the same answer. The
 * HTTP status is 200 whatever the verdict; the verdict and its exit code are in the body.
 * 400 only for a malformed request (unknown suite, unknown project).
 */
export function registerGateStatusRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/gate-status/:sha', async (c) => {
    const projects = Object.keys(getConfig().projects ?? {});
    const project = c.req.query('project') ?? (projects.length === 1 ? projects[0] : null);
    if (project && !projects.includes(project)) return c.json({ error: `Unknown project ${project}` }, 404);
    if (!project) return c.json({ error: `project is required (one of ${projects.join(', ') || 'none configured'})` }, 400);
    const require = parseRequire(c.req.query('require'));
    if (!Array.isArray(require)) return c.json({ error: require.error }, 400);
    const report = await checkGateStatus(project, c.req.param('sha'), require, { lane: c.req.query('lane') ?? null });
    return c.json(report);
  });
}
