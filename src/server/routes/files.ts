import type { Hono } from 'hono';
import type { NodeAppEnv } from '../auth.js';
import { fileViewStatus, readViewableFile } from '../file-view.js';

/** Read-only viewer for paths agents mention (see file-view.ts for the root allowlist). */
export function registerFileRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/files/view', (c) => {
    const result = readViewableFile(c.req.query('path') ?? '');
    if (!result.ok) return c.json({ error: result.error }, fileViewStatus(result.code));
    return c.json(result.data);
  });
}
