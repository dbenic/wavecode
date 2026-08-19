/**
 * Spawned/adopted idle-complete: a stably idle pane closes a stuck running
 * run via onRunComplete. Grok-like generation must not close the run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./session-manager.js', () => ({
  sendRawKeys: vi.fn(() => ({ ok: true, data: undefined })),
  capturePane: vi.fn(),
}));

vi.mock('./db.js', () => ({
  getAgent: vi.fn(),
  updateAgentStatus: vi.fn(),
  listRuns: vi.fn(),
  listTasks: vi.fn(),
  updateTaskStatus: vi.fn(),
}));

vi.mock('./event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('./task-dispatcher.js', () => ({
  onRunComplete: vi.fn(),
  dispatchNext: vi.fn(),
  unblockDependentsPublic: vi.fn(),
  finalizeRun: vi.fn(),
}));

vi.mock('./task-verifier.js', () => ({
  verifyTaskCompletion: vi.fn(async () => undefined),
}));

vi.mock('./code-review.js', () => ({
  onAuthorAgentIdle: vi.fn(async () => undefined),
}));

vi.mock('./project-gate.js', () => ({
  projectRequiresReferee: vi.fn(() => false),
}));

vi.mock('./runner.js', () => ({
  clearRunnerRun: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { capturePane } from './session-manager.js';
import {
  IDLE_CLOSE_GRACE_MS,
  IDLE_OVERRIDE_THRESHOLD,
  startWatching,
  stopWatching,
  tickForTest,
} from './output-watcher.js';

const IDLE_PANE = `
Codex review finished
RESULT: PASS lint=PASS unit=PASS
>
`.trim();

const GROK_RESPONDING = `
Working on the patch
Responding…
`.trim();

const CLAUDE_SPLASH = `
     ✻ Welcome to Claude Code

     Try refactor db.ts

     bypass permissions on (shift+tab to cycle) · gh auth login for PR status
`.trim();

const CODEX_IDLE_PROMPT = `
gpt-5.4 xhigh · 47% left · ~/project
›
`.trim();

const CODEX_WORKING = `
◦ Working (12s • esc to interrupt)
gpt-5.4 xhigh · 47% left · ~/project
`.trim();

function sqliteUtcNow(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 19).replace('T', ' ');
}

describe('output-watcher — idle-complete', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopWatching('agent-1');
    vi.useRealTimers();
  });

  it('closes a stuck running run when a spawned agent is stably idle', async () => {
    const db = await import('./db.js');
    const dispatcher = await import('./task-dispatcher.js');

    const agent = makeAgent({ mode: 'spawned', status: 'working' });
    const run = makeRun();
    vi.mocked(db.getAgent).mockReturnValue({ ok: true, data: agent } as never);
    vi.mocked(db.listRuns).mockReturnValue([run]);
    vi.mocked(db.listTasks).mockReturnValue([makeTask({ status: 'running' })]);
    vi.mocked(capturePane).mockReturnValue({ ok: true, data: IDLE_PANE });

    startWatching(agent.id);
    for (let i = 0; i < IDLE_OVERRIDE_THRESHOLD; i++) {
      tickForTest(agent.id);
    }

    expect(db.updateAgentStatus).toHaveBeenCalledWith(agent.id, 'idle');
    expect(dispatcher.finalizeRun).toHaveBeenCalledWith(
      run.id,
      agent.id,
      0,
      'Idle close without a parseable RESULT file',
    );
    expect(db.updateTaskStatus).not.toHaveBeenCalled();
  });

  it('closes the pane-named run on an already-idle Grok seat (no daemon restart)', async () => {
    const db = await import('./db.js');
    const dispatcher = await import('./task-dispatcher.js');

    const grokRunId = '01M0886K75AJDRRR1BPTA4X7ZC';
    const grokTaskId = '01M0886JQC1ZME43DW286V36YM';
    const agent = makeAgent({ mode: 'spawned', status: 'idle', runtime: 'grok' });
    const stuck = makeRun({ id: grokRunId, task_id: grokTaskId });
    vi.mocked(db.getAgent).mockReturnValue({ ok: true, data: agent } as never);
    vi.mocked(db.listRuns).mockReturnValue([stuck]);
    vi.mocked(db.listTasks).mockReturnValue([makeTask({ id: grokTaskId, status: 'running' })]);
    vi.mocked(capturePane).mockReturnValue({
      ok: true,
      data: [
        `echo '{"type":"run.started","run_id":"${grokRunId}","task_id":"${grokTaskId}"}' | nc -U '/tmp/wavecode-runner-agent-1.sock' 2>/dev/null; echo 'review' | grok --always-approve;`,
        'RESULT: PASS',
        '>',
      ].join('\n'),
    });

    startWatching(agent.id);
    tickForTest(agent.id);

    expect(dispatcher.finalizeRun).toHaveBeenCalledWith(
      grokRunId,
      agent.id,
      0,
      'Idle close without a parseable RESULT file',
    );
  });

  it('closes a Grok TUI review with no RESULT file via finalizeRun (never pane PASS)', async () => {
    const db = await import('./db.js');
    const dispatcher = await import('./task-dispatcher.js');

    const grokRunId = '01M08B7WSC1F3XKYQMNYMC68YB';
    const agent = makeAgent({ mode: 'spawned', status: 'idle', runtime: 'grok' });
    const stuck = makeRun({ id: grokRunId, task_id: 'task-review' });
    vi.mocked(db.getAgent).mockReturnValue({ ok: true, data: agent } as never);
    vi.mocked(db.listRuns).mockReturnValue([stuck]);
    vi.mocked(db.listTasks).mockReturnValue([makeTask({ id: 'task-review', status: 'running' })]);
    vi.mocked(capturePane).mockReturnValue({
      ok: true,
      data: [
        'Your code was reviewed by another AI model. Here are the issues found.',
        '>',
      ].join('\n'),
    });

    startWatching(agent.id);
    tickForTest(agent.id);

    expect(dispatcher.finalizeRun).toHaveBeenCalledWith(
      grokRunId,
      agent.id,
      0,
      'Idle close without a parseable RESULT file',
    );
  });

  it('closes the older stuck run when Codex is already on a later task', async () => {
    const db = await import('./db.js');
    const dispatcher = await import('./task-dispatcher.js');

    const oldRunId = '01M0829117QXE7QP6GNG8EPQQT';
    const oldTaskId = '01M08290HDW155AYGYXG936AA0';
    const newRunId = '01M089NEWRXN00000000000001';
    const agent = makeAgent({ mode: 'spawned', status: 'working', runtime: 'codex' });
    const newer = makeRun({
      id: newRunId,
      task_id: 'task-later',
      started_at: '2026-08-17T12:00:00Z',
    });
    const older = makeRun({
      id: oldRunId,
      task_id: oldTaskId,
      started_at: '2026-08-17T10:00:00Z',
    });
    vi.mocked(db.getAgent).mockReturnValue({ ok: true, data: agent } as never);
    // listRuns is started_at DESC — newest first
    vi.mocked(db.listRuns).mockReturnValue([newer, older]);
    vi.mocked(db.listTasks).mockReturnValue([
      makeTask({ id: oldTaskId, status: 'running' }),
      makeTask({ id: 'task-later', status: 'running' }),
    ]);
    vi.mocked(capturePane).mockReturnValue({
      ok: true,
      data: [
        `echo '{"type":"run.started","run_id":"${oldRunId}","task_id":"${oldTaskId}"}' | nc -U '/tmp/wavecode-runner-agent-1.sock' 2>/dev/null;`,
        'RESULT: PASS',
        `echo '{"type":"run.started","run_id":"${newRunId}","task_id":"task-later"}' | nc -U '/tmp/wavecode-runner-agent-1.sock' 2>/dev/null;`,
        '◦ Working (12s • esc to interrupt)',
        'gpt-5.4 xhigh · 47% left · ~/project',
      ].join('\n'),
    });

    startWatching(agent.id);
    tickForTest(agent.id);

    expect(dispatcher.finalizeRun).toHaveBeenCalledWith(
      oldRunId,
      agent.id,
      0,
      'Idle close without a parseable RESULT file',
    );
    expect(dispatcher.finalizeRun).not.toHaveBeenCalledWith(
      newRunId,
      agent.id,
      0,
      expect.anything(),
    );
    expect(db.updateAgentStatus).not.toHaveBeenCalledWith(agent.id, 'idle');
  });

  it('does not close a run while Grok is Responding/Thinking', async () => {
    const db = await import('./db.js');
    const dispatcher = await import('./task-dispatcher.js');

    const agent = makeAgent({ mode: 'spawned', status: 'working', runtime: 'grok' });
    vi.mocked(db.getAgent).mockReturnValue({ ok: true, data: agent } as never);
    vi.mocked(db.listRuns).mockReturnValue([makeRun()]);
    vi.mocked(db.listTasks).mockReturnValue([makeTask({ status: 'running' })]);
    vi.mocked(capturePane).mockReturnValue({ ok: true, data: GROK_RESPONDING });

    startWatching(agent.id);
    for (let i = 0; i < IDLE_OVERRIDE_THRESHOLD + 2; i++) {
      tickForTest(agent.id);
    }

    expect(dispatcher.finalizeRun).not.toHaveBeenCalled();
    expect(db.updateAgentStatus).not.toHaveBeenCalledWith(agent.id, 'idle');
  });

  it('does not close a run while the pane is still changing', async () => {
    const db = await import('./db.js');
    const dispatcher = await import('./task-dispatcher.js');

    const agent = makeAgent({ mode: 'spawned', status: 'working' });
    vi.mocked(db.getAgent).mockReturnValue({ ok: true, data: agent } as never);
    vi.mocked(db.listRuns).mockReturnValue([makeRun()]);
    vi.mocked(db.listTasks).mockReturnValue([makeTask({ status: 'running' })]);

    let n = 0;
    vi.mocked(capturePane).mockImplementation(() => ({
      ok: true,
      data: `streaming line ${n++}\nmore output`,
    }));

    startWatching(agent.id);
    for (let i = 0; i < IDLE_OVERRIDE_THRESHOLD + 2; i++) {
      tickForTest(agent.id);
    }

    expect(dispatcher.finalizeRun).not.toHaveBeenCalled();
  });

  it('does not idle-finalize a just-dispatched Codex run still showing the idle prompt', async () => {
    const db = await import('./db.js');
    const dispatcher = await import('./task-dispatcher.js');

    const agent = makeAgent({ mode: 'spawned', status: 'working', runtime: 'codex' });
    const run = makeRun({ started_at: sqliteUtcNow() });
    vi.mocked(db.getAgent).mockReturnValue({ ok: true, data: agent } as never);
    vi.mocked(db.listRuns).mockReturnValue([run]);
    vi.mocked(db.listTasks).mockReturnValue([makeTask({ status: 'running' })]);
    vi.mocked(capturePane).mockReturnValue({ ok: true, data: CODEX_IDLE_PROMPT });

    startWatching(agent.id);
    for (let i = 0; i < IDLE_OVERRIDE_THRESHOLD + 2; i++) {
      tickForTest(agent.id);
    }

    expect(dispatcher.finalizeRun).not.toHaveBeenCalled();
    expect(db.updateAgentStatus).not.toHaveBeenCalledWith(agent.id, 'idle');
  });

  it('does not idle-finalize a just-dispatched Claude splash run (Fable/Claude)', async () => {
    const db = await import('./db.js');
    const dispatcher = await import('./task-dispatcher.js');

    const agent = makeAgent({ mode: 'spawned', status: 'working', runtime: 'claude-code' });
    const run = makeRun({ started_at: new Date().toISOString() });
    vi.mocked(db.getAgent).mockReturnValue({ ok: true, data: agent } as never);
    vi.mocked(db.listRuns).mockReturnValue([run]);
    vi.mocked(db.listTasks).mockReturnValue([makeTask({ status: 'running' })]);
    vi.mocked(capturePane).mockReturnValue({ ok: true, data: CLAUDE_SPLASH });

    startWatching(agent.id);
    for (let i = 0; i < IDLE_OVERRIDE_THRESHOLD + 2; i++) {
      tickForTest(agent.id);
    }

    expect(dispatcher.finalizeRun).not.toHaveBeenCalled();
    expect(db.updateAgentStatus).not.toHaveBeenCalledWith(agent.id, 'idle');
  });

  it('after grace, idle + missing result still idle-finalizes (FAIL path)', async () => {
    const db = await import('./db.js');
    const dispatcher = await import('./task-dispatcher.js');

    const agent = makeAgent({ mode: 'spawned', status: 'working', runtime: 'codex' });
    const started = new Date(Date.now() - IDLE_CLOSE_GRACE_MS - 1_000).toISOString();
    const run = makeRun({ started_at: started });
    vi.mocked(db.getAgent).mockReturnValue({ ok: true, data: agent } as never);
    vi.mocked(db.listRuns).mockReturnValue([run]);
    vi.mocked(db.listTasks).mockReturnValue([makeTask({ status: 'running' })]);
    vi.mocked(capturePane).mockReturnValue({ ok: true, data: CODEX_IDLE_PROMPT });

    startWatching(agent.id);
    for (let i = 0; i < IDLE_OVERRIDE_THRESHOLD; i++) {
      tickForTest(agent.id);
    }

    expect(dispatcher.finalizeRun).toHaveBeenCalledWith(
      run.id,
      agent.id,
      0,
      'Idle close without a parseable RESULT file',
    );
    expect(db.updateAgentStatus).toHaveBeenCalledWith(agent.id, 'idle');
  });

  it('idle-finalizes a young run after the pane has shown working', async () => {
    const db = await import('./db.js');
    const dispatcher = await import('./task-dispatcher.js');

    const agent = makeAgent({ mode: 'spawned', status: 'working', runtime: 'codex' });
    const run = makeRun({ started_at: sqliteUtcNow() });
    vi.mocked(db.getAgent).mockReturnValue({ ok: true, data: agent } as never);
    vi.mocked(db.listRuns).mockReturnValue([run]);
    vi.mocked(db.listTasks).mockReturnValue([makeTask({ status: 'running' })]);
    vi.mocked(capturePane)
      .mockReturnValueOnce({ ok: true, data: CODEX_WORKING })
      .mockReturnValue({ ok: true, data: CODEX_IDLE_PROMPT });

    startWatching(agent.id);
    tickForTest(agent.id);
    for (let i = 0; i < IDLE_OVERRIDE_THRESHOLD; i++) {
      tickForTest(agent.id);
    }

    expect(dispatcher.finalizeRun).toHaveBeenCalledWith(
      run.id,
      agent.id,
      0,
      'Idle close without a parseable RESULT file',
    );
  });

  it('overrides a spawned Claude splash from working to idle (no run to close)', async () => {
    const db = await import('./db.js');
    const dispatcher = await import('./task-dispatcher.js');

    const agent = makeAgent({ mode: 'spawned', status: 'working', runtime: 'claude-code' });
    vi.mocked(db.getAgent).mockReturnValue({ ok: true, data: agent } as never);
    vi.mocked(db.listRuns).mockReturnValue([]);
    vi.mocked(db.listTasks).mockReturnValue([]);
    vi.mocked(capturePane).mockReturnValue({ ok: true, data: CLAUDE_SPLASH });

    startWatching(agent.id);
    for (let i = 0; i < IDLE_OVERRIDE_THRESHOLD; i++) {
      tickForTest(agent.id);
    }

    expect(db.updateAgentStatus).toHaveBeenCalledWith(agent.id, 'idle');
    expect(dispatcher.finalizeRun).not.toHaveBeenCalled();
    expect(db.updateTaskStatus).not.toHaveBeenCalled();
  });

  it('still closes a stuck running run for an adopted agent', async () => {
    const db = await import('./db.js');
    const dispatcher = await import('./task-dispatcher.js');

    const agent = makeAgent({ mode: 'adopted', status: 'working', runtime: 'claude-code' });
    const run = makeRun();
    vi.mocked(db.getAgent).mockReturnValue({ ok: true, data: agent } as never);
    vi.mocked(db.listRuns).mockReturnValue([run]);
    vi.mocked(db.listTasks).mockReturnValue([makeTask({ status: 'running' })]);
    vi.mocked(capturePane).mockReturnValue({
      ok: true,
      data: 'Done\nBrewed for 12s\n⏵⏵ claude-code (shift+tab to cycle)',
    });

    startWatching(agent.id);
    for (let i = 0; i < IDLE_OVERRIDE_THRESHOLD; i++) {
      tickForTest(agent.id);
    }

    expect(dispatcher.finalizeRun).toHaveBeenCalledWith(
      run.id,
      agent.id,
      0,
      'Idle close without a parseable RESULT file',
    );
  });
});

function makeAgent(overrides: Partial<{
  id: string;
  mode: 'adopted' | 'spawned';
  status: 'idle' | 'working' | 'error';
  runtime: string;
}> = {}) {
  return {
    id: 'agent-1',
    name: 'grok-fe',
    runtime: 'grok',
    tmux_session: 'wc-grok-fe',
    workspace: '/workspace/countix',
    mode: 'spawned' as const,
    status: 'working' as const,
    model: 'grok-4.6',
    effort: 'xhigh' as const,
    created_at: '2026-08-17T00:00:00Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<{
  id: string;
  task_id: string;
  started_at: string;
}> = {}) {
  return {
    id: 'run-1',
    task_id: 'task-1',
    agent_id: 'agent-1',
    attempt: 1,
    status: 'running' as const,
    started_at: '2026-08-17T00:00:00Z',
    finished_at: null,
    exit_code: null,
    transcript_path: null,
    review_status: 'pending' as const,
    changed_files: null,
    result_path: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<{
  id: string;
  status: 'pending' | 'running' | 'done';
}> = {}) {
  return {
    id: 'task-1',
    agent_id: 'agent-1',
    prompt: 'Implement the gate',
    status: 'running' as const,
    priority: 0,
    created_at: '2026-08-17T00:00:00Z',
    goal_id: null,
    ...overrides,
  };
}
