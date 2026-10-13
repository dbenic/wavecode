import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined) }));

const projects: Record<string, { repo?: string; lane_glob?: string; release_peer?: string; pipeline?: { lane_deny?: string[]; agent_deny?: string[] } }> = {};
const releases: { staging_health_command?: string[]; prod_health_command?: string[] } = {};
const peers: Record<string, { url: string; token: string }> = {};
vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({
    projects, releases, paths: {}, artifacts: { storage: '' },
    review: { auto_pick: false, default_reviewer: 'codex3' },
    peers, notifications: {},
  })),
}));

import * as db from './db.js';
import { ensureDeployStateTable, lastReconciledAt, reconcileDeployStates, resetDeployReconcilerForTest, reviewBoard, scheduleReconcile, startDeployReconciler, stopDeployReconciler } from './deploy-state.js';
import * as gitMemo from './git-memo.js';
import { behindMainAlert, MAIN_PING } from './lane-main.js';
import { setPeerFetchForTest } from './peers.js';
import { ensureReleaseFreezeTable } from './release-freezes.js';
import { ensureReleaseTables, reportRelease, requestRelease, resetStagingTipCacheForTest, resolveStagingTip, stopReleasePollers } from './releases.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
}

function pendingRun(agentId: string): string {
  const task = db.insertTask({ agent_id: agentId, prompt: 'freeze' });
  if (!task.ok) throw new Error(task.error);
  const run = db.insertRun({ task_id: task.data.id, agent_id: agentId });
  if (!run.ok) throw new Error(run.error);
  const done = db.finishRun(run.data.id, 0);
  if (!done.ok) throw new Error(done.error);
  return run.data.id;
}

