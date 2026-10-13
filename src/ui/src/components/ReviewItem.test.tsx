// @vitest-environment jsdom

import '../../test-setup';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ReviewItem from './ReviewItem';
import type { ReviewItem as ReviewItemType, ReleaseFreezeCard } from '../types';

vi.mock('../hooks/useApi', () => ({
  apiGet: vi.fn(async () => []),
  apiPost: vi.fn(async () => ({})),
}));

const SHA = '2431f684b9e960b84e73a4e98b5068869664ffb4';

function item(freeze: (Partial<ReleaseFreezeCard> & { latestReviewIssues?: number }) | null): ReviewItemType {
  const issues = freeze?.latestReviewIssues ?? 0;
  if (freeze) delete freeze.latestReviewIssues;
  const base: ReleaseFreezeCard = {
    sha: SHA, project: 'wavepulse', desk: 91, lane: 'wc-claude2', author_name: 'claude2', reviewer_name: 'codex3',
    verdict: 'pass', freeze_path: '/home/wave/inbox/desk91-freeze-2431f684.md',
    verdict_path: '/home/wave/.wavecode-data/rooms/wavepulse/REPORTS/2026-10-09-desk91-2431f684-code-review-codex3.md',
    gate: 'GREEN', status: 'open', superseded_by: null,
  };
  return {
    run: { id: 'r1', task_id: 't1', agent_id: 'a1', attempt: 1, status: 'done', started_at: '2026-10-09 10:00:00', finished_at: '2026-10-09 10:00:01', exit_code: 0, transcript_path: null, review_status: 'pending', result_path: null, summary: null } as ReviewItemType['run'],
    task: { id: 't1', agent_id: 'a1', prompt: 'Release freeze wavepulse Desk #91 @ 2431f684', status: 'done', priority: 0, created_at: '', goal_id: null } as ReviewItemType['task'],
    agentName: 'claude2',
    artifacts: [],
    duration: 1,
    latestReview: { id: 'cr1', verdict: freeze?.verdict ?? 'pass', issues_found: issues, fix_round: 0, created_at: '' },
    freeze: freeze ? { ...base, ...freeze } : null,
  };
}

function renderItem(it: ReviewItemType) {
  return render(
    <MemoryRouter>
      <ReviewItem item={it} agents={[]} onAction={() => {}} index={0} />
    </MemoryRouter>,
  );
}

