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

function item(freeze: Partial<ReleaseFreezeCard> | null): ReviewItemType {
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
    latestReview: { id: 'cr1', verdict: freeze?.verdict ?? 'pass', issues_found: 0, fix_round: 0, created_at: '' },
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

  it('NEEDS FIXES: card without Promote', () => {
    renderItem(item({ verdict: 'needs-fixes' }));
    expect(screen.queryByText('PROMOTE')).toBeNull();
    expect(screen.getByText('no PASS — not promotable')).toBeTruthy();
  });

  it('a stale SHA shows what superseded it and cannot be promoted', () => {
    renderItem(item({ status: 'stale', superseded_by: 'e65a2ab5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }));
    expect(screen.queryByText('PROMOTE')).toBeNull();
    expect(screen.getByText('STALE → e65a2ab5')).toBeTruthy();
  });

  it('Reject on a freeze asks for a reason and sends it', async () => {
    const api = await import('../hooks/useApi');
    vi.spyOn(window, 'prompt').mockReturnValue('wrong base');
    renderItem(item({}));
    fireEvent.click(screen.getByText('REJECT'));
    await waitFor(() => expect(vi.mocked(api.apiPost)).toHaveBeenCalledWith('/reviews/r1/reject', { reason: 'wrong base' }));
  });

  it('a normal run card is unchanged: no freeze block, retry and hand-off present', () => {
    renderItem(item(null));
    expect(screen.queryByTestId('freeze-card')).toBeNull();
    expect(screen.getByText('RETRY')).toBeTruthy();
    expect(screen.getByText('HAND OFF')).toBeTruthy();
    expect(screen.getByText('PROMOTE')).toBeTruthy();
  });
});
