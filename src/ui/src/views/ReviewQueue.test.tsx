// @vitest-environment jsdom

import '../../test-setup';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ReviewQueue from './ReviewQueue';
import type { LaneCard, MergeQueueRowView, ReviewBoard } from '../types';
import type { SSEEvent } from '../hooks/useSSE';

vi.mock('../hooks/useApi', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock('../hooks/useSSE', () => ({
  useSSE: vi.fn(),
}));

vi.mock('../components/RoomProposals', () => ({
  default: () => null,
}));

function card(over: Partial<LaneCard> & Pick<LaneCard, 'key' | 'title' | 'status' | 'action'>): LaneCard {
  return {
    project: 'countix',
    lane: over.key,
    desk: null,
    sha: 'abcdef12' + '0'.repeat(32),
    owner: 'developer',
    owner_label: 'Antonio',
    needs_you: false,
    mine: true,
    history: false,
    button: null,
    pipeline: [
      { id: 'freeze', label: 'Freeze', mark: 'done', reason: null },
      { id: 'tests', label: 'Tests', mark: 'done', reason: null },
      { id: 'review', label: 'Review', mark: 'current', reason: null },
      { id: 'staging', label: 'Staging', mark: 'todo', reason: null },
      { id: 'ready', label: 'Ready', mark: 'todo', reason: null },
      { id: 'prod', label: 'Prod', mark: 'todo', reason: null },
    ],
    older: [],
    link: null,
    version: null,
    ...over,
  };
}

function board(over: Partial<ReviewBoard>): ReviewBoard {
  return {
    last_reconciled_at: '2026-10-12T20:00:00.000Z',
    stale: false,
    items: [],
    reviewers: [],
    cards: [],
    viewer: { name: 'Antonio' },
    release: {
      prod: { version: '0.442.9', sha: 'a'.repeat(40) },
      staging: { version: '0.443.2', sha: 'e69d42f4' + 'b'.repeat(32) },
      next_version: '0.443.4',
      queued: [{ lane: 'wc-canary', title: 'Canary', sha: '7b2bccd8' + 'c'.repeat(32), version: '0.443.4', desk: null }],
    },
    ...over,
  };
}

describe('ReviewQueue merge queue', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const sse = await import('../hooks/useSSE');
    vi.mocked(sse.useSSE).mockImplementation(() => undefined);
  });

  it('shows each card\'s queue line and lets an admin flip the kill switch', async () => {
    const useApi = await import('../hooks/useApi');
    let enabled = true;
    vi.mocked(useApi.apiGet).mockImplementation(async (path: string) => {
      if (path !== '/reviews/board') throw new Error(path);
      return board({
        viewer: { name: 'Antonio' },
        merge_queue: { can_switch: true, projects: [{ project: 'wavepulse', config_enabled: true, enabled, enabled_by: 'denis', queued: 2 }] },
        cards: [
          card({ key: 'wc-a', lane: 'wc-a', title: 'A', status: 'Reviewed', action: 'Waiting for its turn', queue: { state: 'queued', reason: null, tier: 'ask', position: 1, merge_sha: null, pr: '#103' } }),
          card({ key: 'wc-b', lane: 'wc-b', title: 'B', status: 'In review', action: 'codex3 reviewing', queue: { state: 'waiting', reason: 'waiting gate: quick green, api pending', tier: 'show', position: null, merge_sha: null, pr: null } }),
          card({ key: 'wc-c', lane: 'wc-c', title: 'C', status: 'Needs fixes', action: 'Fix and refreeze', queue: { state: 'bounced', reason: 'merge conflict with main in a.txt', tier: 'ship', position: null, merge_sha: null, pr: null } }),
          card({ key: 'wc-d', lane: 'wc-d', title: 'D', status: 'Merged', action: 'Nothing to do', queue: null }),
        ],
      }) as never;
    });
    vi.mocked(useApi.apiPost).mockImplementation(async (path: string, body?: unknown) => {
      expect(path).toBe('/merge-queue/wavepulse/switch');
      enabled = (body as { enabled: boolean }).enabled;
      return {} as never;
    });
    render(<MemoryRouter><ReviewQueue /></MemoryRouter>);
    expect(await screen.findByText('A')).toBeInTheDocument();
    const lines = screen.getAllByTestId('merge-queue');
    expect(lines.map((el) => el.textContent)).toEqual([
      'Merge queue · #1 · ask · PR #103',
      'Merge queue · waiting · show: waiting gate: quick green, api pending',
      'Merge queue · bounced · ship: merge conflict with main in a.txt',
    ]);
    expect(screen.getByTestId('merge-queue-wavepulse').textContent).toContain('merge queue wavepulse ON · 2 queued');
    fireEvent.click(screen.getByTestId('merge-queue-toggle-wavepulse'));
    await waitFor(() => expect(screen.getByTestId('merge-queue-wavepulse').textContent).toContain('OFF'));
    expect(screen.getByTestId('merge-queue-toggle-wavepulse').textContent).toBe('Start merging');
  });

  it('shows the whole flow: the stall first, then who is merging, queued, waiting and why', async () => {
    const useApi = await import('../hooks/useApi');
    const row = (over: Partial<MergeQueueRowView>): MergeQueueRowView => ({
      sha: 'a'.repeat(40), project: 'wavepulse', lane: 'wc-x', tier: 'show', state: 'waiting', reason: null, priority: 0,
      eligible_at: null, started_at: null, finished_at: null, merge_sha: null, pr: null, updated_at: '2026-10-26 10:00:00', ...over,
    });
    vi.mocked(useApi.apiGet).mockImplementation(async (path: string) => {
      if (path === '/reviews/board') return board({ merge_queue: { can_switch: false, projects: [{ project: 'wavepulse', config_enabled: true, enabled: true, enabled_by: 'denis', queued: 1 }] } }) as never;
      if (path === '/merge-queue') {
        return {
          switches: [],
          stalls: [{ project: 'wavepulse', code: 'GH_AUTH_MISSING', text: 'GitHub token file /home/wave/.config/wavecode/github-token is missing or empty', at: new Date().toISOString(), file: '/home/wave/inbox/wavecode-queue-stall-20261026-1000.md' }],
          rows: [
            row({ sha: 'b'.repeat(40), lane: 'wc-b', state: 'queued', tier: 'ship', eligible_at: '2026-10-26T09:50:00.000Z' }),
            row({ sha: 'c'.repeat(40), lane: 'claude6/overview-fixes', state: 'waiting', tier: 'ask', pr: '#210', reason: 'ASK_TIER_NO_OK: ask because of migrations/0394_x.sql; pull request #210 has no ask-tier-approved label from Denis' }),
            row({ sha: 'd'.repeat(40), lane: 'wc-d', state: 'waiting', reason: 'NO_PASS_ON_SHA: needs one PASS verdict on this exact SHA from a reviewer who is not the author' }),
            row({ sha: 'e'.repeat(40), lane: 'wc-e', state: 'merging', tier: 'show', started_at: new Date().toISOString() }),
            row({ sha: 'f'.repeat(40), lane: 'wc-f', state: 'merged', merge_sha: '9'.repeat(40), finished_at: '2026-10-26T08:00:00.000Z', reason: 'gate GREEN on 99999999' }),
            row({ sha: '1'.repeat(40), lane: 'wc-old', state: 'superseded', reason: 'freeze stale' }),
          ],
        } as never;
      }
      throw new Error(path);
    });
    render(<MemoryRouter><ReviewQueue /></MemoryRouter>);
    expect(await screen.findByTestId('merge-queue-stall')).toHaveTextContent('Stalled · GH_AUTH_MISSING: GitHub token file');
    expect(screen.getByTestId('merge-queue-stall')).toHaveTextContent('wavecode-queue-stall-20261026-1000.md');
    const active = within(screen.getByTestId('merge-queue-active')).getAllByTestId('merge-queue-row');
    expect(active.map((el) => [el.dataset.state, el.dataset.step])).toEqual([['merging', 'merging'], ['queued', 'queued'], ['waiting', 'OK'], ['waiting', 'review']]);
    expect(active[1]).toHaveTextContent('#1 wc-b');
    expect(active[2]).toHaveTextContent('step 4/7 · OK');
    expect(active[2]).toHaveTextContent('ASK_TIER_NO_OK: ask because of migrations/0394_x.sql');
    const done = within(screen.getByTestId('merge-queue-done')).getAllByTestId('merge-queue-row');
    expect(done.map((el) => el.dataset.state)).toEqual(['merged']);
    expect(done[0]).toHaveTextContent('ffffffff → 99999999');
    expect(screen.getByTestId('merge-queue-flow-toggle')).toHaveTextContent('1 merging · 1 queued · 2 waiting · 1 merged');
  });

  it('hides the toggle from a developer and says when the queue is not configured', async () => {
    const useApi = await import('../hooks/useApi');
    vi.mocked(useApi.apiGet).mockImplementation(async () => board({
      merge_queue: { can_switch: false, projects: [{ project: 'wavepulse', config_enabled: false, enabled: false, enabled_by: null, queued: 0 }] },
    }) as never);
    render(<MemoryRouter><ReviewQueue /></MemoryRouter>);
    expect(await screen.findByTestId('merge-queue-wavepulse')).toHaveTextContent('not configured');
    expect(screen.queryByTestId('merge-queue-toggle-wavepulse')).toBeNull();
  });
});

