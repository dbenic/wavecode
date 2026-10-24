import { describe, expect, it } from 'vitest';
import {
  buildLaneCards, buildReleaseView, conflictFilesFromNote,
  type LaneFreezeFact, type LaneViewer, type WorkingLaneFact,
} from './lane-cards.js';

const OWNERS = [
  { name: 'Antonio', lanes: ['wc-s3-*', 'wc-eba-*', 'wc-canary', 'wc-pd111*'] },
  { name: 'Aleš', lanes: ['wc-ales-*', 'wc-recognition-*'] },
];
const ANTONIO: LaneViewer = { name: 'Antonio', lanes: OWNERS[0].lanes };
const ALES: LaneViewer = { name: 'Aleš', lanes: OWNERS[1].lanes };

function fact(over: Partial<LaneFreezeFact> & Pick<LaneFreezeFact, 'sha' | 'lane'>): LaneFreezeFact {
  return {
    project: 'countix',
    desk: null,
    title: null,
    summary: null,
    author_name: 'antonio',
    reviewer_name: null,
    verdict: null,
    verdict_path: null,
    created_at: '2026-10-12T18:00:00.000Z',
    state: 'awaiting_review',
    version: null,
    behind_main: false,
    superseded: false,
    in_staging: false,
    in_prod: false,
    action: 'none',
    action_lock: null,
    run_id: 'run-1',
    run_backed: true,
    quick_running: false,
    eta_min: null,
    conflict_files: [],
    auto_merge_main: false,
    auto_stage: false,
    reviewing_since: null,
    unknown_reason: null,
    live_at: null,
    ...over,
  };
}

