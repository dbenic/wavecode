import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

vi.mock('./db.js', () => ({
  finishRun: vi.fn(),
  getAgent: vi.fn(),
  getRun: vi.fn(),
  insertRun: vi.fn(),
  listOpenRuns: vi.fn(() => []),
  listRuns: vi.fn(() => []),
  updateTaskStatus: vi.fn(),
}));

vi.mock('./event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('./task-dispatcher.js', () => ({
  onRunComplete: vi.fn(),
  finalizeRun: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const configHarness = vi.hoisted(() => ({
  transcriptsRoot: '',
}));

vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({
    paths: { transcripts_root: configHarness.transcriptsRoot },
  })),
}));

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    this.signalCode = signal ?? 'SIGTERM';
    this.exitCode = 1;
    return true;
  });
}

describe('file-runner.ts', () => {
  const tmpDirs: string[] = [];

  beforeEach(async () => {
    vi.clearAllMocks();
    const { resetFileRunnerForTest } = await import('./file-runner.js');
    resetFileRunnerForTest();
  });

  afterEach(async () => {
    const { resetFileRunnerForTest } = await import('./file-runner.js');
    resetFileRunnerForTest();
    vi.useRealTimers();
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-file-runner-'));
    tmpDirs.push(dir);
    return dir;
  }

  async function setupRun(overrides: {
    model?: string | null;
    prompt?: string;
    child?: FakeChild;
    resultPath?: string;
    hooks?: {
      listProcessGroupPids?: () => number[];
      listWorktreePids?: () => number[];
      processTreePollMs?: number;
      processTreeTimeoutMs?: number;
    };
  } = {}) {
    const db = await import('./db.js');
    const fileRunner = await import('./file-runner.js');
    const workspace = tmpDir();
    configHarness.transcriptsRoot = path.join(workspace, 'transcripts');
    const runDir = path.join(workspace, 'runs', 'run-file');
    const resultPath = overrides.resultPath ?? path.join(runDir, 'result.txt');
    const child = overrides.child ?? new FakeChild();

    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: {
        id: 'agent-file',
        name: 'opus-file',
        runtime: 'claude-code',
        tmux_session: 'file:opus-file',
        workspace,
        mode: 'file',
        status: 'idle',
        model: overrides.model ?? 'opus',
        effort: null,
        created_at: '2026-08-23T00:00:00Z',
      },
    } as never);
    vi.mocked(db.listOpenRuns).mockReturnValue([]);
    vi.mocked(db.listRuns).mockReturnValue([]);
    vi.mocked(db.insertRun).mockReturnValue({
      ok: true,
      data: {
        id: 'run-file',
        task_id: 'task-1',
        agent_id: 'agent-file',
        attempt: 1,
        status: 'running',
        started_at: '2026-08-23T00:00:00Z',
        finished_at: null,
        exit_code: null,
        transcript_path: null,
        review_status: 'pending',
        result_path: resultPath,
      },
    } as never);
    vi.mocked(db.getRun).mockReturnValue({
      ok: true,
      data: {
        id: 'run-file',
        task_id: 'task-1',
        agent_id: 'agent-file',
        status: 'running',
        result_path: resultPath,
      },
    } as never);

    const spawn = vi.fn(() => child as unknown as ChildProcess);
    fileRunner.setFileRunnerTestHooks({
      spawn,
      heartbeatMs: 15_000,
      staleMs: 120_000,
      listProcessGroupPids: () => [],
      listWorktreePids: () => [],
      processTreePollMs: 5,
      processTreeTimeoutMs: 50,
      ...overrides.hooks,
    });

    const run = await fileRunner.executeFileRun(
      'agent-file',
      'task-1',
      overrides.prompt ?? 'Add /incoming webhook',
    );

    return { db, fileRunner, workspace, resultPath, child, spawn, run };
  }

  it('writes prompt.md with the task and RESULT briefing, then starts claude -p in the worktree', async () => {
    const { fileRunner, workspace, resultPath, spawn, run, child } = await setupRun({
      model: 'opus',
    });

    expect(run.ok).toBe(true);
    const promptPath = fileRunner.promptPathFor('run-file');
    const prompt = fs.readFileSync(promptPath, 'utf8');
    expect(prompt).toContain('Add /incoming webhook');
    expect(prompt).toContain(resultPath);
    expect(prompt).toContain('RESULT: PASS');
    expect(prompt).toContain('RESULT: FAIL');

    expect(spawn).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = spawn.mock.calls[0];
    expect(bin).toBe('claude');
    expect(args[0]).toBe('-p');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--model');
    expect(args).toContain('opus');
    expect(args.at(-1)).toContain('Add /incoming webhook');
    expect(opts).toEqual(expect.objectContaining({ cwd: workspace, detached: true }));
    expect(opts.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(child.pid).toBe(4242);
  });

  it('records queued → starting → running phases and never touches send-keys', async () => {
    const events = await import('./event-bus.js');
    const dispatcher = await import('./task-dispatcher.js');
    const { fileRunner, child } = await setupRun();

    const status = fileRunner.readFileRunStatus('run-file');
    expect(status?.phase).toBe('running');
    expect(status?.pid).toBe(4242);

    const phases = vi.mocked(events.emit).mock.calls
      .filter((call) => call[0] === 'run.phase')
      .map((call) => (call[3] as { phase: string }).phase);
    expect(phases).toEqual(['queued', 'starting', 'running']);

    expect(dispatcher.finalizeRun).not.toHaveBeenCalled();
    child.stdout.emit('data', Buffer.from('thinking about the webhook\n'));
    expect(fileRunner.readFileRunStatus('run-file')?.last_line).toBe('thinking about the webhook');
  });

  it('honors a parseable RESULT: PASS file on process exit and ignores stdout', async () => {
    const { writeRunResult } = await import('./run-result.js');
    const events = await import('./event-bus.js');
    const dispatcher = await import('./task-dispatcher.js');
    const { db, fileRunner, resultPath, child } = await setupRun();

    child.stdout.emit('data', Buffer.from('RESULT: PASS printed only to the terminal\n'));
    writeRunResult(resultPath, 'PASS', 'Webhook added');
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await vi.waitFor(() => {
      expect(dispatcher.onRunComplete).toHaveBeenCalledWith('run-file', 'agent-file');
    });

    expect(db.finishRun).toHaveBeenCalledWith('run-file', 0);
    expect(fileRunner.readFileRunStatus('run-file')?.phase).toBe('done');
    expect(events.emit).toHaveBeenCalledWith(
      'run.finished',
      'run',
      'run-file',
      expect.objectContaining({ result: 'PASS', phase: 'done' }),
    );
    expect(dispatcher.onRunComplete).toHaveBeenCalledWith('run-file', 'agent-file');
    expect(dispatcher.finalizeRun).not.toHaveBeenCalled();
    expect(fs.readFileSync(fileRunner.cliLogPathFor('run-file'), 'utf8')).toContain(
      'RESULT: PASS printed only to the terminal',
    );
  });

  it('treats missing result.txt after Claude exit 0 as incomplete, not a product FAIL', async () => {
    const events = await import('./event-bus.js');
    const { RESULT_FAIL_LINE } = await import('./run-result.js');
    const { db, fileRunner, resultPath, child } = await setupRun();

    child.stdout.emit('data', Buffer.from('I am done, trust the pane\n'));
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await vi.waitFor(() => {
      expect(db.finishRun).toHaveBeenCalledWith('run-file', 1);
    });

    expect(fileRunner.readFileRunStatus('run-file')?.phase).toBe('incomplete');
    expect(fileRunner.readFileRunStatus('run-file')?.reason).toMatch(/without a parseable RESULT/i);
    expect(fs.existsSync(resultPath)).toBe(false);
    expect(events.emit).toHaveBeenCalledWith(
      'run.failed',
      'run',
      'run-file',
      expect.objectContaining({ result: null, phase: 'incomplete' }),
    );
    if (fs.existsSync(resultPath)) {
      expect(fs.readFileSync(resultPath, 'utf8')).not.toContain(RESULT_FAIL_LINE);
    }
  });

  it('counts an exact RESULT: PASS printed on cli.log when result.txt is missing', async () => {
    const events = await import('./event-bus.js');
    const { RESULT_PASS_LINE } = await import('./run-result.js');
    const { db, fileRunner, resultPath, child } = await setupRun();

    child.stdout.emit('data', Buffer.from('Suite finished\nRESULT: PASS\nmore chatter\n'));
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await vi.waitFor(() => {
      expect(db.finishRun).toHaveBeenCalledWith('run-file', 0);
    });

    expect(fileRunner.readFileRunStatus('run-file')?.phase).toBe('done');
    expect(fs.readFileSync(resultPath, 'utf8').trim().split('\n').at(-1)).toBe(RESULT_PASS_LINE);
    expect(events.emit).toHaveBeenCalledWith(
      'run.finished',
      'run',
      'run-file',
      expect.objectContaining({ result: 'PASS', phase: 'done' }),
    );
  });

  it('fails the task when Claude prints RESULT: FAIL on cli.log', async () => {
    const { RESULT_FAIL_LINE } = await import('./run-result.js');
    const events = await import('./event-bus.js');
    const { db, fileRunner, resultPath, child } = await setupRun();

    child.stdout.emit('data', Buffer.from('API suite failed\nRESULT: FAIL\n'));
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await vi.waitFor(() => {
      expect(db.finishRun).toHaveBeenCalledWith('run-file', 1);
    });

    expect(fileRunner.readFileRunStatus('run-file')?.phase).toBe('failed');
    expect(fs.readFileSync(resultPath, 'utf8').trim().split('\n').at(-1)).toBe(RESULT_FAIL_LINE);
    expect(events.emit).toHaveBeenCalledWith(
      'run.failed',
      'run',
      'run-file',
      expect.objectContaining({ result: 'FAIL', phase: 'failed' }),
    );
  });

  it('lets an agent-written result.txt win over a conflicting RESULT line in stdout', async () => {
    const { writeRunResult, RESULT_FAIL_LINE } = await import('./run-result.js');
    const events = await import('./event-bus.js');
    const { db, fileRunner, resultPath, child } = await setupRun();

    child.stdout.emit('data', Buffer.from('Suite finished\nRESULT: PASS\n'));
    writeRunResult(resultPath, 'FAIL', 'API suite failed');
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await vi.waitFor(() => {
      expect(db.finishRun).toHaveBeenCalledWith('run-file', 1);
    });

    expect(fileRunner.readFileRunStatus('run-file')?.phase).toBe('failed');
    expect(fs.readFileSync(resultPath, 'utf8').trim().split('\n').at(-1)).toBe(RESULT_FAIL_LINE);
    expect(fs.readFileSync(resultPath, 'utf8')).toContain('API suite failed');
    expect(events.emit).toHaveBeenCalledWith(
      'run.failed',
      'run',
      'run-file',
      expect.objectContaining({ result: 'FAIL', phase: 'failed' }),
    );
  });

  it('does not finalize while Claude descendant processes are still running', async () => {
    const { writeRunResult } = await import('./run-result.js');
    const { db, fileRunner, resultPath, child } = await setupRun();
    let remaining = [9999];
    fileRunner.setFileRunnerTestHooks({
      listProcessGroupPids: () => remaining,
      listWorktreePids: () => [],
      processTreePollMs: 10,
      processTreeTimeoutMs: 2_000,
    });

    child.exitCode = 0;
    child.emit('exit', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(db.finishRun).not.toHaveBeenCalled();
    expect(fileRunner.hasLiveFileRun('run-file')).toBe(true);
    expect(fileRunner.readFileRunStatus('run-file')?.phase).toBe('running');
    expect(fileRunner.readFileRunStatus('run-file')?.reason).toBe(fileRunner.FILE_RUNNER_WAITING_FOR_TESTS);

    writeRunResult(resultPath, 'PASS', 'Background suite finished');
    remaining = [];
    await vi.waitFor(() => {
      expect(db.finishRun).toHaveBeenCalledWith('run-file', 0);
    });
    expect(fileRunner.readFileRunStatus('run-file')?.phase).toBe('done');
  });

  it('does not finalize incomplete while last_line says tests are running; later result.txt PASS wins', async () => {
    const { writeRunResult } = await import('./run-result.js');
    const { db, fileRunner, resultPath, child } = await setupRun({
      hooks: { processTreePollMs: 10, processTreeTimeoutMs: 2_000 },
    });

    child.stdout.emit('data', Buffer.from(
      "Integration tests are running against the real Postgres container; I'll pick up the results as soon as the run finishes.\n",
    ));
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(db.finishRun).not.toHaveBeenCalled();
    expect(fileRunner.hasLiveFileRun('run-file')).toBe(true);
    expect(fileRunner.readFileRunStatus('run-file')?.phase).toBe('running');
    expect(fileRunner.readFileRunStatus('run-file')?.reason).toBe(fileRunner.FILE_RUNNER_WAITING_FOR_TESTS);
    expect(fileRunner.readFileRunStatus('run-file')?.last_line).toMatch(/Integration tests are running/i);

    writeRunResult(resultPath, 'PASS', 'Suite finished after Claude walked away');
    await vi.waitFor(() => {
      expect(db.finishRun).toHaveBeenCalledWith('run-file', 0);
    });
    expect(fileRunner.readFileRunStatus('run-file')?.phase).toBe('done');
    expect(fileRunner.readFileRunStatus('run-file')?.phase).not.toBe('incomplete');
  });

  it('does not finalize while worktree test children remain after leaving the process group', async () => {
    const { writeRunResult } = await import('./run-result.js');
    const { db, fileRunner, resultPath, child } = await setupRun();
    let remaining = [7777];
    fileRunner.setFileRunnerTestHooks({
      listProcessGroupPids: () => [],
      listWorktreePids: () => remaining,
      processTreePollMs: 10,
      processTreeTimeoutMs: 2_000,
    });

    child.exitCode = 0;
    child.emit('exit', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(db.finishRun).not.toHaveBeenCalled();
    expect(fileRunner.readFileRunStatus('run-file')?.phase).toBe('running');
    expect(fileRunner.readFileRunStatus('run-file')?.reason).toBe(fileRunner.FILE_RUNNER_WAITING_FOR_TESTS);

    writeRunResult(resultPath, 'PASS', 'Worktree vitest finished');
    remaining = [];
    await vi.waitFor(() => {
      expect(db.finishRun).toHaveBeenCalledWith('run-file', 0);
    });
    expect(fileRunner.readFileRunStatus('run-file')?.phase).toBe('done');
  });

  it('treats last_line that says tests are still running as leftover work', async () => {
    const { looksLikeInFlightWork } = await import('./file-runner.js');
    expect(looksLikeInFlightWork(
      "Integration tests are running against the real Postgres container; I'll pick up the results as soon as the run finishes.",
    )).toBe(true);
    expect(looksLikeInFlightWork('The suite is still running')).toBe(true);
    expect(looksLikeInFlightWork('I am done, trust the pane')).toBe(false);
    expect(looksLikeInFlightWork('RESULT: PASS')).toBe(false);
    expect(looksLikeInFlightWork('Reviewed auth.ts; 2 issues remain')).toBe(false);
  });

  it('lists leftover node processes whose cwd is the worktree', async () => {
    const { listWorktreePids } = await import('./file-runner.js');
    const workspace = tmpDir();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: workspace,
      stdio: 'ignore',
      detached: true,
    });
    try {
      expect(child.pid).toBeTruthy();
      await vi.waitFor(() => {
        expect(listWorktreePids(workspace)).toContain(child.pid);
      });
      expect(listWorktreePids(path.join(workspace, 'missing-subdir'))).not.toContain(child.pid);
    } finally {
      if (child.pid) {
        try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
      }
    }
  });

  it('heartbeats updated_at and fails a stale run with a reason, not a pane guess', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T00:00:00Z'));
    const { db, fileRunner, resultPath, child } = await setupRun();

    const first = fileRunner.readFileRunStatus('run-file')!;
    expect(first.phase).toBe('running');

    vi.setSystemTime(new Date('2026-08-23T00:00:15Z'));
    await vi.advanceTimersByTimeAsync(15_000);
    const beat = fileRunner.readFileRunStatus('run-file')!;
    expect(beat.phase).toBe('running');
    expect(Date.parse(beat.updated_at)).toBeGreaterThan(Date.parse(first.updated_at));

    // Stop heartbeats from refreshing, then warp past the 2-minute stale window.
    fileRunner.setFileRunnerTestHooks({
      spawn: vi.fn(),
      heartbeatMs: 15_000,
      staleMs: 120_000,
      now: () => new Date('2026-08-23T00:03:00Z'),
    });
    const stalePath = fileRunner.statusPathFor('run-file');
    fs.writeFileSync(stalePath, JSON.stringify({
      ...beat,
      updated_at: '2026-08-23T00:00:15.000Z',
    }, null, 2));

    expect(fileRunner.checkFileRunStale('run-file', new Date('2026-08-23T00:03:00Z'))).toBe(true);
    expect(child.kill).toHaveBeenCalled();
    expect(db.finishRun).toHaveBeenCalledWith('run-file', 1);
    expect(fileRunner.readFileRunStatus('run-file')?.phase).toBe('failed');
    expect(fileRunner.readFileRunStatus('run-file')?.reason).toMatch(/Stale file-runner heartbeat/i);
    expect(fs.readFileSync(resultPath, 'utf8')).toMatch(/Stale file-runner heartbeat/i);
    expect(fs.readFileSync(resultPath, 'utf8')).not.toMatch(/idle|capture-pane|send-keys/i);
  });

  it('extends an existing worktree CLAUDE.md with standing rules only', async () => {
    const fileRunner = await import('./file-runner.js');
    const workspace = tmpDir();
    const claudeMd = path.join(workspace, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '# Project\n\nUse the existing auth helper.\n', 'utf8');

    const first = fileRunner.ensureClaudeMd(workspace);
    expect(first.created).toBe(false);
    expect(first.updated).toBe(true);
    const text = fs.readFileSync(claudeMd, 'utf8');
    expect(text).toContain('# Project');
    expect(text).toContain('Use the existing auth helper.');
    expect(text).toContain('RESULT: PASS');
    expect(text).toContain('Do not git push');
    expect(text).not.toContain('Add /incoming webhook');

    const second = fileRunner.ensureClaudeMd(workspace);
    expect(second.updated).toBe(false);
    expect(fs.readFileSync(claudeMd, 'utf8').split('<!-- wavecode-file-runner -->').length).toBe(2);
  });

  it('refuses a second open run and does not spawn claude', async () => {
    const db = await import('./db.js');
    const fileRunner = await import('./file-runner.js');
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: {
        id: 'agent-file',
        mode: 'file',
        workspace: tmpDir(),
        model: 'opus',
      },
    } as never);
    vi.mocked(db.listOpenRuns).mockReturnValue([{ id: 'run-open' }] as never);
    const spawn = vi.fn();
    fileRunner.setFileRunnerTestHooks({ spawn });

    const result = await fileRunner.executeFileRun('agent-file', 'task-2', 'Second task');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('busy');
    expect(spawn).not.toHaveBeenCalled();
    expect(db.insertRun).not.toHaveBeenCalled();
  });

  it('presentFileRun exposes phase, result, and log for the operator card', async () => {
    const { writeRunResult } = await import('./run-result.js');
    const { fileRunner, resultPath, child } = await setupRun();
    child.stdout.emit('data', Buffer.from('working on named files\n'));
    await new Promise((resolve) => fileRunner.hasLiveFileRun('run-file') && resolve(undefined));
    const logPath = fileRunner.cliLogPathFor('run-file');
    fs.writeFileSync(logPath, 'working on named files\n', 'utf8');
    writeRunResult(resultPath, 'FAIL', 'Need a review');

    const presented = fileRunner.presentFileRun({
      id: 'run-file',
      result_path: resultPath,
    }, { includeLog: true });

    expect(presented.phase).toBe('running');
    expect(presented.result).toBe('FAIL');
    expect(presented.result_reason).toBe('Need a review');
    expect(presented.log_path).toBe(fileRunner.cliLogPathFor('run-file'));
    expect(presented.log).toContain('working on named files');
    expect(presented.prompt_path).toBe(fileRunner.promptPathFor('run-file'));
  });
});
