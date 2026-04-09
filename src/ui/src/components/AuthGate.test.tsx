// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AuthGate from './AuthGate';
import type { AuthState } from '../hooks/useApi';

vi.mock('../hooks/useApi', () => ({
  clearAccessToken: vi.fn(),
  useAuthState: vi.fn(),
  verifyAccessToken: vi.fn(),
}));

describe('AuthGate', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    const useApi = await import('../hooks/useApi');
    vi.mocked(useApi.useAuthState).mockReturnValue(makeAuthState());
  });

  it('shows token misconfiguration and disables unlock when no token is configured', async () => {
    const useApi = await import('../hooks/useApi');
    vi.mocked(useApi.useAuthState).mockReturnValue(makeAuthState({
      tokenConfigured: false,
    }));

    render(<AuthGate />);

    expect(screen.getByText(/no fallback token is configured/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'UNLOCK' })).toBeDisabled();
  });

  it('verifies the trimmed token entered by the user', async () => {
    const useApi = await import('../hooks/useApi');
    const user = userEvent.setup();
    render(<AuthGate />);

    await user.type(screen.getByPlaceholderText('Bearer token'), '  secret-token  ');
    await user.click(screen.getByRole('button', { name: 'UNLOCK' }));

    expect(useApi.verifyAccessToken).toHaveBeenCalledWith('secret-token');
  });

  it('clears the local token input and calls clearAccessToken', async () => {
    const useApi = await import('../hooks/useApi');
    vi.mocked(useApi.useAuthState).mockReturnValue(makeAuthState({
      token: 'stored-token',
      unauthorized: true,
    }));

    const user = userEvent.setup();
    render(<AuthGate />);

    const input = screen.getByPlaceholderText('Bearer token') as HTMLInputElement;
    expect(input.value).toBe('stored-token');

    await user.click(screen.getByRole('button', { name: 'CLEAR' }));

    expect(useApi.clearAccessToken).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('');
  });
});

function makeAuthState(overrides: Partial<AuthState> = {}): AuthState {
  return {
    method: 'token',
    tokenConfigured: true,
    token: null,
    unauthorized: false,
    loaded: true,
    ...overrides,
  };
}
