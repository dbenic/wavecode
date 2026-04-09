import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../goal-orchestrator.js', () => ({
  previewGoalPlan: vi.fn(),
  decomposeGoal: vi.fn(),
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
        goal: 'Ship auth',
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
    const response = await requestJson(app, '/api/goals', 'POST', { goal: 'Ship auth' });

    expect(response.status).toBe(201);
    expect(response.json).toEqual({
      goal: 'Ship auth',
      tasks: [
        {
          title: 'Implement API',
          prompt: 'Build the backend API',
        },
      ],
      created_task_ids: ['task-1'],
    });
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
