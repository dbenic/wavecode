import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth.js', async () => {
  const actual = await vi.importActual<typeof import('./auth.js')>('./auth.js');
  return {
    ...actual,
    createAuthMiddleware: () => async (_c: unknown, next: () => Promise<void>) => {
      await next();
    },
  };
});

vi.mock('./routes/system.js', () => ({
  registerSystemRoutes: vi.fn(),
}));

vi.mock('./routes/collaboration.js', () => ({
  registerCollaborationRoutes: vi.fn(),
}));

vi.mock('./routes/tasks.js', () => ({
  registerTaskRoutes: vi.fn(),
}));

vi.mock('./routes/reviews.js', () => ({
  registerReviewRoutes: vi.fn(),
}));

vi.mock('./routes/artifacts.js', () => ({
  registerArtifactRoutes: vi.fn(),
}));

vi.mock('./routes/push.js', () => ({
  registerPushRoutes: vi.fn(),
}));

vi.mock('./db.js', () => ({
  listAgents: vi.fn(),
  getAgent: vi.fn(),
  deleteAgent: vi.fn(),
  updateAgentPin: vi.fn(),
  EFFORT_LEVELS: ['low', 'medium', 'high', 'xhigh'],
  isEffortLevel: (v: unknown) => ['low', 'medium', 'high', 'xhigh'].includes(v as string),
}));

vi.mock('./event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('./session-manager.js', () => ({
  get: vi.fn(),
  scan: vi.fn(),
  adopt: vi.fn(),
  sendKeys: vi.fn(),
  sendRawKeys: vi.fn(),
  capturePaneAnsi: vi.fn(),
  capturePane: vi.fn(),
  getScrollbackSize: vi.fn(),
  capturePaneRange: vi.fn(),
  spawnAgent: vi.fn(),
  kill: vi.fn(),
  detach: vi.fn(),
}));

