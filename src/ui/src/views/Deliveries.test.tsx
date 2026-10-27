// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Deliveries, { fmtMinutes, stageTone, type DeliverySummary } from './Deliveries';
import DesktopNav from '../components/DesktopNav';
import { apiGet, apiPost } from '../hooks/useApi';

vi.mock('../hooks/useApi', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));

const OPEN: DeliverySummary = {
  id: 'd1', title: 'Bank simple posting', project: 'wavepulse', lanes: ['wc-codex1-bank-simple-posting'], shas: ['4fa51cd4'.padEnd(40, '0')],
  release_lane: false, stage: 'gates', stage_started_at: '2026-10-27T11:40:00.000Z', stage_minutes: 95, last_progress_at: null, attempts: 2,
  status: 'open', stall_cause: "gates: BLOCKED — auto: quick check waits for @codex1's other run", stall_at: '2026-10-27T12:00:00.000Z',
  created_by: 'denis', since_at: '2026-10-27T10:00:00.000Z', open_stages: ['gates', 'review'],
  stalls: [{ stage: 'gates', code: 'BLOCKED', cause: "auto: quick check waits for @codex1's other run", minutes: 95, actor: 'codex1' }],
};
const DONE: DeliverySummary = {
  ...OPEN, id: 'd2', title: 'PD158', stage: 'release', stage_minutes: null, status: 'done', stall_cause: null, stall_at: null, open_stages: [], stalls: [], attempts: 1,
};

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPost).mockReset();
});

describe('Deliveries', () => {
  it('lists open deliveries with time in stage and the stall cause', async () => {
    vi.mocked(apiGet).mockResolvedValue([OPEN]);
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    expect(await screen.findByText('Bank simple posting')).toBeTruthy();
    expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/deliveries?status=open');
    expect(screen.getByTestId('delivery-stall-d1').textContent).toContain("BLOCKED in gates (1 h 35 min) · @codex1: auto: quick check waits");
    const pills = screen.getByTestId('delivery-stages-d1').querySelectorAll('span');
    const tones = [...pills].map((p) => p.getAttribute('data-tone'));
    expect(tones).toEqual(['done', 'done', 'done', 'stalled', 'open', 'todo', 'todo', 'todo']);
    expect(pills[3].textContent).toBe('gates · 1 h 35 min');
  });

  it('opens the stage table on click and fetches the detail', async () => {
    vi.mocked(apiGet).mockImplementation(async (path: string) => {
      if (path === '/deliveries/d1') {
        return { ...OPEN, stages: [
          { stage: 'spec', attempt: 1, started_at: '2026-10-27T10:00:00.000Z', finished_at: '2026-10-27T10:10:00.000Z', outcome: 'ok', cause: null, actor: null, sha: null, lane: null },
          { stage: 'gates', attempt: 1, started_at: '2026-10-27T11:40:00.000Z', finished_at: null, outcome: null, cause: "auto: quick check waits for @codex1's other run", actor: null, sha: '4fa51cd4'.padEnd(40, '0'), lane: 'wc-codex1-bank-simple-posting' },
        ] };
      }
      return [OPEN];
    });
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    fireEvent.click(await screen.findByText('Bank simple posting'));
    await waitFor(() => expect(screen.getByTestId('delivery-detail-d1').querySelectorAll('tbody tr').length).toBe(2));
    const rows = screen.getByTestId('delivery-detail-d1').querySelectorAll('tbody tr');
    expect(rows[0].textContent).toContain('spec');
    expect(rows[0].textContent).toContain('10 min');
    expect(rows[1].textContent).toContain('4fa51cd4');
    expect(rows[1].textContent).toContain('(open)');
  });

  it('creates a delivery from the form and shows closed ones on request', async () => {
    vi.mocked(apiGet).mockImplementation(async (path: string) => (path.includes('status=all') ? [OPEN, DONE] : [OPEN]));
    vi.mocked(apiPost).mockResolvedValue({ ...OPEN, id: 'd3', title: 'Invoices' });
    render(<MemoryRouter><Deliveries /></MemoryRouter>);
    await screen.findByText('Bank simple posting');
    fireEvent.click(screen.getByTestId('delivery-submit'));
    expect(screen.getByTestId('delivery-form-error').textContent).toBe('title is required');
    fireEvent.change(screen.getByTestId('delivery-title'), { target: { value: 'Invoices' } });
    fireEvent.change(screen.getByTestId('delivery-lanes'), { target: { value: 'wc-a-x, wc-b-y' } });
    fireEvent.click(screen.getByTestId('delivery-submit'));
    await waitFor(() => expect(vi.mocked(apiPost)).toHaveBeenCalledWith('/deliveries', { title: 'Invoices', project: null, lanes: ['wc-a-x', 'wc-b-y'] }));
    fireEvent.click(screen.getByTestId('deliveries-show-all'));
    expect(await screen.findByText('PD158')).toBeTruthy();
    expect(screen.getByTestId('delivery-status-d2').textContent).toBe('done');
  });

  it('helpers: minutes format and stage tones without spans', () => {
    expect(fmtMinutes(null)).toBe('—');
    expect(fmtMinutes(5)).toBe('5 min');
    expect(fmtMinutes(125)).toBe('2 h 05 min');
    expect(stageTone(DONE, 'release')).toBe('done');
    expect(stageTone(OPEN, 'spec')).toBe('done');
    expect(stageTone(OPEN, 'review')).toBe('open');
    expect(stageTone(OPEN, 'land')).toBe('todo');
  });

  it('is reachable from the desktop nav', () => {
    render(<MemoryRouter><DesktopNav /></MemoryRouter>);
    expect(screen.getByText('Deliveries')).toBeTruthy();
  });
});
