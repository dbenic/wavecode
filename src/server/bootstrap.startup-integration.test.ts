import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./command-chat.js', () => ({
  ensureChatTable: vi.fn(),
}));

vi.mock('./code-review.js', () => ({
  ensureReviewTable: vi.fn(),
}));

vi.mock('./team-manager.js', () => ({
  ensureTeamTables: vi.fn(),
  startAllCommsWatchers: vi.fn(),
  stopAllCommsWatchers: vi.fn(),
}));

vi.mock('./file-sharing.js', () => ({
  ensureFileSharingTable: vi.fn(),
}));

vi.mock('./notifications.js', () => ({
  getVapidPublicKey: vi.fn(),
}));

vi.mock('./health-monitor.js', () => ({
  startHealthMonitor: vi.fn(),
  stopHealthMonitor: vi.fn(),
}));

vi.mock('./artifact-manager.js', () => ({
  pruneOldArtifacts: vi.fn(),
}));

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
  stopAll: vi.fn(),
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

describe('bootstrap startup recovery integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('recovers interrupted spawned work during bootstrap before health monitoring starts', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const sessionManager = await import('./session-manager.js');
    const outputWatcher = await import('./output-watcher.js');
    const dispatcher = await import('./task-dispatcher.js');
    const tmux = await import('./tmux.js');
    const healthMonitor = await import('./health-monitor.js');
    const events = await import('./event-bus.js');

    vi.mocked(config.getConfig).mockReturnValue({
      autonomy: {
        auto_dispatch: true,
        auto_restart: true,
        hang_timeout_min: 10,
        max_task_retries: 2,
      },
    } as Awaited<ReturnType<typeof config.getConfig>>);

    vi.mocked(db.listAgents).mockReturnValue([makeAgent()]);
    vi.mocked(db.listRuns).mockReturnValue([makeRun()]);
    vi.mocked(db.listTasks).mockReturnValue([]);
    vi.mocked(tmux.hasSession).mockReturnValue(false);
    vi.mocked(sessionManager.ensureSpawnedAgentSession).mockReturnValue({
      ok: true,
      data: {
        agent: {
          ...makeAgent(),
          status: 'idle',
        },
        createdSession: true,
      },
    });

    const bootstrap = await import('./bootstrap.js');
    const result = await bootstrap.bootstrapApplication();
    vi.advanceTimersByTime(500);

    expect(db.finishRun).toHaveBeenCalledWith('run-1', 1);
    expect(db.updateTaskStatus).toHaveBeenCalledWith('task-1', 'pending');
    expect(outputWatcher.startWatching).toHaveBeenCalledWith('agent-1');
    expect(dispatcher.dispatchNext).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith(
      'task.retrying',
      'task',
      'task-1',
      expect.objectContaining({
        startup_reconciled: true,
        reason: 'startup_recovery',
      }),
    );
    expect(healthMonitor.startHealthMonitor).toHaveBeenCalledTimes(1);
    expect(result.startupReconciliation.sessionsRecreated).toBe(1);
    expect(result.startupReconciliation.tasksRequeued).toBe(1);
    expect(result.agentCount).toBe(1);
  });
});

function makeAgent() {
  return {
    id: 'agent-1',
    name: 'builder',
    runtime: 'codex' as const,
    tmux_session: 'wc-builder',
    workspace: null,
    mode: 'spawned' as const,
    status: 'working' as const,
    created_at: '2026-04-04T00:00:00Z',
  };
}

function makeRun() {
  return {
    id: 'run-1',
    task_id: 'task-1',
    agent_id: 'agent-1',
    attempt: 1,
    status: 'running' as const,
    started_at: '2026-04-04T00:00:00Z',
    finished_at: null,
    exit_code: null,
    transcript_path: null,
    review_status: 'pending' as const,
    changed_files: null,
  };
}
