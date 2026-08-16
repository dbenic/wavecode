import type { Hono } from 'hono';
import { getRun, insertRunArtifact, listArtifacts, getArtifact } from '../db.js';
import * as artifactManager from '../artifact-manager.js';
import type { NodeAppEnv } from '../auth.js';
import type { Artifact, Result } from '../db.js';

function attachUploadedArtifact(
  artifact: Artifact,
  agentId?: string | null,
): Result<Artifact & { attached_path?: string }> {
  if (!agentId) return { ok: true, data: artifact };

  const attachResult = artifactManager.attachArtifactToAgent(artifact.id, agentId);
  if (!attachResult.ok) return attachResult;

  return {
    ok: true,
    data: {
      ...artifact,
      attached_path: attachResult.data.attachedPath,
    },
  };
}

export function registerArtifactRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/artifacts', (c) => {
    const agentId = c.req.query('agent_id');
    const runId = c.req.query('run_id');

    // If filtering by agent, use the combined query (created by + shared to)
    if (agentId) {
      return c.json(artifactManager.getAgentArtifacts(agentId));
    }

    return c.json(listArtifacts({
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
    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('application/json')) {
      const body = await c.req.json<{
        filename?: string;
        content_base64?: string;
        path?: string;
        note?: string;
        agent_id?: string;
        run_id?: string;
      }>();

      const agentId = body.agent_id?.trim() || undefined;
      const runId = body.run_id?.trim() || undefined;
      const note = body.note?.trim() || undefined;
      let result: Result<Artifact>;

      if (body.content_base64) {
        const filename = body.filename?.trim();
        if (!filename) return c.json({ error: 'filename is required with content_base64' }, 400);
        let buffer: Buffer;
        try {
          buffer = Buffer.from(body.content_base64, 'base64');
        } catch {
          return c.json({ error: 'content_base64 is not valid base64' }, 400);
        }
        if (buffer.length === 0) return c.json({ error: 'content_base64 decoded to an empty file' }, 400);
        result = artifactManager.storeArtifactFromBuffer({
          buffer,
          filename,
          sourceAgentId: agentId,
          sourceRunId: runId,
          note,
        });
      } else if (body.path?.trim()) {
        result = artifactManager.storeArtifact({
          sourcePath: body.path.trim(),
          filename: body.filename?.trim() || undefined,
          sourceAgentId: agentId,
          sourceRunId: runId,
          note,
        });
      } else {
        return c.json({ error: 'Provide content_base64 + filename, or path' }, 400);
      }

      if (!result.ok) return c.json({ error: result.error }, 400);

      const attached = attachUploadedArtifact(result.data, agentId);
      if (!attached.ok) return c.json({ error: attached.error }, 400);
      return c.json(attached.data, 201);
    }

    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;
    const note = formData.get('note') as string | null;
    const agentId = formData.get('agent_id') as string | null;
    const runId = formData.get('run_id') as string | null;

    if (!file) return c.json({ error: 'No file provided' }, 400);

    const buffer = Buffer.from(await file.arrayBuffer());
    const result = artifactManager.storeArtifactFromBuffer({
      buffer,
      filename: file.name,
      sourceAgentId: agentId ?? undefined,
      sourceRunId: runId ?? undefined,
      note: note ?? undefined,
    });

    if (!result.ok) return c.json({ error: result.error }, 500);

    const attached = attachUploadedArtifact(result.data, agentId);
    if (!attached.ok) return c.json({ error: attached.error }, 400);
    return c.json(attached.data, 201);
  });

  app.post('/api/artifacts/:id/attach', async (c) => {
    const artifactId = c.req.param('id');
    const artifactResult = getArtifact(artifactId);
    if (!artifactResult.ok) return c.json({ error: artifactResult.error }, 404);

    const body = await c.req.json<{
      agent_id?: string;
      run_id?: string;
      role?: string;
    }>().catch(() => ({} as { agent_id?: string; run_id?: string; role?: string }));

    const agentId = body.agent_id?.trim() || undefined;
    const runId = body.run_id?.trim() || undefined;
    if (!agentId && !runId) {
      return c.json({ error: 'Provide agent_id and/or run_id' }, 400);
    }

    const response: { ok: true; attached_path?: string; run_id?: string; role?: string } = { ok: true };

    if (runId) {
      const runResult = getRun(runId);
      if (!runResult.ok) return c.json({ error: runResult.error }, 400);
      const role = body.role?.trim() || 'input';
      insertRunArtifact(runId, artifactId, role);
      response.run_id = runId;
      response.role = role;
    }

    if (agentId) {
      const attachResult = artifactManager.attachArtifactToAgent(artifactId, agentId);
      if (!attachResult.ok) return c.json({ error: attachResult.error }, 400);
      response.attached_path = attachResult.data.attachedPath;
    }

    return c.json(response);
  });

  app.post('/api/artifacts/:id/share', async (c) => {
    const body = await c.req.json<{ targetAgentId: string }>();
    const result = artifactManager.shareArtifact(c.req.param('id'), body.targetAgentId);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });

  // Delete an artifact entirely
  app.delete('/api/artifacts/:id', (c) => {
    const result = artifactManager.removeArtifact(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 404);
    return c.json({ ok: true });
  });

  // Detach an artifact from an agent (keeps the artifact, removes the link)
  app.delete('/api/artifacts/:id/agent/:agentId', (c) => {
    const result = artifactManager.detachArtifactFromAgent(
      c.req.param('id'),
      c.req.param('agentId'),
    );
    if (!result.ok) return c.json({ error: result.error }, 404);
    return c.json({ ok: true });
  });
}
