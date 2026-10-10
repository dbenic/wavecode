// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Overview from './Overview';
import type { OverviewResponse } from '../types';

vi.mock('../hooks/useApi', () => ({ apiGet: vi.fn(), apiPost: vi.fn(async () => ({})) }));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));

const SHA = '2431f684b9e960b84e73a4e98b5068869664ffb4';

const RESPONSE: OverviewResponse = {
  board: {
    at: '2026-10-10T15:00:00Z', host: 'countix-dev',
    agents: [
      { id: 'a1', name: 'claude2', alias: null, runtime: 'claude-code', model: 'opus', status: 'working', status_since: null, for_min: 12, current: { task_id: 't', num: 41, prompt: 'Desk #91 credit notes', run_id: 'r1', started_at: '' }, last_reply: { at: '', text: 'Frozen 2431f684' }, blocked_on: null, usage: '83% left', budget: { weekly_left: 83, five_h_left: 60, resets: '14 Oct' }, open_freezes: 1 },
      { id: 'a2', name: 'codex3', alias: null, runtime: 'codex', model: null, status: 'idle', status_since: null, for_min: 90, current: null, last_reply: null, blocked_on: 'awaiting peer answer (deploy/fable)', usage: null, budget: { weekly_left: 8, five_h_left: null, resets: null }, open_freezes: 0 },
    ],
    lanes: [{ sha: SHA, run_id: 'r1', project: 'wavepulse', desk: 91, lane: 'wc-claude2', author: 'claude2', reviewer: 'codex3', verdict: 'pass', gate: 'GREEN', status: 'open', superseded_by: null, promotable: true, summary: 'Desk #91 issued credit notes', staging: null, production: null, next: 'reviewed — stage it, then promote', updated_at: '' }],
    fixes: [{ sha: 'e65a2ab5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', run_id: 'r2', project: 'wavepulse', desk: 43, lane: 'wc-codex2', author: 'codex2', author_agent_id: 'a2', reviewer: 'claude1', reason: 'needs fixes', detail: '/r/v.md', since: '', assigned: null }],
    attention: [{ kind: 'promotable', text: 'wavepulse Desk #91 2431f684: reviewed — stage it, then promote', run_id: 'r1', sha: SHA }],
    counts: { working: 1, idle: 1, error: 0, open_lanes: 1, promotable: 1, releases_open: 0, open_fixes: 1, unassigned_fixes: 1 },
  },
  report: {
    id: 'rep1', created_at: '2026-10-10 15:01:00', trigger: 'review.ai_completed', model: 'claude-sonnet-5-5',
    agents: [{ id: 'a1', note: 'freezing Desk #91, nothing blocks it' }],
    recommendations: [
      { kind: 'stage', run_id: 'r1', sha: SHA, text: 'Stage Desk #91 2431f684.' },
      { kind: 'nudge', agent_id: 'a2', text: 'Ask @codex3 whether Fable answered.' },
      { kind: 'info', text: 'All other lanes quiet.' },
    ],
    plan: [{ title: 'Invoices batch: Desk #91', shas: [SHA], target: 'production', why: 'Independent, PASS, gate green; ship alone.' }],
    digest: 'One lane ready: Desk #91.',
    board_at: '2026-10-10T15:00:00Z',
  },
  overlord: { enabled: true, model: 'claude-sonnet-5-5', heartbeat_min: 30, max_wakes_per_hour: 12 },
};

describe('Overview', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => (p.startsWith('/overview/chat')
      ? [{ id: 'c1', created_at: '', role: 'user', user_id: 'u', user_name: 'denis', text: 'what ships today?' }, { id: 'c2', created_at: '', role: 'assistant', user_id: null, user_name: 'overlord', text: 'Desk #91 alone; stage first.' }]
      : RESPONSE));
  });

  it('the chat comes first, with history; asking posts the message', async () => {
    const api = await import('../hooks/useApi');
    render(<MemoryRouter><Overview /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('overlord-chat')).toBeTruthy());
    const chat = screen.getByTestId('overlord-chat');
    expect(chat.textContent).toContain('Desk #91 alone; stage first.');
    const main = document.querySelector('main')!;
    expect(main.firstElementChild?.getAttribute('data-testid')).toBe('overlord-chat');
    fireEvent.change(screen.getByLabelText('Ask the overlord'), { target: { value: 'who takes the Desk #43 fix?' } });
    fireEvent.click(screen.getByText('ASK'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/overview/chat', { message: 'who takes the Desk #43 fix?' }));
  });

  it('open fixes show who is on them; assigning queues a task for the chosen agent, the author by default; budget shows per agent', async () => {
    const api = await import('../hooks/useApi');
    render(<MemoryRouter><Overview /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('fixes')).toBeTruthy());
    const fix = screen.getByTestId('fix-e65a2ab5');
    expect(fix.textContent).toContain('needs fixes');
    expect((screen.getByLabelText('Assign fix e65a2ab5') as HTMLSelectElement).value).toBe('a2');
    fireEvent.click(within(fix).getByText('ASSIGN'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/overview/fixes/assign', { run_id: 'r2', agent_id: 'a2' }));
    expect(screen.getByTestId('agent-claude2').textContent).toContain('83% week');
    expect(screen.getByTestId('agent-codex3').textContent).toContain('8% week');
  });

  it('shows the digest, the recommendations with DO IT on the actionable ones, the attention list and the agent board with the overlord note', async () => {
    render(<MemoryRouter><Overview /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('overlord-report')).toBeTruthy());
    const rep = screen.getByTestId('overlord-report');
    expect(rep.textContent).toContain('One lane ready: Desk #91.');
    expect(within(rep).getAllByText('DO IT')).toHaveLength(2); // stage + nudge; info has no button
    expect(screen.getByTestId('attention').textContent).toContain('Desk #91');
    const row = screen.getByTestId('agent-claude2');
    expect(row.textContent).toContain('WORKING');
    expect(row.textContent).toContain('#41 Desk #91 credit notes');
    expect(row.textContent).toContain('freezing Desk #91, nothing blocks it');
    expect(row.textContent).toContain('83% week');
    expect(screen.getByTestId('agent-codex3').textContent).toContain('awaiting peer answer');
    expect(screen.getByTestId('lanes').textContent).toContain('reviewed — stage it, then promote');
    expect(screen.getByTestId('release-plan').textContent).toContain('Invoices batch: Desk #91');
  });

  it('DO IT on a stage recommendation posts the stage; on a nudge it sends the line to the agent; NEW REPORT wakes the overlord', async () => {
    const api = await import('../hooks/useApi');
    render(<MemoryRouter><Overview /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('overlord-report')).toBeTruthy());
    const [stage, nudge] = within(screen.getByTestId('overlord-report')).getAllByText('DO IT');
    fireEvent.click(stage);
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/reviews/r1/stage'));
    fireEvent.click(nudge);
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/agents/a2/send', { text: '[Overlord] Ask @codex3 whether Fable answered.' }));
    fireEvent.click(screen.getByText('NEW REPORT'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/overview/wake', {}));
  });
});
