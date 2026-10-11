// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import DeskPanel from './DeskPanel';
import type { Agent, DeskDetail, DeskListResponse } from '../types';

vi.mock('../hooks/useApi', () => ({ apiGet: vi.fn(), apiPost: vi.fn(async () => ({})) }));

const AGENTS = [{ id: 'a1', name: 'codex1', alias: null, status: 'idle' } as unknown as Agent, { id: 'a2', name: 'claude2', alias: null, status: 'working' } as unknown as Agent];

const LIST: DeskListResponse = {
  enabled: true,
  state: { enabled: true, cached_at: '2026-10-11T08:00:00Z', error: null },
  items: [
    { id: 108, status: 'implementing', title: 'PD-108 outgoing line VAT treatment', area: 'invoices', priority: 'high', target_version: null, source: 'email', requester_name: 'Ana', received_at: null, updated_at: '2026-10-10T12:00:00Z', file_count: 2, message_count: 3, last_agent: 'codex2', last_summary: 'spec r2 frozen', merged_into_id: null,
      links: { lanes: [{ sha: '2431f684b9e960b84e73a4e98b5068869664ffb4', verdict: 'needs-fixes', status: 'open', lane: null, author: 'codex2' }], tasks: [{ id: 't1', num: 41, status: 'running', agent_id: 'a2', agent_name: 'codex2' }] } },
    { id: 100, status: 'new', title: 'Partner landing page', area: null, priority: null, target_version: null, source: 'email', requester_name: null, received_at: null, updated_at: null, file_count: 0, message_count: 1, last_agent: null, last_summary: null, merged_into_id: null,
      links: { lanes: [], tasks: [] } },
  ],
};

const DETAIL: DeskDetail = {
  request: { ...LIST.items[0], candidate_sha: null, note: 'before month end', requester_email: 'ana@x.si', created_at: null },
  messages: [{ id: 1, direction: 'inbound', from_name: 'Ana', from_email: null, received_at: '2026-10-08T10:00:00Z', subject: 'VAT on lines', body_text: 'Please make the VAT per line editable.' }],
  events: [{ id: 5, created_at: '2026-10-09T09:00:00Z', kind: 'status', from_status: 'accepted', to_status: 'implementing', body: 'claimed', version: null, release_sha: null, user_name: 'codex2' }],
  files: [{ id: 77, name: 'invoice-sample.pdf', size: 12345, mime: 'application/pdf' }],
  links: LIST.items[0].links,
};

describe('DeskPanel', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => (p.startsWith('/desk/108') ? DETAIL : LIST));
  });

  it('lists open requests with status, what WaveCode has for each, and a hand-to-agent control only where no task is open', async () => {
    render(<DeskPanel agents={AGENTS} />);
    await waitFor(() => expect(screen.getByTestId('desk-table')).toBeTruthy());
    const r108 = screen.getByTestId('desk-108');
    expect(r108.textContent).toContain('IMPLEMENTING');
    expect(r108.textContent).toContain('task #41 · running · @codex2');
    expect(r108.textContent).toContain('2431f684 · needs fixes');
    expect(r108.textContent).toContain('with @codex2');
    expect(within(r108).queryByText('CREATE TASK')).toBeNull();
    const r100 = screen.getByTestId('desk-100');
    expect(r100.textContent).toContain('NEW');
    expect(within(r100).getByText('CREATE TASK')).toBeTruthy();
  });

  it('creating a task posts the chosen agent and the note; opening a request shows its message, files (served through the daemon) and history', async () => {
    const api = await import('../hooks/useApi');
    vi.spyOn(window, 'prompt').mockReturnValueOnce('start today');
    render(<DeskPanel agents={AGENTS} />);
    await waitFor(() => expect(screen.getByTestId('desk-table')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Agent for desk 100'), { target: { value: 'a1' } });
    fireEvent.click(within(screen.getByTestId('desk-100')).getByText('CREATE TASK'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/desk/100/task', { agent_id: 'a1', note: 'start today' }));
    fireEvent.click(screen.getByText('PD-108 outgoing line VAT treatment'));
    await waitFor(() => expect(screen.getByTestId('desk-detail-108')).toBeTruthy());
    const detail = screen.getByTestId('desk-detail-108');
    expect(detail.textContent).toContain('Please make the VAT per line editable.');
    expect(within(detail).getByText('invoice-sample.pdf').getAttribute('href')).toBe('/api/desk/files/77');
    expect(detail.textContent).toContain('→ implementing');
    expect(detail.textContent).toContain('before month end');
  });

  it('renders nothing when the desk is not configured', async () => {
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockResolvedValue({ enabled: false, items: [], state: { enabled: false, cached_at: null, error: null } });
    render(<DeskPanel agents={AGENTS} />);
    await waitFor(() => expect(vi.mocked(api.apiGet)).toHaveBeenCalled());
    expect(screen.queryByTestId('desk-panel')).toBeNull();
  });
});
