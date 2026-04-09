import type { Hono } from 'hono';
import type { NodeAppEnv } from '../auth.js';
import * as templateManager from '../template-manager.js';
import { listTemplates, getTemplate } from '../db.js';
import logger from '../logger.js';

export function registerTemplateRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/templates', (c) => {
    return c.json(listTemplates());
  });

  app.get('/api/templates/:id', (c) => {
    const result = getTemplate(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 404);
    return c.json(result.data);
  });

  app.post('/api/templates', async (c) => {
    const body = await c.req.json().catch(() => null) as { git_url?: string } | null;
    if (!body?.git_url || typeof body.git_url !== 'string') {
      return c.json({ error: 'git_url is required' }, 400);
    }
    const result = await templateManager.addTemplate({ git_url: body.git_url });
    if (!result.ok) {
      logger.warn({ error: result.error, git_url: body.git_url }, 'Failed to add template');
      return c.json({ error: result.error }, 400);
    }
    return c.json(result.data);
  });

  app.post('/api/templates/:id/sync', async (c) => {
    const result = await templateManager.syncTemplate(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.data);
  });

  app.post('/api/templates/:id/trust', (c) => {
    const result = templateManager.trustTemplate(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.data);
  });

  app.delete('/api/templates/:id', (c) => {
    const result = templateManager.removeTemplate(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  app.post('/api/templates/:id/spawn', async (c) => {
    const body = await c.req.json().catch(() => null) as {
      agent_name?: string;
      runtime?: string;
      env?: Record<string, string>;
    } | null;
    if (!body?.agent_name || typeof body.agent_name !== 'string') {
      return c.json({ error: 'agent_name is required' }, 400);
    }
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(body.agent_name)) {
      return c.json({ error: 'agent_name must be 1-64 alphanumeric/dash/underscore chars' }, 400);
    }
    const result = await templateManager.spawnFromTemplate({
      templateId: c.req.param('id'),
      agentName: body.agent_name,
      runtime: body.runtime,
      env: body.env,
    });
    if (!result.ok) {
      logger.warn({ error: result.error }, 'Failed to spawn from template');
      return c.json({ error: result.error }, 400);
    }
    return c.json(result.data);
  });
}
