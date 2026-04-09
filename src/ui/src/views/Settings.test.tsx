// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Settings from './Settings';

vi.mock('../hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
}));

describe('Settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('loads and renders system settings details', async () => {
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
      if (path === '/providers') return { anthropic: true, openai: false, gemini: false, perplexity: false, xai: false } as never;
      return makeSettings() as never;
    });

    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    expect(await screen.findByText('localhost:3777')).toBeInTheDocument();
    expect(screen.getByText('token')).toBeInTheDocument();
    expect(screen.getByText('codex, claude-code')).toBeInTheDocument();
    expect(screen.getByText('/tmp/wavecode/worktrees')).toBeInTheDocument();
  });

  it('saves a replacement API key and refreshes the page state', async () => {
    const api = await import('../hooks/useApi');
    const user = userEvent.setup();
    let settingsFetchCount = 0;

    vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
      if (path === '/providers') return { anthropic: false, openai: false, gemini: false, perplexity: false, xai: false } as never;
      if (path !== '/settings') throw new Error(`Unexpected path: ${path}`);
      settingsFetchCount += 1;
      return (settingsFetchCount === 1
        ? makeSettings({ llm: { has_key: false, api_key: null } })
        : makeSettings({ llm: { has_key: true, api_key: '••••12345678' } })) as never;
    });
    vi.mocked(api.apiPut).mockResolvedValue({ ok: true } as never);

    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    await screen.findByText('Settings');
    await user.type(screen.getByLabelText('Anthropic API Key'), 'sk-ant-secret');
    await user.click(screen.getAllByRole('button', { name: 'SAVE' })[0]);

    await waitFor(() => {
      expect(api.apiPut).toHaveBeenCalledWith('/settings/api-key', { key: 'sk-ant-secret', provider: 'anthropic' });
    });
    await waitFor(() => {
      expect(screen.getByText(/saved successfully/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/api key configured/i)).toBeInTheDocument();
    expect(settingsFetchCount).toBe(2);
  });

  it('persists provider, base URL, and model through the settings API', async () => {
    const api = await import('../hooks/useApi');
    const user = userEvent.setup();

    vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
      if (path === '/providers') return { anthropic: true, openai: false, gemini: false, perplexity: false, xai: false } as never;
      return makeSettings() as never;
    });
    vi.mocked(api.apiPut).mockResolvedValue({ ok: true } as never);

    render(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>,
    );

    const providerSelect = await screen.findByLabelText('Provider');
    expect(providerSelect).toHaveValue('anthropic');
    await user.selectOptions(providerSelect, 'openai-compatible');
    await user.type(screen.getByLabelText('Base URL'), 'http://127.0.0.1:11434/v1');
    const modelInput = screen.getByLabelText('Model');
    await user.clear(modelInput);
    await user.type(modelInput, 'gemma4');
    await user.click(screen.getAllByRole('button', { name: 'SAVE' })[1]);

    await waitFor(() => {
      expect(api.apiPut).toHaveBeenCalledWith('/settings', {
        llm: {
          provider: 'openai-compatible',
          base_url: 'http://127.0.0.1:11434/v1',
          model: 'gemma4',
        },
      });
    });
  });
});

function makeSettings(overrides: Partial<{
  llm: Partial<{
    api_key: string | null;
    has_key: boolean;
    configured: boolean;
    base_url: string | null;
    provider: string;
    model: string;
  }>;
}> = {}) {
  return {
    server: { port: 3777, host: 'localhost' },
    paths: {
      worktrees_root: '/tmp/wavecode/worktrees',
      transcripts_root: '/tmp/wavecode/transcripts',
      teams_root: '/tmp/wavecode/teams',
    },
    auth: { method: 'token', tokenConfigured: true },
    autonomy: {
      auto_dispatch: true,
      auto_restart: true,
      hang_timeout_min: 10,
      max_task_retries: 2,
    },
    llm: {
      provider: 'anthropic',
      api_key: '••••abcd1234',
      has_key: true,
      configured: true,
      base_url: null,
      model: 'claude-sonnet-4-20250514',
      anthropic_api_key: null,
      openai_api_key: null,
      gemini_api_key: null,
      perplexity_api_key: null,
      xai_api_key: null,
      ...overrides.llm,
    },
    notifications: {
      web_push: false,
      ntfy_topic: null,
      telegram_bot_token: null,
    },
    artifacts: {
      storage: '/tmp/wavecode/artifacts',
      retention_days: 30,
    },
    runtimes: ['codex', 'claude-code'],
  };
}
