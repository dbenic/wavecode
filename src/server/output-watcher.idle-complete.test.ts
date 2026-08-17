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
  finishRun: vi.fn(),
  updateTaskStatus: vi.fn(),
}));

vi.mock('./event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('./task-dispatcher.js', () => ({
  onRunComplete: vi.fn(),
  dispatchNext: vi.fn(),
  unblockDependentsPublic: vi.fn(),
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
    const runner = await import('./runner.js');

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
    expect(db.finishRun).toHaveBeenCalledWith(run.id, 0);
    expect(dispatcher.onRunComplete).toHaveBeenCalledWith(run.id, agent.id);
    expect(runner.clearRunnerRun).toHaveBeenCalledWith(agent.id);
    expect(db.updateTaskStatus).not.toHaveBeenCalled();
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

    expect(db.finishRun).not.toHaveBeenCalled();
    expect(dispatcher.onRunComplete).not.toHaveBeenCalled();
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

    expect(db.finishRun).not.toHaveBeenCalled();
    expect(dispatcher.onRunComplete).not.toHaveBeenCalled();
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

    expect(db.finishRun).toHaveBeenCalledWith(run.id, 0);
    expect(dispatcher.onRunComplete).toHaveBeenCalledWith(run.id, agent.id);
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

function makeRun() {
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
  };
}

function makeTask(overrides: Partial<{ status: 'pending' | 'running' | 'done' }> = {}) {
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