describe('deploy reconciler review status and behind-main pings', () => {
  let tmp: string;
  let repo: string;
  let laneSha: string;
  let mainSha: string;
  let alesId: string;
  let codexId: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-recon-'));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    db.initDb(path.join(tmp, 't.db'));
    ensureReleaseFreezeTable();
    projects.wave = { repo, lane_glob: 'wc-*' };
    delete releases.staging_health_command;
    delete releases.prod_health_command;
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'wc-ales');
    fs.writeFileSync(path.join(repo, 'lane.txt'), 'lane');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'lane');
    laneSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/wc-ales', laneSha);
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'main');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main moved');
    mainSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
    const ales = db.insertAgent({ name: 'ales', runtime: 'codex', tmux_session: 'wc-ales', workspace: repo, mode: 'spawned', status: 'idle' });
    const codex = db.insertAgent({ name: 'codex3', runtime: 'codex', tmux_session: 'tmux-codex3', workspace: null, mode: 'spawned', status: 'idle' });
    if (!ales.ok || !codex.ok) throw new Error('seed');
    alesId = ales.data.id;
    codexId = codex.data.id;
  });

  afterEach(() => {
    stopDeployReconciler();
    resetDeployReconcilerForTest();
    stopReleasePollers();
    setPeerFetchForTest(null);
    resetStagingTipCacheForTest();
    for (const name of Object.keys(peers)) delete peers[name];
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete projects.wave;
  });

  function insertFreeze(sha: string, fields: {
    runId?: string | null;
    verdict?: string | null;
    status?: string;
    lane?: string;
    authorId?: string | null;
    authorName?: string | null;
    reviewerId?: string | null;
    createdAt?: string;
  }): void {
    db.getDb().prepare(
      `INSERT INTO release_freezes (
         sha, run_id, project, lane, author_agent_id, author_name, reviewer_agent_id, verdict, status, created_at
       ) VALUES (?, ?, 'wave', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sha,
      fields.runId ?? null,
      fields.lane ?? 'wc-ales',
      fields.authorId === undefined ? alesId : fields.authorId,
      fields.authorName === undefined ? 'ales' : fields.authorName,
      fields.reviewerId === undefined ? codexId : fields.reviewerId,
      fields.verdict ?? null,
      fields.status ?? 'open',
      fields.createdAt ?? '2026-01-01 00:00:00',
    );
  }

  function pings(): { entity_id: string }[] {
    return db.getDb().prepare('SELECT entity_id FROM events WHERE type = ?').all(MAIN_PING) as { entity_id: string }[];
  }

  function stateOf(sha: string): string | null {
    const row = db.getDb().prepare('SELECT state FROM deploy_card_states WHERE sha = ?').get(sha) as { state: string } | undefined;
    return row?.state ?? null;
  }

  it('backfills run review_status from the exact-SHA verdict and ignores the stale column for the queue', async () => {
    const passRun = pendingRun(alesId);
    const fixRun = pendingRun(alesId);
    const reviewRun = pendingRun(alesId);
    const passSha = laneSha;
    const fixSha = mainSha;
    const reviewSha = git(repo, 'rev-parse', 'HEAD~1');
    insertFreeze(passSha, { runId: passRun, verdict: 'pass', createdAt: '2026-01-03 00:00:00' });
    insertFreeze(fixSha, { runId: fixRun, verdict: 'needs-fixes', lane: 'wc-ales', createdAt: '2026-01-02 00:00:00' });
    insertFreeze(reviewSha, { runId: reviewRun, verdict: null, lane: 'wc-other', authorName: 'ales', createdAt: '2026-01-01 00:00:00' });
    db.getDb().prepare(
      `INSERT INTO code_reviews (id, run_id, reviewer_type, reviewer_agent_id, status, verdict)
       VALUES ('rv-pass', ?, 'cross-model', ?, 'done', 'reject')`,
    ).run(reviewRun, codexId);

    const { loadFor } = await import('./reviewer-assign.js');
    const before = db.getAgent(codexId);
    if (!before.ok) throw new Error(before.error);
    expect(loadFor(before.data).openReviews).toBe(0);
    const pending = db.getRun(passRun);
    if (!pending.ok) throw new Error(pending.error);
    expect(pending.data.review_status).toBe('pending');

    await reconcileDeployStates();

    const approved = db.getRun(passRun);
    const rejected = db.getRun(fixRun);
    const fromReview = db.getRun(reviewRun);
    if (!approved.ok || !rejected.ok || !fromReview.ok) throw new Error('run missing');
    expect(approved.data.review_status).toBe('approved');
    expect(rejected.data.review_status).toBe('rejected');
    expect(fromReview.data.review_status).toBe('rejected');
    const after = db.getAgent(codexId);
    if (!after.ok) throw new Error(after.error);
    expect(loadFor(after.data).openReviews).toBe(0);
  });

  it('pings each behind-main lane once per main SHA, and skips superseded, deployed, and denied authors', async () => {
    releases.staging_health_command = ['printf', '%s', mainSha];
    releases.prod_health_command = ['printf', '%s', mainSha];
    insertFreeze(laneSha, { verdict: null, createdAt: '2026-01-02 00:00:00' });
    insertFreeze('b'.repeat(40), { verdict: null, createdAt: '2026-01-01 00:00:00' });

    await reconcileDeployStates();
    expect(pings().map((row) => row.entity_id)).toEqual([`wc-ales:${mainSha}`]);
    const sent = db.listAgentMessages({ to_agent_id: alesId }).map((row) => row.message);
    expect(sent).toContain(behindMainAlert('wc-ales'));
    expect(stateOf(laneSha)).toBe('awaiting_review');

    await reconcileDeployStates();
    expect(pings()).toHaveLength(1);

    const superseded = 'e'.repeat(40);
    db.getDb().prepare(`DELETE FROM release_freezes`).run();
    db.getDb().prepare(`DELETE FROM events WHERE type = ?`).run(MAIN_PING);
    db.getDb().prepare(`DELETE FROM agent_messages`).run();
    insertFreeze(superseded, {
      verdict: null, status: 'stale', createdAt: '2026-01-01 00:00:00',
    });
    db.getDb().prepare(`UPDATE release_freezes SET superseded_by = ? WHERE sha = ?`).run(laneSha, superseded);
    await reconcileDeployStates();
    expect(pings()).toEqual([]);
    expect(stateOf(superseded)).toBe('superseded');
    expect(db.listAgentMessages({ to_agent_id: alesId })).toEqual([]);
  });

  it('does not ping a card already contained in staging, or a denied author', async () => {
    releases.staging_health_command = ['printf', '%s', laneSha];
    releases.prod_health_command = ['printf', '%s', mainSha];
    insertFreeze(laneSha, { verdict: null });
    await reconcileDeployStates();
    expect(pings()).toEqual([]);

    db.getDb().prepare(`DELETE FROM release_freezes`).run();
    releases.staging_health_command = ['printf', '%s', mainSha];
    const codex = db.insertAgent({
      name: 'codex1', runtime: 'codex', tmux_session: 'wc-codex1', workspace: repo, mode: 'spawned', status: 'idle',
    });
    if (!codex.ok) throw new Error(codex.error);
    projects.wave.pipeline = { agent_deny: ['codex1'], lane_deny: ['wc-codex1'] };
    git(repo, 'checkout', '-q', '-b', 'wc-codex1', 'HEAD~1');
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'codex lane');
    const deniedSha = git(repo, 'rev-parse', 'HEAD');
    insertFreeze(deniedSha, {
      verdict: null, lane: 'wc-codex1', authorId: codex.data.id, authorName: 'codex1', reviewerId: null,
    });
    await reconcileDeployStates();
    expect(pings().some((row) => row.entity_id.startsWith('wc-codex1:'))).toBe(false);
    expect(db.listAgentMessages({ to_agent_id: codex.data.id })).toEqual([]);
  });

  it('reads the staging tip and stage_block from the release peer, not the local health command', async () => {
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'checkout', '-q', '-b', 'wc-forward');
    fs.writeFileSync(path.join(repo, 'forward.txt'), 'forward');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'forward');
    const forwardSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'checkout', '-q', '-b', 'staging-tip');
    fs.writeFileSync(path.join(repo, 'staging.txt'), 'staging');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'staging only');
    const stagingSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');

    releases.staging_health_command = ['printf', '%s', forwardSha];
    releases.prod_health_command = ['printf', '%s', mainSha];
    projects.wave.release_peer = 'deploy/fable';
    peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789' };
    setPeerFetchForTest(async () => new Response(JSON.stringify({ sha: stagingSha, version: '0.443.2', lane: 'staging' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    insertFreeze(forwardSha, { verdict: 'pass', lane: 'wc-forward' });

    await reconcileDeployStates();
    const row = db.getDb().prepare('SELECT in_staging, stage_block, state FROM deploy_card_states WHERE sha = ?').get(forwardSha) as {
      in_staging: number | null; stage_block: string | null; state: string;
    };
    expect(row.in_staging).toBe(0);
    expect(row.state).toBe('ready_to_stage');
    expect(row.stage_block).toMatch(/would roll staging back/);
    const board = await reviewBoard({ name: 'antonio', role: 'developer' }, []);
    expect(board.release.staging.sha).toBe(stagingSha);
    const card = board.cards.find((item) => item.lane === 'wc-forward');
    expect(card?.button).toBeNull();
    expect(card?.action).toMatch(/would roll staging back/);

    resetStagingTipCacheForTest();
    setPeerFetchForTest(async () => new Response(JSON.stringify({ error: 'down' }), { status: 500 }));
    await reconcileDeployStates();
    const failed = db.getDb().prepare('SELECT in_staging, state FROM deploy_card_states WHERE sha = ?').get(forwardSha) as {
      in_staging: number | null; state: string;
    };
    expect(failed.in_staging).toBeNull();
    expect(failed.state).toBe('unknown');
    expect((await reviewBoard({ name: 'antonio', role: 'developer' }, [])).release.staging.sha).toBeNull();
  });

  it('marks only the current staging tip on_staging and supersedes an older contained SHA', async () => {
    ensureReleaseTables();
    git(repo, 'checkout', '-q', '-b', 'wc-old');
    fs.writeFileSync(path.join(repo, 'old.txt'), 'old');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'old');
    const oldSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'wc-tip');
    fs.writeFileSync(path.join(repo, 'tip.txt'), 'tip');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'tip');
    const tipSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    releases.staging_health_command = ['printf', '%s', tipSha];
    releases.prod_health_command = ['printf', '%s', mainSha];
    insertFreeze(oldSha, { verdict: 'pass', lane: 'wc-old', createdAt: '2026-01-01 00:00:00' });
    insertFreeze(tipSha, { verdict: 'pass', lane: 'wc-tip', createdAt: '2026-01-02 00:00:00' });

    await reconcileDeployStates();

    expect(stateOf(tipSha)).toBe('on_staging');
    expect(stateOf(oldSha)).toBe('superseded');
    const board = await reviewBoard({ name: 'antonio', role: 'developer' }, []);
    const tip = board.cards.find((card) => card.sha === tipSha);
    const old = board.cards.find((card) => card.sha === oldSha);
    expect(tip).toMatchObject({ status: 'On staging', history: true, needs_you: false });
    expect(old).toMatchObject({ status: 'Superseded', history: true, needs_you: false });
  });

  it('serves the card from the stored item state and does not scan git', async () => {
    ensureDeployStateTable();
    const readySha = 'a'.repeat(40);
    const lockedSha = 'b'.repeat(40);
    const unknownSha = 'c'.repeat(40);
    const readyRun = pendingRun(alesId);
    const lockedRun = pendingRun(alesId);
    const unknownRun = pendingRun(alesId);
    insertFreeze(readySha, { runId: readyRun, verdict: 'pass', lane: 'wc-canary-v4' });
    insertFreeze(lockedSha, { runId: lockedRun, verdict: 'pass', lane: 'wc-canary-locked' });
    insertFreeze(unknownSha, { runId: unknownRun, verdict: 'pass', lane: 'wc-canary-unknown' });
    const write = (sha: string, state: string, stageBlock: string | null, lane: string) => {
      db.getDb().prepare(
        `INSERT INTO deploy_card_states (
           sha, state, merged_main, in_staging, in_prod, behind_main, superseded, verdict, lane, stage_block, last_reconciled_at
         ) VALUES (?, ?, 1, 0, 0, 0, 0, 'pass', ?, ?, '2026-10-13T00:00:00.000Z')`,
      ).run(sha, state, lane, stageBlock);
    };
    write(readySha, 'ready_to_stage', null, 'wc-canary-v4');
    write(lockedSha, 'ready_to_stage', 'would roll staging back', 'wc-canary-locked');

    const ancestor = vi.spyOn(gitMemo, 'gitAncestor');
    const text = vi.spyOn(gitMemo, 'gitText');
    const board = await reviewBoard({ name: 'antonio', role: 'developer' }, []);
    expect(ancestor).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    ancestor.mockRestore();
    text.mockRestore();

    const readyItem = board.items.find((item) => item.freeze?.sha === readySha);
    const readyCard = board.cards.find((card) => card.sha === readySha);
    expect(readyItem?.deploy?.state).toBe('ready_to_stage');
    expect(readyItem?.deploy?.action).toBe('stage');
    expect(readyItem?.deploy?.action_lock).toBeNull();
    expect(readyCard).toMatchObject({ status: 'Ready to stage', history: false });
    expect(readyCard?.button).toMatchObject({ kind: 'stage', label: 'Stage' });

    const lockedItem = board.items.find((item) => item.freeze?.sha === lockedSha);
    const lockedCard = board.cards.find((card) => card.sha === lockedSha);
    expect(lockedItem?.deploy?.state).toBe('ready_to_stage');
    expect(lockedItem?.stage_block).toMatch(/would roll staging back/);
    expect(lockedCard?.status).toBe('Ready to stage');
    expect(lockedCard?.button).toBeNull();

    const unknownItem = board.items.find((item) => item.freeze?.sha === unknownSha);
    const unknownCard = board.cards.find((card) => card.sha === unknownSha);
    expect(unknownItem?.deploy).toMatchObject({ state: 'unknown', unknown_reason: 'Not reconciled yet' });
    expect(unknownCard).toMatchObject({ status: 'Unknown', action: 'Not reconciled yet' });
    expect(unknownCard?.button).toBeNull();
    expect(board.cards.some((card) => card.status === 'Working')).toBe(false);
  });

  it('a deploy finish replaces the cached peer tip, and a second Stage is refused', async () => {
    ensureReleaseTables();
    git(repo, 'checkout', '-q', '-b', 'wc-old');
    fs.writeFileSync(path.join(repo, 'old.txt'), 'old');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'old');
    const oldSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'wc-tip');
    fs.writeFileSync(path.join(repo, 'tip.txt'), 'tip');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'tip');
    const newSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'wc-next');
    fs.writeFileSync(path.join(repo, 'next.txt'), 'next');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'next');
    const childSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');

    releases.prod_health_command = ['printf', '%s', mainSha];
    projects.wave.release_peer = 'deploy/fable';
    peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789' };
    let tip = oldSha;
    setPeerFetchForTest(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/staging-tip')) return Response.json({ sha: tip, version: '1.4.0', lane: 'wc-tip' });
      if (url.pathname.endsWith('/events/log')) return Response.json({ events: [], last_id: 0 });
      if (init?.method === 'POST') return Response.json({ id: 'R1', status: 'sent' }, { status: 201 });
      return Response.json({ id: 'R1', status: 'sent', sha: newSha, target: 'staging' });
    });
    insertFreeze(oldSha, { verdict: 'pass', lane: 'wc-old', createdAt: '2026-01-01 00:00:00' });
    insertFreeze(newSha, { verdict: 'pass', lane: 'wc-tip', createdAt: '2026-01-02 00:00:00' });

    expect((await resolveStagingTip('wave')).tip?.sha).toBe(oldSha);
    tip = newSha;
    const againstStaleCache = await requestRelease({ project: 'wave', sha: newSha, lane: 'wc-tip', target: 'staging', actorName: 'denis' });
    expect(againstStaleCache.ok).toBe(false);
    if (!againstStaleCache.ok) expect(againstStaleCache.error).toMatch(/already on staging/);

    tip = oldSha;
    resetStagingTipCacheForTest();
    const first = await requestRelease({ project: 'wave', sha: newSha, lane: 'wc-tip', target: 'staging', actorName: 'denis' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await requestRelease({ project: 'wave', sha: childSha, lane: 'wc-next', target: 'staging', actorName: 'denis' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(new RegExp(`A staging request for wave is already open \\(${first.data.id}\\)`));
    stopReleasePollers();

    tip = oldSha;
    expect((await resolveStagingTip('wave')).tip?.sha).toBe(oldSha);
    tip = newSha;
    const reported = reportRelease(first.data.id, { status: 'deployed', version: '1.4.0', sha: newSha });
    expect(reported.ok).toBe(true);
    await reconcileDeployStates();
    const board = await reviewBoard({ name: 'antonio', role: 'developer' }, []);
    expect(board.release.staging.sha).toBe(newSha);
    expect(board.cards.find((card) => card.sha === newSha)).toMatchObject({ status: 'On staging', history: true });
    expect(board.cards.find((card) => card.sha === oldSha)).toMatchObject({ status: 'Superseded', history: true });

    const repeat = await requestRelease({ project: 'wave', sha: newSha, lane: 'wc-tip', target: 'staging', actorName: 'denis' });
    expect(repeat.ok).toBe(false);
    if (!repeat.ok) expect(repeat.error).toMatch(/already on staging/);
  });

  it('a deploy finish during the debounce still reconciles', async () => {
    const count = () => (db.getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'deploy.reconciled'").get() as { n: number }).n;
    try {
      startDeployReconciler();
      for (let i = 0; i < 40 && count() < 1; i++) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, 50));
      const base = count();
      scheduleReconcile('stage');
      scheduleReconcile('deploy');
      for (let i = 0; i < 40 && count() < base + 2; i++) await new Promise((r) => setTimeout(r, 50));
      expect(count()).toBeGreaterThanOrEqual(base + 2);
    } finally {
      stopDeployReconciler();
      resetDeployReconcilerForTest();
    }
  });

  it('a deploy reconcile reads a fresh peer tip instead of the cache', async () => {
    projects.wave.release_peer = 'deploy/fable';
    peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789' };
    let tip = mainSha;
    let fetches = 0;
    setPeerFetchForTest(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/staging-tip')) {
        fetches += 1;
        return Response.json({ sha: tip, version: '1.4.0', lane: 'wc-tip' });
      }
      return Response.json({ events: [], last_id: 0 });
    });
    expect((await resolveStagingTip('wave')).tip?.sha).toBe(mainSha);
    tip = laneSha;
    try {
      startDeployReconciler();
      for (let i = 0; i < 40 && !lastReconciledAt(); i++) await new Promise((r) => setTimeout(r, 25));
      const afterStartup = fetches;
      scheduleReconcile('deploy');
      for (let i = 0; i < 40 && fetches <= afterStartup; i++) await new Promise((r) => setTimeout(r, 50));
      const board = await reviewBoard({ name: 'antonio', role: 'developer' }, []);
      expect(fetches).toBeGreaterThan(afterStartup);
      expect(board.release.staging.sha).toBe(laneSha);
    } finally {
      stopDeployReconciler();
      resetDeployReconcilerForTest();
    }
  });
});
