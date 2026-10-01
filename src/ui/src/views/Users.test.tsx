// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Users from './Users';
import type { User } from '../types';

vi.mock('../hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));

const owner: User = { id: 'owner', name: 'owner', role: 'admin', color: '#64748b', profile: null };
const ana: User = { id: 'u-ana', name: 'ana', role: 'developer', color: '#2563eb', profile: 'ana' };

async function setup(me: User) {
  const api = await import('../hooks/useApi');
  vi.mocked(api.apiGet).mockImplementation(async (path: string) => (path === '/me' ? me : [owner, ana]) as never);
  render(<MemoryRouter><Users /></MemoryRouter>);
  await screen.findByText('ana');
  return api;
}

describe('Users settings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('admin adds a user and sees the token once', async () => {
    const api = await setup(owner);
    vi.mocked(api.apiPost).mockResolvedValueOnce({ ...ana, id: 'u-bob', name: 'bob', token: 'wc_secret123' } as never);
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'bob');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Role' }), 'observer');
    await userEvent.click(screen.getByRole('button', { name: 'Add user' }));
    expect(api.apiPost).toHaveBeenCalledWith('/users', { name: 'bob', role: 'observer' });
    expect(await screen.findByTestId('new-token')).toHaveTextContent('wc_secret123');
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('');
  });

  it('admin revokes after confirming; the owner row has no revoke', async () => {
    const api = await setup(owner);
    expect(screen.getAllByRole('button', { name: 'Revoke' })).toHaveLength(1);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.apiDelete).toHaveBeenCalledWith('/users/u-ana'));
  });

  it('shows server errors', async () => {
    const api = await setup(owner);
    vi.mocked(api.apiPost).mockRejectedValueOnce(new Error("User 'ana' already exists"));
    await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'ana');
    await userEvent.click(screen.getByRole('button', { name: 'Add user' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("User 'ana' already exists");
  });

  it('non-admins see the list read-only', async () => {
    await setup(ana);
    expect(screen.queryByRole('form', { name: 'Add user' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    expect(screen.getByText('profile ana')).toBeInTheDocument();
    expect(screen.getByText('Only admins can add or revoke users.')).toBeInTheDocument();
  });
});
