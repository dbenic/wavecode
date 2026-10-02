// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import MySeat from './MySeat';

vi.mock('../hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(async () => ({ ok: true, mcp: { registered: true } })),
  apiPut: vi.fn(async () => ({ rules: '' })),
  apiDelete: vi.fn(async () => ({ ok: true })),
}));

type Seat = Record<string, unknown>;
let seat: Seat;

async function setup(initial: Seat) {
  seat = initial;
  const api = await import('../hooks/useApi');
  vi.mocked(api.apiGet).mockImplementation(async () => seat as never);
  render(<MemoryRouter><MySeat /></MemoryRouter>);
  await screen.findByRole('heading', { name: 'My seat' });
  return api;
}

const OK = {
  status: 'ok', eligible: true, rules: 'always answer in Slovene', has_token: true,
  agent: { id: 'a1', name: 'pm-ana', runtime: 'claude-code', status: 'idle', profile: 'ana' },
};

describe('Settings → My seat (spec §5d)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('no seat: create it with a runtime', async () => {
    const api = await setup({ status: 'none', eligible: true, rules: null, has_token: false });
    expect(await screen.findByText(/You have no seat yet/)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Runtime'), 'codex');
    await userEvent.click(screen.getByRole('button', { name: 'Create my seat' }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/users/me/seat', { runtime: 'codex' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Seat created');
  });

  it('a seat created without MCP registration says so', async () => {
    const api = await setup({ status: 'missing', agent_id: 'a1', eligible: true, rules: null, has_token: false });
    vi.mocked(api.apiPost).mockResolvedValueOnce({ mcp: { registered: false, error: 'Codex seats need a credential profile' } } as never);
    await userEvent.click(screen.getByRole('button', { name: 'Recreate my seat' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('MCP was not registered: Codex seats need a credential profile');
  });

  it('edits rules and re-briefs', async () => {
    const api = await setup(OK);
    expect(await screen.findByText(/pm-ana/)).toBeInTheDocument();
    const box = screen.getByLabelText(/Standing rules/);
    expect(box).toHaveValue('always answer in Slovene');
    await userEvent.clear(box);
    await userEvent.type(box, 'never promote without asking me');
    await userEvent.click(screen.getByRole('button', { name: 'Save & re-brief' }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/users/me/seat/brief'));
    expect(api.apiPut).toHaveBeenCalledWith('/users/me/seat/rules', { rules: 'never promote without asking me' });
    expect(await screen.findByRole('status')).toHaveTextContent('re-briefed');
  });

  it('revokes (after confirming) and rotates the seat token', async () => {
    const api = await setup(OK);
    await screen.findByText(/Seat token: active/);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke seat token' }));
    expect(api.apiDelete).not.toHaveBeenCalled();
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Revoke seat token' }));
    await waitFor(() => expect(api.apiDelete).toHaveBeenCalledWith('/users/me/seat/token'));

    await userEvent.click(screen.getByRole('button', { name: 'Rotate token' }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/users/me/seat/token'));
  });

  it('observers have no seat', async () => {
    await setup({ status: 'none', eligible: false, rules: null, has_token: false });
    expect(await screen.findByText(/Observers have no orchestrator seat/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create my seat/ })).toBeNull();
  });
});
