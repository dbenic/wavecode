import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })), get: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined) }));

const projects: Record<string, { repo?: string; lane_glob?: string; pipeline?: { agent_deny?: string[]; lane_deny?: string[] } }> = {};
vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({
    projects, paths: {}, artifacts: { storage: '' }, review: {},
    server: { host: 'countix-dev' }, peers: {}, releases: {},
  })),
}));

const acting = { user: { id: 'owner', name: 'owner', role: 'admin', allowed_agents: null } as { id: string; name: string; role: string; allowed_agents: null } };
vi.mock('./auth.js', async () => {
  const actual = await vi.importActual<typeof import('./auth.js')>('./auth.js');
  return { ...actual, getActingUser: vi.fn(() => acting.user) };
});

import * as db from './db.js';
import { autoResolveObsoleteFreezes, setFarAheadForTest } from './freeze-resolve.js';
import { ensureReleaseFreezeTable, setFetchDisabledForTest } from './release-freezes.js';
import { ensureReleaseTables } from './releases.js';
import { ensurePeerTables } from './peers.js';
import { ensureReviewTable } from './code-review.js';
import { purgeStalePendingReviews } from './review-purge.js';
import { registerOverviewRoutes } from './routes/overview.js';
import * as rf from './release-freezes.js';
import * as lm from './lane-main.js';
import * as releasesApi from './releases.js';
import * as ov from './overview.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
}

function shaN(n: number): string {
  return n.toString(16).padStart(40, '0');
}

