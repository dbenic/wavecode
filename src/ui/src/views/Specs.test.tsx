// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Specs from './Specs';
import type { SSEEvent } from '../hooks/useSSE';

vi.mock('../hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock('../hooks/useSSE', () => ({
  useSSE: vi.fn(),
}));

vi.mock('../utils/markdown', () => ({
  renderMarkdown: (value: string) => value,
}));

describe('Specs', () => {
  let sseHandler: ((event: SSEEvent) => void) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    sseHandler = null;

    const sse = await import('../hooks/useSSE');
    vi.mocked(sse.useSSE).mockImplementation((handler) => {
      sseHandler = handler;
    });
  });

  it('shows only models for configured providers in the new-spec modal', async () => {
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
      if (path === '/specs') return [] as never;
      if (path === '/agents') return [] as never;
      if (path === '/providers') {
        return { anthropic: false, openai: true, gemini: false, perplexity: false, xai: false } as never;
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Specs />
      </MemoryRouter>,
    );

    await screen.findByText('No specs yet');
    await user.click(screen.getByRole('button', { name: '+ NEW SPEC' }));

    await waitFor(() => {
      const optionLabels = screen.getAllByRole('option').map((option) => option.textContent ?? '');
      expect(optionLabels.some((label) => label.includes('GPT-5.4 ($5/$20/M)'))).toBe(true);
      expect(optionLabels.some((label) => label.includes('Claude Sonnet 4.5'))).toBe(false);
    });
  });

  it('creates a research run from the modal and selects the returned spec', async () => {
    const api = await import('../hooks/useApi');
    const user = userEvent.setup();

    vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
      if (path === '/specs') return [] as never;
      if (path === '/agents') return [makeAgent({ id: 'agent-1', name: 'builder' })] as never;
      if (path === '/providers') {
        return { anthropic: true, openai: false, gemini: false, perplexity: false, xai: false } as never;
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    vi.mocked(api.apiPost).mockImplementation(async (path: string, body?: unknown) => {
      if (path !== '/specs') throw new Error(`Unexpected path: ${path}`);
      expect(body).toEqual({
        prompt: 'Research auth hardening',
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
        target_agent_id: 'agent-1',
      });
      return makeRun({
        id: 'run-1',
        title: 'Research auth hardening',
        prompt: 'Research auth hardening',
        status: 'running',
        target_agent_id: 'agent-1',
      }) as never;
    });

    render(
      <MemoryRouter>
        <Specs />
      </MemoryRouter>,
    );

    await screen.findByText('No specs yet');
    await user.click(screen.getByRole('button', { name: '+ NEW SPEC' }));
    await user.type(screen.getByPlaceholderText(/Research rate-limiting strategies/i), 'Research auth hardening');
    await user.selectOptions(screen.getByLabelText('Attach to agent'), 'agent-1');
    await user.click(screen.getByRole('button', { name: 'Run Research' }));

    await waitFor(() => {
      expect(api.apiPost).toHaveBeenCalledWith('/specs', {
        prompt: 'Research auth hardening',
        model: 'claude-sonnet-4-5',
        provider: 'anthropic',
        target_agent_id: 'agent-1',
      });
    });
    expect(await screen.findByText('Research auth hardening')).toBeInTheDocument();
  });

  it('attaches a completed spec to an agent from the detail view', async () => {
    const api = await import('../hooks/useApi');
    const user = userEvent.setup();

    vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
      if (path === '/specs') {
        return [makeRun({
          id: 'run-2',
          title: 'Auth rollout',
          status: 'done',
          output_md: '# Auth rollout',
        })] as never;
      }
      if (path === '/agents') {
        return [makeAgent({ id: 'agent-9', name: 'reviewer' })] as never;
      }
      if (path === '/providers') {
        return { anthropic: true, openai: true, gemini: false, perplexity: false, xai: false } as never;
      }
      if (path === '/specs/run-2') {
        return makeRun({
          id: 'run-2',
          title: 'Auth rollout',
          status: 'done',
          output_md: '# Auth rollout',
          target_agent_id: 'agent-9',
        }) as never;
      }
      throw new Error(`Unexpected path: ${path}`);
    });
    vi.mocked(api.apiPost).mockImplementation(async (path: string, body?: unknown) => {
      if (path !== '/specs/run-2/attach') throw new Error(`Unexpected path: ${path}`);
      expect(body).toEqual({ agent_id: 'agent-9' });
      return { ok: true, artifact_id: 'artifact-1' } as never;
    });

    render(
      <MemoryRouter>
        <Specs />
      </MemoryRouter>,
    );

    await screen.findByText('Auth rollout');
    await user.click(screen.getByText('Auth rollout'));
    await user.click(screen.getByRole('button', { name: /ATTACH/i }));
    await user.click(screen.getByRole('button', { name: /^Attach$/ }));

    await waitFor(() => {
      expect(api.apiPost).toHaveBeenCalledWith('/specs/run-2/attach', { agent_id: 'agent-9' });
    });
  });

  it('applies SSE research chunks to the selected run output', async () => {
    const api = await import('../hooks/useApi');
    const user = userEvent.setup();

    vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
      if (path === '/specs') {
        return [makeRun({
          id: 'run-3',
          title: 'Live spec',
          status: 'running',
          output_md: 'Intro\n',
        })] as never;
      }
      if (path === '/agents') return [] as never;
      if (path === '/providers') {
        return { anthropic: true, openai: true, gemini: false, perplexity: false, xai: false } as never;
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    render(
      <MemoryRouter>
        <Specs />
      </MemoryRouter>,
    );

    await screen.findByText('Live spec');
    await user.click(screen.getByText('Live spec'));
    expect(await screen.findByText('Intro')).toBeInTheDocument();

    await act(async () => {
      sseHandler?.({
        id: 7,
        type: 'research.chunk',
        entityType: 'research_run',
        entityId: 'run-3',
        payload: { chunk: 'More findings\n' },
        createdAt: '2026-04-09T00:00:00Z',
      });
    });

    await waitFor(() => {
      expect(screen.getByText(/Intro[\s\S]*More findings/i)).toBeInTheDocument();
    });
  });
});

function makeAgent(overrides: Partial<{
  id: string;
  name: string;
}> = {}) {
  return {
    id: 'agent-1',
    name: 'builder',
    runtime: 'codex',
    tmux_session: 'wc-builder',
    workspace: '/workspace/builder',
    mode: 'spawned' as const,
    status: 'idle' as const,
    created_at: '2026-04-09T00:00:00Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<{
  id: string;
  title: string;
  prompt: string;
  provider: string;
  model: string;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  output_md: string;
  target_agent_id: string | null;
}> = {}) {
  return {
    id: 'run-1',
    title: 'Research task',
    prompt: 'Research task',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    status: 'running' as const,
    output_md: '',
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    error: null,
    target_agent_id: null,
    artifact_id: null,
    parent_run_id: null,
    created_at: '2026-04-09T00:00:00Z',
    finished_at: null,
    ...overrides,
  };
}
