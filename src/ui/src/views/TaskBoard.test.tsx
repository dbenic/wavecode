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
      if (path === '/tasks') {
        taskFetchCount += 1;
        return (taskFetchCount === 1
          ? [makeTask('Initial queued work')]
          : [makeTask('Updated queued work')]) as never;
      }

      if (path === '/agents') {
        return [] as never;
      }

      if (path === '/messages?limit=30') {
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
      if (path === '/tasks') {
        return [makeTask('Manual queue still works')] as never;
      }

      if (path === '/agents') {
        return [] as never;
      }

      if (path === '/messages?limit=30') {
        throw new Error('Messages unavailable');
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
      if (path === '/tasks' || path === '/agents' || path === '/messages?limit=30') {
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
});

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
