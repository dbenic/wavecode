/**
 * Every Stage path uses stageEligibility. A merged SHA that is on main and
 * forward of staging stays stageable. Behind, rollback, nothing-new, a newer
 * freeze, and rejected/abandoned do not.
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

const projects: Record<string, Record<string, unknown>> = {};
const releasesCfg: { deploy_agent?: string; staging_health_command?: string[] } = {};
vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ projects, releases: releasesCfg, peers: {}, paths: {}, artifacts: { storage: '' }, review: {}, notifications: {} })),
}));

import * as db from './db.js';
import { considerAutoStage, drainStagingQueue, latestPipelineNote } from './lane-pipeline.js';
import { autoStage } from './overlord.js';
import { ensurePeerTables } from './peers.js';
import { ensureReleaseFreezeTable, resetMergedCacheForTest, setFetchDisabledForTest } from './release-freezes.js';
import { acceptRelease, ensureReleaseTables, listReleases, requestRelease, resetStagingTipCacheForTest } from './releases.js';
import { registerReleaseRoutes } from './routes/releases.js';
import { stage } from './review-queue.js';
import { stageEligibility } from './sha-stage-block.js';
import { resetForwardMemoForTest } from './staging-forward.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
}

describe('stageEligibility on every Stage path', () => {
  let tmp: string;
  let repo: string;
  let health: string;
  let stagingSha: string;
  let mainSha: string;
  let behindSha: string;
  let nextSha: string;
  let authorId: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-elig-'));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    db.initDb(path.join(tmp, 't.db'));
    ensureReleaseFreezeTable();
    ensureReleaseTables();
    ensurePeerTables();
    setFetchDisabledForTest(true);
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 's.txt'), 's');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'staging');
    stagingSha = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'm');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main');
    mainSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
    git(repo, 'checkout', '-q', '-B', 'wc-next', mainSha);
    fs.writeFileSync(path.join(repo, 'n.txt'), 'n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'next');
    nextSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-B', 'wc-behind', base);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'behind');
    behindSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'update-ref', 'refs/remotes/origin/fable/rc-held', nextSha);
    git(repo, 'update-ref', 'refs/remotes/origin/fable/rc-next', nextSha);
    health = path.join(tmp, 'staging.cjs');
    pointHealth(stagingSha);
    projects.demo = { repo, lane_glob: 'wc-*', candidate_refs: 'fable/rc-*' };
    releasesCfg.deploy_agent = 'fable';
    const author = db.insertAgent({ name: 'ales', runtime: 'codex', tmux_session: 'wc-a', workspace: null, mode: 'spawned', status: 'idle' });
    if (!author.ok) throw new Error(author.error);
    authorId = author.data.id;
    db.insertAgent({ name: 'fable', runtime: 'claude-code', tmux_session: 'wc-fable', workspace: repo, mode: 'adopted', status: 'idle' });
  });

  afterEach(() => {
    setFetchDisabledForTest(false);
    resetMergedCacheForTest();
    resetForwardMemoForTest();
    resetStagingTipCacheForTest();
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete projects.demo;
    delete releasesCfg.deploy_agent;
    delete releasesCfg.staging_health_command;
  });

  function pointHealth(sha: string): void {
    fs.writeFileSync(health, `process.stdout.write(${JSON.stringify(sha)} + '\\n');\n`);
    releasesCfg.staging_health_command = [process.execPath, health];
    resetStagingTipCacheForTest();
    resetForwardMemoForTest();
  }

  function insertFreeze(sha: string, fields: { status?: string; lane?: string; created?: string; runId?: string | null } = {}): void {
    db.getDb().prepare(
      `INSERT INTO release_freezes (sha, run_id, project, lane, author_agent_id, author_name, verdict, gate, status, created_at)
       VALUES (?, ?, 'demo', ?, ?, 'ales', 'pass', 'GREEN', ?, ?)`,
    ).run(sha, fields.runId ?? null, fields.lane ?? 'wc-a', authorId, fields.status ?? 'open', fields.created ?? '2026-01-01 00:00:00');
  }

  function freezeRun(sha: string, status: string): string {
    const task = db.insertTask({ agent_id: authorId, prompt: 'merged forward' });
    if (!task.ok) throw new Error(task.error);
    const run = db.insertRun({ task_id: task.data.id, agent_id: authorId });
    if (!run.ok) throw new Error(run.error);
    const done = db.finishRun(run.data.id, 0);
    if (!done.ok) throw new Error(done.error);
    insertFreeze(sha, { status, runId: run.data.id });
    return run.data.id;
  }

  it('requestRelease refuses behind, nothing new, rejected, abandoned, and superseded, and stages a merged SHA that is forward of staging', async () => {
    insertFreeze(mainSha, { status: 'merged' });
    const merged = await requestRelease({ project: 'demo', sha: mainSha, lane: 'wc-a', target: 'staging', actorName: 'denis' });
    expect(merged.ok).toBe(true);

    const behind = await requestRelease({ project: 'demo', sha: behindSha, lane: 'wc-a', target: 'staging', actorName: 'denis' });
    expect(behind.ok).toBe(false);
    if (!behind.ok) expect(behind.error).toBe('behind main: merge main');

    pointHealth(mainSha);
    const same = await requestRelease({ project: 'demo', sha: mainSha, lane: 'wc-a', target: 'staging', actorName: 'denis' });
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error).toBe(`Freeze ${mainSha.slice(0, 8)} is already on staging`);

    pointHealth(stagingSha);
    db.getDb().prepare('DELETE FROM release_requests').run();
    db.getDb().prepare("UPDATE release_freezes SET status = 'rejected' WHERE sha = ?").run(mainSha);
    const rejected = await requestRelease({ project: 'demo', sha: mainSha, lane: 'wc-a', target: 'staging', actorName: 'denis' });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toBe(`Freeze ${mainSha.slice(0, 8)} was rejected`);

    db.getDb().prepare("UPDATE release_freezes SET status = 'abandoned' WHERE sha = ?").run(mainSha);
    const abandoned = await requestRelease({ project: 'demo', sha: mainSha, lane: 'wc-a', target: 'staging', actorName: 'denis' });
    expect(abandoned.ok).toBe(false);
    if (!abandoned.ok) expect(abandoned.error).toBe(`Freeze ${mainSha.slice(0, 8)} was abandoned`);

    db.getDb().prepare("UPDATE release_freezes SET status = 'open', created_at = '2026-01-01 00:00:00' WHERE sha = ?").run(mainSha);
    insertFreeze(nextSha, { lane: 'wc-a', created: '2026-01-02 00:00:00' });
    const older = await requestRelease({ project: 'demo', sha: mainSha, lane: 'wc-a', target: 'staging', actorName: 'denis' });
    expect(older.ok).toBe(false);
    if (!older.ok) expect(older.error).toMatch(/stale/);
    expect(listReleases({ sha: behindSha })).toEqual([]);
    expect(listReleases({ sha: mainSha })).toEqual([]);
  });

  it('acceptRelease uses the deploy box tip and still allows a merged SHA forward of that tip', async () => {
    insertFreeze(mainSha, { status: 'merged' });
    const allowed = await acceptRelease(
      { sha: mainSha, target: 'staging', project: 'demo', lane: 'wc-a' },
      { userName: 'fable', fromPeer: true },
    );
    expect(allowed.ok).toBe(true);

    pointHealth(mainSha);
    const same = await acceptRelease(
      { sha: mainSha, target: 'staging', project: 'demo', lane: 'wc-a' },
      { userName: 'fable', fromPeer: true },
    );
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error).toBe(`Freeze ${mainSha.slice(0, 8)} is already on staging`);

    const behind = await acceptRelease(
      { sha: behindSha, target: 'staging', project: 'demo', lane: 'wc-behind' },
      { userName: 'fable', fromPeer: true },
    );
    expect(behind.ok).toBe(false);
    if (!behind.ok) expect(behind.error).toBe('behind main: merge main');
  });

  it('drainStagingQueue checks again immediately before send', async () => {
    insertFreeze(mainSha);
    db.getDb().exec(`CREATE TABLE IF NOT EXISTS pipeline_queue (
      sha TEXT PRIMARY KEY, project TEXT NOT NULL, lane TEXT, kind TEXT NOT NULL, note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.getDb().prepare(`INSERT INTO pipeline_queue (sha, project, lane, kind) VALUES (?, 'demo', 'wc-a', 'stage')`).run(mainSha);
    pointHealth(mainSha);
    await drainStagingQueue('demo');
    expect(listReleases({ sha: mainSha })).toEqual([]);
    expect(latestPipelineNote('demo', 'wc-a')).toMatch(/already on staging/);

    pointHealth(stagingSha);
    db.getDb().prepare(`INSERT INTO pipeline_queue (sha, project, lane, kind) VALUES (?, 'demo', 'wc-a', 'stage')`).run(mainSha);
    await drainStagingQueue('demo');
    expect(listReleases({ project: 'demo', target: 'staging' })).toHaveLength(1);
    expect(listReleases({ sha: mainSha })[0]).toMatchObject({ requested_by: 'auto', target: 'staging' });
  });

  it('considerAutoStage and overlord auto-stage both use the guard', async () => {
    insertFreeze(mainSha);
    projects.demo.pipeline = { auto_stage: true };
    pointHealth(mainSha);
    await considerAutoStage(mainSha);
    expect(listReleases({ sha: mainSha })).toEqual([]);
    expect(latestPipelineNote('demo', 'wc-a')).toMatch(/already on staging/);

    pointHealth(stagingSha);
    await considerAutoStage(mainSha);
    expect(listReleases({ sha: mainSha })).toHaveLength(1);

    db.getDb().prepare('DELETE FROM release_requests').run();
    pointHealth(mainSha);
    const skipped = await autoStage({
      lanes: [{ status: 'open', verdict: 'pass', candidate: null, staging: null, project: 'demo', sha: mainSha, lane: 'wc-a', desk: null, reviewer: 'codex3', gate: 'GREEN', run_id: null }],
    } as never);
    expect(skipped).toBe(0);
    expect(listReleases({ sha: mainSha })).toEqual([]);

    pointHealth(stagingSha);
    const staged = await autoStage({
      lanes: [{ status: 'open', verdict: 'pass', candidate: null, staging: null, project: 'demo', sha: mainSha, lane: 'wc-a', desk: null, reviewer: 'codex3', gate: 'GREEN', run_id: null }],
    } as never);
    expect(staged).toBe(1);
    expect(listReleases({ sha: mainSha })[0]?.requested_by).toBe('overlord');
  });

  it('the candidate Stage route refuses a tip already on staging and accepts one that moves staging forward', async () => {
    const app = new Hono();
    registerReleaseRoutes(app as never);
    pointHealth(nextSha);
    resetMergedCacheForTest();
    const held = await app.fetch(new Request('http://x/api/releases/candidates/fable%2Frc-held/stage', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'demo' }),
    }));
    expect(held.status).toBe(400);
    expect(await held.json()).toMatchObject({ error: `Freeze ${nextSha.slice(0, 8)} is already on staging` });

    pointHealth(stagingSha);
    resetMergedCacheForTest();
    const forward = await app.fetch(new Request('http://x/api/releases/candidates/fable%2Frc-next/stage', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'demo' }),
    }));
    expect(forward.status).toBe(202);
    expect(listReleases({ sha: nextSha, target: 'staging' })).toHaveLength(1);
  });

  it('stage() allows a freeze closed as merged when its SHA is on main and forward of staging', async () => {
    const runId = freezeRun(mainSha, 'merged');
    const staged = await stage(runId);
    expect(staged.ok).toBe(true);
    if (staged.ok) expect(staged.data.sha).toBe(mainSha);
    const direct = await stageEligibility(mainSha, 'demo');
    expect(direct.error).toBeNull();
  });
});
