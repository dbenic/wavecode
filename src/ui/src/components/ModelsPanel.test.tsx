// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import ModelsPanel from './ModelsPanel';
import type { Agent } from '../types';

vi.mock('../hooks/useApi', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));

const AGENTS = [
  { id: 'a1', name: 'ultra-scout', alias: 'scout', runtime: 'codex', status: 'idle', model: 'gpt-6-astra', effort: 'high', profile: 'denis', live_model: { label: 'GPT-6.1-Sol', model: 'gpt-6.1-sol', effort: 'ultra' }, model_mismatch: true },
  { id: 'a2', name: 'codex2', alias: null, runtime: 'codex', status: 'working', model: null, effort: 'high', profile: 'denis2', live_model: { label: 'GPT-5.6-Sol', model: 'gpt-5.6-sol', effort: 'high' }, model_mismatch: false },
  { id: 'a3', name: 'claude1', alias: null, runtime: 'claude-code', status: 'idle', model: 'claude-opus-5-5', effort: 'high', profile: 'denis', live_model: null, model_mismatch: false },
  { id: 'a4', name: 'login-ales-codex', alias: null, runtime: 'codex', status: 'idle', model: null, effort: null, profile: 'ales', live_model: null, model_mismatch: false },
] as unknown as Agent[];

describe('ModelsPanel', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockResolvedValue(AGENTS as never);
  });

  it('lists every agent with its pin and what it runs, flags a drifted pin, and hides login seats', async () => {
    render(<ModelsPanel />);
    await waitFor(() => expect(screen.getByTestId('models-table')).toBeTruthy());
    const scout = screen.getByTestId('model-row-ultra-scout');
    expect(scout.textContent).toContain('gpt-6-astra high');
    expect(scout.textContent).toContain('GPT-6.1-Sol ultra ≠ pin');
    expect(within(scout).getByText('MODEL')).toBeTruthy();
    expect(screen.getByTestId('model-row-codex2').textContent).toContain('default high'); // effort pinned, model from the CLI
    expect(screen.getByTestId('model-row-claude1').textContent).toContain('not shown by the CLI');
    expect(screen.queryByTestId('model-row-login-ales-codex')).toBeNull();
    expect(screen.getByTestId('models-panel').textContent).toContain('1 running something other than their pin');
  });
});