describe('ReviewItem freeze card', () => {
  it('shows repo, desk, lane, SHA, author, reviewer, gate and both file links; PROMOTE on a PASS; no retry/hand-off', async () => {
    renderItem(item({}));
    const card = screen.getByTestId('freeze-card');
    expect(card.textContent).toContain('wavepulse');
    expect(card.textContent).toContain('Desk #91');
    expect(card.textContent).toContain('wc-claude2');
    expect(card.textContent).toContain(SHA.slice(0, 12));
    expect(card.textContent).toContain('@claude2');
    expect(card.textContent).toContain('@codex3');
    expect(card.textContent).toContain('GATE GREEN');
    const links = screen.getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['freeze note', 'verdict']);
    expect(links[1].getAttribute('href')).toBe(`/file?path=${encodeURIComponent('/home/wave/.wavecode-data/rooms/wavepulse/REPORTS/2026-10-09-desk91-2431f684-code-review-codex3.md')}`);
    expect(screen.getByText('PROMOTE')).toBeTruthy();
    expect(screen.queryByText('RETRY')).toBeNull();
    expect(screen.queryByText('HAND OFF')).toBeNull();
    await waitFor(() => expect(screen.getByText('REJECT')).toBeTruthy());
  });

  it('NEEDS FIXES: card without Promote, verdict chip is not a green PASS, and STAGE needs a PASS', async () => {
    const api = await import('../hooks/useApi');
    vi.mocked(api.apiGet).mockImplementation(async (p: string) => {
      if (String(p).includes('ai-reviews')) {
        return [{
          id: 'cr1', run_id: 'r1', reviewer_type: 'cross-model', reviewer_agent_id: null, reviewer_runtime: null,
          status: 'done', diff: null, feedback: 'R1 — P1\nVERDICT: NEEDS FIXES', issues_found: 0,
          verdict: 'needs-fixes', fix_round: 0, fixes_sent_at: null, created_at: '',
        }];
      }
      return [];
    });
    renderItem(item({ verdict: 'needs-fixes', latestReviewIssues: 0 }));
    expect(screen.queryByText('PROMOTE')).toBeNull();
    expect(screen.getByText('no PASS — not promotable')).toBeTruthy();
    expect(screen.getByText('@codex3 VERDICT')).toBeTruthy();
    const chip = screen.getByTestId('review-chip');
    expect(chip.textContent).toMatch(/NEEDS FIXES/);
    expect(chip.textContent).not.toMatch(/PASS/);
    expect(chip.className).toMatch(/amber/);
    const stage = screen.getByText('STAGE');
    expect((stage as HTMLButtonElement).disabled).toBe(true);
    expect(stage.getAttribute('title')).toMatch(/reviewer's PASS on this exact SHA/);
    await waitFor(() => expect(chip.textContent).not.toMatch(/✓ PASS/));
  });

  it('an admin can still stage a freeze that is not a PASS', async () => {
    const api = await import('../hooks/useApi');
    render(
      <MemoryRouter>
        <ReviewItem item={item({ verdict: 'needs-fixes' })} agents={[]} onAction={() => {}} index={0} isAdmin />
      </MemoryRouter>,
    );
    const stage = screen.getByText('STAGE');
    expect((stage as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(stage);
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/reviews/r1/stage', undefined));
  });

  it('a stale SHA shows what superseded it and cannot be promoted', () => {
    renderItem(item({ status: 'stale', superseded_by: 'e65a2ab5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }));
    expect(screen.queryByText('PROMOTE')).toBeNull();
    expect(screen.getByText('STALE → e65a2ab5')).toBeTruthy();
  });

  it('locks STAGE on a stale freeze for an admin too', () => {
    render(
      <MemoryRouter>
        <ReviewItem item={item({ status: 'stale', verdict: 'pass' })} agents={[]} onAction={() => {}} index={0} isAdmin />
      </MemoryRouter>,
    );
    const stage = screen.getByRole('button', { name: 'STAGE' });
    expect((stage as HTMLButtonElement).disabled).toBe(true);
    expect(stage.getAttribute('title')).toMatch(/stale/);
  });

  it('disables STAGE when stage_block is set, including for an admin', () => {
    const blocked = item({});
    blocked.stage_block = 'would roll staging back: 2431f684 is missing 2 commits now on staging (v1.4.0, wc-ship)';
    render(
      <MemoryRouter>
        <ReviewItem item={blocked} agents={[]} onAction={() => {}} index={0} isAdmin />
      </MemoryRouter>,
    );
    const stage = screen.getByRole('button', { name: 'STAGE' });
    expect((stage as HTMLButtonElement).disabled).toBe(true);
    expect(stage.getAttribute('title')).toBe(blocked.stage_block);
    expect(screen.getByTestId('stage-lock').textContent).toBe(blocked.stage_block);
  });

  it('keeps STAGE available on a merged freeze when the SHA is not otherwise blocked', () => {
    render(
      <MemoryRouter>
        <ReviewItem item={item({ status: 'merged', verdict: 'pass' })} agents={[]} onAction={() => {}} index={0} isAdmin />
      </MemoryRouter>,
    );
    const stage = screen.getByRole('button', { name: 'STAGE' });
    expect((stage as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('stage-lock')).toBeNull();
  });

  it('keeps PROMOTE disabled until the full run is green, and shows a failure after staging', () => {
    const withBlock = item({});
    withBlock.promote_block = 'full run not green on 2431f684';
    withBlock.full_fail_flag = 'Full run FAILED after staging: lint. Fix before asking for prod';
    withBlock.status_line = 'On staging (quick check) · Full run: FAIL: lint';
    render(
      <MemoryRouter>
        <ReviewItem item={withBlock} agents={[]} onAction={() => {}} index={0} />
      </MemoryRouter>,
    );
    const promote = screen.getByText('PROMOTE');
    expect((promote as HTMLButtonElement).disabled).toBe(true);
    expect(promote.getAttribute('title')).toMatch(/full run not green on 2431f684/);
    expect(screen.getByTestId('full-fail-flag').textContent).toMatch(/Full run FAILED after staging: lint/);
    expect(screen.getByTestId('status-line').textContent).toMatch(/On staging \(quick check\)/);
  });

  it('Reject on a freeze asks for a reason and sends it', async () => {
    const api = await import('../hooks/useApi');
    vi.spyOn(window, 'prompt').mockReturnValue('wrong base');
    renderItem(item({}));
    fireEvent.click(screen.getByText('REJECT'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/reviews/r1/reject', { reason: 'wrong base' }));
  });

  it('STAGE becomes the live chip while staging is in flight, and comes back after a failure', () => {
    const { rerender } = render(
      <MemoryRouter>
        <ReviewItem item={item({})} agents={[]} onAction={() => {}} index={0} staging={{ id: 'rel-1', sha: SHA, status: 'sent', phase: 'verify', progress: 'heartbeat' }} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: 'STAGE' })).toBeNull();
    expect(screen.getByTestId('phase-verify').className).toMatch(/animate-pulse/);
    rerender(
      <MemoryRouter>
        <ReviewItem item={item({})} agents={[]} onAction={() => {}} index={0} staging={{ id: 'rel-1', sha: SHA, status: 'failed', phase: 'build', progress: 'fail', error: 'BUILD: build failed in fixture', rollbackStatus: 'ok' }} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('stage-chip').textContent).toContain('Failed at build');
    expect(screen.getByRole('button', { name: 'STAGE' })).toBeTruthy();
  });

  it('hides a zero-second timer', () => {
    const it = item({});
    it.duration = 0;
    renderItem(it);
    expect(screen.queryByText('0s')).toBeNull();
  });

  it('a reconciled card shows the note summary, version, badge and a locked reason', () => {
    const it = item({});
    it.deploy = {
      state: 'awaiting_tests',
      version: '0.442.10',
      badge: 'staging',
      test_kind: 'quick',
      test_at: '2026-10-12T12:00:00.000Z',
      test_word: 'pending',
      title: 'Desk #91 freeze note — issued credit notes',
      summary: 'issued credit notes',
      desk: 91,
      lane: 'wc-claude2',
      verdict: 'pass',
      unknown_reason: null,
      action: 'stage',
      action_lock: 'Waiting for quick or full tests on this exact SHA',
      admin_bypass: false,
      hide_errors: true,
      show_reject: true,
      run_backed: true,
      last_reconciled_at: '2026-10-12T12:04:00.000Z',
    };
    it.test_errors = [{ host: 'runner', msg: 'down' }];
    renderItem(it);
    expect(screen.getByText('Desk #91 freeze note — issued credit notes')).toBeTruthy();
    expect(screen.getByTestId('freeze-summary').textContent).toBe('issued credit notes');
    expect(screen.getByTestId('release-version').textContent).toBe('v0.442.10');
    expect(screen.getByTestId('deploy-badge').textContent).toBe('STAGING');
    expect(screen.getByTestId('test-kind').textContent).toMatch(/quick pending/);
    const stage = screen.getByRole('button', { name: 'STAGE' });
    expect((stage as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('action-lock').textContent).toMatch(/Waiting for quick or full tests/);
    expect(screen.queryByTestId('host-unreachable')).toBeNull();
    expect(screen.queryByText('PROMOTE')).toBeNull();
  });

  it('a composition card shows no desk number, and a superseded card has no stage button', () => {
    const it = item({ desk: 91 });
    it.deploy = {
      state: 'superseded',
      version: null,
      badge: null,
      test_kind: 'full',
      test_at: null,
      test_word: 'green',
      title: 'Composition release — wavepulse 0.442.0',
      summary: 'wavepulse 0.442.0',
      desk: null,
      lane: 'wc-codex2-wavenetic-04420-composition',
      verdict: 'pass',
      unknown_reason: null,
      action: 'none',
      action_lock: null,
      admin_bypass: false,
      hide_errors: true,
      show_reject: false,
      run_backed: true,
      last_reconciled_at: '2026-10-12T12:04:00.000Z',
    };
    renderItem(it);
    expect(screen.getByTestId('freeze-card').textContent).not.toMatch(/Desk #/);
    expect(screen.getByTestId('freeze-card').textContent).toContain('wc-codex2-wavenetic-04420-composition');
    expect(screen.queryByRole('button', { name: 'STAGE' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'PROMOTE' })).toBeNull();
  });

  it('a normal run card is unchanged: no freeze block, retry and hand-off present', () => {
    renderItem(item(null));
    expect(screen.queryByTestId('freeze-card')).toBeNull();
    expect(screen.getByText('RETRY')).toBeTruthy();
    expect(screen.getByText('HAND OFF')).toBeTruthy();
    expect(screen.getByText('PROMOTE')).toBeTruthy();
  });
});