describe('lane cards', () => {
  it('keeps one card per lane and folds older freezes into it', () => {
    const cards = buildLaneCards([
      fact({ sha: 'd7b7b1fb' + 'a'.repeat(32), lane: 'wc-s3-104', title: 'S3', desk: 104, created_at: '2026-10-12T19:00:00.000Z', reviewer_name: 'codex2', reviewing_since: '2026-10-12T19:10:00.000Z' }),
      fact({ sha: '11111111' + 'b'.repeat(32), lane: 'wc-s3-104', title: 'S3', desk: 104, created_at: '2026-10-11T09:00:00.000Z', state: 'superseded', superseded: true }),
    ], [], ANTONIO, OWNERS);
    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe('#104 S3');
    expect(cards[0].sha?.slice(0, 8)).toBe('d7b7b1fb');
    expect(cards[0].status).toBe('In review');
    expect(cards[0].action).toBe('codex2 reviewing since 19:10');
    const pooled = buildLaneCards([
      fact({ sha: 'd7b7b1fb' + 'a'.repeat(32), lane: 'wc-ales-106', reviewer_name: 'ales-codex1', reviewing_since: '2026-10-12T19:10:00.000Z', same_owner_pool: true }),
    ], [], ALES, OWNERS);
    expect(pooled[0].action).toBe('ales-codex1 reviewing since 19:10 — same-owner reviewer via pool');
    expect(cards[0].owner_label).toBe('codex2');
    expect(cards[0].older).toHaveLength(1);
    expect(cards[0].older[0].sha.startsWith('11111111')).toBe(true);
    expect(cards[0].history).toBe(false);
    expect(cards[0].pipeline.find((step) => step.id === 'review')?.mark).toBe('current');
  });

  it('says when main is merging, when the author was told, and which files conflict', () => {
    const lane = 'wc-recognition-timeout';
    const sha = '56f6a55d' + 'c'.repeat(32);
    const base = fact({ sha, lane, title: 'Recognition timeout', author_name: 'ales', behind_main: true, state: 'awaiting_review' });
    const told = buildLaneCards([base], [], ALES, OWNERS)[0];
    expect(told.status).toBe('Behind main');
    expect(told.action).toBe('Merge main and refreeze (agent notified)');
    expect(told.owner).toBe('developer');
    expect(told.needs_you).toBe(true);
    expect(told.button).toBeNull();
    expect(told.pipeline.find((step) => step.id === 'freeze')?.mark).toBe('blocked');

    const auto = buildLaneCards([{ ...base, auto_merge_main: true }], [], ALES, OWNERS)[0];
    expect(auto.action).toBe('Merging main automatically…');
    expect(auto.owner).toBe('developer');
    expect(auto.needs_you).toBe(true);
    expect(auto.mine).toBe(true);

    const conflict = buildLaneCards([{ ...base, conflict_files: ['invoice.ts', 'tax.ts'] }], [], ALES, OWNERS)[0];
    expect(conflict.action).toBe('Resolve conflict in invoice.ts, tax.ts');
    expect(conflict.owner_label).toBe('Aleš');
  });

  it('names the quick check, the staging button, Denis, and a live card in history', () => {
    const testing = buildLaneCards([
      fact({ sha: 'a'.repeat(40), lane: 'wc-canary', quick_running: true, eta_min: 6, state: 'awaiting_tests' }),
    ], [], ANTONIO, OWNERS)[0];
    expect(testing.status).toBe('Testing');
    expect(testing.action).toBe('Quick check running, about 6 min');
    expect(testing.owner).toBe('system');
    expect(testing.pipeline.find((step) => step.id === 'tests')?.mark).toBe('current');

    const staging = buildLaneCards([
      fact({ sha: 'e69d42f4' + 'd'.repeat(32), lane: 'wc-eba-viewer', title: 'EBA viewer', state: 'on_staging', action: 'ready' }),
    ], [], ANTONIO, OWNERS)[0];
    expect(staging.action).toBe('Check it on staging, then press Ready for prod');
    expect(staging.button).toEqual(expect.objectContaining({ kind: 'ready', label: 'Ready for prod' }));
    expect(staging.needs_you).toBe(false);
    expect(staging.history).toBe(true);
    expect(staging.pipeline.find((step) => step.id === 'ready')?.mark).toBe('current');

    const waiting = buildLaneCards([
      fact({ sha: '7b2bccd8' + 'e'.repeat(32), lane: 'wc-canary', title: 'Canary', state: 'awaiting_prod_go', version: 'v0.443.4', action: 'none' }),
    ], [], ANTONIO, OWNERS)[0];
    expect(waiting.status).toBe('Waiting for Denis');
    expect(waiting.action).toBe('in release 0.443.4');
    expect(waiting.owner_label).toBe('Denis');
    expect(waiting.button).toBeNull();
    expect(waiting.needs_you).toBe(false);

    const approver = buildLaneCards([
      fact({ sha: '7b2bccd8' + 'e'.repeat(32), lane: 'wc-canary', title: 'Canary', state: 'awaiting_prod_go', version: '0.443.4', action: 'promote' }),
    ], [], ANTONIO, OWNERS)[0];
    expect(approver.button).toEqual(expect.objectContaining({ kind: 'promote', label: 'Promote' }));
    expect(approver.needs_you).toBe(true);

    const live = buildLaneCards([
      fact({ sha: 'f'.repeat(40), lane: 'wc-old', state: 'live_on_prod', version: '0.442.8', live_at: '2026-10-12T18:04:00.000Z' }),
    ], [], ANTONIO, OWNERS)[0];
    expect(live.history).toBe(true);
    expect(live.status).toBe('Live');
    expect(live.action).toBe('0.442.8 · 12 Oct 18:04');
    expect(live.pipeline.every((step) => step.mark === 'done')).toBe(true);
  });

  it('gives needs-fixes one summary line and a verdict link, never the path as the action', () => {
    const card = buildLaneCards([
      fact({
        sha: '2b104dd9' + 'a'.repeat(32),
        lane: 'wc-ales-106',
        desk: 106,
        title: 'S3',
        author_name: 'ales',
        verdict: 'needs-fixes',
        state: 'needs_fixes',
        summary: 'The timeout still fires.\nSee /home/wave/inbox/freezes/verdict.md',
        verdict_path: '/home/wave/inbox/freezes/verdict.md',
      }),
    ], [], ALES, OWNERS)[0];
    expect(card.status).toBe('Needs fixes');
    expect(card.action).toBe('The timeout still fires.');
    expect(card.action).not.toContain('/home/');
    expect(card.link).toEqual({ label: 'Read the verdict', path: '/home/wave/inbox/freezes/verdict.md' });
    expect(card.owner_label).toBe("Aleš's agent");
    expect(card.pipeline.find((step) => step.id === 'review')?.mark).toBe('blocked');
    expect(card.button).toBeNull();
  });

  it('says a staging request is open, and only an admin gets Clear stuck request', () => {
    const sha = 'a'.repeat(40);
    const open = fact({
      sha, lane: 'wc-s3-104', state: 'ready_to_stage', action: 'stage',
      open_request_id: 'REL1', open_request_at: '2026-10-13 06:04:00', can_clear: true,
    });
    const card = buildLaneCards([open], [], ANTONIO, OWNERS)[0];
    expect(card.action).toBe('Staging request open since 06:04');
    expect(card.button).toMatchObject({ kind: 'clear', label: 'Clear stuck request', release_id: 'REL1' });
    const hidden = buildLaneCards([{ ...open, can_clear: false }], [], ANTONIO, OWNERS)[0];
    expect(hidden.action).toBe('Staging request open since 06:04');
    expect(hidden.button).toBeNull();
  });

  it('a behind-main branch is the author to-do, and Ready to stage names that author', () => {
    const behind = buildLaneCards([
      fact({
        sha: '336a5008' + 'a'.repeat(32), lane: 'canary-e2e-stage-v5', author_name: 'antonio',
        behind_main: true, state: 'ready_to_stage',
      }),
    ], [], ANTONIO, OWNERS)[0];
    expect(behind.status).toBe('Behind main');
    expect(behind.needs_you).toBe(true);
    expect(behind.mine).toBe(true);
    expect(behind.owner).toBe('developer');
    expect(behind.owner_label).toBe('Antonio');

    const ready = buildLaneCards([
      fact({
        sha: 'cab9ffe2' + 'b'.repeat(32), lane: 'wc-fable', author_name: 'fable',
        state: 'ready_to_stage', action: 'stage', run_backed: true, run_id: 'run-fable',
      }),
    ], [], null, OWNERS)[0];
    expect(ready.status).toBe('Ready to stage');
    expect(ready.button).toMatchObject({ kind: 'stage', label: 'Stage' });
    expect(ready.owner).toBe('developer');
    expect(ready.owner_label).toBe('fable');
    expect(ready.needs_you).toBe(true);
  });

  it('offers Stage only when it is manual, and locks it in words with no button', () => {
    const open = buildLaneCards([
      fact({ sha: 'a'.repeat(40), lane: 'wc-s3-104', state: 'ready_to_stage', action: 'stage', auto_stage: false }),
    ], [], ANTONIO, OWNERS)[0];
    expect(open.action).toBe('Press Stage');
    expect(open.button?.label).toBe('Stage');

    const automatic = buildLaneCards([
      fact({ sha: 'b'.repeat(40), lane: 'wc-s3-104', state: 'ready_to_stage', action: 'stage', auto_stage: true }),
    ], [], ANTONIO, OWNERS)[0];
    expect(automatic.action).toBe('Staging automatically…');
    expect(automatic.button).toBeNull();
    expect(automatic.needs_you).toBe(false);

    const locked = buildLaneCards([
      fact({ sha: 'c'.repeat(40), lane: 'wc-s3-104', state: 'ready_to_stage', action: 'stage', action_lock: 'Staging only moves forward' }),
    ], [], ANTONIO, OWNERS)[0];
    expect(locked.button).toBeNull();
    expect(locked.action).toBe('Staging only moves forward');
    expect(locked.pipeline.find((step) => step.id === 'staging')).toMatchObject({ mark: 'blocked', reason: 'Staging only moves forward' });
  });

  it('shows a lane with no freeze as Working, and My lanes follows the developer globs', () => {
    const working: WorkingLaneFact = {
      project: 'countix', lane: 'wc-pd111-s3', sha: 'cfec444f' + 'd'.repeat(32), author_name: 'antonio', title: 'PD-111 S3', desk: 111,
    };
    const cards = buildLaneCards([
      fact({ sha: '56f6a55d' + 'e'.repeat(32), lane: 'wc-recognition-timeout', title: 'Recognition timeout', behind_main: true, author_name: 'ales' }),
    ], [working], ANTONIO, OWNERS);
    const pd = cards.find((card) => card.lane === 'wc-pd111-s3');
    expect(pd?.status).toBe('Working');
    expect(pd?.action).toBe('Nothing frozen yet');
    expect(pd?.owner_label).toBe('Antonio');
    expect(pd?.mine).toBe(true);
    expect(pd?.needs_you).toBe(false);
    expect(pd?.history).toBe(true);
    expect(cards.find((card) => card.lane === 'wc-recognition-timeout')?.mine).toBe(false);

    const ales = buildLaneCards(cards.length ? [
      fact({ sha: '56f6a55d' + 'e'.repeat(32), lane: 'wc-recognition-timeout', behind_main: true }),
    ] : [], [working], ALES, OWNERS);
    expect(ales.find((card) => card.lane === 'wc-pd111-s3')?.mine).toBe(false);
    expect(ales.find((card) => card.lane === 'wc-recognition-timeout')?.mine).toBe(true);

    const everyone = buildLaneCards([], [working], null, OWNERS);
    expect(everyone[0].mine).toBe(false);
  });

  it('puts a superseded lane in history and queues Waiting for Denis on the release', () => {
    const cards = buildLaneCards([
      fact({ sha: 'abcabcab' + 'f'.repeat(32), lane: 'wc-old', state: 'superseded', superseded: true, title: 'Old' }),
      fact({ sha: '7b2bccd8' + 'a'.repeat(32), lane: 'wc-canary', title: 'Canary', state: 'awaiting_prod_go', version: '0.443.4', action: 'none' }),
    ], [], null, OWNERS);
    expect(cards.find((card) => card.lane === 'wc-old')?.history).toBe(true);
    const release = buildReleaseView(cards, {
      prod: { version: '0.442.9', sha: 'a'.repeat(40) },
      staging: { version: '0.443.2', sha: 'e69d42f4' + 'b'.repeat(32) },
    });
    expect(release.next_version).toBe('0.443.4');
    expect(release.queued.map((row) => row.title)).toEqual(['Canary']);
    expect(release.prod.version).toBe('0.442.9');
    expect(release.staging.sha?.slice(0, 8)).toBe('e69d42f4');
  });

  it('reads conflict file names out of the pipeline note', () => {
    expect(conflictFilesFromNote('auto: merge conflict in src/tax/invoice.ts, lib/tax.ts — @ales')).toEqual(['invoice.ts', 'tax.ts']);
    expect(conflictFilesFromNote('reassigned @a → @b')).toEqual([]);
  });

  it('greys Push to staging with the stored reason, and enables it only when that reason is empty', () => {
    const blocked = buildLaneCards([
      fact({ sha: 'd'.repeat(40), lane: 'wc-s3-104', ops_stage_block: 'needs green quick check on dddddddd' }),
    ], [], null, OWNERS)[0];
    expect(blocked.ops_push).toEqual({ enabled: false, reason: 'needs green quick check on dddddddd' });
    const open = buildLaneCards([
      fact({ sha: 'e'.repeat(40), lane: 'wc-s3-105', ops_stage_block: null }),
    ], [], null, OWNERS)[0];
    expect(open.ops_push).toEqual({ enabled: true, reason: null });
  });
});
