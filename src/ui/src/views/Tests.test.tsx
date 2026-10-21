// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Tests, { agentNameOf, fmtDuration } from './Tests';
import type { SSEEvent } from '../hooks/useSSE';
import sample from '../../../server/fixtures/test-portal/sample.json';

vi.mock('../hooks/useApi', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
let sseHandler: ((e: SSEEvent) => void) | null = null;
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn((h: (e: SSEEvent) => void) => { sseHandler = h; }) }));

const DOC = {
  ...sample,
  runs: [
    { ...sample.runs[0], median_s: 1680, median_min: 28.0, pace: '' },
    { ...sample.runs[1], median_s: 600, median_min: 10.0, pace: 'red', elapsed_s: 1800, started_at: new Date(Date.now() - 1800_000).toISOString() },
    ...sample.runs.slice(2),
  ],
  runners: [
    { name: 'countix-testing', type: 'gateway', server_type: '', role: '', health: 'ok', preflight: 'ok', load: 1.2, mem_avail_gb: 90, disk_used_pct: 9, state: 'busy', age_s: null, age_min: null, slots: [{ name: 'slot1', state: 'idle' }, { name: 'slot2', state: 'busy' }] },
    { name: 'countix-testing slot 2', type: 'main', server_type: '', role: 'main server slot', group: 'main', health: 'ok', preflight: 'ok', load: null, mem_avail_gb: null, disk_used_pct: null, state: 'busy', age_s: null, age_min: null, agent: 'wave.countix-dev.claude6', kind: 'slot', sha: 'ade3a1f' },
    { ...sample.runners[0], server_type: 'ccx43', role: 'weekday runner' },
    { ...sample.runners[3], health: 'not probed', preflight: 'not probed' },
  ],
};
const STATE = { enabled: true, host: 'countix-testing.tailf32df0.ts.net:8088', doc: DOC, fetched_at: new Date().toISOString(), error: null, next_in_s: 20, schema_ok: true };
const AGENTS = [{ id: 'a5', name: 'claude5' }, { id: 'a6', name: 'claude6' }];

describe('Tests page', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    sseHandler = null;
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => (p === '/agents' ? AGENTS : STATE) as never);
    vi.mocked(api.apiPost).mockResolvedValue(STATE as never);
  });

  it('formats durations and maps submitter labels', () => {
    expect(fmtDuration(36)).toBe('36 s');
    expect(fmtDuration(820)).toBe('13 min');
    expect(fmtDuration(3600 + 125)).toBe('1 h 02 min');
    expect(fmtDuration(null)).toBe('–');
    expect(agentNameOf('wave.countix-dev.claude6')).toBe('claude6');
    expect(agentNameOf('gate.fable')).toBeNull();
  });

  it('shows runs against their budget with agent links, runners with health, results and the scaler; reloads on the portal event', async () => {
    const api = await import('../hooks/useApi');
    render(<MemoryRouter><Tests /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('tests-runs')).toBeTruthy());
    expect(screen.getByTestId('tests-healthy').textContent).toContain('3 of 4 runners busy');
    const slot2 = screen.getByTestId('run-slot2');
    expect(within(slot2).getByText('claude6')).toBeTruthy(); // linked WaveCode agent
    expect(slot2.textContent).toContain('~28 min'); // the kind's median, not the fixed budget
    const runnerARun = screen.getByTestId('run-runner-a');
    expect(runnerARun.textContent).toContain('unknown');
    expect(runnerARun.textContent).toContain('red'); // the portal's pace word
    expect(screen.queryByTestId('runner-countix-testing')).toBeNull(); // the gateway summary row is not a runner
    const slotRow = screen.getByTestId('runner-countix-testing slot 2');
    expect(slotRow.textContent).toContain('main server slot');
    expect(slotRow.textContent).toContain('claude6 ade3a1f');
    const runnerA = screen.getByTestId('runner-runner-a');
    expect(runnerA.textContent).toContain('ccx43'); // server_type, not the "legacy" label
    expect(runnerA.textContent).toContain('weekday runner');
    expect(runnerA.textContent).toContain('25.8');
    expect(screen.getByTestId('runner-full-a').textContent).toContain('not probed');
    expect(screen.getByTestId('tests-results').textContent).toContain('GREEN');
    expect(screen.getByTestId('tests-results').textContent).toContain('32 min');
    expect(screen.getByTestId('tests-runners').textContent).toContain('shadow numbers, not real capacity');
    const before = vi.mocked(api.apiGet).mock.calls.filter((c) => c[0] === '/tests/status').length;
    sseHandler?.({ id: 1, type: 'tests.portal', entityType: 'system', entityId: 'test-portal', payload: { running: 4 }, createdAt: '' } as SSEEvent);
    await waitFor(() => expect(vi.mocked(api.apiGet).mock.calls.filter((c) => c[0] === '/tests/status').length).toBe(before + 1));
    fireEvent.click(screen.getByText('REFRESH'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/tests/status/refresh'));
  });

  it('says so when the portal is unreachable or not configured', async () => {
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => (p === '/agents' ? AGENTS : { ...STATE, error: 'timeout', next_in_s: 60 }) as never);
    render(<MemoryRouter><Tests /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('tests-fetched').textContent).toContain('status unavailable (timeout) · retry in 60 s'));
    expect(screen.getByTestId('tests-runs')).toBeTruthy(); // the last snapshot stays visible
  });
});