describe('overview snapshot', () => {
  let tmp: string;
  let app: Hono;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-overview-'));
    db.initDb(path.join(tmp, 't.db'));
    ensureReleaseFreezeTable();
    ensureReleaseTables();
    ensurePeerTables();
    setFetchDisabledForTest(true);
    acting.user = { id: 'owner', name: 'owner', role: 'admin', allowed_agents: null };
    app = new Hono();
    registerOverviewRoutes(app as never);
    for (const key of Object.keys(projects)) delete projects[key];
  });

  afterEach(() => {
    setFarAheadForTest(null);
    setFetchDisabledForTest(false);
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function runFor(agentId: string): string {
    const task = db.insertTask({ agent_id: agentId, prompt: 'work', created_by: null });
    if (!task.ok) throw new Error(task.error);
    const run = db.insertRun({ task_id: task.data.id, agent_id: agentId });
    if (!run.ok) throw new Error(run.error);
    return run.data.id;
  }

  function insertFreeze(fields: {
    sha: string; lane: string; status?: string; runId?: string | null; project?: string | null;
    authorId?: string | null; authorName?: string | null; verdict?: string | null;
    reason?: string | null; createdAt?: string; updatedAt?: string;
  }): void {
    db.getDb().prepare(
      `INSERT INTO release_freezes (
         sha, run_id, project, lane, author_agent_id, author_name, verdict, status, decision_reason, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      fields.sha,
      fields.runId ?? null,
      fields.project ?? null,
      fields.lane,
      fields.authorId ?? null,
      fields.authorName ?? null,
      fields.verdict ?? null,
      fields.status ?? 'open',
      fields.reason ?? null,
      fields.createdAt ?? '2026-10-01 00:00:00',
      fields.updatedAt ?? fields.createdAt ?? '2026-10-12 00:00:00',
    );
  }

  it('25 stale freezes in one lane are history, not decisions', () => {
    const agent = db.insertAgent({ name: 'claude1', runtime: 'claude-code', tmux_session: 'wc-claude1', mode: 'spawned', status: 'idle' });
    if (!agent.ok) throw new Error(agent.error);
    const runId = runFor(agent.data.id);
    for (let i = 0; i < 25; i++) {
      insertFreeze({
        sha: shaN(i + 1),
        lane: 'desk84-s6-year-end',
        status: 'stale',
        runId,
        project: 'countix',
        authorId: agent.data.id,
        authorName: 'claude1',
        createdAt: `2026-10-01 00:${String(i).padStart(2, '0')}:00`,
      });
    }
    const board = ov.buildBoard();
    expect(board.attention.filter((row) => row.kind === 'stale')).toEqual([]);
    expect(board.lanes).toEqual([]);
    expect(board.history).toHaveLength(1);
    expect(board.history[0].lane).toBe('desk84-s6-year-end');
    expect(board.history[0].sha).toBe(shaN(25));
  });

  it('GET /api/overview reads the snapshot and does no git or per-freeze work', async () => {
    const agent = db.insertAgent({ name: 'claude1', runtime: 'claude-code', tmux_session: 'wc-claude1', mode: 'spawned', status: 'idle' });
    if (!agent.ok) throw new Error(agent.error);
    const runId = runFor(agent.data.id);
    for (let i = 0; i < 25; i++) {
      insertFreeze({ sha: shaN(100 + i), lane: 'desk84-s6-year-end', status: 'stale', runId, project: 'countix', createdAt: `2026-10-02 00:${String(i).padStart(2, '0')}:00` });
    }
    ov.reconcileOverview();
    const listFreezes = vi.spyOn(rf, 'listFreezes');
    const candidateFor = vi.spyOn(rf, 'candidateFor');
    const reconcileMerged = vi.spyOn(rf, 'reconcileMerged');
    const isOnMain = vi.spyOn(rf, 'isOnMain');
    const commitsBehind = vi.spyOn(lm, 'commitsBehind');
    const listReleases = vi.spyOn(releasesApi, 'listReleases');
    const started = performance.now();
    const res = await app.fetch(new Request('http://x/api/overview'));
    const elapsed = performance.now() - started;
    expect(res.status).toBe(200);
    const body = await res.json() as { board: { agents: unknown[]; attention: Array<{ kind: string }>; history: unknown[] } };
    expect(body.board.agents).toHaveLength(1);
    expect(body.board.attention.filter((row) => row.kind === 'stale')).toEqual([]);
    expect(body.board.history).toHaveLength(1);
    expect(elapsed).toBeLessThan(300);
    expect(listFreezes).not.toHaveBeenCalled();
    expect(candidateFor).not.toHaveBeenCalled();
    expect(reconcileMerged).not.toHaveBeenCalled();
    expect(isOnMain).not.toHaveBeenCalled();
    expect(commitsBehind).not.toHaveBeenCalled();
    expect(listReleases).not.toHaveBeenCalled();
  });

  it('pages attention at 20 and keeps the full count of each kind', async () => {
    const agent = db.insertAgent({ name: 'claude2', runtime: 'claude-code', tmux_session: 'wc-claude2', mode: 'spawned', status: 'idle' });
    if (!agent.ok) throw new Error(agent.error);
    const runId = runFor(agent.data.id);
    for (let i = 0; i < 25; i++) {
      insertFreeze({
        sha: shaN(200 + i),
        lane: `lane-${i}`,
        status: 'open',
        verdict: 'pass',
        runId,
        authorName: 'claude2',
        createdAt: `2026-10-03 00:${String(i).padStart(2, '0')}:00`,
        updatedAt: '2026-10-12 12:00:00',
      });
    }
    const full = ov.buildBoard();
    expect(full.attention.filter((row) => row.kind === 'promotable')).toHaveLength(25);
    ov.reconcileOverview();
    const page1 = await (await app.fetch(new Request('http://x/api/overview?attention_page=1'))).json() as {
      board: { attention: unknown[]; attention_total: number; attention_page: number; attention_groups: Array<{ kind: string; count: number; items: unknown[] }> };
    };
    expect(page1.board.attention).toHaveLength(20);
    expect(page1.board.attention_total).toBe(25);
    expect(page1.board.attention_page).toBe(1);
    expect(page1.board.attention_groups.find((g) => g.kind === 'promotable')).toMatchObject({ count: 25 });
    const page2 = await (await app.fetch(new Request('http://x/api/overview?attention_page=2'))).json() as { board: { attention: unknown[]; attention_page: number } };
    expect(page2.board.attention_page).toBe(2);
    expect(page2.board.attention).toHaveLength(5);
  });

  it('auto-assigns the author and skips codex1 and a denied seat', async () => {
    const codex1 = db.insertAgent({ name: 'codex1', runtime: 'codex', tmux_session: 'wc-codex1', mode: 'spawned', status: 'idle' });
    const denied = db.insertAgent({ name: 'builder', runtime: 'codex', tmux_session: 'wc-builder', mode: 'spawned', status: 'idle' });
    const author = db.insertAgent({ name: 'claude2', runtime: 'claude-code', tmux_session: 'wc-claude2', mode: 'spawned', status: 'idle' });
    if (!codex1.ok || !denied.ok || !author.ok) throw new Error('agent');
    projects.demo = { pipeline: { agent_deny: ['builder'] } };
    const recent = '2026-10-12 12:00:00';
    insertFreeze({ sha: shaN(301), lane: 'wc-codex1', status: 'open', verdict: 'needs-fixes', runId: runFor(codex1.data.id), authorId: codex1.data.id, authorName: 'codex1', updatedAt: recent, createdAt: recent });
    insertFreeze({ sha: shaN(302), lane: 'wc-builder', status: 'open', verdict: 'needs-fixes', runId: runFor(denied.data.id), project: 'demo', authorId: denied.data.id, authorName: 'builder', updatedAt: recent, createdAt: recent });
    insertFreeze({ sha: shaN(303), lane: 'wc-claude2', status: 'open', verdict: 'needs-fixes', runId: runFor(author.data.id), authorId: author.data.id, authorName: 'claude2', updatedAt: recent, createdAt: recent });

    const board = ov.buildBoard();
    const byLane = new Map(board.fixes.map((row) => [row.lane, row]));
    expect(byLane.get('wc-codex1')?.assigned).toBeNull();
    expect(byLane.get('wc-builder')?.assigned).toBeNull();
    expect(byLane.get('wc-claude2')?.assigned).toMatchObject({ agent_name: 'claude2', status: 'pending' });
    expect(board.attention.filter((row) => row.kind === 'fix_unassigned').map((row) => row.sha).sort()).toEqual([shaN(301), shaN(302)].sort());
    const tasks = db.getDb().prepare('SELECT fix_sha, agent_id FROM tasks WHERE fix_sha IS NOT NULL').all() as { fix_sha: string; agent_id: string }[];
    expect(tasks).toEqual([{ fix_sha: shaN(303), agent_id: author.data.id }]);

    const codexRun = byLane.get('wc-codex1')!.run_id;
    const res = await app.fetch(new Request('http://x/api/overview/fixes/assign', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ run_id: codexRun, agent_id: codex1.data.id, note: 'please today' }),
    }));
    expect(res.status).toBe(201);
    const made = await res.json() as { task: { prompt: string; fix_sha: string } };
    expect(made.task.fix_sha).toBe(shaN(301));
    expect(made.task.prompt).toContain('From owner: please today');
  });

  it('closes a freeze on the deploy tip, leaves a cherry-pick that is not deployed open, and closes a rejected lane that moved ahead', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    projects.wave = { repo, lane_glob: 'wc-*' };
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const shipped = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', shipped);
    const agent = db.insertAgent({ name: 'claude2', runtime: 'claude-code', tmux_session: 'wc-claude2', workspace: repo, mode: 'spawned', status: 'idle' });
    if (!agent.ok) throw new Error(agent.error);
    const shippedRun = runFor(agent.data.id);
    insertFreeze({ sha: shipped, lane: 'wc-claude2', status: 'open', verdict: 'pass', runId: shippedRun, project: 'wave', authorId: agent.data.id, authorName: 'claude2', updatedAt: '2026-10-12 12:00:00' });
    db.getDb().prepare(
      `INSERT INTO release_requests (id, project, sha, target, status, origin, deployed_sha) VALUES ('rel-ship', 'wave', ?, 'staging', 'deployed', 'local', ?)`,
    ).run(shipped, shipped);

    git(repo, 'checkout', '-q', '-b', 'wc-empty');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'same');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'lane patch');
    const cherrySha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'cherry-pick', '--no-commit', cherrySha);
    git(repo, 'commit', '-q', '-m', 'same patch on main');
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
    const cherryRun = runFor(agent.data.id);
    insertFreeze({ sha: cherrySha, lane: 'wc-empty', status: 'open', verdict: 'needs-fixes', runId: cherryRun, project: 'wave', authorId: agent.data.id, authorName: 'claude2', updatedAt: '2026-10-12 12:00:00' });

    git(repo, 'checkout', '-q', '-b', 'wc-far');
    fs.writeFileSync(path.join(repo, 'c.txt'), 'old');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'rejected work');
    const rejected = git(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'c.txt'), 'one');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'ahead 1');
    fs.writeFileSync(path.join(repo, 'c.txt'), 'two');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'ahead 2');
    git(repo, 'update-ref', 'refs/remotes/origin/wc-far', git(repo, 'rev-parse', 'HEAD'));
    const rejectedRun = runFor(agent.data.id);
    insertFreeze({
      sha: rejected, lane: 'wc-far', status: 'rejected', verdict: 'reject', reason: 'no',
      runId: rejectedRun, project: 'wave', authorId: agent.data.id, authorName: 'claude2', updatedAt: '2026-10-12 12:00:00',
    });
    setFarAheadForTest(2);

    expect(autoResolveObsoleteFreezes()).toBe(2);
    const statusOf = (sha: string) => db.getDb().prepare('SELECT status, superseded_by FROM release_freezes WHERE sha = ?').get(sha) as { status: string; superseded_by: string | null };
    expect(statusOf(shipped)).toMatchObject({ status: 'merged', superseded_by: 'shipped' });
    expect(statusOf(cherrySha)).toMatchObject({ status: 'open', superseded_by: null });
    expect(statusOf(rejected).status).toBe('stale');
    const board = ov.buildBoard();
    expect(board.attention.filter((row) => row.kind === 'promotable' || row.kind === 'fix_unassigned')).toEqual([]);
    expect(board.lanes.find((row) => row.sha === cherrySha)?.next).toBe('merged, not yet deployed');
    expect(board.fixes.map((row) => row.sha)).not.toContain(cherrySha);
    expect(board.fixes.map((row) => row.sha)).not.toContain(rejected);
    expect(board.lanes.map((row) => row.sha)).not.toContain(shipped);
  });

  it('closes a cherry-pick once the main commit is contained in the deploy tip', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    projects.wave = { repo, lane_glob: 'wc-*' };
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'wc-empty');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'same');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'lane patch');
    const cherrySha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'cherry-pick', '--no-commit', cherrySha);
    git(repo, 'commit', '-q', '-m', 'same patch on main');
    const mainEq = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', mainEq);
    const agent = db.insertAgent({ name: 'claude2', runtime: 'claude-code', tmux_session: 'wc-claude2', workspace: repo, mode: 'spawned', status: 'idle' });
    if (!agent.ok) throw new Error(agent.error);
    insertFreeze({ sha: cherrySha, lane: 'wc-empty', status: 'open', verdict: 'pass', runId: runFor(agent.data.id), project: 'wave', authorId: agent.data.id, authorName: 'claude2', updatedAt: '2026-10-12 12:00:00' });
    db.getDb().prepare(
      `INSERT INTO release_requests (id, project, sha, target, status, origin, deployed_sha) VALUES ('rel-cherry', 'wave', ?, 'staging', 'deployed', 'local', ?)`,
    ).run(mainEq, mainEq);

    expect(autoResolveObsoleteFreezes()).toBe(1);
    const row = db.getDb().prepare('SELECT status, superseded_by FROM release_freezes WHERE sha = ?').get(cherrySha) as { status: string; superseded_by: string };
    expect(row).toMatchObject({ status: 'merged', superseded_by: mainEq });
  });

  it('leaves a deployed cherry-pick open when the deploy tip cannot be read', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    projects.wave = { repo, lane_glob: 'wc-*' };
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'wc-empty');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'same');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'lane patch');
    const cherrySha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'cherry-pick', '--no-commit', cherrySha);
    git(repo, 'commit', '-q', '-m', 'same patch on main');
    const mainEq = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', mainEq);
    const agent = db.insertAgent({ name: 'claude2', runtime: 'claude-code', tmux_session: 'wc-claude2', workspace: repo, mode: 'spawned', status: 'idle' });
    if (!agent.ok) throw new Error(agent.error);
    insertFreeze({ sha: cherrySha, lane: 'wc-empty', status: 'open', verdict: 'pass', runId: runFor(agent.data.id), project: 'wave', authorId: agent.data.id, authorName: 'claude2', updatedAt: '2026-10-12 12:00:00' });
    db.getDb().prepare(
      `INSERT INTO release_requests (id, project, sha, target, status, origin, deployed_sha) VALUES ('rel-cherry', 'wave', ?, 'staging', 'deployed', 'local', ?)`,
    ).run(mainEq, mainEq);
    const spy = vi.spyOn(releasesApi, 'currentStagingTip').mockImplementation(() => {
      throw new Error('unreadable tip');
    });
    try {
      expect(autoResolveObsoleteFreezes()).toBe(0);
      const row = db.getDb().prepare('SELECT status FROM release_freezes WHERE sha = ?').get(cherrySha) as { status: string };
      expect(row.status).toBe('open');
    } finally {
      spy.mockRestore();
    }
    expect(autoResolveObsoleteFreezes()).toBe(1);
    const closed = db.getDb().prepare('SELECT status FROM release_freezes WHERE sha = ?').get(cherrySha) as { status: string };
    expect(closed.status).toBe('merged');
  });

  it('a merge-only tip is not promotable and a stale merge-main tip is not a decision', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    projects.wave = { repo, lane_glob: 'wc-*' };
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'checkout', '-q', '-b', 'wc-ales');
    fs.writeFileSync(path.join(repo, 'lane.txt'), 'lane');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'lane work');
    const oldSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'main-only');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main feature');
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
    git(repo, 'checkout', '-q', 'wc-ales');
    git(repo, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', '-m', 'merge main', 'origin/main');
    const merged = git(repo, 'rev-parse', 'HEAD');
    const agent = db.insertAgent({ name: 'ales', runtime: 'codex', tmux_session: 'wc-ales', workspace: repo, mode: 'spawned', status: 'idle' });
    if (!agent.ok) throw new Error(agent.error);
    const runId = runFor(agent.data.id);
    insertFreeze({ sha: oldSha, lane: 'wc-ales', status: 'stale', verdict: 'pass', runId, project: 'wave', createdAt: '2026-10-01 00:00:00' });
    insertFreeze({ sha: merged, lane: 'wc-ales', status: 'open', verdict: 'pass', runId, project: 'wave', createdAt: '2026-10-02 00:00:00', updatedAt: '2026-10-12 00:00:00' });
    const board = ov.buildBoard();
    expect(board.attention.filter((row) => row.kind === 'stale' || row.kind === 'promotable')).toEqual([]);
    expect(board.lanes).toHaveLength(1);
    expect(board.lanes[0]).toMatchObject({ sha: merged, promotable: false });
  });

  it('purges pending review runs older than 7 days with no review activity and keeps the row', async () => {
    const agent = db.insertAgent({ name: 'claude2', runtime: 'claude-code', tmux_session: 'wc-claude2', mode: 'spawned', status: 'idle' });
    if (!agent.ok) throw new Error(agent.error);
    const mk = (finished: string) => {
      const id = runFor(agent.data.id);
      db.finishRun(id, 0);
      db.getDb().prepare('UPDATE runs SET finished_at = ?, review_status = ? WHERE id = ?').run(finished, 'pending', id);
      return id;
    };
    ensureReviewTable();
    const old = mk('2026-10-01 00:00:00');
    const reviewed = mk('2026-10-01 00:00:00');
    const recent = mk('2026-10-12 12:00:00');
    db.getDb().prepare(
      `INSERT INTO code_reviews (id, run_id, reviewer_type, status, verdict) VALUES ('cr1', ?, 'cross-model', 'done', 'pass')`,
    ).run(reviewed);
    const dry = purgeStalePendingReviews({ now: Date.parse('2026-10-13T00:00:00Z'), dryRun: true });
    expect(dry.abandoned).toEqual([old]);
    expect(db.getRun(old).data?.review_status).toBe('pending');
    const purged = purgeStalePendingReviews({ now: Date.parse('2026-10-13T00:00:00Z') });
    expect(purged.abandoned).toEqual([old]);
    expect(db.getRun(old).data?.review_status).toBe('abandoned');
    expect(db.getRun(reviewed).data?.review_status).toBe('pending');
    expect(db.getRun(recent).data?.review_status).toBe('pending');
    expect(db.getRun(old).ok).toBe(true);

    acting.user = { id: 'u', name: 'antonio', role: 'developer', allowed_agents: null };
    expect((await app.fetch(new Request('http://x/api/overview/reviews/purge', { method: 'POST', body: '{}' }))).status).toBe(403);
    acting.user = { id: 'owner', name: 'owner', role: 'admin', allowed_agents: null };
    const again = await app.fetch(new Request('http://x/api/overview/reviews/purge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ days: 7 }) }));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ abandoned: 0, dry_run: false });
  });

  it('records before/after timing for a seeded board', async () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    projects.wave = { repo, lane_glob: 'wc-*' };
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), '0');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'c0');
    const shas: string[] = [];
    for (let i = 1; i <= 30; i++) {
      fs.writeFileSync(path.join(repo, 'a.txt'), String(i));
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', `c${i}`);
      shas.push(git(repo, 'rev-parse', 'HEAD'));
    }
    git(repo, 'update-ref', 'refs/remotes/origin/main', shas[shas.length - 1]!);
    const agent = db.insertAgent({ name: 'claude1', runtime: 'claude-code', tmux_session: 'wc-claude1', mode: 'spawned', status: 'idle' });
    if (!agent.ok) throw new Error(agent.error);
    const runId = runFor(agent.data.id);
    shas.forEach((sha, i) => insertFreeze({
      sha, lane: `lane-${i}`, status: 'stale', runId, project: 'wave', createdAt: `2026-09-01 00:${String(i).padStart(2, '0')}:00`,
    }));
    for (let i = 0; i < 25; i++) {
      insertFreeze({
        sha: shaN(400 + i), lane: 'desk84-s6-year-end', status: 'stale', runId, project: 'wave',
        createdAt: `2026-09-02 00:${String(i).padStart(2, '0')}:00`,
      });
    }
    const beforeStart = performance.now();
    rf.reconcileMerged();
    for (const freeze of rf.listFreezes()) {
      releasesApi.listReleases({ sha: freeze.sha, limit: 20 });
      db.getDb().prepare('SELECT summary FROM runs WHERE id = ?').get(freeze.run_id);
      db.getDb().prepare('SELECT id FROM tasks WHERE prompt LIKE ? LIMIT 1').get(`%[fix ${freeze.sha.slice(0, 8)}]%`);
    }
    const beforeMs = performance.now() - beforeStart;
    ov.reconcileOverview();
    const afterStart = performance.now();
    const res = await app.fetch(new Request('http://x/api/overview'));
    const afterMs = performance.now() - afterStart;
    expect(res.status).toBe(200);
    expect(afterMs).toBeLessThan(300);
    const timing = { before_ms: Math.round(beforeMs), after_ms: Math.round(afterMs), freezes: rf.listFreezes().length };
    fs.writeFileSync('/tmp/overview-timing.json', JSON.stringify(timing));
    expect(timing.after_ms).toBeLessThan(timing.before_ms);
  });
});
