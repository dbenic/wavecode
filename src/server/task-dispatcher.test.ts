import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  getDb: vi.fn(),
  listTasks: vi.fn(),
  listRuns: vi.fn(),
  getTask: vi.fn(),
  getRun: vi.fn(),
  updateTaskStatus: vi.fn(),
  updateAgentStatus: vi.fn(),
  listAgents: vi.fn(),
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
});
