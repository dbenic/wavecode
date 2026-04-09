import type { Hono } from 'hono';
import type { NodeAppEnv } from '../auth.js';
import {
  listResearchRuns,
  getResearchRun,
  deleteResearchRun,
  setResearchArtifact,
} from '../db.js';
import { startResearchRun, forkResearchRun } from '../research-runner.js';
import { storeArtifactFromBuffer, shareArtifact } from '../artifact-manager.js';
import logger from '../logger.js';

export function registerSpecsRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/specs', (c) => {
    return c.json(listResearchRuns());
  });

  app.get('/api/specs/:id', (c) => {
    const result = getResearchRun(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 404);
    return c.json(result.data);
  });

  app.post('/api/specs', async (c) => {
    const body = await c.req.json().catch(() => null) as {
      prompt?: string;
      model?: string;
      provider?: string;
      target_agent_id?: string | null;
    } | null;
    if (!body?.prompt || typeof body.prompt !== 'string' || body.prompt.trim().length < 3) {
      return c.json({ error: 'prompt is required (min 3 chars)' }, 400);
    }
    const result = startResearchRun({
      prompt: body.prompt.trim(),
      model: body.model,
      provider: body.provider as 'anthropic' | 'openai' | 'gemini' | 'perplexity' | 'xai' | undefined,
      targetAgentId: body.target_agent_id ?? null,
    });
    if (!result.ok) {
      logger.warn({ error: result.error }, 'Failed to start research run');
      return c.json({ error: result.error }, 400);
    }
    return c.json(result.data);
  });

  app.post('/api/specs/:id/attach', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => null) as { agent_id?: string } | null;
    if (!body?.agent_id) return c.json({ error: 'agent_id required' }, 400);

    const run = getResearchRun(id);
    if (!run.ok) return c.json({ error: run.error }, 404);
    if (run.data.status !== 'done') {
      return c.json({ error: `Run is ${run.data.status}, cannot attach` }, 400);
    }
    if (!run.data.output_md.trim()) {
      return c.json({ error: 'Run has no output' }, 400);
    }

    const filename = `spec-${run.data.title.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40)}.md`;
    const stored = storeArtifactFromBuffer({
      buffer: Buffer.from(run.data.output_md, 'utf-8'),
      filename,
      note: `Research spec: ${run.data.title}`,
    });
    if (!stored.ok) return c.json({ error: stored.error }, 500);

    const shared = shareArtifact(stored.data.id, body.agent_id);
    if (!shared.ok) return c.json({ error: shared.error }, 400);

    setResearchArtifact(id, stored.data.id, body.agent_id);
    return c.json({ ok: true, artifact_id: stored.data.id });
  });

  app.post('/api/specs/:id/fork', async (c) => {
    const body = await c.req.json().catch(() => null) as { prompt?: string } | null;
    if (!body?.prompt || body.prompt.trim().length < 3) {
      return c.json({ error: 'prompt is required (min 3 chars)' }, 400);
    }
    const result = forkResearchRun(c.req.param('id'), body.prompt.trim());
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json(result.data);
  });

  app.delete('/api/specs/:id', (c) => {
    const ok = deleteResearchRun(c.req.param('id'));
    if (!ok) return c.json({ error: 'Not found' }, 404);
    return c.json({ ok: true });
  });
}
