import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  listAgents: vi.fn(),
  getAgent: vi.fn(),
  updateAgentStatus: vi.fn(),
  listRuns: vi.fn(),
  updateTaskStatus: vi.fn(),
  finishRun: vi.fn(),
}));

vi.mock('./config.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('./event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('./notifications.js', () => ({
  notifyAgentCrashed: vi.fn(async () => undefined),
}));

vi.mock('./session-manager.js', () => ({
  capturePane: vi.fn(),
  ensureSpawnedAgentSession: vi.fn(),
}));

vi.mock('./task-dispatcher.js', () => ({
  dispatchNext: vi.fn(),
}));

vi.mock('./tmux.js', () => ({
  hasSession: vi.fn(),
  killSession: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('health-monitor.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    try {
      const monitor = await import('./health-monitor.js');
      monitor.stopHealthMonitor();
    } catch {
      // Ignore cleanup failures for fresh module loads.
    }

    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('restarts crashed spawned agents, requeues runs, and redispatches recovered work', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const events = await import('./event-bus.js');
    const notifications = await import('./notifications.js');
    const sessionManager = await import('./session-manager.js');
    const dispatcher = await import('./task-dispatcher.js');
    const tmux = await import('./tmux.js');

    vi.mocked(config.getConfig).mockReturnValue(makeConfig({
      auto_dispatch: true,
      auto_restart: true,
      hang_timeout_min: 10,
    }));
    vi.mocked(db.listAgents).mockReturnValue([
      makeAgent({ id: 'agent-1', name: 'builder', mode: 'spawned', status: 'working', tmux_session: 'wc-builder' }),
    ]);
    vi.mocked(tmux.hasSession).mockReturnValue(false);
    vi.mocked(db.listRuns).mockReturnValue([
      { id: 'run-1', task_id: 'task-1' },
    ] as never);
    vi.mocked(sessionManager.ensureSpawnedAgentSession).mockReturnValue({
      ok: true,
      data: {
        agent: makeAgent({ id: 'agent-1', name: 'builder', mode: 'spawned', status: 'idle', tmux_session: 'wc-builder' }),
        createdSession: true,
      },
    } as never);

    const monitor = await import('./health-monitor.js');
    monitor.startHealthMonitor();

    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(500);

    expect(db.updateAgentStatus).toHaveBeenCalledWith('agent-1', 'error');
    expect(db.finishRun).toHaveBeenCalledWith('run-1', 1);
    expect(db.updateTaskStatus).toHaveBeenCalledWith('task-1', 'pending');
    expect(sessionManager.ensureSpawnedAgentSession).toHaveBeenCalledWith('agent-1');
    expect(notifications.notifyAgentCrashed).toHaveBeenCalledWith('builder', 'agent-1');
    expect(dispatcher.dispatchNext).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      'agent.crashed',
      'agent',
      'agent-1',
      { name: 'builder', mode: 'spawned', restarting: true },
    );
    expect(events.emit).toHaveBeenCalledWith(
      'run.failed',
      'run',
      'run-1',
      expect.objectContaining({
        agent_id: 'agent-1',
        task_id: 'task-1',
        reason: 'agent_crash_recovery',
      }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'task.retrying',
      'task',
      'task-1',
      expect.objectContaining({
        agent_id: 'agent-1',
        run_id: 'run-1',
        reason: 'agent_crash_recovery',
      }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'agent.restarted',
      'agent',
      'agent-1',
      { name: 'builder' },
    );
  });

  it('marks adopted agents as errored and notifies only once when their session dies', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const events = await import('./event-bus.js');
    const notifications = await import('./notifications.js');
    const sessionManager = await import('./session-manager.js');
    const tmux = await import('./tmux.js');

    let agent = makeAgent({
      id: 'agent-2',
      name: 'legacy-shell',
      mode: 'adopted',
      status: 'working',
      tmux_session: 'legacy-shell',
    });

    vi.mocked(config.getConfig).mockReturnValue(makeConfig({
      auto_dispatch: false,
      auto_restart: true,
      hang_timeout_min: 10,
    }));
    vi.mocked(db.listAgents).mockImplementation(() => [agent] as never);
    vi.mocked(db.updateAgentStatus).mockImplementation((_id, status) => {
      agent = { ...agent, status };
      return { ok: true, data: agent } as never;
    });
    vi.mocked(tmux.hasSession).mockReturnValue(false);

    const monitor = await import('./health-monitor.js');
    monitor.startHealthMonitor();

    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(30000);

    expect(db.updateAgentStatus).toHaveBeenCalledTimes(1);
    expect(db.updateAgentStatus).toHaveBeenCalledWith('agent-2', 'error');
    expect(notifications.notifyAgentCrashed).toHaveBeenCalledTimes(1);
    expect(notifications.notifyAgentCrashed).toHaveBeenCalledWith('legacy-shell', 'agent-2');
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      'agent.crashed',
      'agent',
      'agent-2',
      { name: 'legacy-shell', mode: 'adopted' },
    );
    expect(sessionManager.ensureSpawnedAgentSession).not.toHaveBeenCalled();
  });

  it('kills hung spawned agents and restarts them on the next monitor cycle', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const events = await import('./event-bus.js');
    const notifications = await import('./notifications.js');
    const sessionManager = await import('./session-manager.js');
    const tmux = await import('./tmux.js');

    let sessionAlive = true;
    const agent = makeAgent({
      id: 'agent-3',
      name: 'reviewer',
      mode: 'spawned',
      status: 'working',
      tmux_session: 'wc-reviewer',
    });

    vi.mocked(config.getConfig).mockReturnValue(makeConfig({
      auto_dispatch: false,
      auto_restart: true,
      hang_timeout_min: 0,
    }));
    vi.mocked(db.listAgents).mockReturnValue([agent]);
    vi.mocked(db.listRuns).mockReturnValue([
      { id: 'run-3', task_id: 'task-3' },
    ] as never);
    vi.mocked(tmux.hasSession).mockImplementation(() => sessionAlive);
    vi.mocked(tmux.killSession).mockImplementation(() => {
      sessionAlive = false;
    });
    vi.mocked(sessionManager.capturePane).mockReturnValue({
      ok: true,
      data: 'still working on the same output',
    } as never);
    vi.mocked(sessionManager.ensureSpawnedAgentSession).mockReturnValue({
      ok: true,
      data: {
        agent: makeAgent({ id: 'agent-3', name: 'reviewer', mode: 'spawned', status: 'idle', tmux_session: 'wc-reviewer' }),
        createdSession: true,
      },
    } as never);

    const monitor = await import('./health-monitor.js');
    monitor.startHealthMonitor();

    await vi.advanceTimersByTimeAsync(30000);
    expect(tmux.killSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30000);
    expect(tmux.killSession).toHaveBeenCalledWith('wc-reviewer');
    expect(db.updateAgentStatus).toHaveBeenCalledWith('agent-3', 'error');

    await vi.advanceTimersByTimeAsync(30000);

    expect(sessionManager.ensureSpawnedAgentSession).toHaveBeenCalledWith('agent-3');
    expect(db.finishRun).toHaveBeenCalledWith('run-3', 1);
    expect(db.updateTaskStatus).toHaveBeenCalledWith('task-3', 'pending');
    expect(notifications.notifyAgentCrashed).toHaveBeenCalledWith('reviewer', 'agent-3');
    expect(events.emit).toHaveBeenCalledWith(
      'agent.restarted',
      'agent',
      'agent-3',
      { name: 'reviewer' },
    );
  });

  it('emits hung events for adopted agents without killing or restarting them', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const events = await import('./event-bus.js');
    const notifications = await import('./notifications.js');
    const sessionManager = await import('./session-manager.js');
    const tmux = await import('./tmux.js');

    vi.mocked(config.getConfig).mockReturnValue(makeConfig({
      auto_dispatch: false,
      auto_restart: true,
      hang_timeout_min: 0,
    }));
    vi.mocked(db.listAgents).mockReturnValue([
      makeAgent({
        id: 'agent-4',
        name: 'observer',
        mode: 'adopted',
        status: 'working',
        tmux_session: 'observer-shell',
      }),
    ]);
    vi.mocked(tmux.hasSession).mockReturnValue(true);
    vi.mocked(sessionManager.capturePane).mockReturnValue({
      ok: true,
      data: 'unchanged output',
    } as never);

    const monitor = await import('./health-monitor.js');
    monitor.startHealthMonitor();

    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(30000);

    expect(events.emit).toHaveBeenCalledWith(
      'agent.hung',
      'agent',
      'agent-4',
      { name: 'observer', stale_minutes: 0 },
    );
    expect(notifications.notifyAgentCrashed).not.toHaveBeenCalled();
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(sessionManager.ensureSpawnedAgentSession).not.toHaveBeenCalled();
  });
});

function makeConfig(overrides: {
  auto_dispatch: boolean;
  auto_restart: boolean;
  hang_timeout_min: number;
}) {
  return {
    autonomy: {
      auto_dispatch: overrides.auto_dispatch,
      auto_restart: overrides.auto_restart,
      hang_timeout_min: overrides.hang_timeout_min,
    },
  } as never;
}

function makeAgent(overrides: Partial<{
  id: string;
  name: string;
  runtime: string;
  tmux_session: string;
  workspace: string | null;
  mode: 'spawned' | 'adopted';
  status: 'idle' | 'working' | 'error';
}> = {}) {
  return {
    id: 'agent-1',
    name: 'builder',
    runtime: 'codex',
    tmux_session: 'wc-builder',
    workspace: '/workspace/builder',
    mode: 'spawned' as const,
    status: 'idle' as const,
    created_at: '2026-04-08T00:00:00Z',
    ...overrides,
  };
}
