import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  getDb: vi.fn(),
  listTasks: vi.fn(),
  listRuns: vi.fn(),
  getTask: vi.fn(),
  getRun: vi.fn(),
  getAgent: vi.fn(),
  insertAgentMessage: vi.fn(),
  updateTaskStatus: vi.fn(),
  updateAgentStatus: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock('./project-gate.js', () => ({
  maybeInvokeProjectGate: vi.fn(async () => null),
}));

vi.mock('./code-review.js', () => ({
  maybeAutoReview: vi.fn(async () => undefined),
}));

vi.mock('./decision-extractor.js', () => ({
  extractDecisions: vi.fn(async () => []),
}));

vi.mock('./logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('./config.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('./event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('./runner.js', () => ({
  executeRun: vi.fn(),
}));

vi.mock('./session-manager.js', () => ({
  sendKeys: vi.fn(),
}));

describe('task-dispatcher.ts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function setupBaseMocks(autoDispatch: boolean) {
    const db = await import('./db.js');
    const config = await import('./config.js');

    vi.mocked(config.getConfig).mockReturnValue({
      autonomy: {
        auto_dispatch: autoDispatch,
        auto_restart: true,
        hang_timeout_min: 10,
        max_task_retries: 2,
      },
    } as Awaited<ReturnType<typeof config.getConfig>>);

    vi.mocked(db.listAgents).mockReturnValue([
      {
        id: 'agent-1',
        name: 'agent-1',
        runtime: 'codex',
        tmux_session: 'wc-agent-1',
        workspace: null,
        mode: 'spawned',
        status: 'idle',
        created_at: '2026-04-03T00:00:00Z',
      },
    ]);

    vi.mocked(db.listTasks).mockImplementation((filters?: { status?: string; agent_id?: string }) => {
      const task = {
        id: 'task-1',
        agent_id: null,
        prompt: 'Implement auth hardening',
        status: 'pending' as const,
        priority: 1,
        created_at: '2026-04-03T00:00:00Z',
        goal_id: null,
      };

      if (filters?.status === 'pending') {
        return [task];
      }

      return [task];
    });

    vi.mocked(db.getDb).mockReturnValue({
      prepare: (sql: string) => {
        if (sql.includes(`UPDATE tasks SET status = 'running'`)) {
          return { run: () => ({ changes: 1 }) };
        }

        if (sql.includes('SELECT depends_on_id FROM task_dependencies')) {
          return { all: () => [] };
        }

        throw new Error(`Unexpected SQL in test: ${sql}`);
      },
    } as unknown as ReturnType<typeof db.getDb>);
  }

  it('skips automatic dispatch when auto_dispatch is disabled', async () => {
    await setupBaseMocks(false);

    const runner = await import('./runner.js');
    const dispatcher = await import('./task-dispatcher.js');
    dispatcher.resetDispatcherForTest();

    await dispatcher.dispatchNext();
    vi.runAllTimers();

    expect(vi.mocked(runner.executeRun)).not.toHaveBeenCalled();
  });

  it('allows manual dispatch even when auto_dispatch is disabled', async () => {
    await setupBaseMocks(false);

    const runner = await import('./runner.js');
    vi.mocked(runner.executeRun).mockResolvedValue({ id: 'run-1' } as never);

    const dispatcher = await import('./task-dispatcher.js');
    dispatcher.resetDispatcherForTest();

    await dispatcher.dispatchNext({ manual: true });
    vi.runAllTimers();
    await Promise.resolve();

    expect(vi.mocked(runner.executeRun)).toHaveBeenCalledWith(
      'agent-1',
      'task-1',
      'Implement auth hardening',
    );
  });

  it('does not idle the agent when a later run is still running', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');

    vi.mocked(config.getConfig).mockReturnValue({
      autonomy: { auto_dispatch: false, max_task_retries: 2 },
    } as never);
    vi.mocked(db.getRun).mockReturnValue({
      ok: true,
      data: {
        id: '01M0829117QXE7QP6GNG8EPQQT',
        task_id: '01M08290HDW155AYGYXG936AA0',
        agent_id: 'agent-1',
        status: 'done',
      },
    } as never);
    vi.mocked(db.getTask).mockReturnValue({
      ok: true,
      data: {
        id: '01M08290HDW155AYGYXG936AA0',
        prompt: 'Codex review',
        agent_id: 'agent-1',
      },
    } as never);
    vi.mocked(db.listRuns).mockReturnValue([
      { id: '01M089NEWRXN00000000000001', status: 'running' },
    ] as never);
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: { id: 'agent-1', workspace: null },
    } as never);
    vi.mocked(db.getDb).mockReturnValue({
      prepare: () => ({ all: () => [] }),
    } as never);

    const dispatcher = await import('./task-dispatcher.js');
    await dispatcher.onRunComplete('01M0829117QXE7QP6GNG8EPQQT', 'agent-1');

    expect(db.updateTaskStatus).toHaveBeenCalledWith('01M08290HDW155AYGYXG936AA0', 'done');
    expect(db.updateAgentStatus).not.toHaveBeenCalledWith('agent-1', 'idle');
  });
});
