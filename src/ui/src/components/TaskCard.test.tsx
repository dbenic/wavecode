// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TaskCard, { waitLine } from './TaskCard';

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

// 31 Oct 2026: tasks pinned to an agent on another subscription sat pending with no signal.
describe('TaskCard wait line', () => {
  const ales = { name: 'ales-codex1', profile: 'ales', owner: null };
  const pending = { ...makeTask('pending'), wait_reason: 'profile' as const };

  it('says why a pending task pinned to an agent is not running', () => {
    expect(waitLine(pending, ales)).toBe("waiting: profile — ales is Ales's subscription");
    expect(waitLine({ ...pending, wait_reason: 'owner' }, { ...ales, owner: 'ales' })).toBe('waiting: owner — ales holds ales-codex1');
    expect(waitLine({ ...pending, wait_reason: 'quota' }, ales)).toBe('waiting: quota — ales-codex1 is under its plan floor');
    expect(waitLine({ ...pending, wait_reason: null }, ales)).toBeNull();
    expect(waitLine(pending)).toBe("waiting: profile — another profile is Another profile's subscription");
  });

  it('renders the line on the pending card only', () => {
    const { rerender } = render(
      <MemoryRouter><TaskCard task={pending} agentName="ales-codex1" agent={ales} index={0} /></MemoryRouter>,
    );
    expect(screen.getByText("waiting: profile — ales is Ales's subscription")).toBeInTheDocument();
    rerender(
      <MemoryRouter><TaskCard task={{ ...pending, status: 'running' }} agentName="ales-codex1" agent={ales} index={0} /></MemoryRouter>,
    );
    expect(screen.queryByText(/waiting:/)).toBeNull();
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
