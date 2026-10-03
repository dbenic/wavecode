// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import AgentView from './AgentView';
import type { SSEEvent } from '../hooks/useSSE';

vi.mock('../hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiUpload: vi.fn(),
}));

vi.mock('../hooks/useSSE', () => ({
  useSSE: vi.fn(),
}));

vi.mock('../utils/sanitize', () => ({
  sanitizeHtml: (value: string) => value,
}));

vi.mock('../components/StatusBadge', () => ({
  default: ({ status }: { status: string }) => <div>{status}</div>,
}));

vi.mock('../components/DecisionsBar', () => ({
  default: () => null,
}));

vi.mock('../components/AgentGuidesBar', () => ({
  default: () => null,
}));

describe('AgentView', () => {
  let sseHandler: ((event: SSEEvent) => void) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    sseHandler = null;

    const sse = await import('../hooks/useSSE');
    vi.mocked(sse.useSSE).mockImplementation((handler) => {
      sseHandler = handler;
    });
  });

  it('refreshes terminal output when a newer agent output version arrives over SSE', async () => {
    const useApi = await import('../hooks/useApi');

    let outputFetchCount = 0;
    vi.mocked(useApi.apiGet).mockImplementation(async (path: string) => {
      if (path === '/agents/agent-1') {
        return makeAgent({ outputVersion: 1 }) as never;
      }

      if (path === '/agents') {
        return [makeAgent({ outputVersion: 1 })] as never;
      }

      if (path === '/enhance/status') {
        return { available: false } as never;
      }

      if (path === '/agents/agent-1/output?lines=250&ansi=true') {
        outputFetchCount += 1;
        return {
          output: outputFetchCount === 1 ? 'Initial output line' : 'Updated output line',
          html: '',
        } as never;
      }

      // DecisionsBar fetches decisions for the agent's workspace
      if (path.startsWith('/decisions')) {
        return [] as never;
      }

      // AgentGuidesBar fetches guides
      if (path.startsWith('/agents/agent-1/guides') || path.startsWith('/guides')) {
        return [] as never;
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    render(
      <MemoryRouter initialEntries={['/agent/agent-1']}>
        <Routes>
          <Route path="/agent/:id" element={<AgentView />} />
          <Route path="/" element={<div>Dashboard</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Initial output line')).toBeInTheDocument();
    expect(sseHandler).toBeTruthy();

    await act(async () => {
      sseHandler?.(makeAgentEvent('agent.output_updated', {
        status: 'working',
        outputVersion: 2,
        lastOutputLine: 'Updated output line',
      }));
    });

    await waitFor(() => {
      expect(screen.getByText('Updated output line')).toBeInTheDocument();
    });
    expect(outputFetchCount).toBe(2);
  });

  it('the header badge says whose subscription the agent runs on (account · plan), falling back to the profile name', async () => {
    const useApi = await import('../hooks/useApi');
    const agent = { ...makeAgent(), runtime: 'claude-code', profile: 'denis', subscription: { account: 'denis@example.com', plan: 'Claude Max' } };
    vi.mocked(useApi.apiGet).mockImplementation(async (path: string) => {
      if (path === '/agents/agent-1') return agent as never;
      if (path === '/agents') return [agent] as never;
      if (path === '/enhance/status') return { available: false } as never;
      if (path.startsWith('/agents/agent-1/output')) return { output: '', html: '' } as never;
      return [] as never;
    });
    render(
      <MemoryRouter initialEntries={['/agent/agent-1']}>
        <Routes><Route path="/agent/:id" element={<AgentView />} /></Routes>
      </MemoryRouter>,
    );
    const badge = await screen.findByText('denis@example.com · Claude Max');
    expect(badge).toHaveAttribute('title', 'Subscription: denis@example.com · Claude Max (profile denis)');

    const { subscriptionLabel, modelBadge, prettyModel } = await import('./AgentView');
    expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(prettyModel('opus')).toBe('Opus');
    expect(prettyModel('gpt-5.3-codex')).toBe('GPT-5.3 Codex');
    expect(prettyModel('grok-4.6')).toBe('Grok 4.6');
    expect(prettyModel('something-else')).toBe('something-else');
    expect(modelBadge({ model: 'claude-opus-5-5', effort: 'xhigh', runtime_defaults: { model: 'opus', effort: 'low' } })).toEqual({ label: 'Opus 5.5 · xhigh', pinned: true });
    expect(modelBadge({ model: null, effort: null, runtime_defaults: { model: 'gpt-5.3-codex', effort: 'high' } })).toEqual({ label: 'GPT-5.3 Codex · high', pinned: false });
    expect(modelBadge({ model: null, effort: null, runtime_defaults: { model: null, effort: null } })).toBeNull();
    expect(subscriptionLabel({ profile: 'ana', subscription: { account: null, plan: null } })).toBe('ana');
    expect(subscriptionLabel({ profile: null, subscription: { account: null, plan: 'ChatGPT Plus' } })).toBe('ChatGPT Plus');
    expect(subscriptionLabel({ profile: null, subscription: undefined })).toBeNull();
  });

  it('uses attached workspace paths in both direct and AI sends', async () => {
    const user = userEvent.setup();
    const useApi = await import('../hooks/useApi');

    vi.mocked(useApi.apiGet).mockImplementation(async (path: string) => {
      if (path === '/agents/agent-1') {
        return makeAgent({ outputVersion: 1 }) as never;
      }

      if (path === '/agents') {
        return [makeAgent({ outputVersion: 1 })] as never;
      }

      if (path === '/enhance/status') {
        return { available: false } as never;
      }

      if (path === '/agents/agent-1/output?lines=250&ansi=true') {
        return {
          output: 'Initial output line',
          html: '',
        } as never;
      }

      if (path.startsWith('/decisions') || path.startsWith('/guides') || path.startsWith('/agents/agent-1/guides')) {
        return [] as never;
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    vi.mocked(useApi.apiUpload)
      .mockResolvedValueOnce({
        id: 'artifact-1',
        filename: 'brief.md',
        storage_path: '/artifact-store/brief.md',
        attached_path: '/workspace/agent-1/.wavecode/artifacts/brief.md',
      } as never)
      .mockResolvedValueOnce({
        id: 'artifact-2',
        filename: 'diagram.png',
        storage_path: '/artifact-store/diagram.png',
        attached_path: '/workspace/agent-1/.wavecode/artifacts/diagram.png',
      } as never);

    vi.mocked(useApi.apiPost).mockImplementation(async (path: string, body?: unknown) => {
      if (path === '/agents/agent-1/send') {
        expect(body).toEqual({
          text: expect.stringContaining('/workspace/agent-1/.wavecode/artifacts/brief.md'),
        });
        return { ok: true } as never;
      }

      if (path === '/chat/send') {
        expect(body).toEqual({
          message: expect.stringContaining('/workspace/agent-1/.wavecode/artifacts/diagram.png'),
        });
        return {
          reply: 'Attached file noted.',
          toolCalls: [],
        } as never;
      }

      throw new Error(`Unexpected path: ${path}`);
    });

    render(
      <MemoryRouter initialEntries={['/agent/agent-1']}>
        <Routes>
          <Route path="/agent/:id" element={<AgentView />} />
          <Route path="/" element={<div>Dashboard</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Initial output line')).toBeInTheDocument();

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, new File(['# Brief\n'], 'brief.md', { type: 'text/markdown' }));
    await waitFor(() => {
      expect(useApi.apiUpload).toHaveBeenCalledTimes(1);
    });

    await user.type(screen.getByPlaceholderText('Direct — sends to agent terminal...'), 'Summarize this');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    await waitFor(() => {
      expect(useApi.apiPost).toHaveBeenCalledWith('/agents/agent-1/send', {
        text: expect.stringContaining('/workspace/agent-1/.wavecode/artifacts/brief.md'),
      });
    });

    await user.upload(fileInput, new File(['png'], 'diagram.png', { type: 'image/png' }));
    await waitFor(() => {
      expect(useApi.apiUpload).toHaveBeenCalledTimes(2);
    });

    await user.click(screen.getByTitle('Direct mode: sends to agent terminal'));
    await user.type(screen.getByPlaceholderText('AI mode — use @agent to coordinate, ask questions...'), 'Review this too');
    await user.click(screen.getByRole('button', { name: 'SEND' }));

    await waitFor(() => {
      expect(useApi.apiPost).toHaveBeenCalledWith('/chat/send', {
        message: expect.stringContaining('/workspace/agent-1/.wavecode/artifacts/diagram.png'),
      });
    });
  });
});

function makeAgent(overrides: Partial<{
  outputVersion: number;
}> = {}) {
  return {
    id: 'agent-1',
    name: 'Agent One',
    runtime: 'codex',
    tmux_session: 'wave-agent-1',
    workspace: '/workspace/agent-1',
    mode: 'spawned' as const,
    status: 'idle' as const,
    created_at: '2026-04-03T00:00:00Z',
    outputVersion: 0,
    ...overrides,
  };
}

function makeAgentEvent(type: string, payload: Record<string, unknown>): SSEEvent {
  return {
    id: 1,
    type,
    entityType: 'agent',
    entityId: 'agent-1',
    payload,
    createdAt: '2026-04-03T00:00:00Z',
  };
}
