// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ReviewQueue from './ReviewQueue';
import type { SSEEvent } from '../hooks/useSSE';

vi.mock('../hooks/useApi', () => ({
  apiGet: vi.fn(),
}));

vi.mock('../hooks/useSSE', () => ({
  useSSE: vi.fn(),
}));

vi.mock('../components/ReviewItem', () => ({
  default: ({ item }: { item: { task: { prompt: string } } }) => <div>{item.task.prompt}</div>,
}));

describe('ReviewQueue', () => {
  let sseHandler: ((event: SSEEvent) => void) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    sseHandler = null;

    const sse = await import('../hooks/useSSE');
    vi.mocked(sse.useSSE).mockImplementation((handler) => {
      sseHandler = handler;
    });
  });

  it('refreshes reviews when a review-related SSE event arrives', async () => {
    const useApi = await import('../hooks/useApi');

    let reviewFetchCount = 0;
    vi.mocked(useApi.apiGet).mockImplementation(async (path: string) => {
      if (path === '/reviews') {
        reviewFetchCount += 1;
        return (reviewFetchCount === 1
          ? [makeReviewItem('Initial review item')]
          : [makeReviewItem('Updated review item')]) as never;
      }

      if (path === '/agents') {
        return [] as never;
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    render(
      <MemoryRouter>
        <ReviewQueue />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Initial review item')).toBeInTheDocument();
    expect(sseHandler).toBeTruthy();

    await act(async () => {
      sseHandler?.(makeReviewEvent('run.finished'));
    });

    await waitFor(() => {
      expect(screen.getByText('Updated review item')).toBeInTheDocument();
    });
  });
});

function makeReviewItem(prompt: string) {
  return {
    run: {
      id: prompt,
      task_id: 'task-1',
      agent_id: 'agent-1',
      attempt: 1,
      status: 'done' as const,
      started_at: '2026-04-03T00:00:00Z',
      finished_at: '2026-04-03T00:01:00Z',
      exit_code: 0,
      transcript_path: null,
      review_status: 'pending' as const,
    },
    task: {
      id: 'task-1',
      agent_id: 'agent-1',
      prompt,
      status: 'done' as const,
      priority: 0,
      created_at: '2026-04-03T00:00:00Z',
    },
    agentName: 'agent-1',
    artifacts: [],
    duration: 60,
  };
}

function makeReviewEvent(type: string): SSEEvent {
  return {
    id: 1,
    type,
    entityType: 'run',
    entityId: 'run-1',
    payload: null,
    createdAt: '2026-04-03T00:00:00Z',
  };
}
