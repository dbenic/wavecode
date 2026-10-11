// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import type { SSEEvent } from '../hooks/useSSE';
import type { Agent } from '../types';

vi.mock('../hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock('../hooks/useSSE', () => ({
  useSSE: vi.fn(),
}));

vi.mock('../components/AgentCard', () => ({
  default: ({ agent }: { agent: { name: string; status: string; lastOutputLine?: string } }) => (
    <div>{`${agent.name}|${agent.status}|${agent.lastOutputLine ?? ''}`}</div>
  ),
}));

describe('Dashboard', () => {
  let sseHandler: ((event: SSEEvent) => void) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    sseHandler = null;

    const sse = await import('../hooks/useSSE');
    vi.mocked(sse.useSSE).mockImplementation((handler) => {
      sseHandler = handler;
    });
  });

  it('patches agent status locally and removes detached agents from the grid', async () => {
    const api = await import('../hooks/useApi');

    vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
      if (path !== '/agents') throw new Error(`Unexpected path: ${path}`);
      return [makeAgent({ id: 'agent-1', name: 'alpha', status: 'idle', lastOutputLine: 'ready' })] as never;
    });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(await screen.findByText('alpha|idle|ready')).toBeInTheDocument();

    await act(async () => {
      sseHandler?.(makeAgentEvent('agent.status_changed', 'agent-1', {
        status: 'working',
        lastOutputLine: 'compiling',
      }));
    });

    expect(screen.getByText('alpha|working|compiling')).toBeInTheDocument();

    await act(async () => {
      sseHandler?.(makeAgentEvent('agent.detached', 'agent-1', null));
    });

    await waitFor(() => {
      expect(screen.queryByText('alpha|working|compiling')).not.toBeInTheDocument();
    });
  });

  it('refetches the agent list when a spawned agent arrives over SSE', async () => {
    const api = await import('../hooks/useApi');
    let fetchCount = 0;

    vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
      if (path !== '/agents') throw new Error(`Unexpected path: ${path}`);
      fetchCount += 1;
      return (fetchCount === 1
        ? [makeAgent({ id: 'agent-1', name: 'alpha' })]
        : [makeAgent({ id: 'agent-1', name: 'alpha' }), makeAgent({ id: 'agent-2', name: 'beta' })]) as never;
    });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    expect(await screen.findByText('alpha|idle|ready')).toBeInTheDocument();

    await act(async () => {
      sseHandler?.(makeAgentEvent('agent.spawned', 'agent-2', { name: 'beta' }));
    });

    await waitFor(() => {
      expect(screen.getByText('beta|idle|ready')).toBeInTheDocument();
    });
    expect(fetchCount).toBe(2);
  });

  it('spawns an agent from the dashboard modal', async () => {
    const user = userEvent.setup();
    const api = await import('../hooks/useApi');

    vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
      if (path === '/settings') return { runtimes: ['claude-code', 'codex'], projects: [{ name: 'wavepulse', repo: '/home/wave/repos/wavepulse' }], spawn: { max_per_user: 4 } } as never;
      if (path === '/profiles') return [{ name: 'ana', shared: false, public: false, mine: true, can_login: true, runtimes: { 'claude-code': { logged_in: false, subscription: null, login_seat: null, agents: 0 }, codex: { logged_in: true, subscription: { account: 'ana@countix.ai', plan: 'ChatGPT Pro' }, login_seat: null, agents: 1 } } }] as never;
      if (path === '/me') return { name: 'ana', role: 'developer', profile: 'ana' } as never;
      return [] as never;
    });
    vi.mocked(api.apiPost).mockImplementation(async (path: string, body?: unknown) => {
      if (path === '/agents/spawn') {
        expect(body).toEqual({
          name: 'co-builder',
          runtime: 'codex',
          repo: '/tmp/project-x',
        });
        return makeAgent({
          id: 'agent-9',
          name: 'co-builder',
          workspace: '/tmp/project-x',
        }) as never;
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await screen.findByText('No agents managed');

    await user.click(screen.getByRole('button', { name: 'Spawn Agent' }));
    const modal = await screen.findByTestId('spawn-modal');
    // the project select prefilled the repo from the configured base clone
    await waitFor(() => expect((within(modal).getByLabelText('Repo') as HTMLInputElement).value).toBe('/home/wave/repos/wavepulse'));
    // Claude Code is not logged in on this profile: the form says so and refuses to spawn
    await user.selectOptions(within(modal).getByLabelText('Runtime'), 'claude-code');
    expect(within(modal).getByTestId('spawn-subscription').textContent).toContain('not logged in');
    expect((within(modal).getByRole('button', { name: /^Spawn Agent$/ }) as HTMLButtonElement).disabled).toBe(true);
    // Codex is logged in: the account and plan show, the quota too
    await user.selectOptions(within(modal).getByLabelText('Runtime'), 'codex');
    expect(within(modal).getByTestId('spawn-subscription').textContent).toContain('ana@countix.ai · ChatGPT Pro');
    expect(within(modal).getByTestId('spawn-subscription').textContent).toContain('1 of 4 agents');
    await user.clear(within(modal).getByLabelText('Name'));
    await user.type(within(modal).getByLabelText('Name'), 'co-builder');
    await user.clear(within(modal).getByLabelText('Repo'));
    await user.type(within(modal).getByLabelText('Repo'), '/tmp/project-x');
    await user.click(within(modal).getByRole('button', { name: /^Spawn Agent$/ }));

    await waitFor(() => {
      expect(api.apiPost).toHaveBeenCalledWith('/agents/spawn', {
        name: 'co-builder',
        runtime: 'codex',
        repo: '/tmp/project-x',
      });
    });
  });
});

function makeAgent(overrides: Partial<Agent> = {}) {
  return {
    id: 'agent-1',
    name: 'alpha',
    runtime: 'codex',
    tmux_session: 'wc-alpha',
    workspace: '/workspace/alpha',
    mode: 'spawned' as const,
    status: 'idle' as const,
    created_at: '2026-04-04T00:00:00Z',
    lastOutputLine: 'ready',
    ...overrides,
  };
}

function makeAgentEvent(
  type: string,
  entityId: string,
  payload: Record<string, unknown> | null,
): SSEEvent {
  return {
    id: 1,
    type,
    entityType: 'agent',
    entityId,
    payload,
    createdAt: '2026-04-04T00:00:00Z',
  };
}
