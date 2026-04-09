// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TaskCard from './TaskCard';

const navigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigate,
  };
});

vi.mock('../hooks/useApi', () => ({
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

describe('TaskCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    navigate.mockReset();
  });

  it('opens the singular agent route from the collapsed agent link', () => {
    render(
      <MemoryRouter>
        <TaskCard task={makeTask('pending')} agentName="builder" index={0} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByTitle('Open builder'));

    expect(navigate).toHaveBeenCalledWith('/agent/agent-1');
  });

  it('does not offer retry or cancel actions while a task is running', () => {
    render(
      <MemoryRouter>
        <TaskCard task={makeTask('running')} agentName="builder" index={0} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByText('Implement agent task flow'));

    expect(screen.queryByText('RETRY')).not.toBeInTheDocument();
    expect(screen.queryByText('CANCEL')).not.toBeInTheDocument();
  });
});

function makeTask(status: 'pending' | 'running') {
  return {
    id: 'task-1',
    agent_id: 'agent-1',
    prompt: 'Implement agent task flow',
    status,
    priority: 1,
    created_at: '2026-04-08T00:00:00Z',
    dependencies: [],
    dependents: [],
  };
}
