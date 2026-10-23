// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Queue, { fmtAge } from './Queue';
import DesktopNav from '../components/DesktopNav';
import type { FableQueueReport } from '../types';

vi.mock('../hooks/useApi', () => ({ apiGet: vi.fn() }));

const unknown = { status: 'unknown' as const };
const REPORT: FableQueueReport = {
  collected_at: '2026-10-23T12:00:00.000Z',
  poll_s: 10,
  pending_alert_min: 15,
  notes_unavailable: 1,
  bots: [{
    id: 'fable',
    socket: 'fable',
    session: 'claude-countix',
    state: 'idle',
    state_error: 'socket unavailable',
    inbox_error: 'missing',
    outbox_error: null,
    pending: [{ name: '145-brief.md', age_s: 1200, status: 'unmatched' }],
    unmatched: [{ name: '145-brief.md', age_s: 1200, status: 'unmatched' }],
    current: { name: '145-brief.md', age_s: 1200, status: 'unmatched' },
    newest_receipt: { name: 'fable-prodw-roles-20261023.md', age_s: 30 },
    capture: 'esc to interrupt\npassword=[redacted]',
  }],
  alerts: [
    { kind: 'pending_too_long', bot: 'fable', name: '145-brief.md', age_s: 1200 },
    { kind: 'idle_with_pending', bot: 'fable', pending: 1 },
  ],
  pipeline: [{
    card: '#145',
    stages: { freeze: { status: 'seen', name: 'desk-145-freeze.md', age_s: 30 }, review: unknown, staged: unknown, 'GO-ready': unknown, live: unknown },
  }, {
    card: 'ENG-5',
    stages: { freeze: unknown, review: unknown, staged: unknown, 'GO-ready': unknown, live: unknown },
  }],
};

describe('Queue page', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockResolvedValue(REPORT as never);
  });

  it('formats ages', () => {
    expect(fmtAge(12)).toBe('12 s');
    expect(fmtAge(120)).toBe('2 min');
    expect(fmtAge(3720)).toBe('1 h 02 min');
  });

  it('shows bots, alerts, and unknown stages', async () => {
    render(<MemoryRouter><Queue /></MemoryRouter>);
    expect(await screen.findByTestId('queue-bot-fable')).toBeTruthy();
    expect(screen.getByTestId('queue-alerts').textContent).toContain('145-brief.md pending 20 min');
    expect(screen.getByTestId('queue-alerts').textContent).toContain('idle with 1 pending');
    expect(screen.getByTestId('queue-state-error-fable').textContent).toBe('socket unavailable');
    expect(screen.getByTestId('queue-bot-fable').textContent).toContain('inbox missing');
    expect(screen.getByTestId('queue-unmatched-fable').textContent).toContain('unmatched 145-brief.md');
    expect(screen.getByTestId('queue-unmatched-fable').textContent).toContain('fable-prodw-roles-20261023.md');
    expect(screen.getByTestId('queue-capture-fable').textContent).toContain('[redacted]');
    expect(screen.getByTestId('queue-capture-fable').textContent).not.toContain('hunter2');
    const card = screen.getByTestId('queue-card-#145');
    expect(card.textContent).toContain('desk-145-freeze.md');
    expect(card.textContent).toContain('unknown');
    expect(screen.getByTestId('queue-card-ENG-5').textContent).toContain('unknown');
    expect(screen.getByTestId('queue-notes-unavailable').textContent).toContain('unavailable');
    expect(screen.getByTestId('queue-collected').textContent).toContain('2026-10-23T12:00:00.000Z');
  });

  it('puts Queue in the desktop nav', () => {
    render(<MemoryRouter><DesktopNav /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Queue' })).toBeTruthy();
  });
});