describe('ReviewQueue', () => {
  let sseHandler: ((event: SSEEvent) => void) | null = null;

  beforeEach(async () => {
    vi.clearAllMocks();
    sseHandler = null;
    const sse = await import('../hooks/useSSE');
    vi.mocked(sse.useSSE).mockImplementation((handler) => {
      sseHandler = handler;
    });
  });

  async function renderBoard(payload: ReviewBoard) {
    const useApi = await import('../hooks/useApi');
    vi.mocked(useApi.apiGet).mockImplementation(async (path: string) => {
      if (path === '/reviews/board') return payload as never;
      throw new Error(`Unexpected path: ${path}`);
    });
    render(<MemoryRouter><ReviewQueue /></MemoryRouter>);
  }

  it('refreshes the lane card when a review event arrives', async () => {
    const useApi = await import('../hooks/useApi');
    let n = 0;
    vi.mocked(useApi.apiGet).mockImplementation(async (path: string) => {
      if (path !== '/reviews/board') throw new Error(path);
      n += 1;
      const title = n === 1 ? 'S3' : 'S3 updated';
      return board({ cards: [card({ key: 'wc-s3-104', lane: 'wc-s3-104', title, status: 'In review', action: 'codex2 reviewing since 19:10' })] }) as never;
    });
    render(<MemoryRouter><ReviewQueue /></MemoryRouter>);
    expect(await screen.findByText('S3')).toBeInTheDocument();
    await act(async () => { sseHandler?.({ id: 1, type: 'run.finished', entityType: 'run', entityId: 'r', payload: null, createdAt: '2026-10-12T20:00:00Z' }); });
    await waitFor(() => expect(screen.getByText('S3 updated')).toBeInTheDocument());
  });

  it('defaults to My lanes, counts what you have to do, and hides the other developer', async () => {
    await renderBoard(board({
      cards: [
        card({ key: 'wc-eba-viewer', lane: 'wc-eba-viewer', title: 'EBA viewer', status: 'On staging', action: 'Check it on staging, then press Ready for prod', needs_you: true, button: { kind: 'ready', label: 'Ready for prod', run_id: null, sha: 'e69d42f4', project: 'countix' } }),
        card({ key: 'wc-recognition-timeout', lane: 'wc-recognition-timeout', title: 'Recognition timeout', status: 'Behind main', action: 'Merge main and refreeze (agent notified)', mine: false, needs_you: true, owner_label: 'Aleš' }),
      ],
    }));
    expect(await screen.findByTestId('things-to-do')).toHaveTextContent('You have 1 thing to do');
    expect(screen.getByText('EBA viewer')).toBeInTheDocument();
    expect(screen.queryByText('Recognition timeout')).not.toBeInTheDocument();
    expect(screen.getByTestId('action-ready')).toHaveTextContent('Ready for prod');
    expect(screen.getByTestId('how-it-works').querySelectorAll('li')).toHaveLength(7);
    fireEvent.click(screen.getByTestId('scope-toggle'));
    expect(screen.getByText('Recognition timeout')).toBeInTheDocument();
  });

  it('puts a superseded card in History and shows the release', async () => {
    await renderBoard(board({
      cards: [
        card({ key: 'wc-s3-104', lane: 'wc-s3-104', title: '#104 S3', status: 'In review', action: 'codex2 reviewing since 19:10' }),
        card({ key: 'wc-old', lane: 'wc-old', title: 'Old freeze', status: 'Superseded', action: 'A newer freeze replaced this one', history: true, needs_you: false }),
      ],
    }));
    expect(await screen.findByText('#104 S3')).toBeInTheDocument();
    expect(screen.queryByText('Old freeze')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('view-history'));
    expect(screen.getByText('Old freeze')).toBeInTheDocument();
    expect(screen.queryByText('#104 S3')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('view-release'));
    expect(screen.getByTestId('release-production')).toHaveTextContent('0.442.9');
    expect(screen.getByTestId('release-staging')).toHaveTextContent('e69d42f4');
    expect(screen.getByTestId('queued-wc-canary')).toHaveTextContent('Canary');
  });

  it('says the queue is clear when nothing is yours', async () => {
    await renderBoard(board({ cards: [], viewer: { name: 'Antonio' } }));
    expect(await screen.findByTestId('empty-state')).toHaveTextContent('Nothing for you, everything is moving.');
  });

  it('shows every lane when the viewer is unknown', async () => {
    await renderBoard(board({
      viewer: { name: null },
      cards: [
        card({ key: 'wc-s3-104', lane: 'wc-s3-104', title: '#104 S3', status: 'In review', action: 'codex2 reviewing since 19:10', mine: false }),
        card({ key: 'wc-ales-106', lane: 'wc-ales-106', title: '#106', status: 'Needs fixes', action: 'The timeout still fires.', mine: false, owner_label: "Aleš's agent" }),
      ],
    }));
    expect(await screen.findByText('#104 S3')).toBeInTheDocument();
    expect(screen.getByText('#106')).toBeInTheDocument();
    expect(screen.queryByTestId('things-to-do')).not.toBeInTheDocument();
    expect(screen.getByTestId('view-all')).toHaveTextContent('All lanes');
  });

  it('shows each reviewer queue and whether the pane is busy', async () => {
    await renderBoard(board({
      reviewers: [
        { id: 'c2', name: 'codex2', alias: null, busy: true, queue: 2 },
        { id: 'c3', name: 'codex3', alias: 'c3', busy: false, queue: 0 },
      ],
    }));
    expect(await screen.findByTestId('reviewer-load-codex2')).toHaveTextContent('@codex2 busy · queue 2');
    expect(screen.getByTestId('reviewer-load-codex3')).toHaveTextContent('@c3 idle · queue 0');
  });

  it('greys Push to staging with the reason, and posts the SHA when it is enabled', async () => {
    const useApi = await import('../hooks/useApi');
    vi.mocked(useApi.apiPost).mockResolvedValue({} as never);
    const sha = 'a'.repeat(40);
    await renderBoard(board({
      cards: [card({
        key: 'wc-s3-104',
        lane: 'wc-s3-104',
        title: '#104 S3',
        status: 'Ready to stage',
        action: 'Press Stage',
        sha,
        ops_push: { enabled: false, reason: "Stage needs the reviewer's PASS on this exact SHA" },
      })],
    }));
    const grey = await screen.findByTestId('push-staging');
    expect((grey as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('push-staging-reason')).toHaveTextContent("Stage needs the reviewer's PASS on this exact SHA");
    fireEvent.click(grey);
    expect(useApi.apiPost).not.toHaveBeenCalled();
  });

  it('posts Push to staging for an eligible SHA', async () => {
    const useApi = await import('../hooks/useApi');
    vi.mocked(useApi.apiPost).mockResolvedValue({} as never);
    const sha = 'b'.repeat(40);
    await renderBoard(board({
      cards: [card({
        key: 'wc-s3-104',
        lane: 'wc-s3-104',
        title: '#104 S3',
        status: 'Ready to stage',
        action: 'Press Stage',
        sha,
        ops_push: { enabled: true, reason: null },
      })],
    }));
    fireEvent.click(await screen.findByTestId('push-staging'));
    await waitFor(() => expect(useApi.apiPost).toHaveBeenCalledWith('/ops/stage', { sha }));
  });

  it('does not show a file path as the thing to do', async () => {
    await renderBoard(board({
      cards: [card({
        key: 'wc-ales-106',
        lane: 'wc-ales-106',
        title: '#106',
        status: 'Needs fixes',
        action: 'The timeout still fires.',
        owner_label: "Aleš's agent",
        link: { label: 'Read the verdict', path: '/home/wave/inbox/freezes/verdict.md' },
        mine: true,
      })],
    }));
    expect(await screen.findByTestId('verdict-link')).toHaveTextContent('Read the verdict');
    expect(screen.queryByText(/\/home\/wave/)).not.toBeInTheDocument();
  });
});
