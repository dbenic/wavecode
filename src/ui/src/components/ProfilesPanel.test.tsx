// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ProfilesPanel from './ProfilesPanel';
import type { ProfileInfo } from '../types';
import type { SSEEvent } from '../hooks/useSSE';

vi.mock('../hooks/useApi', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
let sseHandler: ((e: SSEEvent) => void) | null = null;
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn((h: (e: SSEEvent) => void) => { sseHandler = h; }) }));

const PROFILES: ProfileInfo[] = [
  { name: 'antonio', shared: false, public: false, mine: true, can_login: true, runtimes: {
    'claude-code': { logged_in: false, subscription: null, login_seat: null, agents: 0 },
    codex: { logged_in: true, subscription: { account: 'antonio@countix.ai', plan: 'ChatGPT Pro' }, login_seat: null, agents: 2 },
  } },
  { name: 'denis', shared: false, public: true, mine: false, can_login: false, runtimes: {
    'claude-code': { logged_in: true, subscription: { account: 'denis@countix.ai', plan: 'max' }, login_seat: null, agents: 2 },
    codex: { logged_in: true, subscription: null, login_seat: null, agents: 3 },
  } },
];

describe('ProfilesPanel', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sseHandler = null;
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => (p === '/profiles' ? PROFILES : { open: true, agent_id: 'seat-1', url: 'https://claude.com/cai/oauth/authorize?x=1', code: null, awaiting_code: true, tail: ['Paste code here if prompted >'] }) as never);
    vi.mocked(api.apiPost).mockResolvedValue({ agent: { id: 'seat-1' }, session: 'wc-login-antonio-claude-code', expires_at: '2026-10-11T10:15:00Z' } as never);
  });

  it('shows per profile and CLI whether it is logged in, the account and plan, the agent count, and LOG IN only where the person may', async () => {
    render(<ProfilesPanel />);
    await waitFor(() => expect(screen.getByTestId('profiles-table')).toBeTruthy());
    const mine = screen.getByTestId('profile-antonio');
    expect(mine.textContent).toContain('you');
    expect(mine.textContent).toContain('not logged in');
    expect(within(mine).getByText('LOG IN')).toBeTruthy();
    expect(mine.textContent).toContain('antonio@countix.ai · ChatGPT Pro');
    expect(mine.textContent).toContain('2 agents');
    const pool = screen.getByTestId('profile-denis');
    expect(pool.textContent).toContain('pool');
    expect(within(pool).queryByText('LOG IN')).toBeNull();
  });

  it('LOG IN opens the seat, shows the device code from its pane, and reports the outcome from the login_finished event', async () => {
    const api = await import('../hooks/useApi');
    render(<ProfilesPanel />);
    await waitFor(() => expect(screen.getByTestId('profiles-table')).toBeTruthy());
    fireEvent.click(within(screen.getByTestId('profile-antonio')).getByText('LOG IN'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/profiles/antonio/login', { runtime: 'claude-code' }));
    await waitFor(() => expect(within(screen.getByTestId('login-wizard')).getByText('OPEN SIGN-IN LINK').getAttribute('href')).toBe('https://claude.com/cai/oauth/authorize?x=1'));
    expect(vi.mocked(api.apiGet)).toHaveBeenCalledWith('/profiles/antonio/login/claude-code');
    fireEvent.change(screen.getByLabelText('Login code'), { target: { value: 'abc#123' } });
    fireEvent.click(screen.getByText('SEND'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/profiles/antonio/login/claude-code/code', { code: 'abc#123' }));
    sseHandler?.({ id: 1, type: 'profile.login_finished', entityType: 'agent', entityId: 'seat-1', payload: { profile: 'antonio', runtime: 'claude-code', logged_in: true, reason: 'exited' }, createdAt: '' } as SSEEvent);
    await waitFor(() => expect(screen.getByTestId('login-wizard').textContent).toContain('Logged in. Agents on this profile can start now.'));
  });
});
