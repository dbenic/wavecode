import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const netHarness = vi.hoisted(() => {
  let connectionHandler: ((connection: {
    on: (event: string, cb: (data: Buffer) => void) => void;
  }) => void) | null = null;

  const listenMock = vi.fn();
  const closeMock = vi.fn();
  const createServerMock = vi.fn((handler: typeof connectionHandler) => {
    connectionHandler = handler;
    return {
      listen: listenMock,
      close: closeMock,
    };
  });

  return {
    createServerMock,
    listenMock,
    closeMock,
    emitData(data: string) {
      if (!connectionHandler) {
        throw new Error('No runner connection handler registered');
      }

      const listeners = new Map<string, Array<(chunk: Buffer) => void>>();
      const connection = {
        on(event: string, cb: (chunk: Buffer) => void) {
          const handlers = listeners.get(event) ?? [];
          handlers.push(cb);
          listeners.set(event, handlers);
        },
      };

      connectionHandler(connection);
      for (const handler of listeners.get('data') ?? []) {
        handler(Buffer.from(data));
      }
    },
    reset() {
      connectionHandler = null;
      createServerMock.mockClear();
      listenMock.mockClear();
      closeMock.mockClear();
    },
  };
});

vi.mock('node:net', () => ({
  default: {
    createServer: netHarness.createServerMock,
  },
  createServer: netHarness.createServerMock,
}));

vi.mock('./db.js', () => ({
  finishRun: vi.fn(),
  insertRun: vi.fn(),
  updateTaskStatus: vi.fn(),
  getAgent: vi.fn(),
  listRuns: vi.fn(),
  updateRunChangedFiles: vi.fn(),
}));

