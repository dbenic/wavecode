import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  listResearchRuns: vi.fn(),
  getResearchRun: vi.fn(),
  deleteResearchRun: vi.fn(),
  setResearchArtifact: vi.fn(),
}));

vi.mock('../research-runner.js', () => ({
  startResearchRun: vi.fn(),
  forkResearchRun: vi.fn(),
}));

vi.mock('../artifact-manager.js', () => ({
  storeArtifactFromBuffer: vi.fn(),
  shareArtifact: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  default: {
    warn: vi.fn(),
  },
}));

describe('spec routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('rejects creating a spec when the prompt is too short', async () => {
    const app = await createSpecsApp();
    const response = await requestJson(app, '/api/specs', 'POST', {
      prompt: 'no',
    });

    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: 'prompt is required (min 3 chars)' });
  });

  it('starts a research run through the specs API', async () => {
    const runner = await import('../research-runner.js');
    vi.mocked(runner.startResearchRun).mockReturnValue({
      ok: true,
      data: makeRun({
        id: 'run-1',
        prompt: 'Research rate limiting',
        provider: 'openai',
        model: 'gpt-5.4',
        target_agent_id: 'agent-1',
      }),
    } as never);

    const app = await createSpecsApp();
    const response = await requestJson(app, '/api/specs', 'POST', {
      prompt: '  Research rate limiting  ',
      provider: 'openai',
      model: 'gpt-5.4',
      target_agent_id: 'agent-1',
    });

    expect(response.status).toBe(200);
    expect(runner.startResearchRun).toHaveBeenCalledWith({
      prompt: 'Research rate limiting',
      provider: 'openai',
      model: 'gpt-5.4',
      targetAgentId: 'agent-1',
    });
    expect(response.json).toEqual(makeRun({
      id: 'run-1',
      prompt: 'Research rate limiting',
      provider: 'openai',
      model: 'gpt-5.4',
      target_agent_id: 'agent-1',
    }));
  });

  it('rejects attaching specs that are not completed', async () => {
    const db = await import('../db.js');
    vi.mocked(db.getResearchRun).mockReturnValue({
      ok: true,
      data: makeRun({
        id: 'run-2',
        status: 'running',
      }),
    } as never);

    const app = await createSpecsApp();
    const response = await requestJson(app, '/api/specs/run-2/attach', 'POST', {
      agent_id: 'agent-1',
    });

    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: 'Run is running, cannot attach' });
  });

  it('stores and shares a completed spec artifact with an agent', async () => {
    const db = await import('../db.js');
    const artifacts = await import('../artifact-manager.js');

    vi.mocked(db.getResearchRun).mockReturnValue({
      ok: true,
      data: makeRun({
        id: 'run-3',
        title: 'Auth: phase 1 / final',
        status: 'done',
        output_md: '# Spec\n\nShip auth safely.\n',
      }),
    } as never);
    vi.mocked(artifacts.storeArtifactFromBuffer).mockReturnValue({
      ok: true,
      data: { id: 'artifact-1' },
    } as never);
    vi.mocked(artifacts.shareArtifact).mockReturnValue({
      ok: true,
      data: undefined,
    } as never);

    const app = await createSpecsApp();
    const response = await requestJson(app, '/api/specs/run-3/attach', 'POST', {
      agent_id: 'agent-42',
    });

    expect(response.status).toBe(200);
    expect(artifacts.storeArtifactFromBuffer).toHaveBeenCalledWith({
      buffer: Buffer.from('# Spec\n\nShip auth safely.\n', 'utf-8'),
      filename: 'spec-Auth--phase-1---final.md',
      note: 'Research spec: Auth: phase 1 / final',
    });
    expect(artifacts.shareArtifact).toHaveBeenCalledWith('artifact-1', 'agent-42');
    expect(db.setResearchArtifact).toHaveBeenCalledWith('run-3', 'artifact-1', 'agent-42');
    expect(response.json).toEqual({ ok: true, artifact_id: 'artifact-1' });
  });

  it('forks an existing spec run when given a valid prompt', async () => {
    const runner = await import('../research-runner.js');
    vi.mocked(runner.forkResearchRun).mockReturnValue({
      ok: true,
      data: makeRun({
        id: 'run-4',
        title: 'fork: Auth follow-up',
        prompt: 'Research fallback auth',
        parent_run_id: 'run-3',
      }),
    } as never);

    const app = await createSpecsApp();
    const response = await requestJson(app, '/api/specs/run-3/fork', 'POST', {
      prompt: '  Research fallback auth  ',
    });

    expect(response.status).toBe(200);
    expect(runner.forkResearchRun).toHaveBeenCalledWith('run-3', 'Research fallback auth');
    expect(response.json).toEqual(makeRun({
      id: 'run-4',
      title: 'fork: Auth follow-up',
      prompt: 'Research fallback auth',
      parent_run_id: 'run-3',
    }));
  });
});

async function createSpecsApp() {
  const { registerSpecsRoutes } = await import('./specs.js');
  const app = new Hono();
  registerSpecsRoutes(app);
  return app;
}

async function requestJson(app: Hono, url: string, method: string, body?: unknown) {
  const response = await app.fetch(new Request(`http://localhost${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }));

  return {
    status: response.status,
    json: await response.json(),
  };
}

function makeRun(overrides: Partial<{
  id: string;
  title: string;
  prompt: string;
  provider: string;
  model: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  output_md: string;
  target_agent_id: string | null;
  parent_run_id: string | null;
}> = {}) {
  return {
    id: 'run-1',
    title: 'Research task',
    prompt: 'Research task',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    status: 'running' as const,
    output_md: '',
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    error: null,
    target_agent_id: null,
    artifact_id: null,
    parent_run_id: null,
    created_at: '2026-04-09T00:00:00Z',
    finished_at: null,
    ...overrides,
  };
}
