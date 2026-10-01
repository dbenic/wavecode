// @vitest-environment jsdom

import '../../../test-setup';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Roster, { TASK_DRAG_TYPE } from './Roster';
import type { Agent, Task, User } from '../../types';

const ana: User = { id: 'u-ana', name: 'ana', role: 'developer', color: '#2563eb' };
const bob: User = { id: 'u-bob', name: 'bob', role: 'developer', color: '#16a34a' };
const NOW = Date.parse('2026-10-01T10:00:00Z');

function agent(over: Partial<Agent>): Agent {
  return {
    id: over.name!, name: 'x', runtime: 'grok', tmux_session: 'wc', workspace: null,
    mode: 'spawned', status: 'idle', model: null, effort: null, created_at: '', ...over,
  };
}

const AGENTS = [
  agent({ name: 'grok-fe', owner_id: 'u-ana', owner: 'ana', lease_reason: 'reserved', lease_expires_at: '2026-10-01T13:12:00Z', status: 'working' }),
  agent({ name: 'codex-rev', owner_id: null }),
  agent({ name: 'opus-fe', owner_id: 'u-bob', owner: 'bob' }),
  agent({ name: 'bob-sub', owner_id: null, profile: 'bob', profile_compatible: false }),
];

function renderRoster(over: Partial<Parameters<typeof Roster>[0]> = {}) {
  const props = {
    agents: AGENTS,
    tasks: [{ id: 't1', agent_id: 'grok-fe', prompt: 'T1 identity', status: 'running', priority: 0, created_at: '' }] as Task[],
    me: ana,
    users: new Map([[ana.id, ana], [bob.id, bob]]),
    focusedAgentId: null,
    now: NOW,
    onFocus: vi.fn(),
    onReserve: vi.fn(),
    onRelease: vi.fn(),
    onAssign: vi.fn(),
    ...over,
  };
  render(<Roster {...props} />);
  return props;
}

describe('Roster', () => {
  it('groups agents into Mine / Free / Team with owner, task and lease countdown', () => {
    renderRoster();
    const mine = within(screen.getByRole('region', { name: 'Mine' }));
    expect(mine.getByText('grok-fe')).toBeInTheDocument();
    expect(mine.getByText('T1 identity')).toBeInTheDocument();
    expect(mine.getByTitle('Lease time left')).toHaveTextContent('3h 12m');

    expect(within(screen.getByRole('region', { name: 'Free' })).getByText('codex-rev')).toBeInTheDocument();
    const team = within(screen.getByRole('region', { name: 'Team' }));
    expect(team.getByText('(bob)')).toBeInTheDocument();
    expect(team.getByText('(free · other subscription)')).toBeInTheDocument();
    expect(team.getAllByLabelText('locked')).toHaveLength(1); // only bob's lease locks; other-subscription is free
  });

  it('owner color dot uses the lease holder color', () => {
    renderRoster();
    const dot = screen.getByTestId('roster-opus-fe').querySelector('[aria-hidden]') as HTMLElement;
    expect(dot.style.backgroundColor).toBe('rgb(22, 163, 74)');
  });

  it('reserve free agents, release my own; nothing for others or other subscriptions', async () => {
    const props = renderRoster();
    await userEvent.click(within(screen.getByTestId('roster-codex-rev')).getByRole('button', { name: 'Reserve' }));
    expect(props.onReserve).toHaveBeenCalledWith(expect.objectContaining({ name: 'codex-rev' }));
    await userEvent.click(within(screen.getByTestId('roster-grok-fe')).getByRole('button', { name: 'Release' }));
    expect(props.onRelease).toHaveBeenCalledWith(expect.objectContaining({ name: 'grok-fe' }));
    expect(within(screen.getByTestId('roster-opus-fe')).queryByRole('button', { name: /Reserve|Release/ })).toBeNull();
    expect(within(screen.getByTestId('roster-bob-sub')).queryByRole('button', { name: 'Reserve' })).toBeNull();
  });

  it('admins may release anyone; observers get no lease buttons', () => {
    renderRoster({ me: { ...ana, id: 'owner', role: 'admin' } });
    expect(within(screen.getByTestId('roster-opus-fe')).getByRole('button', { name: 'Release' })).toBeInTheDocument();
    screen.getByText('All agents'); // sanity
  });

  it('observers see no lease buttons', () => {
    renderRoster({ me: { ...ana, role: 'observer' } });
    expect(screen.queryByRole('button', { name: /Reserve|Release/ })).toBeNull();
  });

  it('clicking an agent focuses its thread; All agents clears focus', async () => {
    const props = renderRoster();
    await userEvent.click(screen.getByRole('button', { name: /codex-rev/ }));
    expect(props.onFocus).toHaveBeenCalledWith('codex-rev');
    await userEvent.click(screen.getByRole('button', { name: 'All agents' }));
    expect(props.onFocus).toHaveBeenLastCalledWith(null);
  });

  it('dropping a board task onto an agent assigns it; never onto a locked agent', () => {
    const props = renderRoster();
    const dataTransfer = { types: [TASK_DRAG_TYPE], getData: (t: string) => (t === TASK_DRAG_TYPE ? 'task-9' : '') };
    fireEvent.drop(screen.getByTestId('roster-codex-rev'), { dataTransfer });
    expect(props.onAssign).toHaveBeenCalledWith('task-9', expect.objectContaining({ name: 'codex-rev' }));

    fireEvent.drop(screen.getByTestId('roster-opus-fe'), { dataTransfer });
    expect(props.onAssign).toHaveBeenCalledTimes(1);
  });
});