vi.mock('./event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('./config.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('./runtime-launcher.js', () => ({
  getTranscriptsRoot: vi.fn(),
}));

vi.mock('./tmux.js', () => ({
  sendTextAndEnter: vi.fn(),
}));

vi.mock('./task-dispatcher.js', () => ({
  onRunComplete: vi.fn(),
}));

describe('runner.ts', () => {
  const tmpDirs: string[] = [];
  const runnerIds = new Set<string>();

  beforeEach(() => {
    vi.clearAllMocks();
    netHarness.reset();
  });

  afterEach(async () => {
    try {
      const runner = await import('./runner.js');
      for (const runnerId of runnerIds) {
        runner.stopRunner(runnerId);
      }
    } catch {
      // Ignore cleanup failures.
    }

    runnerIds.clear();
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;

    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('builds and sends the runner script for a new run', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const events = await import('./event-bus.js');
    const runtimeLauncher = await import('./runtime-launcher.js');
    const tmux = await import('./tmux.js');

    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-runner-script-'));
    tmpDirs.push(transcriptDir);

    vi.mocked(config.getConfig).mockReturnValue(makeConfig());
    vi.mocked(runtimeLauncher.getTranscriptsRoot).mockReturnValue(transcriptDir);
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: makeAgent({ id: 'agent-script', tmux_session: 'wc-script' }),
    } as never);
    vi.mocked(db.listRuns).mockReturnValue([]);
    vi.mocked(db.insertRun).mockReturnValue({
      ok: true,
      data: makeRun({ id: 'run-script', task_id: 'task-1', agent_id: 'agent-script' }),
    } as never);

    const runner = await import('./runner.js');
    runner.startRunner('agent-script', 'wc-script', 'codex');
    runnerIds.add('agent-script');

    const run = await runner.executeRun('agent-script', 'task-1', "Implement 'auth' middleware");
    const transcriptPath = path.join(transcriptDir, 'run_run-script.log');

    expect(run).toEqual(makeRun({ id: 'run-script', task_id: 'task-1', agent_id: 'agent-script' }));
    expect(db.insertRun).toHaveBeenCalledWith({ task_id: 'task-1', agent_id: 'agent-script', attempt: 1 });
    expect(db.updateTaskStatus).toHaveBeenCalledWith('task-1', 'running');
    expect(events.emit).toHaveBeenCalledWith(
      'run.started',
      'run',
      'run-script',
      expect.objectContaining({
        task_id: 'task-1',
        agent_id: 'agent-script',
        attempt: 1,
      }),
    );
    expect(tmux.sendTextAndEnter).toHaveBeenCalledWith(
      'wc-script',
      expect.stringContaining("echo 'Implement '\\''auth'\\'' middleware' | codex --full-auto;"),
    );
    expect(tmux.sendTextAndEnter).toHaveBeenCalledWith(
      'wc-script',
      expect.stringContaining("nc -U '/tmp/wavecode-runner-agent-script.sock'"),
    );
    await waitForCondition(() => {
      expect(fs.existsSync(transcriptPath)).toBe(true);
    });
  });

  it('processes socket-delivered run.finished events and writes transcripts', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const events = await import('./event-bus.js');
    const runtimeLauncher = await import('./runtime-launcher.js');
    const tmux = await import('./tmux.js');
    const dispatcher = await import('./task-dispatcher.js');

    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-runner-finish-'));
    tmpDirs.push(transcriptDir);

    vi.mocked(config.getConfig).mockReturnValue(makeConfig());
    vi.mocked(runtimeLauncher.getTranscriptsRoot).mockReturnValue(transcriptDir);
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: makeAgent({ id: 'agent-finish', tmux_session: 'wc-finish' }),
    } as never);
    vi.mocked(db.listRuns).mockReturnValue([]);
    vi.mocked(db.insertRun).mockReturnValue({
      ok: true,
      data: makeRun({ id: 'run-finish', task_id: 'task-finish', agent_id: 'agent-finish' }),
    } as never);

    const runner = await import('./runner.js');
    runner.startRunner('agent-finish', 'wc-finish', 'codex');
    runnerIds.add('agent-finish');

    await runner.executeRun('agent-finish', 'task-finish', 'Finish the runner wiring');
    expect(tmux.sendTextAndEnter).toHaveBeenCalled();

    const instance = runner.getRunner('agent-finish');
    expect(instance).toBeDefined();
    if (!instance) return;

    expect(netHarness.listenMock).toHaveBeenCalledWith(instance.socketPath);

    netHarness.emitData(
      '{"type":"run.finished","run_id":"run-finish","exit_code":0,"changed_files":["src/auth.ts"]}\n',
    );

    await waitForCondition(() => {
      expect(db.finishRun).toHaveBeenCalledWith('run-finish', 0);
    });
    await waitForCondition(() => {
      expect(db.updateRunChangedFiles).toHaveBeenCalledWith('run-finish', ['src/auth.ts']);
    });
    await waitForCondition(() => {
      expect(dispatcher.onRunComplete).toHaveBeenCalledWith('run-finish', 'agent-finish');
    });

    expect(events.emit).toHaveBeenCalledWith(
      'run.finished',
      'run',
      'run-finish',
      {
        agent_id: 'agent-finish',
        exit_code: 0,
        changed_files: ['src/auth.ts'],
      },
    );

    const transcriptPath = path.join(transcriptDir, 'run_run-finish.log');
    await waitForCondition(() => {
      expect(fs.existsSync(transcriptPath)).toBe(true);
    });
    expect(fs.readFileSync(transcriptPath, 'utf-8')).toContain('"type":"run.finished"');
  });

  it('marks the run failed when tmux sendTextAndEnter throws', async () => {
    const db = await import('./db.js');
    const config = await import('./config.js');
    const events = await import('./event-bus.js');
    const runtimeLauncher = await import('./runtime-launcher.js');
    const tmux = await import('./tmux.js');

    const transcriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-runner-error-'));
    tmpDirs.push(transcriptDir);

    vi.mocked(config.getConfig).mockReturnValue(makeConfig());
    vi.mocked(runtimeLauncher.getTranscriptsRoot).mockReturnValue(transcriptDir);
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: makeAgent({ id: 'agent-error', tmux_session: 'wc-error' }),
    } as never);
    vi.mocked(db.listRuns).mockReturnValue([]);
    vi.mocked(db.insertRun).mockReturnValue({
      ok: true,
      data: makeRun({ id: 'run-error', task_id: 'task-error', agent_id: 'agent-error' }),
    } as never);
    vi.mocked(tmux.sendTextAndEnter).mockImplementation(() => {
      throw new Error('tmux unavailable');
    });

    const runner = await import('./runner.js');
    runner.startRunner('agent-error', 'wc-error', 'codex');
    runnerIds.add('agent-error');

    const result = await runner.executeRun('agent-error', 'task-error', 'Ship it');
    const transcriptPath = path.join(transcriptDir, 'run_run-error.log');

    expect(result).toBeNull();
    expect(db.finishRun).toHaveBeenCalledWith('run-error', 1);
    expect(db.updateTaskStatus).toHaveBeenNthCalledWith(1, 'task-error', 'running');
    expect(db.updateTaskStatus).toHaveBeenNthCalledWith(2, 'task-error', 'failed');
    expect(events.emit).toHaveBeenCalledWith(
      'run.failed',
      'run',
      'run-error',
      { error: 'tmux unavailable' },
    );
    await waitForCondition(() => {
      expect(fs.existsSync(transcriptPath)).toBe(true);
    });
  });
});

function makeConfig() {
  return {
    runtimes: {
      codex: {
        command: 'codex --full-auto',
        idle_pattern: '^>\\s*$',
      },
    },
  } as never;
}

function makeAgent(overrides: Partial<{
  id: string;
  name: string;
  runtime: string;
  tmux_session: string;
}> = {}) {
  return {
    id: 'agent-1',
    name: 'builder',
    runtime: 'codex',
    tmux_session: 'wc-builder',
    workspace: '/workspace/builder',
    mode: 'spawned' as const,
    status: 'idle' as const,
    created_at: '2026-04-09T00:00:00Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<{
  id: string;
  task_id: string;
  agent_id: string;
}> = {}) {
  return {
    id: 'run-1',
    task_id: 'task-1',
    agent_id: 'agent-1',
    attempt: 1,
    status: 'running' as const,
    started_at: '2026-04-09T00:00:00Z',
    finished_at: null,
    exit_code: null,
    transcript_path: null,
    review_status: 'pending' as const,
    changed_files: null,
    ...overrides,
  };
}

async function waitForCondition(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Condition was not met before timeout');
}
