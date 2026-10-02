// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import CommandCenter from './CommandCenter';
import { TASK_DRAG_TYPE } from '../components/command-center/Roster';
import type { SSEEvent } from '../hooks/useSSE';
import type { Agent, ThreadItem, User } from '../types';

vi.mock('../hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(async () => ({ ok: true })),
  apiPut: vi.fn(async () => ({ ok: true })),
  apiPatch: vi.fn(async () => ({ ok: true })),
  apiUpload: vi.fn(async () => ({ id: 'art-1' })),
}));

vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));

const ana: User = { id: 'u-ana', name: 'ana', role: 'developer', color: '#2563eb' };

function agent(over: Partial<Agent>): Agent {
  return {
    id: over.name!, name: 'x', runtime: 'grok', tmux_session: 'wc', workspace: null,
    mode: 'spawned', status: 'idle', model: null, effort: null, created_at: '', can_act: true, ...over,
  };
}

function item(over: Partial<ThreadItem>): ThreadItem {
  return {
    id: `ev-${over.event_id}`, event_id: 1, at: '2026-10-01 10:00:00', kind: 'report', type: 'x',
    agent_id: 'grok-fe', actor_id: null, title: 't', body: null, refs: {}, needs_attention: false, actions: [], ...over,
  };
}

let sseHandler: ((e: SSEEvent) => void) | null = null;
let threadPages: Array<{ items: ThreadItem[]; cursor: number }> = [];

async function setup(me: User = ana) {
  const api = await import('../hooks/useApi');
  vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
    if (path === '/me') return me as never;
    if (path === '/users') return [ana, { id: 'u-bob', name: 'bob', role: 'developer', color: '#16a34a' }] as never;
    if (path === '/artifacts') return [{ id: 'art-7', filename: 'mockup.png' }] as never;
    if (path === '/agents') return [
      agent({ name: 'grok-fe', owner_id: 'u-ana', owner: 'ana' }),
      agent({ name: 'codex-rev' }),
      agent({ name: 'claude-fe-1', alias: 'toni', tags: ['frontend'] }),
      agent({ name: 'grok-fe-2', alias: 'mia', tags: ['frontend'] }),
      agent({ name: 'pm', orchestrator: true, role: 'orchestrator' }),
    ] as never;
    if (path === '/tasks') return [{ id: 'task-1', agent_id: null, prompt: 'T5 UI', status: 'pending', priority: 0, created_at: new Date().toISOString(), created_by: 'u-ana' }] as never;
    if (path === '/reviews') return [{}, {}] as never;
    if (path.startsWith('/thread')) return (threadPages.shift() ?? { items: [], cursor: 99 }) as never;
    if (path.startsWith('/agents/grok-fe/output')) return { output: '$ npm test\n✓ ok' } as never;
    if (path === '/runs/run-1/log') return { log: 'full run log' } as never;
    throw new Error(`unexpected GET ${path}`);
  });
  render(<MemoryRouter><CommandCenter /></MemoryRouter>);
  await screen.findByText('Report one');
  return api;
}

