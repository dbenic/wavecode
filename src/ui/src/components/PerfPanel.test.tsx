// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PerfPanel from './PerfPanel';
import type { PerfSnapshot } from '../types';

vi.mock('../hooks/useApi', () => ({ apiGet: vi.fn() }));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));

const SNAP: PerfSnapshot = {
  at: new Date().toISOString(), uptime_s: 7200,
  loop_ms: { p50: 1.2, p99: 820, max: 2300, mean: 40 }, cpu_pct: 24.8, rss_mb: 196,
  last_minute: { spawns: { 'git merge-base': 1536, 'git rev-parse': 131, 'tmux capture-pane': 345 }, sync_spawns: 1667, sync_blocked_ms: 9800 },
  last_15_min: { spawns: { 'git merge-base': 9000 }, sync_spawns: 9000, sync_blocked_ms: 60000 },
  jobs: { deploy_reconcile: { last_ms: 12400, last_at: new Date().toISOString(), max_ms: 15000, runs: 3 } },
  lag_threshold_ms: 500,
  storage: { events: 266899, events_short_lived: 240000, freezes: 646, tasks: 181, runs: 400, db_bytes: 380 * 1048576 },
};

describe('PerfPanel', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => {
      if (p === '/me') return { id: 'u', name: 'denis', role: 'admin' } as never;
      if (p === '/health') return { event_loop: { p99_ms: 4, max_ms: 18 } } as never;
      return SNAP as never;
    });
  });

  it('shows an admin the loop lag flagged against the threshold, forks by command, job durations and journal size; REFRESH reads again', async () => {
    const api = await import('../hooks/useApi');
    render(<PerfPanel />);
    await waitFor(() => expect(screen.getByTestId('perf-loop').textContent).toContain('p99 820 ms'));
    expect(screen.getByTestId('health-panel').textContent).toContain('p99 4 ms');
    expect(screen.getByTestId('health-loop').textContent).toContain('max 18 ms');
    expect(screen.getByTestId('perf-loop').className).toContain('amber');
    expect(screen.getByTestId('perf-spawns').textContent).toContain('2012 forks');
    expect(screen.getByTestId('perf-spawns').textContent).toContain('9.8 s');
    expect(screen.getByText('git merge-base')).toBeInTheDocument();
    expect(screen.getByTestId('job-deploy_reconcile').textContent).toContain('12.4 s');
    expect(screen.getByTestId('perf-storage').textContent).toContain('266,899 events');
    expect(screen.getByTestId('perf-storage').textContent).toContain('380 MB');
    const calls = vi.mocked(api.apiGet).mock.calls.filter((c) => c[0] === '/health/perf').length;
    fireEvent.click(screen.getByText('REFRESH'));
    await waitFor(() => expect(vi.mocked(api.apiGet).mock.calls.filter((c) => c[0] === '/health/perf').length).toBe(calls + 1));
  });

  it('renders nothing for a developer', async () => {
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => (p === '/me' ? { id: 'u', name: 'ana', role: 'developer' } : SNAP) as never);
    render(<PerfPanel />);
    await waitFor(() => expect(vi.mocked(api.apiGet)).toHaveBeenCalledWith('/me'));
    expect(screen.queryByTestId('perf-panel')).toBeNull();
    expect(vi.mocked(api.apiGet)).not.toHaveBeenCalledWith('/health/perf');
  });
});
