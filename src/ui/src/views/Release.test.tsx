// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Release from './Release';
import type { ReleaseRequest, ReviewItem } from '../types';

vi.mock('../hooks/useApi', () => ({ apiGet: vi.fn(), apiPost: vi.fn(async () => ({})) }));
vi.mock('../hooks/useSSE', () => ({ useSSE: vi.fn() }));

const SHA_A = '2431f684b9e960b84e73a4e98b5068869664ffb4';
const SHA_B = '3562f0404cfc19de7ea6946ec57aa381055f8479';

function card(sha: string, over: Partial<NonNullable<ReviewItem['freeze']>> = {}): ReviewItem {
  return {
    run: { id: `run-${sha.slice(0, 4)}`, task_id: 't', agent_id: 'a', attempt: 1, status: 'done', started_at: '', finished_at: '', exit_code: 0, transcript_path: null, review_status: 'pending', result_path: null, summary: null } as ReviewItem['run'],
    task: { id: 't', agent_id: 'a', prompt: 'x', status: 'done', priority: 0, created_at: '', goal_id: null } as ReviewItem['task'],
    agentName: 'claude2', artifacts: [], duration: 1, latestReview: null,
    freeze: { sha, project: 'wavepulse', desk: 91, lane: 'wc-claude2', author_name: 'claude2', reviewer_name: 'codex3', verdict: 'pass', freeze_path: '/home/wave/inbox/desk91-freeze.md', verdict_path: null, gate: 'GREEN', status: 'open', superseded_by: null, ...over },
  };
}

const STAGED: ReleaseRequest = {
  id: 'R1', project: 'wavepulse', sha: SHA_A, lane: 'wc-claude2', target: 'staging', desk: '91', reviewer: 'codex3', requested_by: 'denis',
  origin: 'local', peer: 'deploy', peer_request_id: 'X1', run_id: 'run-2431', deploy_agent_id: null, status: 'deployed', version: '0.442.10',
  deployed_sha: SHA_A, report: 'deployed', error: null, created_at: '2026-10-10T14:00:00', updated_at: '2026-10-10T14:05:00', reported_at: '2026-10-10 14:05:00',
};

describe('Release view', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => {
      if (p === '/reviews') return [card(SHA_A), card(SHA_B, { verdict: 'needs-fixes', desk: 43, lane: 'wc-codex2' })];
      if (p.startsWith('/releases')) return [STAGED];
      return [];
    });
  });

  it('one row per reviewed lane with verdict, gate, staging and production state; Promote only on a PASS', async () => {
    render(<MemoryRouter><Release /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('lanes')).toBeTruthy());
    const a = screen.getByTestId(`lane-${SHA_A.slice(0, 8)}`);
    expect(a.textContent).toContain('Desk #91');
    expect(a.textContent).toContain('PASS');
    expect(a.textContent).toContain('GREEN');
    expect(a.textContent).toContain('deployed v0.442.10');
    expect((within(a).getByText('PROMOTE') as HTMLButtonElement).disabled).toBe(false);
    const b = screen.getByTestId(`lane-${SHA_B.slice(0, 8)}`);
    expect(b.textContent).toContain('NEEDS FIXES');
    expect((within(b).getByText('PROMOTE') as HTMLButtonElement).disabled).toBe(true);
    expect((within(b).getByText('STAGE') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('history').textContent).toContain('STAGING');
  });

  it('Stage posts the staging request; Promote asks for confirmation and posts the production GO', async () => {
    const api = await import('../hooks/useApi');
    render(<MemoryRouter><Release /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('lanes')).toBeTruthy());
    const b = screen.getByTestId(`lane-${SHA_B.slice(0, 8)}`);
    fireEvent.click(within(b).getByText('STAGE'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith(`/reviews/run-${SHA_B.slice(0, 4)}/stage`));
    const a = screen.getByTestId(`lane-${SHA_A.slice(0, 8)}`);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(within(a).getByText('PROMOTE'));
    expect(vi.mocked(api.apiPost)).not.toHaveBeenCalledWith(`/reviews/run-${SHA_A.slice(0, 4)}/promote`);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    fireEvent.click(within(a).getByText('PROMOTE'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith(`/reviews/run-${SHA_A.slice(0, 4)}/promote`));
  });
});
