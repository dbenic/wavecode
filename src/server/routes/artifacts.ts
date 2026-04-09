import type { Hono } from 'hono';
import { listArtifacts, getArtifact } from '../db.js';
import * as artifactManager from '../artifact-manager.js';
import type { NodeAppEnv } from '../auth.js';

export function registerArtifactRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/artifacts', (c) => {
    const agentId = c.req.query('agent_id');
    const runId = c.req.query('run_id');
    return c.json(listArtifacts({
      source_agent_id: agentId || undefined,
      source_run_id: runId || undefined,
    }));
  });

  app.get('/api/artifacts/:id', (c) => {
    const result = getArtifact(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 404);
    return c.json(result.data);
  });

  app.get('/api/artifacts/:id/download', async (c) => {
    const result = getArtifact(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 404);

    const artifact = result.data;
    const fsNode = await import('node:fs');
    if (!fsNode.existsSync(artifact.storage_path)) {
      return c.json({ error: 'File not found on disk' }, 404);
    }

    const buffer = fsNode.readFileSync(artifact.storage_path);
    const isInline = artifact.mime_type.startsWith('image/')
      || artifact.mime_type === 'application/pdf'
      || artifact.mime_type.startsWith('text/');

    return new Response(buffer, {
      headers: {
        'Content-Type': artifact.mime_type,
        'Content-Disposition': isInline
          ? `inline; filename="${artifact.filename}"`
          : `attachment; filename="${artifact.filename}"`,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  });

  app.post('/api/artifacts/upload', async (c) => {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    const note = formData.get('note') as string | null;
    const agentId = formData.get('agent_id') as string | null;

    if (!file) return c.json({ error: 'No file provided' }, 400);

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = artifactManager.storeArtifactFromBuffer({
      buffer,
      filename: file.name,
      sourceAgentId: agentId ?? undefined,
      note: note ?? undefined,
    });

    if (!result.ok) return c.json({ error: result.error }, 500);

    if (agentId) {
      const attachResult = artifactManager.attachArtifactToAgent(result.data.id, agentId);
      if (!attachResult.ok) return c.json({ error: attachResult.error }, 400);

      return c.json({
        ...result.data,
        attached_path: attachResult.data.attachedPath,
      }, 201);
    }

    return c.json(result.data, 201);
  });

  app.post('/api/artifacts/:id/share', async (c) => {
    const body = await c.req.json<{ targetAgentId: string }>();
    const result = artifactManager.shareArtifact(c.req.param('id'), body.targetAgentId);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });
}
