import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./llm-provider.js', () => ({
  completeText: vi.fn(),
}));

vi.mock('./db.js', () => ({
  insertTask: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock('./task-dispatcher.js', () => ({
  addDependency: vi.fn(),
  dispatchNext: vi.fn(),
}));

vi.mock('./event-bus.js', () => ({
  emit: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('goal-orchestrator.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('extracts JSON plans wrapped in markdown code fences', async () => {
    const llm = await import('./llm-provider.js');
    const db = await import('./db.js');

    vi.mocked(db.listAgents).mockReturnValue([]);
    vi.mocked(llm.completeText).mockResolvedValue({
      ok: true,
      data: `\`\`\`json
{
  "tasks": [
    {
      "title": "Write spec",
      "prompt": "Document the rollout plan",
      "priority": 7
    }
  ]
}
\`\`\``,
    } as never);

    const orchestrator = await import('./goal-orchestrator.js');
    const result = await orchestrator.previewGoalPlan('Ship the rollout');

    expect(result).toEqual({
      ok: true,
      data: {
        tasks: [
          {
            title: 'Write spec',
            prompt: 'Document the rollout plan',
            priority: 7,
          },
        ],
      },
    });
  });

  it('creates goal tasks, wires dependencies, and dispatches them', async () => {
    const llm = await import('./llm-provider.js');
    const db = await import('./db.js');
    const dispatcher = await import('./task-dispatcher.js');
    const events = await import('./event-bus.js');

    vi.mocked(db.listAgents).mockReturnValue([
      makeAgent({ id: 'agent-1', name: 'builder', runtime: 'codex' }),
      makeAgent({ id: 'agent-2', name: 'reviewer', runtime: 'claude-code' }),
    ]);
    vi.mocked(llm.completeText).mockResolvedValue({
      ok: true,
      data: JSON.stringify({
        tasks: [
          {
            title: 'Implement API',
            prompt: 'Build the backend API',
            agent_hint: 'builder',
            priority: 9,
          },
          {
            title: 'Review API',
            prompt: 'Review the backend changes',
            agent_hint: 'claude-code',
            depends_on_indices: [0],
          },
        ],
      }),
    } as never);
    vi.mocked(db.insertTask)
      .mockReturnValueOnce({
        ok: true,
        data: makeTask({ id: 'task-1', agent_id: 'agent-1', prompt: 'Build the backend API', priority: 9 }),
      } as never)
      .mockReturnValueOnce({
        ok: true,
        data: makeTask({ id: 'task-2', agent_id: 'agent-2', prompt: 'Review the backend changes', priority: 5 }),
      } as never);

    const orchestrator = await import('./goal-orchestrator.js');
    const result = await orchestrator.decomposeGoal('Ship the backend');

    expect(db.insertTask).toHaveBeenNthCalledWith(1, {
      agent_id: 'agent-1',
      prompt: 'Build the backend API',
      priority: 9,
    });
    expect(db.insertTask).toHaveBeenNthCalledWith(2, {
      agent_id: 'agent-2',
      prompt: 'Review the backend changes',
      priority: 5,
    });
    expect(dispatcher.addDependency).toHaveBeenCalledWith('task-2', 'task-1');
    expect(events.emit).toHaveBeenCalledWith(
      'goal.created',
      'system',
      'goal-orchestrator',
      expect.objectContaining({
        goal: 'Ship the backend',
        task_count: 2,
        task_ids: ['task-1', 'task-2'],
      }),
    );
    expect(dispatcher.dispatchNext).toHaveBeenCalledWith({ manual: true });
    expect(result).toEqual({
      ok: true,
      data: {
        goal: 'Ship the backend',
        tasks: [
          {
            title: 'Implement API',
            prompt: 'Build the backend API',
            agent_hint: 'builder',
            priority: 9,
          },
          {
            title: 'Review API',
            prompt: 'Review the backend changes',
            agent_hint: 'claude-code',
            depends_on_indices: [0],
          },
        ],
        created_task_ids: ['task-1', 'task-2'],
      },
    });
  });

  it('rejects plans that depend on the current or a later task', async () => {
    const llm = await import('./llm-provider.js');
    const db = await import('./db.js');

    vi.mocked(db.listAgents).mockReturnValue([]);
    vi.mocked(llm.completeText).mockResolvedValue({
      ok: true,
      data: JSON.stringify({
        tasks: [
          {
            title: 'Implement API',
            prompt: 'Build the backend API',
          },
          {
            title: 'Review API',
            prompt: 'Review the backend changes',
            depends_on_indices: [1],
          },
        ],
      }),
    } as never);

    const orchestrator = await import('./goal-orchestrator.js');
    const result = await orchestrator.previewGoalPlan('Ship the backend');

    expect(result).toEqual({
      ok: false,
      error: 'Task at index 1 depends on index 1 which is not before it',
    });
  });
});

function makeAgent(overrides: Partial<{
  id: string;
  name: string;
  runtime: string;
}> = {}) {
  return {
    id: 'agent-1',
    name: 'builder',
    runtime: 'codex',
    tmux_session: 'wc-builder',
    workspace: '/workspace/builder',
    mode: 'spawned' as const,
    status: 'idle' as const,
    created_at: '2026-04-08T00:00:00Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<{
  id: string;
  agent_id: string | null;
  prompt: string;
  priority: number;
}> = {}) {
  return {
    id: 'task-1',
    agent_id: 'agent-1',
    prompt: 'Build the backend API',
    status: 'pending' as const,
    priority: 5,
    created_at: '2026-04-08T00:00:00Z',
    ...overrides,
  };
}
