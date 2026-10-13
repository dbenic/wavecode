// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Release from './Release';
import type { Board, LaneBoardRow, OverviewResponse } from '../types';

vi.mock('../hooks/useApi', () => ({ apiGet: vi.fn(), apiPost: vi.fn(async () => ({})) }));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));

const SHA_A = '2431f684b9e960b84e73a4e98b5068869664ffb4';
const SHA_B = '3562f0404cfc19de7ea6946ec57aa381055f8479';
const SHA_C = 'e65a2ab5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TIP = 'f91a5fc7aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function lane(sha: string, over: Partial<LaneBoardRow> = {}): LaneBoardRow {
  return {
    sha, run_id: `run-${sha.slice(0, 4)}`, project: 'wavepulse', desk: 91, lane: 'wc-claude2', author: 'claude2', reviewer: 'codex3', verdict: 'pass', gate: 'GREEN',
    status: 'open', superseded_by: null, promotable: false, candidate: null, summary: null, staging: null, production: null,
    next: 'reviewed — waiting to be composed into the next candidate', updated_at: '', ...over,
  };
}

const BOARD: Board = {
  at: '', host: 'countix-dev', agents: [], desk: null, fixes: [], attention: [],
  lanes: [
    lane(SHA_A, { desk: 78, lane: 'claude1/desk78-collector', author: 'claude1', reviewer: 'codex2', staging: { status: 'deployed', version: '0.443.3-rc', at: '2026-10-10T15:00:00Z', by: 'denis', verified_by: null, verified_at: null } }),
    lane(SHA_B, { desk: 88, candidate: 'fable/rc-0443-2', next: 'in candidate fable/rc-0443-2 — ships with that release' }),
    lane(SHA_C, { desk: 108, status: 'stale', superseded_by: 'bc60af76aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', verdict: 'needs-fixes', next: 'stale' }),
  ],
  candidates: [{
    project: 'wavepulse', name: 'fable/rc-0443-2', tip: TIP, committed_at: '2026-10-10T14:30:00Z',
    lanes: [{ sha: SHA_B, desk: 88, lane: 'origin/wc-codex2-desk88', verdict: 'pass', author: 'codex2' }],
    staging: null, production: null, verified: null, next: 'composed — staged by the deployer on its own; verify on staging, then GO',
  }],
  counts: { working: 0, idle: 0, error: 0, open_lanes: 2, promotable: 0, releases_open: 0, open_fixes: 0, unassigned_fixes: 0 },
};

const RESPONSE: OverviewResponse = { board: BOARD, report: null, overlord: { enabled: true, model: 'claude-sonnet-5-5', heartbeat_min: 30, max_wakes_per_hour: 12 } };

