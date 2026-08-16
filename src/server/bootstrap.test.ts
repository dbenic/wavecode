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

vi.mock('./output-watcher.js', () => ({
  stopAll: vi.fn(),
}));

vi.mock('./health-monitor.js', () => ({
  startHealthMonitor: vi.fn(),
  stopHealthMonitor: vi.fn(),
}));

vi.mock('./artifact-manager.js', () => ({
  pruneOldArtifacts: vi.fn(),
}));

vi.mock('./startup-reconcile.js', () => ({
  reconcileStartupState: vi.fn(),
}));

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({
    autonomy: { auto_dispatch: true },
  })),
}));

vi.mock('./task-dispatcher.js', () => ({
  dispatchNext: vi.fn(),
}));

describe('bootstrap.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('initializes background services and returns startup summary', async () => {
    const db = await import('./db.js');
    const commandChat = await import('./command-chat.js');
    const codeReview = await import('./code-review.js');
    const teamManager = await import('./team-manager.js');
    const fileSharing = await import('./file-sharing.js');
    const notifications = await import('./notifications.js');
    const healthMonitor = await import('./health-monitor.js');
    const reconcile = await import('./startup-reconcile.js');

    vi.spyOn(db, 'listAgents').mockReturnValue([
      {
        id: 'agent-1',
        name: 'builder',
        runtime: 'codex',
        tmux_session: 'wc-builder',
        workspace: null,
        mode: 'spawned',
        status: 'idle',
        created_at: '2026-04-03T00:00:00Z',
      },
    ]);

    vi.mocked(reconcile.reconcileStartupState).mockResolvedValue({
      agentsChecked: 1,
      sessionsRecreated: 0,
      sessionsInterrupted: 0,
      adoptedMissingSessions: 0,
      runsRecovered: 0,
      tasksRequeued: 0,
      tasksFailed: 0,
      orphanRunningTasksRequeued: 0,
      orphanRunningTasksFailed: 0,
      agentResumeFailures: 0,
    });

    const bootstrap = await import('./bootstrap.js');
    const result = await bootstrap.bootstrapApplication();

    expect(commandChat.ensureChatTable).toHaveBeenCalledTimes(1);
    expect(codeReview.ensureReviewTable).toHaveBeenCalledTimes(1);
    expect(teamManager.ensureTeamTables).toHaveBeenCalledTimes(1);
    expect(fileSharing.ensureFileSharingTable).toHaveBeenCalledTimes(1);
    expect(teamManager.startAllCommsWatchers).toHaveBeenCalledTimes(1);
    expect(notifications.getVapidPublicKey).toHaveBeenCalledTimes(1);
    expect(healthMonitor.startHealthMonitor).toHaveBeenCalledTimes(1);
    expect(result.agentCount).toBe(1);
    expect(result.startupReconciliation.agentsChecked).toBe(1);

    bootstrap.shutdownApplication();
  });

  it('schedules artifact pruning and clears services on shutdown', async () => {
    const artifactManager = await import('./artifact-manager.js');
    const healthMonitor = await import('./health-monitor.js');
    const outputWatcher = await import('./output-watcher.js');
    const teamManager = await import('./team-manager.js');
    const reconcile = await import('./startup-reconcile.js');
    const db = await import('./db.js');

    vi.spyOn(db, 'listAgents').mockReturnValue([]);
    vi.mocked(reconcile.reconcileStartupState).mockResolvedValue({
      agentsChecked: 0,
      sessionsRecreated: 0,
      sessionsInterrupted: 0,
      adoptedMissingSessions: 0,
      runsRecovered: 0,
      tasksRequeued: 0,
      tasksFailed: 0,
      orphanRunningTasksRequeued: 0,
      orphanRunningTasksFailed: 0,
      agentResumeFailures: 0,
    });
    vi.mocked(artifactManager.pruneOldArtifacts).mockReturnValue(2);

    const bootstrap = await import('./bootstrap.js');
    await bootstrap.bootstrapApplication();

    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(artifactManager.pruneOldArtifacts).toHaveBeenCalledTimes(1);

    bootstrap.shutdownApplication();

    expect(healthMonitor.stopHealthMonitor).toHaveBeenCalled();
    expect(outputWatcher.stopAll).toHaveBeenCalled();
    expect(teamManager.stopAllCommsWatchers).toHaveBeenCalled();
  });

  it('polls dispatchNext so out-of-band pending tasks are not stuck', async () => {
    const dispatcher = await import('./task-dispatcher.js');
    const reconcile = await import('./startup-reconcile.js');
    const db = await import('./db.js');
    const { DISPATCH_POLL_MS } = await import('./bootstrap.js');

    vi.spyOn(db, 'listAgents').mockReturnValue([]);
    vi.mocked(reconcile.reconcileStartupState).mockResolvedValue({
      agentsChecked: 0,
      sessionsRecreated: 0,
      sessionsInterrupted: 0,
      adoptedMissingSessions: 0,
      runsRecovered: 0,
      tasksRequeued: 0,
      tasksFailed: 0,
      orphanRunningTasksRequeued: 0,
      orphanRunningTasksFailed: 0,
      agentResumeFailures: 0,
    });

    const bootstrap = await import('./bootstrap.js');
    await bootstrap.bootstrapApplication();

    vi.mocked(dispatcher.dispatchNext).mockClear();
    vi.advanceTimersByTime(DISPATCH_POLL_MS);
    expect(dispatcher.dispatchNext).toHaveBeenCalledTimes(1);

    bootstrap.shutdownApplication();
  });
});
