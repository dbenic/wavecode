// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TaskBoard from './TaskBoard';
import type { SSEEvent } from '../hooks/useSSE';

vi.mock('../hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock('../hooks/useSSE', () => ({
  useSSE: vi.fn(),
}));

vi.mock('../components/TaskCard', () => ({
  default: ({ task }: { task: { prompt: string } }) => <div>{task.prompt}</div>,
}));

describe('TaskBoard', () => {
  let sseHandler: ((event: SSEEvent) => void) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    sseHandler = null;

    const sse = await import('../hooks/useSSE');
    vi.mocked(sse.useSSE).mockImplementation((handler) => {
      sseHandler = handler;
    });
  });

  it('refreshes tasks when a task SSE event arrives', async () => {
    const useApi = await import('../hooks/useApi');

    let taskFetchCount = 0;
    vi.mocked(useApi.apiGet).mockImplementation(async (path: string) => {
      if (path.startsWith('/tasks/board')) {
        taskFetchCount += 1;
        return makeBoard(taskFetchCount === 1
          ? [makeTask('Initial queued work')]
          : [makeTask('Updated queued work')]) as never;
      }

      if (path === '/agents') {
        return [] as never;
      }

      if (path === '/messages?limit=30') {
        return [] as never;
      }

      if (path === '/goals') {
        return [] as never;
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    render(
      <MemoryRouter>
        <TaskBoard />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Initial queued work')).toBeInTheDocument();
    expect(sseHandler).toBeTruthy();

    await act(async () => {
      sseHandler?.(makeTaskEvent('task.completed'));
    });

    await waitFor(() => {
      expect(screen.getByText('Updated queued work')).toBeInTheDocument();
    });
  });

  it('still loads tasks when optional messages fail to load', async () => {
    const useApi = await import('../hooks/useApi');

    vi.mocked(useApi.apiGet).mockImplementation(async (path: string) => {
      if (path.startsWith('/tasks/board')) {
        return makeBoard([makeTask('Manual queue still works')]) as never;
      }

      if (path === '/agents') {
        return [] as never;
      }

      if (path === '/messages?limit=30') {
        throw new Error('Messages unavailable');
      }

      if (path === '/goals') {
        return [] as never;
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    render(
      <MemoryRouter>
        <TaskBoard />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Manual queue still works')).toBeInTheDocument();
  });

  it('shows manual task creation errors instead of failing silently', async () => {
    const useApi = await import('../hooks/useApi');

    vi.mocked(useApi.apiGet).mockImplementation(async (path: string) => {
      if (path.startsWith('/tasks/board')) return makeBoard([]) as never;
      if (path === '/agents' || path === '/messages?limit=30' || path === '/goals') {
        return [] as never;
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    vi.mocked(useApi.apiPost).mockImplementation(async (path: string) => {
      if (path === '/tasks') {
        throw new Error('Dependency task not found: task-123');
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    render(
      <MemoryRouter>
        <TaskBoard />
      </MemoryRouter>,
    );

    expect(await screen.findByText('No tasks yet')).toBeInTheDocument();

    fireEvent.click(screen.getByText('+ Manual'));
    fireEvent.change(
      screen.getByPlaceholderText('Task prompt — what should the agent do?'),
      { target: { value: 'Add retry guards' } },
    );
    fireEvent.click(screen.getByText('Create'));

    expect(await screen.findByText('Dependency task not found: task-123')).toBeInTheDocument();
  });

  it('done tasks come paged with the real column count; SHOW MORE asks the board for a bigger page', async () => {
    const useApi = await import('../hooks/useApi');
    const paths: string[] = [];
    vi.mocked(useApi.apiGet).mockImplementation(async (path: string) => {
      paths.push(path);
      if (path.startsWith('/tasks/board')) {
        const want = Number(new URL(path, 'http://x').searchParams.get('done') ?? 2);
        const done = Array.from({ length: Math.min(want, 5) }, (_, i) => ({ ...makeTask(`Done work ${i + 1}`), status: 'done' as const }));
        return { counts: { pending: 0, running: 0, done: 5, failed: 0, blocked: 0 }, active: [], done, failed: [], page_size: 2, has_more: { done: done.length < 5, failed: false } } as never;
      }
      if (path === '/agents' || path === '/messages?limit=30' || path === '/goals') return [] as never;
      throw new Error(`Unexpected path: ${path}`);
    });

    render(<MemoryRouter><TaskBoard /></MemoryRouter>);
    expect(await screen.findByText('Done work 2')).toBeInTheDocument();
    expect(screen.queryByText('Done work 3')).toBeNull();
    expect(screen.getByTestId('count-done').textContent).toBe('5');
    fireEvent.click(screen.getByText(/SHOW 2 MORE/));
    expect(await screen.findByText('Done work 4')).toBeInTheDocument();
    expect(paths.some((p) => p === '/tasks/board?done=4')).toBe(true);
    // a burst of task events costs one reload, not one per event
    const before = paths.filter((p) => p.startsWith('/tasks/board')).length;
    await act(async () => {
      sseHandler?.(makeTaskEvent('task.completed'));
      sseHandler?.(makeTaskEvent('task.completed'));
      sseHandler?.(makeTaskEvent('run.phase'));
    });
    await waitFor(() => expect(paths.filter((p) => p.startsWith('/tasks/board')).length).toBe(before + 1));
  });

  it('shows a goal rollup of done vs total child tasks', async () => {
    const useApi = await import('../hooks/useApi');

    vi.mocked(useApi.apiGet).mockImplementation(async (path: string) => {
      if (path.startsWith('/tasks/board')) {
        return makeBoard([makeTask('Add /incoming route')]) as never;
      }
      if (path === '/agents' || path === '/messages?limit=30') {
        return [] as never;
      }
      if (path === '/goals') {
        return [{
          id: 'goal-1',
          title: 'Employee incoming view',
          status: 'active',
          workspace: null,
          external_id: 'F-16',
          created_at: '2026-08-16T00:00:00Z',
          rollup: { pending: 1, running: 0, done: 2, failed: 0, blocked: 0, total: 3 },
        }] as never;
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    render(
      <MemoryRouter>
        <TaskBoard />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Employee incoming view')).toBeInTheDocument();
    expect(screen.getByText('F-16')).toBeInTheDocument();
    expect(screen.getByText('2/3 done')).toBeInTheDocument();
  });
});

function makeBoard(active: ReturnType<typeof makeTask>[]) {
  return {
    counts: { pending: active.length, running: 0, done: 0, failed: 0, blocked: 0 },
    active, done: [], failed: [], page_size: 25, has_more: { done: false, failed: false },
  };
}

function makeTask(prompt: string) {
  return {
    id: prompt,
    agent_id: null,
    prompt,
    status: 'pending' as const,
    priority: 0,
    created_at: '2026-04-03T00:00:00Z',
    dependencies: [],
    dependents: [],
  };
}

function makeTaskEvent(type: string): SSEEvent {
  return {
    id: 1,
    type,
    entityType: 'task',
    entityId: 'task-1',
    payload: null,
    createdAt: '2026-04-03T00:00:00Z',
  };
}