describe('Release view (candidates are the unit of production)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => {
      if (p === '/overview') return RESPONSE;
      if (p === '/reviews') return [];
      if (p === '/me') return { id: 'owner', name: 'denis', role: 'admin', color: '#64748b' };
      if (p.startsWith('/releases/audit')) return [{ at: '2026-10-10T14:00:00', who: 'denis', action: 'verify', target: 'staging', sha: SHA_A, project: 'wavepulse', desk: '78', detail: 'Ready for prod — lane claude1/desk78-collector', release_id: null, run_id: null }];
      return [];
    });
  });

  it('shows the candidate with its lanes and the production button; lanes alone have no production button; stale lanes are hidden until asked', async () => {
    render(<MemoryRouter><Release /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('candidates')).toBeTruthy());
    const cand = screen.getByTestId('candidate-fable/rc-0443-2');
    expect(cand.textContent).toContain('Desk #88');
    expect(cand.textContent).toContain('not ready for prod');
    expect(within(cand).getByText('DEPLOY TO PRODUCTION')).toBeTruthy();
    expect(within(cand).getByText('READY FOR PROD')).toBeTruthy();
    const lanes = screen.getByTestId('lanes');
    expect(within(lanes).getByTestId(`lane-${SHA_A.slice(0, 8)}`)).toBeTruthy();
    expect(within(lanes).queryByTestId(`lane-${SHA_B.slice(0, 8)}`)).toBeNull(); // in candidate: hidden
    expect(within(lanes).queryByTestId(`lane-${SHA_C.slice(0, 8)}`)).toBeNull(); // stale: hidden
    expect(within(lanes).queryByText('DEPLOY TO PRODUCTION')).toBeNull();
    fireEvent.click(screen.getByText(/show 1 in candidates · 1 stale\/merged/));
    expect(within(screen.getByTestId('lanes')).getByTestId(`lane-${SHA_C.slice(0, 8)}`).textContent).toContain('stale');
    expect(screen.getByTestId('audit').textContent).toContain('denis');
    expect(screen.getByTestId('audit').textContent).toMatch(/ready for prod/i);
  });

  it('DEPLOY TO PRODUCTION on a candidate confirms with its lanes and staging state, then posts the GO for the candidate', async () => {
    const api = await import('../hooks/useApi');
    render(<MemoryRouter><Release /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('candidates')).toBeTruthy());
    const cand = screen.getByTestId('candidate-fable/rc-0443-2');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(within(cand).getByText('DEPLOY TO PRODUCTION'));
    expect(confirm.mock.calls[0][0]).toMatch(/DEPLOY TO PRODUCTION[\s\S]*candidate fable\/rc-0443-2[\s\S]*tip SHA f91a5fc7[\s\S]*Desk #88 3562f040[\s\S]*not ready for prod/i);
    expect(vi.mocked(api.apiPost)).not.toHaveBeenCalled();
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    fireEvent.click(within(cand).getByText('DEPLOY TO PRODUCTION'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/releases/candidates/fable%2Frc-0443-2/promote', { project: 'wavepulse' }));
  });

  it('READY FOR PROD records a SHA with a note; STAGE on a lane posts the lane staging', async () => {
    const api = await import('../hooks/useApi');
    vi.spyOn(window, 'prompt').mockReturnValueOnce('invoices checked');
    render(<MemoryRouter><Release /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('candidates')).toBeTruthy());
    const ready = within(screen.getByTestId('candidate-fable/rc-0443-2')).getByText('READY FOR PROD');
    expect(ready.getAttribute('title')).toMatch(/Ready for prod/i);
    fireEvent.click(ready);
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/releases/verify', { sha: TIP, project: 'wavepulse', note: 'invoices checked' }));
    const row = within(screen.getByTestId('lanes')).getByTestId(`lane-${SHA_A.slice(0, 8)}`);
    expect(row.textContent).toMatch(/On staging: 2431f684b v0\.443\.3-rc/);
    expect(within(row).getByText('READY FOR PROD')).toBeTruthy(); // staged, not yet marked
    fireEvent.click(within(row).getByText('STAGE'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/reviews/run-2431/stage'));
  });

  it('locks a run-level STAGE button when that SHA is behind main or would roll staging back', async () => {
    const api = await import('../hooks/useApi');
    const block = 'behind main: merge main';
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => {
      if (p === '/overview') return RESPONSE;
      if (p === '/reviews') return [{ freeze: { sha: SHA_A }, stage_block: block }];
      if (p === '/me') return { id: 'owner', name: 'denis', role: 'admin', color: '#64748b' };
      return [];
    });
    render(<MemoryRouter><Release /></MemoryRouter>);
    const row = await waitFor(() => within(screen.getByTestId('lanes')).getByTestId(`lane-${SHA_A.slice(0, 8)}`));
    const stage = within(row).getByText('STAGE') as HTMLButtonElement;
    expect(stage.disabled).toBe(true);
    expect(stage.getAttribute('title')).toBe(block);
    expect(within(row).getByTestId('stage-lock').textContent).toBe(block);
    fireEvent.click(stage);
    expect(vi.mocked(api.apiPost)).not.toHaveBeenCalled();
  });

  it('a developer can Stage and mark Ready for prod, and does not see Deploy to production', async () => {
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => {
      if (p === '/overview') return RESPONSE;
      if (p === '/me') return { id: 'u-antonio', name: 'antonio', role: 'developer', color: '#2563eb' };
      if (p === '/reviews') return [];
      return [];
    });
    render(<MemoryRouter><Release /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('candidates')).toBeTruthy());
    const cand = screen.getByTestId('candidate-fable/rc-0443-2');
    expect(within(cand).queryByText('DEPLOY TO PRODUCTION')).toBeNull();
    expect(within(cand).getByText('READY FOR PROD')).toBeTruthy();
    expect(within(cand).getByText('STAGE')).toBeTruthy();
    fireEvent.click(within(cand).getByText('STAGE'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/releases/candidates/fable%2Frc-0443-2/stage', { project: 'wavepulse' }));
  });

  it('STAGE stays off for a developer until the reviewer PASS, and an admin can still press it', async () => {
    const api = await import('../hooks/useApi');
    const board: Board = {
      ...BOARD,
      lanes: BOARD.lanes.map((l) => l.sha === SHA_A ? { ...l, verdict: 'needs-fixes' } : l),
      candidates: BOARD.candidates.map((c) => ({ ...c, lanes: c.lanes.map((l) => ({ ...l, verdict: 'needs-fixes' })) })),
    };
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => {
      if (p === '/overview') return { ...RESPONSE, board };
      if (p === '/me') return { id: 'u-antonio', name: 'antonio', role: 'developer', color: '#2563eb' };
      return [];
    });
    const view = render(<MemoryRouter><Release /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('candidates')).toBeTruthy());
    const row = within(screen.getByTestId('lanes')).getByTestId(`lane-${SHA_A.slice(0, 8)}`);
    expect((within(row).getByText('STAGE') as HTMLButtonElement).disabled).toBe(true);
    expect(within(row).getByText('STAGE').getAttribute('title')).toMatch(/reviewer's PASS/);
    const cand = screen.getByTestId('candidate-fable/rc-0443-2');
    expect((within(cand).getByText('STAGE') as HTMLButtonElement).disabled).toBe(true);
    view.unmount();

    vi.mocked(api.apiGet).mockImplementation(async (p: string) => {
      if (p === '/overview') return { ...RESPONSE, board };
      if (p === '/me') return { id: 'owner', name: 'denis', role: 'admin', color: '#64748b' };
      return [];
    });
    render(<MemoryRouter><Release /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('candidates')).toBeTruthy());
    expect((within(within(screen.getByTestId('lanes')).getByTestId(`lane-${SHA_A.slice(0, 8)}`)).getByText('STAGE') as HTMLButtonElement).disabled).toBe(false);
    expect((within(screen.getByTestId('candidate-fable/rc-0443-2')).getByText('STAGE') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a developer can stage a composed candidate the deploy agent already deployed, even if a lane is not a PASS', async () => {
    const api = await import('../hooks/useApi');
    const board: Board = {
      ...BOARD,
      candidates: BOARD.candidates.map((c) => ({
        ...c,
        lanes: c.lanes.map((l) => ({ ...l, verdict: 'needs-fixes' })),
        staging: { status: 'deployed', version: '0.443.3-rc', at: '2026-10-10T15:00:00Z', by: 'fable', verified_by: null, verified_at: null },
      })),
    };
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => {
      if (p === '/overview') return { ...RESPONSE, board };
      if (p === '/me') return { id: 'u-antonio', name: 'antonio', role: 'developer', color: '#2563eb' };
      return [];
    });
    render(<MemoryRouter><Release /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('candidates')).toBeTruthy());
    const stage = within(screen.getByTestId('candidate-fable/rc-0443-2')).getByText('STAGE');
    expect((stage as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(stage);
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/releases/candidates/fable%2Frc-0443-2/stage', { project: 'wavepulse' }));
  });

  it('a marked candidate and lane show Ready for prod', async () => {
    const api = await import('../hooks/useApi');
    const board: Board = {
      ...BOARD,
      lanes: BOARD.lanes.map((l) => l.sha === SHA_A ? { ...l, staging: { status: 'deployed', version: '0.443.3-rc', at: '2026-10-10T15:00:00Z', by: 'denis', verified_by: 'antonio', verified_at: '2026-10-10T16:00:00Z' }, next: 'Ready for prod — antonio' } : l),
      candidates: BOARD.candidates.map((c) => ({ ...c, verified: { by: 'antonio', at: '2026-10-10T16:00:00Z', note: 'invoices' }, next: 'Ready for prod — antonio' })),
    };
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => {
      if (p === '/overview') return { ...RESPONSE, board };
      if (p === '/me') return { id: 'owner', name: 'denis', role: 'admin', color: '#64748b' };
      if (p === '/reviews') return [];
      return [];
    });
    render(<MemoryRouter><Release /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('candidates')).toBeTruthy());
    const cand = screen.getByTestId('candidate-fable/rc-0443-2');
    expect(cand.textContent).toContain('Ready for prod');
    expect(cand.textContent).toContain('antonio');
    expect(within(cand).queryByText('READY FOR PROD')).toBeNull();
    const row = screen.getByTestId(`lane-${SHA_A.slice(0, 8)}`);
    expect(row.textContent).toContain('Ready for prod · antonio');
  });
});