describe('CommandCenter', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sseHandler = null;
    const sse = await import('../hooks/useSSE');
    vi.mocked(sse.useSSE).mockImplementation((h) => { sseHandler = h; });
    threadPages = [{
      cursor: 10,
      items: [
        item({ event_id: 1, title: 'Report one', body: 'auth done' }),
        item({ event_id: 2, kind: 'request', title: 'Question', needs_attention: true, refs: { task_id: 'task-1' },
          actions: [{ id: 'reply', label: 'Reply', method: 'POST', path: '/api/messages', body: { to: 'grok-fe', message: '{text}', ref_task_id: 'task-1' } }] }),
        item({ event_id: 3, kind: 'run', title: 'Run failed', agent_id: 'codex-rev', needs_attention: true, refs: { run_id: 'run-1' },
          actions: [
            { id: 'open_log', label: 'Open log', method: 'GET', path: '/api/runs/run-1/log' },
            { id: 'hand_off', label: 'Hand off', method: 'POST', path: '/api/reviews/run-1/handoff', body: { targetAgentId: '{agent_id}' } },
          ] }),
      ],
    }];
  });

  it('with no target selected, a question goes to the orchestrator seat (Ask mode)', async () => {
    const api = await setup();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Target' })).toHaveValue('pm'));
    expect(screen.getByRole('radio', { name: 'Ask' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'what is chatgpt-countix doing?{Enter}');
    expect(api.apiPost).toHaveBeenCalledWith('/agents/pm/send', { text: 'what is chatgpt-countix doing?' });
  });

  it('a target the user picked is kept when agents reload', async () => {
    await setup();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Target' }), 'codex-rev');
    await act(async () => {
      sseHandler?.({ id: 50, type: 'agent.updated', entityType: 'agent', entityId: 'pm', payload: {}, createdAt: '' });
    });
    expect(screen.getByRole('combobox', { name: 'Target' })).toHaveValue('codex-rev');
  });

  it('a reply bubble sits directly under its prompt; tapping a chip sends the option to the seat', async () => {
    threadPages = [{ cursor: 30, items: [
      item({ event_id: 1, title: 'Report one' }),
      item({ event_id: 20, kind: 'prompt', title: 'Prompt sent', agent_id: 'pm', actor_id: 'u-ana', body: 'what is chatgpt-countix doing?' }),
      item({ event_id: 21, kind: 'run', title: 'Run started', agent_id: 'codex-rev' }),
      item({ event_id: 22, kind: 'reply', title: 'Reply', agent_id: 'pm', needs_attention: true, refs: { prompt_event_id: 20 },
        body: 'It is running invoices.\nReview Codex2 now?\n[ ] Review now\n[ ] Hold',
        actions: [
          { id: 'quick_reply', label: 'Review now', method: 'POST', path: '/api/agents/pm/send', body: { text: 'Review now' } },
          { id: 'quick_reply', label: 'Hold', method: 'POST', path: '/api/agents/pm/send', body: { text: 'Hold' } },
        ] }),
    ] }];
    const api = await setup();
    const order = screen.getAllByTestId(/^thread-item-/).map((el) => el.getAttribute('data-testid'));
    expect(order).toEqual(['thread-item-1', 'thread-item-20', 'thread-item-22', 'thread-item-21']);

    await userEvent.click(within(screen.getByTestId('thread-item-22')).getByRole('button', { name: 'Hold' }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/agents/pm/send', { text: 'Hold' }));
    expect(screen.getByRole('button', { name: /Attention/ })).toHaveTextContent('●1');
  });

  describe('§5c grammar end to end (each line → existing routes)', () => {
    async function say(text: string) {
      const box = screen.getByRole('textbox', { name: 'Message' });
      await userEvent.type(box, `${text}{Escape}{Enter}`);
    }

    it('#reserve @toni 2h reserves in one request', async () => {
      const api = await setup();
      await say('#reserve @toni 2h');
      await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/agents/claude-fe-1/reserve', { hours: 2 }));
      expect(vi.mocked(api.apiPost).mock.calls.filter(([p]) => String(p).includes('/reserve'))).toHaveLength(1);
    });

    it("@toni @mia review each other's lane → two pane sends", async () => {
      const api = await setup();
      await say("@toni @mia review each other's lane");
      await waitFor(() => expect(vi.mocked(api.apiPost).mock.calls.filter(([p]) => String(p).endsWith('/send'))).toEqual([
        ['/agents/claude-fe-1/send', { text: "review each other's lane" }],
        ['/agents/grok-fe-2/send', { text: "review each other's lane" }],
      ]));
    });

    it('an unknown #foo goes to the orchestrator seat unchanged', async () => {
      const api = await setup();
      await say('#foo bar');
      await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/agents/pm/send', { text: '#foo bar' }));
    });

    it('@frontend sends to both tagged agents', async () => {
      const api = await setup();
      await say('@frontend ship it');
      await waitFor(() => expect(vi.mocked(api.apiPost).mock.calls.filter(([p]) => String(p).endsWith('/send')).map(([p]) => p))
        .toEqual(['/agents/claude-fe-1/send', '/agents/grok-fe-2/send']));
    });

    it('#status, @all, @person, #task, #promote, #file, #tag, #release', async () => {
      const api = await setup();
      await say('#status');
      await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/agents/pm/send', { text: expect.stringMatching(/status/i) }));
      await say('@all standup in 5');
      await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/messages', { message: 'standup in 5', message_type: 'info' }));
      await say('@bob please approve T7');
      await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/messages', { to_user: 'bob', message: 'please approve T7' }));
      await say('#task @mia polish the header');
      await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/tasks', { prompt: 'polish the header', agent_id: 'grok-fe-2' }));
      await say('#file @toni mockup.png');
      await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/artifacts/art-7/share', { targetAgentId: 'claude-fe-1' }));
      await say('#tag @toni frontend');
      await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/agents/claude-fe-1/tags', { tag: 'frontend' }));
      await say('#release @toni');
      await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/agents/claude-fe-1/release'));
      await say('#promote #3');
      // task #3 is not known → unparseable → seat, unchanged
      await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/agents/pm/send', { text: '#promote #3' }));
    });

    it('roster Rename sets alias and persona', async () => {
      const api = await setup();
      vi.spyOn(window, 'prompt').mockReturnValueOnce('rex').mockReturnValueOnce('backend lead');
      await userEvent.click(within(screen.getByTestId('roster-codex-rev')).getByRole('button', { name: 'Rename' }));
      await waitFor(() => expect(api.apiPatch).toHaveBeenCalledWith('/agents/codex-rev', { alias: 'rex', persona: 'backend lead' }));
    });
  });

  describe('collapsible Board and Roster (spec §4.4)', () => {
    const grid = () => screen.getByTestId('command-center-grid').className;

    it('defaults to the 40px rail with badges when the viewer owns no running task; click expands, ▸ collapses', async () => {
      await setup();
      const rail = within(screen.getByTestId('board-rail'));
      expect(rail.getByLabelText('Open tasks: 1')).toBeInTheDocument();
      expect(rail.getByLabelText('Pending reviews: 2')).toBeInTheDocument();
      expect(rail.getByLabelText('Attention: 2')).toBeInTheDocument();
      expect(grid()).toContain('min-[1101px]:grid-cols-[16rem_minmax(0,1fr)_40px]');
      expect(screen.getByTestId('board-full').className).toContain('sm:hidden'); // phones still get the board tab

      await userEvent.click(rail.getByRole('button', { name: 'Expand board' }));
      expect(screen.queryByTestId('board-rail')).toBeNull();
      expect(grid()).toContain('min-[1101px]:grid-cols-[16rem_minmax(0,1fr)_18rem]');
      expect(screen.getByTestId('board-full').className).not.toContain('sm:hidden');

      await userEvent.click(screen.getByRole('button', { name: 'Collapse board' }));
      expect(screen.getByTestId('board-rail')).toBeInTheDocument();
    });

    it('defaults to expanded when the viewer owns a running task', async () => {
      const api = await import('../hooks/useApi');
      const original = vi.mocked(api.apiGet).getMockImplementation();
      await setup();
      vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
        if (path === '/tasks') return [{ id: 'task-9', agent_id: 'grok-fe', prompt: 'mine, running', status: 'running', priority: 0, created_at: new Date().toISOString(), created_by: 'u-ana' }] as never;
        return original ? original(path) : (null as never);
      });
      await act(async () => {
        sseHandler?.({ id: 60, type: 'task.dispatched', entityType: 'task', entityId: 'task-9', payload: {}, createdAt: '' });
      });
      await waitFor(() => expect(screen.queryByTestId('board-rail')).toBeNull());
      expect(grid()).toContain('_18rem]');
    });

    it('the viewer\'s own toggle wins over the default for the session', async () => {
      const api = await import('../hooks/useApi');
      const original = vi.mocked(api.apiGet).getMockImplementation();
      await setup();
      await userEvent.click(within(screen.getByTestId('board-rail')).getByRole('button', { name: 'Expand board' }));
      await userEvent.click(screen.getByRole('button', { name: 'Collapse board' }));
      // a running task of mine appears — the default would now expand, but the viewer chose collapsed
      vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
        if (path === '/tasks') return [{ id: 'task-9', agent_id: 'grok-fe', prompt: 'mine', status: 'running', priority: 0, created_at: '', created_by: 'u-ana' }] as never;
        return original ? original(path) : (null as never);
      });
      await act(async () => {
        sseHandler?.({ id: 61, type: 'task.dispatched', entityType: 'task', entityId: 'task-9', payload: {}, createdAt: '' });
      });
      expect(screen.getByTestId('board-rail')).toBeInTheDocument();
    });

    it('the Roster collapses to avatars at ≤1100px (full roster above), and avatars focus the thread', async () => {
      await setup();
      expect(screen.getByTestId('roster-avatars').className).toBe('hidden sm:block min-[1101px]:hidden');
      expect(screen.getByTestId('roster-full').className).toBe('sm:hidden min-[1101px]:block');
      expect(grid()).toContain('sm:grid-cols-[3.5rem_minmax(0,1fr)_40px]');
      await userEvent.click(within(screen.getByTestId('roster-avatars')).getByRole('button', { name: '@codex-rev' }));
      expect(screen.getByText('Run failed')).toBeInTheDocument();
      expect(screen.queryByText('Report one')).toBeNull();
    });
  });

  it('loads roster, thread, board and presence', async () => {
    await setup();
    expect(within(screen.getByRole('region', { name: 'Mine' })).getByText('grok-fe')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Free' })).getByText('codex-rev')).toBeInTheDocument();
    expect(screen.getByText('reviews: 2')).toBeInTheDocument();
    expect(screen.getByText('T5 UI')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Attention/ })).toHaveTextContent('●2');
  });

  it('SSE events pull the feed after the cursor (no polling)', async () => {
    const api = await setup();
    threadPages.push({ cursor: 12, items: [item({ event_id: 11, kind: 'alert', title: 'Agent crashed' })] });
    await act(async () => {
      sseHandler?.({ id: 11, type: 'agent.crashed', entityType: 'agent', entityId: 'grok-fe', payload: {}, createdAt: '' });
    });
    expect(await screen.findByText('Agent crashed')).toBeInTheDocument();
    expect(api.apiGet).toHaveBeenCalledWith('/thread?since=10&limit=200');
  });

  it('after an ownership change the visible window is re-read and stale actions are replaced', async () => {
    const api = await setup();
    expect(within(screen.getByTestId('thread-item-2')).getByRole('button', { name: 'Reply' })).toBeInTheDocument();

    // Server now computes no Reply for item 2 (e.g. the agent was reserved by someone else)
    threadPages.push({ cursor: 12, items: [item({ event_id: 2, kind: 'request', title: 'Question', needs_attention: true, actions: [] })] });
    await act(async () => {
      sseHandler?.({ id: 12, type: 'agent.reserved', entityType: 'agent', entityId: 'grok-fe', payload: {}, createdAt: '' });
    });
    await waitFor(() => expect(within(screen.getByTestId('thread-item-2')).queryByRole('button', { name: 'Reply' })).toBeNull());
    // /thread without `since` = the newest page, re-read (initial load was the first such call)
    expect(vi.mocked(api.apiGet).mock.calls.filter(([p]) => p === '/thread?limit=200')).toHaveLength(2);
    // Older items not in the re-read page are kept, not dropped
    expect(screen.getByText('Report one')).toBeInTheDocument();
    expect(screen.getByText('Run failed')).toBeInTheDocument();

    // and the cursor still moves forward afterwards
    await act(async () => {
      sseHandler?.({ id: 13, type: 'run.started', entityType: 'run', entityId: 'r', payload: {}, createdAt: '' });
    });
    await waitFor(() => expect(api.apiGet).toHaveBeenCalledWith('/thread?since=12&limit=200'));
  });

  it('kill asks for confirmation (slash command and thread action)', async () => {
    const api = await setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Target' }), 'grok-fe');
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), '/kill{Enter}');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Kill grok-fe'));
    expect(api.apiPost).not.toHaveBeenCalledWith('/agents/grok-fe/kill');
    expect(screen.getByRole('alert')).toHaveTextContent('Kill cancelled');

    confirm.mockReturnValueOnce(true);
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), '{Enter}');
    expect(api.apiPost).toHaveBeenCalledWith('/agents/grok-fe/kill');
  });

  it('a kill action button also confirms', async () => {
    threadPages = [{ cursor: 5, items: [
      item({ event_id: 1, title: 'Report one' }),
      item({ event_id: 4, kind: 'alert', title: 'Agent crashed', needs_attention: true,
        actions: [{ id: 'kill', label: 'Kill', method: 'POST', path: '/api/agents/grok-fe/kill' }] }),
    ] }];
    const api = await setup();
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await userEvent.click(within(screen.getByTestId('thread-item-4')).getByRole('button', { name: 'Kill' }));
    expect(api.apiPost).not.toHaveBeenCalled();
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    await userEvent.click(within(screen.getByTestId('thread-item-4')).getByRole('button', { name: 'Kill' }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/agents/grok-fe/kill', undefined));
  });

  it('if /me fails the composer is disabled with a visible reason', async () => {
    const api = await import('../hooks/useApi');
    const base = vi.mocked(api.apiGet).getMockImplementation();
    await setup();
    // re-render with /me failing
    vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
      if (path === '/me') throw new Error('Unauthorized');
      return base ? base(path) : (null as never);
    });
    threadPages = [{ cursor: 1, items: [item({ event_id: 1, title: 'Report one' })] }];
    render(<MemoryRouter><CommandCenter /></MemoryRouter>);
    expect(await screen.findByText(/Couldn't load your identity/)).toBeInTheDocument();
  });

  it('focusing an agent filters the thread and targets the composer; the terminal tail opens on demand', async () => {
    await setup();
    await userEvent.click(within(screen.getByTestId('roster-full')).getByRole('button', { name: /codex-rev/ }));
    expect(screen.queryByText('Report one')).toBeNull();
    expect(screen.getByText('Run failed')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Target' })).toHaveValue('codex-rev');

    await userEvent.click(within(screen.getByTestId('roster-full')).getByRole('button', { name: /^grok-fe/ }));
    await userEvent.click(screen.getByRole('button', { name: /terminal tail/ }));
    expect(await screen.findByTestId('terminal-tail')).toHaveTextContent('✓ ok');
  });

  it('Reply action switches the composer to Reply with the task ref, then posts /messages', async () => {
    const api = await setup();
    await userEvent.click(within(screen.getByTestId('thread-item-2')).getByRole('button', { name: 'Reply' }));
    expect(screen.getByRole('radio', { name: 'Reply' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'use wavecode.db{Enter}');
    expect(api.apiPost).toHaveBeenCalledWith('/messages', { to: 'grok-fe', message: 'use wavecode.db', ref_task_id: 'task-1' });
  });

  it('GET actions show their output; placeholder actions are filled before the call', async () => {
    const api = await setup();
    await userEvent.click(within(screen.getByTestId('thread-item-3')).getByRole('button', { name: 'Open log' }));
    expect(await screen.findByText('full run log')).toBeInTheDocument();

    vi.spyOn(window, 'prompt').mockReturnValueOnce('codex-rev');
    await userEvent.click(within(screen.getByTestId('thread-item-3')).getByRole('button', { name: 'Hand off' }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/reviews/run-1/handoff', { targetAgentId: 'codex-rev' }));

    vi.spyOn(window, 'prompt').mockReturnValueOnce(null); // cancelled → nothing sent
    vi.mocked(api.apiPost).mockClear();
    await userEvent.click(within(screen.getByTestId('thread-item-3')).getByRole('button', { name: 'Hand off' }));
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it('composer modes hit the right endpoints', async () => {
    const api = await setup();
    const box = screen.getByRole('textbox', { name: 'Message' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Target' }), 'grok-fe');
    await userEvent.type(box, 'start{Enter}');
    expect(api.apiPost).toHaveBeenCalledWith('/agents/grok-fe/send', { text: 'start' });

    await userEvent.click(screen.getByRole('radio', { name: 'Task' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Effort' }), 'xhigh');
    await userEvent.type(box, 'build it{Enter}');
    expect(api.apiPatch).toHaveBeenCalledWith('/agents/grok-fe', { effort: 'xhigh' });
    expect(api.apiPost).toHaveBeenCalledWith('/tasks', { prompt: 'build it', agent_id: 'grok-fe' });

    await userEvent.type(box, '/reserve 3h{Enter}');
    expect(api.apiPost).toHaveBeenCalledWith('/agents/grok-fe/reserve', { hours: 3 });

    await userEvent.click(screen.getByRole('radio', { name: 'File' }));
    await userEvent.upload(screen.getByLabelText('File'), new File(['x'], 'spec.md'));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/artifacts/art-1/share', { targetAgentId: 'grok-fe' }));
    expect(api.apiUpload).toHaveBeenCalledWith('/artifacts/upload', expect.any(FormData));
  });

  it('/promote uses the latest run in the thread for that agent, and says so when there is none', async () => {
    const api = await setup();
    const box = screen.getByRole('textbox', { name: 'Message' });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Target' }), 'codex-rev');
    await userEvent.type(box, '/promote{Enter}');
    expect(api.apiPost).toHaveBeenCalledWith('/reviews/run-1/promote');

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Target' }), 'grok-fe');
    await userEvent.type(box, '/retry{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('No run for grok-fe in the thread yet');
  });

  it('reserve from the roster and drag a board task onto an agent', async () => {
    const api = await setup();
    await userEvent.click(within(screen.getByTestId('roster-codex-rev')).getByRole('button', { name: 'Reserve' }));
    expect(api.apiPost).toHaveBeenCalledWith('/agents/codex-rev/reserve', {});

    const card = screen.getByText('T5 UI').closest('li')!;
    const store: Record<string, string> = {};
    const dataTransfer = { setData: (k: string, v: string) => { store[k] = v; }, getData: (k: string) => store[k], types: [TASK_DRAG_TYPE], effectAllowed: '' };
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.drop(screen.getByTestId('roster-codex-rev'), { dataTransfer });
    await waitFor(() => expect(api.apiPut).toHaveBeenCalledWith('/tasks/task-1', { agent_id: 'codex-rev' }));
  });

  it('mobile tabs switch panes and carry the attention badge', async () => {
    await setup();
    expect(screen.getByTestId('attention-badge')).toHaveTextContent('2');
    await userEvent.click(screen.getByRole('tab', { name: /Board/ }));
    expect(screen.getByRole('tab', { name: /Board/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: 'Board' }).closest('aside')!.className).toMatch(/(^|\s)block/);
    expect(screen.getByRole('region', { name: 'Thread' }).closest('main')!.className).toMatch(/(^|\s)hidden/);
  });

  it('observers get no composer', async () => {
    await setup({ ...ana, role: 'observer' });
    expect(screen.queryByRole('form', { name: 'Composer' })).toBeNull();
  });

  it('admins see Stop all and the Users link', async () => {
    const api = await setup({ id: 'owner', name: 'owner', role: 'admin', color: '#64748b' });
    expect(screen.getByRole('link', { name: 'Users' })).toHaveAttribute('href', '/settings/users');
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    await userEvent.click(screen.getByRole('button', { name: 'Stop all' }));
    expect(api.apiPost).toHaveBeenCalledWith('/system/stop-all');
  });
});
