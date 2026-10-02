// @vitest-environment jsdom

import '../../../test-setup';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RosterAvatars from './RosterAvatars';
import type { Agent, User } from '../../types';

function agent(over: Partial<Agent>): Agent {
  return {
    id: over.name!, name: 'x', runtime: 'grok', tmux_session: 'wc', workspace: null,
    mode: 'spawned', status: 'idle', model: null, effort: null, created_at: '', ...over,
  };
}

const ana: User = { id: 'u-ana', name: 'ana', role: 'developer', color: '#2563eb' };

describe('RosterAvatars (≤1100px)', () => {
  it('one avatar per agent by alias, lease-holder color, click focuses', async () => {
    const onFocus = vi.fn();
    render(
      <RosterAvatars
        agents={[agent({ name: 'codex-be', alias: 'rex', status: 'working', owner_id: 'u-ana', owner: 'ana' }), agent({ name: 'pm' })]}
        users={new Map([[ana.id, ana]])}
        focusedAgentId={null}
        onFocus={onFocus}
      />,
    );
    const rex = screen.getByRole('button', { name: '@rex' });
    expect(rex).toHaveTextContent('re');
    expect(rex).toHaveAttribute('title', '@rex · working · ana');
    expect(rex.style.backgroundColor).toBe('rgb(37, 99, 235)');
    await userEvent.click(rex);
    expect(onFocus).toHaveBeenCalledWith('codex-be');
    await userEvent.click(screen.getByRole('button', { name: 'All agents' }));
    expect(onFocus).toHaveBeenLastCalledWith(null);
  });
});
