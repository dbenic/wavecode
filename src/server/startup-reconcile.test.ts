import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  listAgents: vi.fn(),
  listRuns: vi.fn(),
  listTasks: vi.fn(),
  finishRun: vi.fn(),
  updateAgentStatus: vi.fn(),
  updateTaskStatus: vi.fn(),
  getAgent: vi.fn(),
}));

vi.mock('./config.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('./event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('./session-manager.js', () => ({
  sendRawKeys: vi.fn(),
  ensureSpawnedAgentSession: vi.fn(),
}));

vi.mock('./output-watcher.js', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
}));

vi.mock('./task-dispatcher.js', () => ({
  dispatchNext: vi.fn(),
}));

vi.mock('./tmux.js', () => ({
  hasSession: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('startup-reconcile.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('requeues in-flight spawned runs, recreates missing sessions, and re-dispatches recovered work', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const tmux = await import('./tmux.js');
    const sessionManager = await import('./session-manager.js');
    const outputWatcher = await import('./output-watcher.js');
    const dispatcher = await import('./task-dispatcher.js');
    const events = await import('./event-bus.js');

    vi.mocked(config.getConfig).mockReturnValue({
      autonomy: {
        auto_dispatch: true,
        auto_restart: true,
        hang_timeout_min: 10,
        max_task_retries: 2,
      },
    } as Awaited<ReturnType<typeof config.getConfig>>);

    vi.mocked(db.listAgents).mockReturnValue([
      {
        id: 'agent-1',
        name: 'builder',
        runtime: 'codex',
        tmux_session: 'wc-builder',
        workspace: null,
        mode: 'spawned',
        status: 'working',
        created_at: '2026-04-03T00:00:00Z',
      },
    ]);

    vi.mocked(db.listRuns).mockReturnValue([
      {
        id: 'run-1',
        task_id: 'task-1',
        agent_id: 'agent-1',
        attempt: 1,
        status: 'running',
        started_at: '2026-04-03T00:00:00Z',
        finished_at: null,
        exit_code: null,
        transcript_path: null,
        review_status: 'pending',
        changed_files: null,
      },
    ]);

    vi.mocked(db.listTasks).mockReturnValue([]);
    vi.mocked(tmux.hasSession).mockReturnValue(false);
    vi.mocked(sessionManager.ensureSpawnedAgentSession).mockReturnValue({
      ok: true,
      data: {
        agent: {
          id: 'agent-1',
          name: 'builder',
          runtime: 'codex',
          tmux_session: 'wc-builder',
          workspace: null,
          mode: 'spawned',
          status: 'idle',
          created_at: '2026-04-03T00:00:00Z',
        },
        createdSession: true,
      },
    });

    const reconcile = await import('./startup-reconcile.js');
    const result = await reconcile.reconcileStartupState();
    vi.runAllTimers();

    expect(db.finishRun).toHaveBeenCalledWith('run-1', 1);
    expect(db.updateTaskStatus).toHaveBeenCalledWith('task-1', 'pending');
    expect(sessionManager.ensureSpawnedAgentSession).toHaveBeenCalledWith('agent-1');
    expect(outputWatcher.startWatching).toHaveBeenCalledWith('agent-1');
    expect(dispatcher.dispatchNext).toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      'task.retrying',
      'task',
      'task-1',
      expect.objectContaining({ startup_reconciled: true, reason: 'startup_recovery' }),
    );
    expect(result.sessionsRecreated).toBe(1);
    expect(result.runsRecovered).toBe(1);
    expect(result.tasksRequeued).toBe(1);
  });

  it('marks adopted agents with missing sessions as errored', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const tmux = await import('./tmux.js');
    const outputWatcher = await import('./output-watcher.js');
    const events = await import('./event-bus.js');

    vi.mocked(config.getConfig).mockReturnValue({
      autonomy: {
        auto_dispatch: false,
        auto_restart: true,
        hang_timeout_min: 10,
        max_task_retries: 2,
      },
    } as Awaited<ReturnType<typeof config.getConfig>>);

    vi.mocked(db.listAgents).mockReturnValue([
      {
        id: 'agent-2',
        name: 'legacy-shell',
        runtime: 'claude-code',
        tmux_session: 'legacy-shell',
        workspace: null,
        mode: 'adopted',
        status: 'idle',
        created_at: '2026-04-03T00:00:00Z',
      },
    ]);

    vi.mocked(db.listRuns).mockReturnValue([]);
    vi.mocked(db.listTasks).mockReturnValue([]);
    vi.mocked(tmux.hasSession).mockReturnValue(false);

    const reconcile = await import('./startup-reconcile.js');
    const result = await reconcile.reconcileStartupState();

    expect(outputWatcher.stopWatching).toHaveBeenCalledWith('agent-2');
    expect(db.updateAgentStatus).toHaveBeenCalledWith('agent-2', 'error');
    expect(events.emit).toHaveBeenCalledWith(
      'agent.crashed',
      'agent',
      'agent-2',
      expect.objectContaining({ startup_reconciled: true }),
    );
    expect(result.adoptedMissingSessions).toBe(1);
  });

  it('repairs orphan running tasks without active runs', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const tmux = await import('./tmux.js');
    const sessionManager = await import('./session-manager.js');
    const outputWatcher = await import('./output-watcher.js');
    const dispatcher = await import('./task-dispatcher.js');
    const events = await import('./event-bus.js');

    vi.mocked(config.getConfig).mockReturnValue({
      autonomy: {
        auto_dispatch: true,
        auto_restart: true,
        hang_timeout_min: 10,
        max_task_retries: 2,
      },
    } as Awaited<ReturnType<typeof config.getConfig>>);

    vi.mocked(db.listAgents).mockReturnValue([
      {
        id: 'agent-3',
        name: 'reviewer',
        runtime: 'aider',
        tmux_session: 'wc-reviewer',
        workspace: null,
        mode: 'spawned',
        status: 'idle',
        created_at: '2026-04-03T00:00:00Z',
      },
    ]);

    vi.mocked(db.listRuns).mockReturnValue([]);
    vi.mocked(db.listTasks).mockReturnValue([
      {
        id: 'task-9',
        agent_id: 'agent-3',
        prompt: 'Recover me',
        status: 'running',
        priority: 0,
        created_at: '2026-04-03T00:00:00Z',
      },
    ]);
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: {
        id: 'agent-3',
        name: 'reviewer',
        runtime: 'aider',
        tmux_session: 'wc-reviewer',
        workspace: null,
        mode: 'spawned',
        status: 'idle',
        created_at: '2026-04-03T00:00:00Z',
      },
    });
    vi.mocked(tmux.hasSession).mockReturnValue(true);
    vi.mocked(sessionManager.ensureSpawnedAgentSession).mockReturnValue({
      ok: true,
      data: {
        agent: {
          id: 'agent-3',
          name: 'reviewer',
          runtime: 'aider',
          tmux_session: 'wc-reviewer',
          workspace: null,
          mode: 'spawned',
          status: 'idle',
          created_at: '2026-04-03T00:00:00Z',
        },
        createdSession: false,
      },
    });

    const reconcile = await import('./startup-reconcile.js');
    const result = await reconcile.reconcileStartupState();
    vi.runAllTimers();

    expect(sessionManager.ensureSpawnedAgentSession).toHaveBeenCalledWith('agent-3');
    expect(outputWatcher.startWatching).toHaveBeenCalledWith('agent-3');
    expect(db.updateTaskStatus).toHaveBeenCalledWith('task-9', 'pending');
    expect(dispatcher.dispatchNext).toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith(
      'task.retrying',
      'task',
      'task-9',
      expect.objectContaining({ reason: 'orphan_running_task' }),
    );
    expect(result.orphanRunningTasksRequeued).toBe(1);
  });
});
