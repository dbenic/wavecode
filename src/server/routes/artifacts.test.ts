import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  listArtifacts: vi.fn(),
  getArtifact: vi.fn(),
}));

vi.mock('../artifact-manager.js', () => ({
  storeArtifactFromBuffer: vi.fn(),
  attachArtifactToAgent: vi.fn(),
  shareArtifact: vi.fn(),
  getAgentArtifacts: vi.fn(),
  removeArtifact: vi.fn(),
  detachArtifactFromAgent: vi.fn(),
}));

describe('artifact routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads and auto-attaches an artifact when agent_id is provided', async () => {
    const artifacts = await import('../artifact-manager.js');
    vi.mocked(artifacts.storeArtifactFromBuffer).mockReturnValue({
      ok: true,
      data: {
        id: 'artifact-1',
        filename: 'brief.md',
        storage_path: '/artifact-store/brief.md',
      },
    } as never);
    vi.mocked(artifacts.attachArtifactToAgent).mockReturnValue({
      ok: true,
      data: {
        attachedPath: '/workspace/agent-1/.wavecode/artifacts/brief.md',
      },
    } as never);

    const app = await createArtifactsApp();
    const formData = new FormData();
    formData.set('file', new File(['# Brief\n'], 'brief.md', { type: 'text/markdown' }));
    formData.set('agent_id', 'agent-1');

    const response = await app.fetch(new Request('http://localhost/api/artifacts/upload', {
      method: 'POST',
      body: formData,
    }));

    expect(response.status).toBe(201);
    expect(artifacts.storeArtifactFromBuffer).toHaveBeenCalledWith(expect.objectContaining({
      filename: 'brief.md',
      sourceAgentId: 'agent-1',
    }));
    expect(artifacts.attachArtifactToAgent).toHaveBeenCalledWith('artifact-1', 'agent-1');
    await expect(response.json()).resolves.toEqual(expect.objectContaining({
      id: 'artifact-1',
      filename: 'brief.md',
      attached_path: '/workspace/agent-1/.wavecode/artifacts/brief.md',
    }));
  });

  it('GET /api/artifacts?agent_id uses getAgentArtifacts for combined query', async () => {
    const artifacts = await import('../artifact-manager.js');
    vi.mocked(artifacts.getAgentArtifacts).mockReturnValue([
      { id: 'a1', filename: 'test.md' },
      { id: 'a2', filename: 'shared.png' },
    ] as never);

    const app = await createArtifactsApp();
    const response = await app.fetch(new Request('http://localhost/api/artifacts?agent_id=agent-1'));

    expect(response.status).toBe(200);
    expect(artifacts.getAgentArtifacts).toHaveBeenCalledWith('agent-1');
    const data = await response.json();
    expect(data).toHaveLength(2);
  });

  it('DELETE /api/artifacts/:id deletes an artifact', async () => {
    const artifacts = await import('../artifact-manager.js');
    vi.mocked(artifacts.removeArtifact).mockReturnValue({
      ok: true,
      data: undefined,
    } as never);

    const app = await createArtifactsApp();
    const response = await app.fetch(new Request('http://localhost/api/artifacts/artifact-1', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(200);
    expect(artifacts.removeArtifact).toHaveBeenCalledWith('artifact-1');
  });

  it('DELETE /api/artifacts/:id returns 404 for non-existent artifact', async () => {
    const artifacts = await import('../artifact-manager.js');
    vi.mocked(artifacts.removeArtifact).mockReturnValue({
      ok: false,
      error: 'Artifact not-exists not found',
    } as never);

    const app = await createArtifactsApp();
    const response = await app.fetch(new Request('http://localhost/api/artifacts/not-exists', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(404);
  });

  it('DELETE /api/artifacts/:id/agent/:agentId detaches artifact from agent', async () => {
    const artifacts = await import('../artifact-manager.js');
    vi.mocked(artifacts.detachArtifactFromAgent).mockReturnValue({
      ok: true,
      data: undefined,
    } as never);

    const app = await createArtifactsApp();
    const response = await app.fetch(new Request('http://localhost/api/artifacts/artifact-1/agent/agent-1', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(200);
    expect(artifacts.detachArtifactFromAgent).toHaveBeenCalledWith('artifact-1', 'agent-1');
  });

  it('returns an error when upload succeeds but workspace attachment fails', async () => {
    const artifacts = await import('../artifact-manager.js');
    vi.mocked(artifacts.storeArtifactFromBuffer).mockReturnValue({
      ok: true,
      data: {
        id: 'artifact-2',
        filename: 'spec.md',
        storage_path: '/artifact-store/spec.md',
      },
    } as never);
    vi.mocked(artifacts.attachArtifactToAgent).mockReturnValue({
      ok: false,
      error: 'Agent has no workspace directory',
    } as never);

    const app = await createArtifactsApp();
    const formData = new FormData();
    formData.set('file', new File(['# Spec\n'], 'spec.md', { type: 'text/markdown' }));
    formData.set('agent_id', 'agent-9');

    const response = await app.fetch(new Request('http://localhost/api/artifacts/upload', {
      method: 'POST',
      body: formData,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Agent has no workspace directory' });
  });
});

async function createArtifactsApp() {
  const { registerArtifactRoutes } = await import('./artifacts.js');
  const app = new Hono();
  registerArtifactRoutes(app);
  return app;
}
