import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  getDb: vi.fn(),
  getAgent: vi.fn(),
  getTask: vi.fn(),
  insertTask: vi.fn(),
  findGoal: vi.fn(),
  listRuns: vi.fn(() => []),
  listTasks: vi.fn(() => []),
  updateTaskStatus: vi.fn(),
}));

vi.mock('../config.js', () => ({
  getConfig: vi.fn(() => ({
    autonomy: {
      auto_dispatch: false,
      auto_restart: true,
      hang_timeout_min: 10,
      max_task_retries: 2,
    },
  })),
}));

vi.mock('../event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('../task-dispatcher.js', () => ({
  addDependency: vi.fn(),
  dispatchNext: vi.fn(),
  finalizeRun: vi.fn(),
  getDependencies: vi.fn(() => []),
  getDependents: vi.fn(() => []),
}));

vi.mock('../logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('task routes', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    const db = await import('../db.js');
    vi.mocked(db.getDb).mockReturnValue({
      transaction: <T>(fn: () => T) => fn,
    } as unknown as ReturnType<typeof db.getDb>);
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('rejects task creation when a dependency task does not exist', async () => {
    const db = await import('../db.js');
    vi.mocked(db.getTask).mockReturnValue({
      ok: false,
      error: 'Task missing-task not found',
    });

    const app = await createTaskApp();
    const response = await requestJson(app, '/api/tasks', 'POST', {
      prompt: 'Build the API',
      depends_on: ['missing-task'],
    });

    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: 'Dependency task not found: missing-task' });
    expect(db.insertTask).not.toHaveBeenCalled();
  });

  it('links a created task to a goal by ULID or external_id', async () => {
    const db = await import('../db.js');
    vi.mocked(db.findGoal).mockReturnValue({
      ok: true,
      data: {
        id: 'goal-1',
        title: 'W0',
        status: 'active',
        workspace: null,
        external_id: 'W0',
        created_at: '2026-08-16T00:00:00Z',
      },
    } as never);
    vi.mocked(db.insertTask).mockReturnValue({
      ok: true,
      data: {
        id: 'task-1',
        agent_id: null,
        prompt: 'Add /incoming route',
        status: 'pending',
        priority: 0,
        created_at: '2026-08-16T00:00:00Z',
        goal_id: 'goal-1',
      },
    } as never);

    const app = await createTaskApp();
    const response = await requestJson(app, '/api/tasks', 'POST', {
      prompt: 'Add /incoming route',
      goal_id: 'W0',
      hold: true,
    });

    expect(response.status).toBe(201);
    expect(db.findGoal).toHaveBeenCalledWith('W0');
    expect(db.insertTask).toHaveBeenCalledWith({
      prompt: 'Add /incoming route',
      agent_id: undefined,
      priority: undefined,
      goal_id: 'goal-1',
    });
    expect(response.json).toMatchObject({ id: 'task-1', goal_id: 'goal-1' });
  });

  it('rejects create when goal_id does not resolve', async () => {
    const db = await import('../db.js');
    vi.mocked(db.findGoal).mockReturnValue({
      ok: false,
      error: "Goal 'missing' not found",
    });

    const app = await createTaskApp();
    const response = await requestJson(app, '/api/tasks', 'POST', {
      prompt: 'Orphan child',
      goal_id: 'missing',
    });

    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: 'Goal not found: missing' });
    expect(db.insertTask).not.toHaveBeenCalled();
  });

  it('skips auto-dispatch when hold is true', async () => {
    const db = await import('../db.js');
    const config = await import('../config.js');
    const dispatcher = await import('../task-dispatcher.js');
    vi.mocked(config.getConfig).mockReturnValue({
      autonomy: { auto_dispatch: true, auto_restart: true, hang_timeout_min: 10, max_task_retries: 2 },
    } as never);
    vi.mocked(db.insertTask).mockReturnValue({
      ok: true,
      data: {
        id: 'task-hold',
        agent_id: null,
        prompt: 'Held work',
        status: 'pending',
        priority: 0,
        created_at: '2026-08-16T00:00:00Z',
        goal_id: null,
      },
    } as never);

    const app = await createTaskApp();
    const response = await requestJson(app, '/api/tasks', 'POST', {
      prompt: 'Held work',
      hold: true,
    });

    expect(response.status).toBe(201);
    expect(dispatcher.dispatchNext).not.toHaveBeenCalled();
  });

  it('rejects retry for running tasks', async () => {
    const db = await import('../db.js');
    vi.mocked(db.getTask).mockReturnValue({
      ok: true,
      data: makeTask('running'),
    });

    const app = await createTaskApp();
    const response = await requestJson(app, '/api/tasks/task-1/retry', 'POST');

    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: 'Cannot retry a running task' });
    expect(db.updateTaskStatus).not.toHaveBeenCalled();
  });

  it('rejects cancellation for completed tasks', async () => {
    const db = await import('../db.js');
    vi.mocked(db.getTask).mockReturnValue({
      ok: true,
      data: makeTask('done'),
    });

    const app = await createTaskApp();
    const response = await requestJson(app, '/api/tasks/task-1', 'DELETE');

    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: 'Only pending, blocked, or running tasks can be cancelled' });
    expect(db.updateTaskStatus).not.toHaveBeenCalled();
  });
});

async function createTaskApp() {
  const { registerTaskRoutes } = await import('./tasks.js');
  const app = new Hono();
  registerTaskRoutes(app);
  return app;
}

async function requestJson(app: Hono, url: string, method: string, body?: unknown) {
  const response = await app.fetch(new Request(`http://localhost${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }));

  return {
    status: response.status,
    json: await response.json(),
  };
}

function makeTask(status: string) {
  return {
    id: 'task-1',
    agent_id: null,
    prompt: 'Implement task routing hardening',
    status,
    priority: 0,
    created_at: '2026-04-08T00:00:00Z',
  };
}
