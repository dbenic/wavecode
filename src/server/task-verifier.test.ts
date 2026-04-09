import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('./db.js', () => ({
  getTask: vi.fn(),
  getAgent: vi.fn(),
  updateTaskStatus: vi.fn(),
  listRuns: vi.fn(),
}));

vi.mock('./session-manager.js', () => ({
  capturePane: vi.fn(),
}));

vi.mock('./llm-provider.js', () => ({
  getResolvedLlmConfig: vi.fn(),
  isLlmConfigured: vi.fn(),
}));

vi.mock('./event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('./task-dispatcher.js', () => ({
  dispatchNext: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('task-verifier.ts', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useRealTimers();

    const config = await import('./config.js');
    const db = await import('./db.js');
    const sessions = await import('./session-manager.js');
    const llm = await import('./llm-provider.js');

    vi.mocked(config.getConfig).mockReturnValue({
      autonomy: {
        auto_dispatch: true,
        auto_restart: true,
        hang_timeout_min: 10,
        max_task_retries: 2,
        verify_completion: true,
      },
    } as never);
    vi.mocked(db.getTask).mockReturnValue({
      ok: true,
      data: {
        id: 'task-1',
        agent_id: 'agent-1',
        prompt: 'Implement the backend API',
        status: 'done',
        priority: 8,
        created_at: '2026-04-08T00:00:00Z',
      },
    } as never);
    vi.mocked(db.getAgent).mockReturnValue({
      ok: true,
      data: {
        id: 'agent-1',
        name: 'builder',
        runtime: 'codex',
        tmux_session: 'wc-builder',
        workspace: '/workspace/builder',
        mode: 'spawned',
        status: 'idle',
        created_at: '2026-04-08T00:00:00Z',
      },
    } as never);
    vi.mocked(db.listRuns).mockReturnValue([{ id: 'run-1' }] as never);
    vi.mocked(sessions.capturePane).mockReturnValue({
      ok: true,
      data: 'Implemented the API.\nRan tests successfully.\n›',
    } as never);
    vi.mocked(llm.isLlmConfigured).mockReturnValue(true);
    vi.mocked(llm.getResolvedLlmConfig).mockReturnValue({
      provider: 'openai-compatible',
      apiKey: 'sk-test',
      baseUrl: 'http://llm.test/v1',
      model: 'gpt-test',
    } as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('skips verification when the feature is disabled', async () => {
    const config = await import('./config.js');
    const sessions = await import('./session-manager.js');
    vi.mocked(config.getConfig).mockReturnValue({
      autonomy: {
        auto_dispatch: true,
        auto_restart: true,
        hang_timeout_min: 10,
        max_task_retries: 2,
        verify_completion: false,
      },
    } as never);

    const verifier = await import('./task-verifier.js');
    const result = await verifier.verifyTaskCompletion('task-1', 'agent-1');

    expect(result).toBeNull();
    expect(sessions.capturePane).not.toHaveBeenCalled();
  });

  it('marks tasks pending again and schedules retry on high-confidence failure', async () => {
    vi.useFakeTimers();

    const db = await import('./db.js');
    const events = await import('./event-bus.js');
    const dispatcher = await import('./task-dispatcher.js');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: '{"result":"failed","reason":"Tests are still failing","confidence":0.92}',
          },
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const verifier = await import('./task-verifier.js');
    const result = await verifier.verifyTaskCompletion('task-1', 'agent-1');

    expect(result).toEqual({
      result: 'failed',
      reason: 'Tests are still failing',
      confidence: 0.92,
    });
    expect(db.updateTaskStatus).toHaveBeenNthCalledWith(1, 'task-1', 'failed');
    expect(db.updateTaskStatus).toHaveBeenNthCalledWith(2, 'task-1', 'pending');
    expect(events.emit).toHaveBeenNthCalledWith(
      1,
      'task.failed',
      'task',
      'task-1',
      expect.objectContaining({
        agent_id: 'agent-1',
        reason: 'Tests are still failing',
        verified: true,
      }),
    );
    expect(events.emit).toHaveBeenNthCalledWith(
      2,
      'task.retrying',
      'task',
      'task-1',
      {
        reason: 'Tests are still failing',
        attempt: 2,
      },
    );

    vi.advanceTimersByTime(2000);
    await Promise.resolve();

    expect(dispatcher.dispatchNext).toHaveBeenCalledTimes(1);
  });

  it('keeps successful tasks unchanged when verification passes', async () => {
    const db = await import('./db.js');
    const events = await import('./event-bus.js');
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: '{"result":"completed","reason":"The task is done","confidence":0.88}',
          },
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const verifier = await import('./task-verifier.js');
    const result = await verifier.verifyTaskCompletion('task-1', 'agent-1');

    expect(result).toEqual({
      result: 'completed',
      reason: 'The task is done',
      confidence: 0.88,
    });
    expect(db.updateTaskStatus).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://llm.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });
});
