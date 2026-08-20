import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  getDb: vi.fn(),
  listTasks: vi.fn(),
  listRuns: vi.fn(),
  listOpenRuns: vi.fn(() => []),
  hasOpenRun: vi.fn(() => false),
  finishRun: vi.fn(),
  insertRun: vi.fn(),
  updateRunResultPath: vi.fn(),
  reconcileFailedRunToPass: vi.fn(),
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
    const dispatcher = await import('./task-dispatcher.js');
    dispatcher.resetLatePassReconcileForTest();
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
    vi.mocked(runner.executeRun).mockResolvedValue({ ok: true, data: { id: 'run-1' } } as never);

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
    vi.mocked(db.listOpenRuns).mockReturnValue([
      { id: '01M089NEWRXN00000000000001', status: 'running', finished_at: null },
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

  it('refuses dispatch when the agent already has an open run', async () => {
    await setupBaseMocks(true);
    const db = await import('./db.js');
    const runner = await import('./runner.js');

    vi.mocked(db.hasOpenRun).mockReturnValue(true);
    vi.mocked(db.listOpenRuns).mockReturnValue([
      { id: '01M0829117QXE7QP6GNG8EPQQT', task_id: 'task-old', status: 'running', finished_at: null },
    ] as never);

    const dispatcher = await import('./task-dispatcher.js');
    dispatcher.resetDispatcherForTest();
    await dispatcher.dispatchNext({ manual: true });
    vi.runAllTimers();

    expect(vi.mocked(runner.executeRun)).not.toHaveBeenCalled();
  });

  it('finalizeRun writes FAIL and does not invent PASS when the result file is missing', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const db = await import('./db.js');
    const events = await import('./event-bus.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-finalize-'));
    const resultPath = path.join(dir, 'result.txt');
    vi.mocked(db.getRun).mockReturnValue({
      ok: true,
      data: {
        id: 'run-1',
        task_id: 'task-1',
        agent_id: 'agent-1',
        result_path: resultPath,
        status: 'running',
        finished_at: null,
      },
    } as never);
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: { id: 'agent-1', workspace: dir, mode: 'spawned' },
    } as never);
    vi.mocked(db.getTask).mockReturnValue({
      ok: true,
      data: { id: 'task-1', status: 'running', prompt: 'Review', agent_id: 'agent-1' },
    } as never);
    vi.mocked(db.listOpenRuns).mockReturnValue([]);
    vi.mocked(db.listRuns).mockReturnValue([{ id: 'run-1' }] as never);
    vi.mocked(db.finishRun).mockImplementation((id: string, exit: number) => {
      const data = {
        id,
        task_id: 'task-1',
        agent_id: 'agent-1',
        status: exit === 0 ? 'done' : 'failed',
        exit_code: exit,
        result_path: resultPath,
      };
      vi.mocked(db.getRun).mockReturnValue({ ok: true, data } as never);
      return { ok: true, data } as never;
    });
    vi.mocked(db.getDb).mockReturnValue({
      prepare: () => ({ all: () => [] }),
    } as never);
    vi.mocked((await import('./config.js')).getConfig).mockReturnValue({
      autonomy: { auto_dispatch: false, max_task_retries: 2 },
    } as never);

    const dispatcher = await import('./task-dispatcher.js');
    const finished = dispatcher.finalizeRun(
      'run-1',
      'agent-1',
      0,
      'Idle close without a parseable RESULT file',
    );

    expect(finished.ok).toBe(true);
    expect(db.finishRun).toHaveBeenCalledWith('run-1', 1);
    expect(fs.readFileSync(resultPath, 'utf8').trim().split('\n').at(-1)).toBe('RESULT: FAIL');
    expect(events.emit).toHaveBeenCalledWith(
      'run.failed',
      'run',
      'run-1',
      expect.objectContaining({ exit_code: 1, result: 'FAIL' }),
    );
    await Promise.resolve();
    expect(db.updateTaskStatus).toHaveBeenCalledWith('task-1', 'failed');
    expect(db.updateTaskStatus).not.toHaveBeenCalledWith('task-1', 'pending');
    expect(events.emit).toHaveBeenCalledWith(
      'task.failed',
      'task',
      'task-1',
      expect.objectContaining({ reason: 'spawned_result_not_pass', result: 'FAIL' }),
    );
    expect(events.emit).not.toHaveBeenCalledWith(
      'task.retrying',
      'task',
      'task-1',
      expect.anything(),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finalizeRun keeps an existing PASS file (idle-close does not invent FAIL over PASS)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const db = await import('./db.js');
    const events = await import('./event-bus.js');
    const { writeRunResult, RESULT_PASS_LINE } = await import('./run-result.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-finalize-pass-'));
    const resultPath = path.join(dir, 'result.txt');
    writeRunResult(resultPath, 'PASS', 'All checks green');
    vi.mocked(db.getRun).mockReturnValue({
      ok: true,
      data: {
        id: 'run-pass',
        task_id: 'task-pass',
        agent_id: 'agent-1',
        result_path: resultPath,
        status: 'running',
        finished_at: null,
      },
    } as never);
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: { id: 'agent-1', workspace: dir, mode: 'spawned' },
    } as never);
    vi.mocked(db.getTask).mockReturnValue({
      ok: true,
      data: { id: 'task-pass', status: 'running', prompt: 'Review', agent_id: 'agent-1' },
    } as never);
    vi.mocked(db.listOpenRuns).mockReturnValue([]);
    vi.mocked(db.listRuns).mockReturnValue([{ id: 'run-pass' }] as never);
    vi.mocked(db.insertAgentMessage).mockReturnValue({ ok: true, data: { id: 'msg-1' } } as never);
    vi.mocked(db.finishRun).mockImplementation((id: string, exit: number) => {
      const data = {
        id,
        task_id: 'task-pass',
        agent_id: 'agent-1',
        status: exit === 0 ? 'done' : 'failed',
        exit_code: exit,
        result_path: resultPath,
      };
      vi.mocked(db.getRun).mockReturnValue({ ok: true, data } as never);
      return { ok: true, data } as never;
    });
    vi.mocked(db.getDb).mockReturnValue({
      prepare: () => ({ all: () => [] }),
    } as never);
    vi.mocked((await import('./config.js')).getConfig).mockReturnValue({
      autonomy: { auto_dispatch: false, max_task_retries: 2 },
    } as never);

    const dispatcher = await import('./task-dispatcher.js');
    const finished = dispatcher.finalizeRun(
      'run-pass',
      'agent-1',
      0,
      'Idle close without a parseable RESULT file',
    );

    expect(finished.ok).toBe(true);
    expect(db.finishRun).toHaveBeenCalledWith('run-pass', 0);
    expect(fs.readFileSync(resultPath, 'utf8').trim().split('\n').at(-1)).toBe(RESULT_PASS_LINE);
    expect(fs.readFileSync(resultPath, 'utf8')).not.toContain('Idle close without a parseable RESULT file');
    expect(events.emit).toHaveBeenCalledWith(
      'run.finished',
      'run',
      'run-pass',
      expect.objectContaining({ exit_code: 0, result: 'PASS' }),
    );
    await Promise.resolve();
    expect(db.updateTaskStatus).toHaveBeenCalledWith('task-pass', 'done');
    expect(events.emit).not.toHaveBeenCalledWith(
      'task.retrying',
      'task',
      'task-pass',
      expect.anything(),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reconciles idle-close FAIL when a parseable PASS file appears later', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const db = await import('./db.js');
    const events = await import('./event-bus.js');
    const { writeRunResult, RESULT_PASS_LINE } = await import('./run-result.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-late-pass-'));
    const resultPath = path.join(dir, 'result.txt');
    const failedRun = {
      id: 'run-late',
      task_id: 'task-late',
      agent_id: 'agent-1',
      status: 'failed',
      exit_code: 1,
      result_path: resultPath,
      review_status: 'pending',
    };
    vi.mocked(db.getRun).mockReturnValue({
      ok: true,
      data: {
        ...failedRun,
        status: 'running',
        finished_at: null,
        exit_code: null,
      },
    } as never);
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: { id: 'agent-1', workspace: dir, mode: 'spawned' },
    } as never);
    vi.mocked(db.getTask).mockReturnValue({
      ok: true,
      data: { id: 'task-late', status: 'running', prompt: 'Review', agent_id: 'agent-1' },
    } as never);
    vi.mocked(db.listOpenRuns).mockReturnValue([]);
    vi.mocked(db.listRuns).mockReturnValue([{ id: 'run-late' }] as never);
    vi.mocked(db.getDb).mockReturnValue({
      prepare: () => ({ all: () => [] }),
    } as never);
    vi.mocked(db.finishRun).mockImplementation((id: string, exit: number) => {
      const data = { ...failedRun, id, status: exit === 0 ? 'done' : 'failed', exit_code: exit };
      vi.mocked(db.getRun).mockReturnValue({ ok: true, data } as never);
      return { ok: true, data } as never;
    });
    vi.mocked(db.reconcileFailedRunToPass).mockImplementation((id: string) => {
      const data = { ...failedRun, id, status: 'done', exit_code: 0 };
      vi.mocked(db.getRun).mockReturnValue({ ok: true, data } as never);
      return { ok: true, data } as never;
    });
    vi.mocked((await import('./config.js')).getConfig).mockReturnValue({
      autonomy: { auto_dispatch: false, max_task_retries: 2 },
    } as never);

    const dispatcher = await import('./task-dispatcher.js');
    dispatcher.finalizeRun(
      'run-late',
      'agent-1',
      0,
      'Idle close without a parseable RESULT file',
    );
    expect(db.finishRun).toHaveBeenCalledWith('run-late', 1);
    expect(fs.readFileSync(resultPath, 'utf8').trim().split('\n').at(-1)).toBe('RESULT: FAIL');

    await Promise.resolve();
    vi.mocked(db.getTask).mockReturnValue({
      ok: true,
      data: { id: 'task-late', status: 'failed', prompt: 'Review', agent_id: 'agent-1' },
    } as never);

    writeRunResult(resultPath, 'PASS', 'Reviewed auth.ts; no issues');
    expect(fs.readFileSync(resultPath, 'utf8').trim().split('\n').at(-1)).toBe(RESULT_PASS_LINE);

    vi.advanceTimersByTime(1000);
    await Promise.resolve();

    expect(db.reconcileFailedRunToPass).toHaveBeenCalledWith('run-late');
    expect(db.updateTaskStatus).toHaveBeenCalledWith('task-late', 'done');
    expect(db.updateTaskStatus).not.toHaveBeenCalledWith('task-late', 'pending');
    expect(events.emit).toHaveBeenCalledWith(
      'run.finished',
      'run',
      'run-late',
      expect.objectContaining({ exit_code: 0, result: 'PASS', late_pass: true }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'task.completed',
      'task',
      'task-late',
      expect.objectContaining({ late_pass: true }),
    );
    expect(events.emit).not.toHaveBeenCalledWith(
      'task.retrying',
      'task',
      'task-late',
      expect.anything(),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reconcileLatePass leaves idle-close FAIL when the file is still missing or unparseable', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const db = await import('./db.js');
    const events = await import('./event-bus.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-late-miss-'));
    const resultPath = path.join(dir, 'result.txt');
    const failedRun = {
      id: 'run-miss',
      task_id: 'task-miss',
      agent_id: 'agent-1',
      status: 'failed' as const,
      exit_code: 1,
      result_path: resultPath,
      review_status: 'pending' as const,
    };
    vi.mocked(db.getRun).mockReturnValue({ ok: true, data: failedRun } as never);
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: { id: 'agent-1', workspace: dir, mode: 'spawned' },
    } as never);
    vi.mocked(db.getTask).mockReturnValue({
      ok: true,
      data: { id: 'task-miss', status: 'failed', prompt: 'Review', agent_id: 'agent-1' },
    } as never);

    const dispatcher = await import('./task-dispatcher.js');
    const missing = dispatcher.reconcileLatePass('run-miss');
    expect(missing.ok && missing.data.reconciled).toBe(false);
    expect(db.reconcileFailedRunToPass).not.toHaveBeenCalled();
    expect(db.updateTaskStatus).not.toHaveBeenCalledWith('task-miss', 'done');

    fs.writeFileSync(
      resultPath,
      'Your code was reviewed by another AI model. Here are the issues found.\nRESULT: PASS lint=PASS\n',
      'utf8',
    );
    const fromPane = dispatcher.reconcileLatePass('run-miss');
    expect(fromPane.ok && fromPane.data.reconciled).toBe(false);
    expect(db.reconcileFailedRunToPass).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalledWith(
      'run.finished',
      'run',
      'run-miss',
      expect.anything(),
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('auto-retries an adopted failed run within the retry budget', async () => {
    const db = await import('./db.js');
    const events = await import('./event-bus.js');

    vi.mocked((await import('./config.js')).getConfig).mockReturnValue({
      autonomy: { auto_dispatch: false, max_task_retries: 2 },
    } as never);
    vi.mocked(db.getRun).mockReturnValue({
      ok: true,
      data: {
        id: 'run-adopted',
        task_id: 'task-adopted',
        agent_id: 'agent-adopted',
        status: 'failed',
        result_path: null,
      },
    } as never);
    vi.mocked(db.getTask).mockReturnValue({
      ok: true,
      data: { id: 'task-adopted', status: 'running', prompt: 'Review', agent_id: 'agent-adopted' },
    } as never);
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: { id: 'agent-adopted', workspace: null, mode: 'adopted' },
    } as never);
    vi.mocked(db.listOpenRuns).mockReturnValue([]);
    vi.mocked(db.listRuns).mockReturnValue([{ id: 'run-adopted' }] as never);
    vi.mocked(db.getDb).mockReturnValue({
      prepare: () => ({ all: () => [] }),
    } as never);

    const dispatcher = await import('./task-dispatcher.js');
    await dispatcher.onRunComplete('run-adopted', 'agent-adopted');

    expect(db.updateTaskStatus).toHaveBeenCalledWith('task-adopted', 'pending');
    expect(events.emit).toHaveBeenCalledWith(
      'task.retrying',
      'task',
      'task-adopted',
      expect.objectContaining({ attempt: 2, max: 2 }),
    );
  });
});
