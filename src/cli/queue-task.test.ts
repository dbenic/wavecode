import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dispatchNext = vi.fn();
const executeRun = vi.fn();
const addDependency = vi.fn(() => true);

vi.mock('../server/task-dispatcher.js', () => ({
  addDependency: (...args: unknown[]) => addDependency(...args),
  dispatchNext: (...args: unknown[]) => dispatchNext(...args),
  executeRun: (...args: unknown[]) => executeRun(...args),
}));

vi.mock('../server/config.js', () => ({
  getConfig: vi.fn(() => ({
    server: { port: 3777, host: '0.0.0.0' },
    auth: { fallback_token: 'test-token' },
  })),
}));

import { DAEMON_DOWN_HINT, queueTask, resolveDaemonConnection } from './queue-task.js';

describe('queueTask', () => {
  const insertTaskFn = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.WAVECODE_URL;
    delete process.env.WAVECODE_TOKEN;
  });

  afterEach(() => {
    delete process.env.WAVECODE_URL;
    delete process.env.WAVECODE_TOKEN;
  });

  it('POSTs /api/tasks on the daemon and does not dispatch in-process', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://127.0.0.1:3777/api/tasks');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        prompt: 'build auth',
        agent_id: 'agent-1',
        priority: 2,
        depends_on: ['task-0'],
      });
      return new Response(JSON.stringify({
        id: 'task-http',
        prompt: 'build auth',
        agent_id: 'agent-1',
        priority: 2,
        status: 'pending',
        dependencies: ['task-0'],
      }), { status: 201 });
    });

    const result = await queueTask(
      { prompt: 'build auth', agentId: 'agent-1', priority: 2, dependsOn: ['task-0'] },
      { fetchImpl: fetchImpl as unknown as typeof fetch, insertTaskFn },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      id: 'task-http',
      via: 'http',
      agent_id: 'agent-1',
    });
    expect(insertTaskFn).not.toHaveBeenCalled();
    expect(dispatchNext).not.toHaveBeenCalled();
    expect(executeRun).not.toHaveBeenCalled();
    expect(addDependency).not.toHaveBeenCalled();
  });

  it('falls back to a local pending insert when the daemon is down', async () => {
    insertTaskFn.mockReturnValue({
      ok: true,
      data: {
        id: 'task-local',
        prompt: 'offline work',
        agent_id: null,
        priority: 0,
        status: 'pending',
      },
    });

    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    const result = await queueTask(
      { prompt: 'offline work', dependsOn: ['dep-1'] },
      { fetchImpl: fetchImpl as unknown as typeof fetch, insertTaskFn },
    );

    expect(result).toEqual({
      ok: true,
      data: {
        id: 'task-local',
        prompt: 'offline work',
        agent_id: null,
        priority: 0,
        status: 'pending',
        via: 'local-insert',
      },
      hint: DAEMON_DOWN_HINT,
    });
    expect(insertTaskFn).toHaveBeenCalledWith({
      prompt: 'offline work',
      agent_id: undefined,
      priority: undefined,
    });
    expect(addDependency).toHaveBeenCalledWith('task-local', 'dep-1');
    expect(dispatchNext).not.toHaveBeenCalled();
    expect(executeRun).not.toHaveBeenCalled();
  });

  it('does not local-insert when the daemon rejects the request', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Agent xyz not found' }), { status: 400 }),
    );

    const result = await queueTask(
      { prompt: 'bad agent', agentId: 'xyz' },
      { fetchImpl: fetchImpl as unknown as typeof fetch, insertTaskFn },
    );

    expect(result).toEqual({ ok: false, error: 'Agent xyz not found' });
    expect(insertTaskFn).not.toHaveBeenCalled();
    expect(dispatchNext).not.toHaveBeenCalled();
  });

  it('resolves the daemon URL from WAVECODE_URL and loopback for 0.0.0.0', () => {
    expect(resolveDaemonConnection()).toEqual({
      url: 'http://127.0.0.1:3777',
      token: 'test-token',
    });

    process.env.WAVECODE_URL = 'http://example.test:9999/';
    process.env.WAVECODE_TOKEN = 'env-token';
    expect(resolveDaemonConnection()).toEqual({
      url: 'http://example.test:9999/',
      token: 'env-token',
    });
  });
});