vi.mock('./output-watcher.js', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  getLastOutputLine: vi.fn(),
  getOutputVersion: vi.fn(),
  isWatching: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('app agent lifecycle routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('lists agents with watcher metadata', async () => {
    const db = await import('./db.js');
    const outputWatcher = await import('./output-watcher.js');

    vi.mocked(db.listAgents).mockReturnValue([makeAgent()]);
    vi.mocked(outputWatcher.getLastOutputLine).mockReturnValue('latest line');
    vi.mocked(outputWatcher.getOutputVersion).mockReturnValue(3);
    vi.mocked(outputWatcher.isWatching).mockReturnValue(true);

    const { createApp } = await import('./app.js');
    const app = createApp();
    const response = await app.fetch(new Request('http://localhost/api/agents'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({
        id: 'agent-1',
        lastOutputLine: 'latest line',
        outputVersion: 3,
        watching: true,
      }),
    ]);
  });

  it('spawns agents through the API and starts watching their output', async () => {
    const sessionManager = await import('./session-manager.js');
    const outputWatcher = await import('./output-watcher.js');
    const events = await import('./event-bus.js');

    vi.mocked(sessionManager.spawnAgent).mockReturnValue({
      ok: true,
      data: makeAgent(),
    });

    const { createApp } = await import('./app.js');
    const app = createApp();
    const response = await app.fetch(new Request('http://localhost/api/agents/spawn', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'builder',
        runtime: 'codex',
      }),
    }));

    expect(response.status).toBe(201);
    expect(sessionManager.spawnAgent).toHaveBeenCalledWith({
      name: 'builder',
      runtime: 'codex',
    });
    expect(outputWatcher.startWatching).toHaveBeenCalledWith('agent-1');
    expect(events.emit).toHaveBeenCalledWith(
      'agent.spawned',
      'agent',
      'agent-1',
      expect.objectContaining({
        name: 'builder',
        runtime: 'codex',
      }),
    );
  });

  it('updates an agent model/effort pin through PATCH', async () => {
    const db = await import('./db.js');
    const sessionManager = await import('./session-manager.js');
    const events = await import('./event-bus.js');

    vi.mocked(sessionManager.get).mockReturnValue({ ok: true, data: makeAgent() });
    vi.mocked(db.updateAgentPin).mockReturnValue({
      ok: true,
      data: { ...makeAgent(), model: 'grok-4.6', effort: 'xhigh' },
    });

    const { createApp } = await import('./app.js');
    const app = createApp();
    const response = await app.fetch(new Request('http://localhost/api/agents/agent-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'grok-4.6', effort: 'xhigh' }),
    }));

    expect(response.status).toBe(200);
    expect(db.updateAgentPin).toHaveBeenCalledWith('agent-1', {
      model: 'grok-4.6',
      effort: 'xhigh',
    });
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ model: 'grok-4.6', effort: 'xhigh' }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'agent.updated',
      'agent',
      'agent-1',
      expect.objectContaining({ model: 'grok-4.6', effort: 'xhigh' }),
    );
  });

  it('rejects PATCH bodies with invalid pins', async () => {
    const db = await import('./db.js');

    const { createApp } = await import('./app.js');
    const app = createApp();

    const badEffort = await app.fetch(new Request('http://localhost/api/agents/agent-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ effort: 'ultra' }),
    }));
    expect(badEffort.status).toBe(400);

    const badModel = await app.fetch(new Request('http://localhost/api/agents/agent-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'x; rm -rf /' }),
    }));
    expect(badModel.status).toBe(400);

    const empty = await app.fetch(new Request('http://localhost/api/agents/agent-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }));
    expect(empty.status).toBe(400);

    expect(db.updateAgentPin).not.toHaveBeenCalled();
  });

  it('detaches agents through the API and tears down output watchers', async () => {
    const db = await import('./db.js');
    const sessionManager = await import('./session-manager.js');
    const outputWatcher = await import('./output-watcher.js');
    const events = await import('./event-bus.js');

    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: makeAgent(),
    });
    vi.mocked(sessionManager.detach).mockReturnValue({ ok: true, data: makeAgent() });

    const { createApp } = await import('./app.js');
    const app = createApp();
    const response = await app.fetch(new Request('http://localhost/api/agents/agent-1', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(200);
    expect(outputWatcher.stopWatching).toHaveBeenCalledWith('agent-1');
    expect(sessionManager.detach).toHaveBeenCalledWith('agent-1');
    expect(events.emit).toHaveBeenCalledWith(
      'agent.detached',
      'agent',
      'agent-1',
      { name: 'builder' },
    );
  });

  it('kills spawned agents through the API', async () => {
    const sessionManager = await import('./session-manager.js');
    const outputWatcher = await import('./output-watcher.js');
    const events = await import('./event-bus.js');

    vi.mocked(sessionManager.get).mockReturnValue({ ok: true, data: makeAgent() });
    vi.mocked(sessionManager.kill).mockReturnValue({ ok: true, data: undefined });

    const { createApp } = await import('./app.js');
    const app = createApp();
    const response = await app.fetch(new Request('http://localhost/api/agents/agent-1/kill', {
      method: 'POST',
    }));

    expect(response.status).toBe(200);
    expect(outputWatcher.stopWatching).toHaveBeenCalledWith('agent-1');
    expect(sessionManager.kill).toHaveBeenCalledWith('agent-1');
    expect(events.emit).toHaveBeenCalledWith(
      'agent.killed',
      'agent',
      'agent-1',
      expect.objectContaining({ name: 'builder' }),
    );
  });

  it('returns 400 when killing an adopted agent', async () => {
    const sessionManager = await import('./session-manager.js');

    vi.mocked(sessionManager.get).mockReturnValue({
      ok: true,
      data: { ...makeAgent(), mode: 'adopted' as const },
    });
    vi.mocked(sessionManager.kill).mockReturnValue({
      ok: false,
      error: 'Cannot kill adopted session. Detach it instead.',
    });

    const { createApp } = await import('./app.js');
    const app = createApp();
    const response = await app.fetch(new Request('http://localhost/api/agents/agent-1/kill', {
      method: 'POST',
    }));

    expect(response.status).toBe(400);
  });
});

function makeAgent() {
  return {
    id: 'agent-1',
    name: 'builder',
    runtime: 'codex' as const,
    tmux_session: 'wc-builder',
    workspace: '/workspace/builder',
    mode: 'spawned' as const,
    status: 'idle' as const,
    model: null,
    effort: null,
    created_at: '2026-04-04T00:00:00Z',
  };
}
