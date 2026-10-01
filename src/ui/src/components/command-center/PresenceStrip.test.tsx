// @vitest-environment jsdom

import '../../../test-setup';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PresenceStrip from './PresenceStrip';
import type { Agent, User } from '../../types';

const ana: User = { id: 'u-ana', name: 'ana', role: 'developer', color: '#2563eb' };
const marko: User = { id: 'u-marko', name: 'marko', role: 'developer', color: '#db2777' };
const admin: User = { id: 'owner', name: 'owner', role: 'admin', color: '#64748b' };

const agents = [{ owner_id: 'u-ana' }, { owner_id: 'u-ana' }, { owner_id: null }] as Agent[];

describe('PresenceStrip', () => {
  it('lists people with their agent counts, active first, marking you', () => {
    render(<PresenceStrip users={[marko, ana]} agents={agents} me={ana} onStopAll={vi.fn()} />);
    const entries = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(entries).toEqual(['ana(2) · you', 'marko']);
  });

  it('Stop all is admin-only', async () => {
    const onStopAll = vi.fn();
    const { rerender } = render(<PresenceStrip users={[ana]} agents={[]} me={ana} onStopAll={onStopAll} />);
    expect(screen.queryByRole('button', { name: 'Stop all' })).toBeNull();
    rerender(<PresenceStrip users={[ana]} agents={[]} me={admin} onStopAll={onStopAll} />);
    await userEvent.click(screen.getByRole('button', { name: 'Stop all' }));
    expect(onStopAll).toHaveBeenCalled();
  });
});
