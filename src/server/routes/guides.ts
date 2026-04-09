import type { Hono } from 'hono';
import type { NodeAppEnv } from '../auth.js';
import * as guideManager from '../guide-manager.js';
import {
  listGuides,
  listGuideSources,
  getGuide,
  listGuidesForAgent,
} from '../db.js';
import logger from '../logger.js';

export function registerGuideRoutes(app: Hono<NodeAppEnv>): void {
  // --- Guide sources ---

  app.get('/api/guide-sources', (c) => {
    return c.json(listGuideSources());
  });

  app.post('/api/guide-sources', async (c) => {
    const body = await c.req.json().catch(() => null) as { name?: string; url?: string; glob?: string } | null;
    if (!body?.name || !body?.url) {
      return c.json({ error: 'name and url are required' }, 400);
    }
    if (typeof body.name !== 'string' || typeof body.url !== 'string') {
      return c.json({ error: 'name and url must be strings' }, 400);
    }
    const result = await guideManager.addGitSource({
      name: body.name,
      url: body.url,
      glob: body.glob,
    });
    if (!result.ok) {
      logger.warn({ error: result.error, name: body.name }, 'Failed to add guide source');
      return c.json({ error: result.error }, 400);
    }
    return c.json(result.data);
  });

  app.post('/api/guide-sources/:id/sync', async (c) => {
    const result = await guideManager.syncSource(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.data);
  });

  app.delete('/api/guide-sources/:id', (c) => {
    const result = guideManager.removeSource(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  // --- Guides ---

  app.get('/api/guides', (c) => {
    const sourceId = c.req.query('source') || undefined;
    const search = c.req.query('search') || undefined;
    return c.json(listGuides({ sourceId, search }));
  });

  app.get('/api/guides/:id', (c) => {
    const id = c.req.param('id');
    // Support lookup by slug (contains /) via separate route below
    const guide = getGuide(id);
    if (!guide.ok) return c.json({ error: guide.error }, 404);
    const content = guideManager.readGuideContent(id);
    if (!content.ok) return c.json({ error: content.error }, 404);
    return c.json({
      ...guide.data,
      content: content.data.content,
    });
  });

  // --- Agent-guide attachments ---

  app.get('/api/agents/:id/guides', (c) => {
    return c.json(listGuidesForAgent(c.req.param('id')));
  });

  app.post('/api/agents/:id/guides', async (c) => {
    const body = await c.req.json().catch(() => null) as { guide_ids?: string[] } | null;
    if (!body?.guide_ids || !Array.isArray(body.guide_ids)) {
      return c.json({ error: 'guide_ids array required' }, 400);
    }
    const agentId = c.req.param('id');
    const results: { guide_id: string; ok: boolean; error?: string }[] = [];
    for (const guideId of body.guide_ids) {
      const r = guideManager.attachGuide(agentId, guideId);
      results.push({ guide_id: guideId, ok: r.ok, error: r.ok ? undefined : r.error });
    }
    return c.json({ results });
  });

  app.delete('/api/agents/:agentId/guides/:guideId', (c) => {
    const result = guideManager.detachGuide(c.req.param('agentId'), c.req.param('guideId'));
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });
}
