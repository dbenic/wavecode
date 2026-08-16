import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../goal-orchestrator.js', () => ({
  previewGoalPlan: vi.fn(),
  decomposeGoal: vi.fn(),
  persistGoal: vi.fn(),
  isPersistOnlyGoal: (body: { decompose?: unknown; persist_only?: unknown }) =>
    body.decompose === false || body.persist_only === true,
}));

vi.mock('../db.js', () => ({
  listGoalsWithRollup: vi.fn(() => []),
  getGoalWithRollup: vi.fn(),
  listTasks: vi.fn(() => []),
}));

vi.mock('../task-dispatcher.js', () => ({
  getDependencies: vi.fn(() => []),
  getDependents: vi.fn(() => []),
}));

vi.mock('../logger.js', () => ({
  default: {
    warn: vi.fn(),
  },
}));

describe('goal routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('rejects empty preview requests', async () => {
    const app = await createGoalApp();
    const response = await requestJson(app, '/api/goals/preview', 'POST', { goal: '   ' });

    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: 'Missing or empty "goal" field' });
  });

  it('returns preview tasks for a trimmed goal', async () => {
    const orchestrator = await import('../goal-orchestrator.js');
    vi.mocked(orchestrator.previewGoalPlan).mockResolvedValue({
      ok: true,
      data: {
        tasks: [
          {
            title: 'Implement API',
            prompt: 'Build the backend API',
            priority: 8,
          },
        ],
      },
    } as never);

    const app = await createGoalApp();
    const response = await requestJson(app, '/api/goals/preview', 'POST', { goal: '  Ship auth  ' });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      tasks: [
        {
          title: 'Implement API',
          prompt: 'Build the backend API',
          priority: 8,
        },
      ],
    });
    expect(orchestrator.previewGoalPlan).toHaveBeenCalledWith('Ship auth');
  });

  it('creates tasks from a valid goal', async () => {
    const orchestrator = await import('../goal-orchestrator.js');
    vi.mocked(orchestrator.decomposeGoal).mockResolvedValue({
      ok: true,
      data: {
        goal: {
          id: 'goal-1',
          title: 'Ship auth',
          status: 'active',
          workspace: null,
          external_id: 'F-16',
          created_at: '2026-08-16T00:00:00Z',
        },
        tasks: [
          {
            title: 'Implement API',
            prompt: 'Build the backend API',
          },
        ],
        created_task_ids: ['task-1'],
      },
    } as never);

    const app = await createGoalApp();
    const response = await requestJson(app, '/api/goals', 'POST', {
      goal: 'Ship auth',
      external_id: 'F-16',
    });

    expect(response.status).toBe(201);
    expect(response.json).toEqual({
      goal: {
        id: 'goal-1',
        title: 'Ship auth',
        status: 'active',
        workspace: null,
        external_id: 'F-16',
        created_at: '2026-08-16T00:00:00Z',
      },
      tasks: [
        {
          title: 'Implement API',
          prompt: 'Build the backend API',
        },
      ],
      created_task_ids: ['task-1'],
    });
    expect(orchestrator.decomposeGoal).toHaveBeenCalledWith('Ship auth', {
      title: undefined,
      workspace: undefined,
      external_id: 'F-16',
    });
  });

  it('persists a goal without decomposing when decompose is false', async () => {
    const orchestrator = await import('../goal-orchestrator.js');
    vi.mocked(orchestrator.persistGoal).mockReturnValue({
      ok: true,
      data: {
        id: 'goal-w0',
        title: 'W0 seed',
        status: 'active',
        workspace: '/ws/countix',
        external_id: 'W0',
        created_at: '2026-08-16T00:00:00Z',
      },
    } as never);

    const app = await createGoalApp();
    const response = await requestJson(app, '/api/goals', 'POST', {
      title: 'W0 seed',
      workspace: '/ws/countix',
      external_id: 'W0',
      decompose: false,
    });

    expect(response.status).toBe(201);
    expect(response.json).toEqual({
      goal: {
        id: 'goal-w0',
        title: 'W0 seed',
        status: 'active',
        workspace: '/ws/countix',
        external_id: 'W0',
        created_at: '2026-08-16T00:00:00Z',
      },
      tasks: [],
      created_task_ids: [],
      persist_only: true,
    });
    expect(orchestrator.persistGoal).toHaveBeenCalledWith({
      title: 'W0 seed',
      goal: undefined,
      workspace: '/ws/countix',
      external_id: 'W0',
    });
    expect(orchestrator.decomposeGoal).not.toHaveBeenCalled();
  });

  it('rejects persist-only goals with no title or goal', async () => {
    const orchestrator = await import('../goal-orchestrator.js');
    vi.mocked(orchestrator.persistGoal).mockReturnValue({
      ok: false,
      error: 'title or goal is required',
    });

    const app = await createGoalApp();
    const response = await requestJson(app, '/api/goals', 'POST', { decompose: false });

    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: 'title or goal is required' });
    expect(orchestrator.decomposeGoal).not.toHaveBeenCalled();
  });

  it('treats persist_only as persist-only', async () => {
    const orchestrator = await import('../goal-orchestrator.js');
    vi.mocked(orchestrator.persistGoal).mockReturnValue({
      ok: true,
      data: {
        id: 'goal-g1',
        title: 'G1',
        status: 'active',
        workspace: null,
        external_id: 'G1',
        created_at: '2026-08-16T00:00:00Z',
      },
    } as never);

    const app = await createGoalApp();
    const response = await requestJson(app, '/api/goals', 'POST', {
      goal: 'G1 board seed',
      persist_only: true,
    });

    expect(response.status).toBe(201);
    expect(orchestrator.persistGoal).toHaveBeenCalled();
    expect(orchestrator.decomposeGoal).not.toHaveBeenCalled();
    expect(response.json).toMatchObject({ persist_only: true, created_task_ids: [] });
  });

  it('lists goals with rollup counts', async () => {
    const db = await import('../db.js');
    vi.mocked(db.listGoalsWithRollup).mockReturnValue([
      {
        id: 'goal-1',
        title: 'Ship auth',
        status: 'active',
        workspace: null,
        external_id: 'F-16',
        created_at: '2026-08-16T00:00:00Z',
        rollup: { pending: 1, running: 0, done: 2, failed: 0, blocked: 0, total: 3 },
      },
    ] as never);

    const app = await createGoalApp();
    const response = await requestJson(app, '/api/goals', 'GET');

    expect(response.status).toBe(200);
    expect(response.json).toEqual([
      {
        id: 'goal-1',
        title: 'Ship auth',
        status: 'active',
        workspace: null,
        external_id: 'F-16',
        created_at: '2026-08-16T00:00:00Z',
        rollup: { pending: 1, running: 0, done: 2, failed: 0, blocked: 0, total: 3 },
      },
    ]);
  });

  it('returns a goal with child tasks', async () => {
    const db = await import('../db.js');
    vi.mocked(db.getGoalWithRollup).mockReturnValue({
      ok: true,
      data: {
        id: 'goal-1',
        title: 'Ship auth',
        status: 'active',
        workspace: null,
        external_id: 'F-16',
        created_at: '2026-08-16T00:00:00Z',
        rollup: { pending: 1, running: 0, done: 0, failed: 0, blocked: 0, total: 1 },
      },
    } as never);
    vi.mocked(db.listTasks).mockReturnValue([
      {
        id: 'task-1',
        agent_id: null,
        prompt: 'Build the backend API',
        status: 'pending',
        priority: 5,
        created_at: '2026-08-16T00:00:00Z',
        goal_id: 'goal-1',
      },
    ] as never);

    const app = await createGoalApp();
    const response = await requestJson(app, '/api/goals/F-16', 'GET');

    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({
      id: 'goal-1',
      external_id: 'F-16',
      rollup: { pending: 1, total: 1 },
      tasks: [expect.objectContaining({ id: 'task-1', goal_id: 'goal-1' })],
    });
    expect(db.getGoalWithRollup).toHaveBeenCalledWith('F-16');
    expect(db.listTasks).toHaveBeenCalledWith({ goal_id: 'goal-1' });
  });
});

async function createGoalApp() {
  const { registerGoalRoutes } = await import('./goals.js');
  const app = new Hono();
  registerGoalRoutes(app);
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
