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

  it('detaches agents through the API and tears down output watchers', async () => {
    const db = await import('./db.js');
    const outputWatcher = await import('./output-watcher.js');
    const events = await import('./event-bus.js');

    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: makeAgent(),
    });

    const { createApp } = await import('./app.js');
    const app = createApp();
    const response = await app.fetch(new Request('http://localhost/api/agents/agent-1', {
      method: 'DELETE',
    }));

    expect(response.status).toBe(200);
    expect(outputWatcher.stopWatching).toHaveBeenCalledWith('agent-1');
    expect(db.deleteAgent).toHaveBeenCalledWith('agent-1');
    expect(events.emit).toHaveBeenCalledWith(
      'agent.detached',
      'agent',
      'agent-1',
      { name: 'builder' },
    );
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
    created_at: '2026-04-04T00:00:00Z',
  };
}
