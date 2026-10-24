// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OpsLanes, { fmtAge } from './OpsLanes';
import DesktopNav from '../components/DesktopNav';
import type { OpsLanesReport } from '../types';

vi.mock('../hooks/useApi', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

const REPORT: OpsLanesReport = {
  collected_at: '2026-10-24T20:00:00.000Z',
  poll_s: 10,
  stale_min: 2,
  dir_error: 'missing',
  lanes: [
    {
      id: 'pilot',
      bot: 'pilot',
      file: 'ok',
      red: true,
      reasons: ['stale', 'key'],
      role: 'unknown',
      model: 'opus',
      key_status: 'expired',
      key_checked_at: 'unknown',
      current_job: 'password=[redacted]',
      heartbeat_at: '2026-10-24T19:57:00.000Z',
      heartbeat_age_s: 180,
      last_receipt_path: 'unknown',
      last_receipt_at: 'unknown',
    },
    {
      id: 'scout',
      bot: 'unknown',
      file: 'missing',
      red: true,
      reasons: ['missing'],
      role: 'unknown',
      model: 'unknown',
      key_status: 'unknown',
      key_checked_at: 'unknown',
      current_job: 'unknown',
      heartbeat_at: 'unknown',
      heartbeat_age_s: null,
      last_receipt_path: 'unknown',
      last_receipt_at: 'unknown',
    },
    {
      id: 'stager',
      bot: 'stager',
      file: 'ok',
      red: false,
      reasons: [],
      role: 'stage',
      model: 'sonnet',
      key_status: 'ok',
      key_checked_at: '2026-10-24T19:59:00.000Z',
      current_job: 'idle',
      heartbeat_at: '2026-10-24T19:59:30.000Z',
      heartbeat_age_s: 30,
      last_receipt_path: '/srv/fable/2/outbox/stager-live-20261024.md',
      last_receipt_at: '2026-10-24T19:40:00.000Z',
    },
  ],
};

describe('Ops lanes page', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockResolvedValue(REPORT as never);
  });

  it('formats ages', () => {
    expect(fmtAge(12)).toBe('12 s');
    expect(fmtAge(180)).toBe('3 min');
  });

  it('shows the live board, unknown fields, and red rows', async () => {
    render(<MemoryRouter><OpsLanes /></MemoryRouter>);
    const pilot = await screen.findByTestId('ops-lane-pilot');
    expect(pilot.getAttribute('data-red')).toBe('true');
    expect(pilot.textContent).toContain('expired');
    expect(pilot.textContent).toContain('stale');
    expect(pilot.textContent).toContain('unknown');
    expect(pilot.textContent).toContain('[redacted]');
    expect(pilot.textContent).not.toContain('hunter2');
    const scout = screen.getByTestId('ops-lane-scout');
    expect(scout.getAttribute('data-red')).toBe('true');
    expect(scout.textContent).toContain('missing');
    expect(scout.textContent).toContain('unknown');
    expect(screen.getByTestId('ops-lane-stager').getAttribute('data-red')).toBe('false');
    expect(screen.getByTestId('ops-dir-error').textContent).toContain('directory missing');
    expect(screen.getByTestId('ops-collected').textContent).toContain('2026-10-24T20:00:00.000Z');
    expect(screen.getByTestId('ops-jobs-empty').textContent).toContain('No jobs yet');
  });

  it('lists a job and asks for data', async () => {
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockImplementation(async (path: string) => {
      if (path === '/ops/jobs') {
        return [{
          id: 'job1',
          kind: 'ask_data',
          role: 'scout',
          status: 'queued',
          requester: 'denis',
          payload: {},
          created_at: '2026-10-24T20:00:00.000Z',
          receipt_paths: ['/srv/opsbots/receipts/scout/answer.md'],
          approval: null,
        }] as never;
      }
      return REPORT as never;
    });
    vi.mocked(api.apiPost).mockResolvedValue({ job: { status: 'queued' } } as never);
    render(<MemoryRouter><OpsLanes /></MemoryRouter>);
    const row = await screen.findByTestId('ops-job-job1');
    expect(row.textContent).toContain('queued');
    expect(row.textContent).toContain('scout');
    expect(row.textContent).toContain('denis');
    expect(row.textContent).toContain('/srv/opsbots/receipts/scout/answer.md');
    fireEvent.change(screen.getByTestId('ask-company'), { target: { value: 'hipsl' } });
    fireEvent.change(screen.getByTestId('ask-question'), { target: { value: 'what is the payroll total' } });
    fireEvent.click(screen.getByTestId('ask-submit'));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith('/ops/ask', {
      company: 'hipsl', env: 'staging', question: 'what is the payroll total', intent: 'read',
    }));
    expect(await screen.findByTestId('ask-note')).toHaveTextContent('Queued for the scout');
  });

  it('puts Ops lanes next to Tests', () => {
    render(<MemoryRouter><DesktopNav /></MemoryRouter>);
    const labels = screen.getAllByRole('button').map((button) => button.textContent);
    expect(labels.indexOf('Ops lanes')).toBe(labels.indexOf('Tests') + 1);
  });
});
