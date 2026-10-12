/**
 * Stage locks follow the freeze SHA, including a lane that is not configured
 * and a run whose card has already left the review list.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })), sendRawKeys: vi.fn(() => ({ ok: true })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined) }));

const projects: Record<string, { repo?: string; lane_glob?: string }> = {};
const releases: { staging_health_command?: string[]; prod_health_command?: string[] } = {};
vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({
    projects, releases, peers: {}, paths: {}, artifacts: { storage: '' },
    review: {}, notifications: {},
  })),
}));

import * as db from './db.js';
import { resetLaneBoardForTest } from './dev-lanes.js';
import { registerReleaseRoutes } from './routes/releases.js';
import { registerReviewRoutes } from './routes/reviews.js';
import { ensureReleaseFreezeTable, setFetchDisabledForTest } from './release-freezes.js';
import { ensureReleaseTables, resetStagingTipCacheForTest } from './releases.js';
import { stage } from './review-queue.js';
import { shaStageBlock, stageRefusal } from './sha-stage-block.js';
import { resetForwardMemoForTest } from './staging-forward.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
}

describe('stageRefusal', () => {
  const sha = 'b1729c93aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  it('refuses closed, merged, superseded, and contained SHAs before a forward move', () => {
    expect(stageRefusal({ sha, status: 'merged' })).toBe('Freeze b1729c93 is already on main');
    expect(stageRefusal({ sha, status: 'open', onMain: true })).toBe('Freeze b1729c93 is already on main');
    expect(stageRefusal({ sha, status: 'rejected' })).toBe('Freeze b1729c93 was rejected');
    expect(stageRefusal({ sha, status: 'promoted' })).toBe('Freeze b1729c93 was already promoted');
    expect(stageRefusal({ sha, status: 'stale', lane: 'canary-e2e', supersededBy: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toMatch(/stale/);
    expect(stageRefusal({ sha, status: 'open', behind: true })).toBe('behind main: merge main');
    expect(stageRefusal({ sha, status: 'open', inProd: true, forward: 'would roll staging back' })).toBe('Freeze b1729c93 is already in production');
    expect(stageRefusal({ sha, status: 'open', forward: 'would roll staging back: b1729c93 is missing 2 commits now on staging' })).toMatch(/would roll staging back/);
    expect(stageRefusal({ sha, status: 'open', inStaging: true })).toBe('Freeze b1729c93 is already on staging');
    expect(stageRefusal({ sha, status: 'open' })).toBeNull();
  });
});

describe('stage block from the card SHA', () => {
  let tmp: string;
  let repo: string;
  let base: string;
  let laneSha: string;
  let stagingSha: string;
  let authorId: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-stage-block-'));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    db.initDb(path.join(tmp, 't.db'));
    ensureReleaseFreezeTable();
    ensureReleaseTables();
    setFetchDisabledForTest(true);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-B', 'staging', base);
    fs.writeFileSync(path.join(repo, 's.txt'), 's1');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'staging 1');
    fs.writeFileSync(path.join(repo, 's2.txt'), 's2');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'staging 2');
    stagingSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-B', 'wc-a', base);
    fs.writeFileSync(path.join(repo, 'lane.txt'), 'lane');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'lane');
    laneSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/wc-a', laneSha);
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'update-ref', 'refs/remotes/origin/main', base);
    const health = path.join(tmp, 'staging.cjs');
    fs.writeFileSync(health, `process.stdout.write(${JSON.stringify(stagingSha)} + '\\n');\n`);
    projects.wave = { repo, lane_glob: 'wc-*' };
    releases.staging_health_command = [process.execPath, health];
    delete releases.prod_health_command;
    const author = db.insertAgent({ name: 'ales', runtime: 'codex', tmux_session: 'wc-a', workspace: null, mode: 'spawned', status: 'idle' });
    if (!author.ok) throw new Error(author.error);
    authorId = author.data.id;
  });

  afterEach(() => {
    setFetchDisabledForTest(false);
    resetLaneBoardForTest();
    resetForwardMemoForTest();
    resetStagingTipCacheForTest();
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete projects.wave;
    delete releases.staging_health_command;
    delete releases.prod_health_command;
  });

  function freezeRun(sha: string, lane: string, prompt: string): string {
    const task = db.insertTask({ agent_id: authorId, prompt });
    if (!task.ok) throw new Error(task.error);
    const run = db.insertRun({ task_id: task.data.id, agent_id: authorId });
    if (!run.ok) throw new Error(run.error);
    const done = db.finishRun(run.data.id, 0);
    if (!done.ok) throw new Error(done.error);
    db.getDb().prepare(
      `INSERT INTO release_freezes (sha, run_id, project, lane, author_agent_id, author_name, verdict, gate, status)
       VALUES (?, ?, 'wave', ?, ?, 'ales', 'pass', 'GREEN', 'open')`,
    ).run(sha, run.data.id, lane, authorId);
    return run.data.id;
  }

  it('fills stage_block for an unknown lane and an older SHA, and Stage refuses closed or contained runs', async () => {
    const older = freezeRun(base, 'wc-a', 'older card');
    const canary = freezeRun(laneSha, 'canary-e2e', 'unknown lane');
    const contained = freezeRun(stagingSha, 'canary-e2e', 'already staged');

    const app = new Hono();
    registerReviewRoutes(app as never);
    registerReleaseRoutes(app as never);
    const listed = await app.fetch(new Request('http://x/api/reviews'));
    expect(listed.status).toBe(200);
    const cards = await listed.json() as Array<{ task: { prompt: string }; stage_block: string | null }>;
    const byPrompt = new Map(cards.map((card) => [card.task.prompt, card.stage_block]));
    expect(byPrompt.get('older card')).toBe(`Freeze ${base.slice(0, 8)} is already on main`);
    expect(byPrompt.get('unknown lane')).toMatch(/would roll staging back/);
    expect(byPrompt.get('already staged')).toBe(`Freeze ${stagingSha.slice(0, 8)} is already on staging`);

    const one = await app.fetch(new Request(`http://x/api/reviews/${canary}`));
    expect(await one.json()).toMatchObject({ stage_block: expect.stringMatching(/would roll staging back/) });

    const stagedOlder = await stage(older);
    expect(stagedOlder.ok).toBe(false);
    if (!stagedOlder.ok) expect(stagedOlder.error).toBe(`Freeze ${base.slice(0, 8)} is already on main`);

    const stagedContained = await stage(contained);
    expect(stagedContained.ok).toBe(false);
    if (!stagedContained.ok) expect(stagedContained.error).toBe(`Freeze ${stagingSha.slice(0, 8)} is already on staging`);

    const stagedCanary = await stage(canary);
    expect(stagedCanary.ok).toBe(false);
    if (!stagedCanary.ok) expect(stagedCanary.error).toMatch(/would roll staging back/);

    db.getDb().prepare("UPDATE release_freezes SET status = 'merged', superseded_by = 'main' WHERE run_id = ?").run(canary);
    db.getDb().prepare("UPDATE runs SET review_status = 'approved' WHERE id = ?").run(canary);
    const afterClose = await app.fetch(new Request('http://x/api/reviews'));
    const stillListed = await afterClose.json() as Array<{ task: { prompt: string } }>;
    expect(stillListed.some((card) => card.task.prompt === 'unknown lane')).toBe(false);
    const stagedMerged = await stage(canary);
    expect(stagedMerged.ok).toBe(false);
    if (!stagedMerged.ok) expect(stagedMerged.error).toBe(`Freeze ${laneSha.slice(0, 8)} is already on main`);

    db.getDb().prepare("UPDATE release_freezes SET status = 'stale', superseded_by = ? WHERE run_id = ?").run(laneSha, contained);
    const stagedStale = await stage(contained);
    expect(stagedStale.ok).toBe(false);
    if (!stagedStale.ok) expect(stagedStale.error).toMatch(/stale/);

    const prod = path.join(tmp, 'prod.cjs');
    fs.writeFileSync(prod, `process.stdout.write(${JSON.stringify(stagingSha)} + '\\n');\n`);
    releases.prod_health_command = [process.execPath, prod];
    const prodBlock = await shaStageBlock({
      sha: stagingSha, project: 'wave', lane: 'canary-e2e', gate: 'GREEN', status: 'open', superseded_by: null,
    });
    expect(prodBlock).toBe(`Freeze ${stagingSha.slice(0, 8)} is already in production`);
  });
});
