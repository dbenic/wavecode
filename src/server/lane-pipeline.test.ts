import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined) }));

const review = {
  auto_review: false, default_reviewer: 'codex3', self_review: true, max_fix_loops: 2,
  require_pass_to_promote: false, gate_dependents_on_approval: false, auto_pick: true, freeze_inbox: [] as string[],
};
const projects: Record<string, Record<string, unknown>> = {};
const releases: { deploy_agent?: string } = {};
vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ review, projects, releases, peers: {}, paths: {}, artifacts: { storage: '' }, notifications: {} })),
}));

import * as db from './db.js';
import { notify } from './notifications.js';
import { commitsBehind } from './lane-main.js';
import { laneStatusLine } from './lane-status.js';
import { alertBehind, alertLanesPastStaging, alertMerged, pingLaneAboutMain } from './lane-main.js';
import {
  considerAutoStage, drainStagingQueue, latestPipelineNote, onAuthorDone, onMainAdvanced, setPipelineExecForTest,
} from './lane-pipeline.js';
import { listPendingReviews } from './review-queue.js';
import { ensureReleaseFreezeTable, getFreeze, ingestFreezeFile, listReviewFreezes, setFetchDisabledForTest } from './release-freezes.js';
import { loadDevLanes, requestLaneReview } from './dev-lanes.js';
import { auditTrail, listReleases, reportRelease, verifyStaging } from './releases.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const calls: string[][] = [];

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
}

function agent(name: string, workspace: string | null, runtime = 'codex') {
  const row = db.insertAgent({
    name, runtime, tmux_session: `tmux-${name}`, workspace, mode: 'spawned', status: 'idle',
  });
  if (!row.ok) throw new Error(row.error);
  return row.data;
}

function messages(agentId: string): string[] {
  return db.listAgentMessages({ to_agent_id: agentId }).map((row) => row.message);
}

describe('hands-free lane pipeline', () => {
  let tmp: string;
  let repo: string;
  let freezeDir: string;
  let pipe: Record<string, unknown>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-pipe-'));
    repo = path.join(tmp, 'repo');
    freezeDir = path.join(tmp, 'freezes');
    fs.mkdirSync(repo);
    db.initDb(path.join(tmp, 't.db'));
    calls.length = 0;
    setPipelineExecForTest((argv) => {
      calls.push(argv);
      const text = argv.join(' ');
      if (text.includes('quick-fail')) return { code: 1, stdout: 'RED' };
      if (text.includes('gate-run')) return { code: 0, stdout: 'QUEUED\nGREEN' };
      return { code: 0, stdout: 'ok' };
    });
    pipe = {
      auto_freeze: false, auto_gate: false, auto_review: false, auto_stage: false, auto_merge_main: false,
      quick_check_command: ['quick-check', '{sha}', '{lane}'],
      push_command: ['push-lane', '{lane}', '{sha}'],
      gate_command: ['gate-run', '--full', '{sha}'],
      review_routes: {} as Record<string, string>,
      review_deny: ['codex1'],
      freeze_dir: freezeDir,
    };
    projects.wave = { repo, lane_glob: 'wc-*', main_remote: 'origin', main_branch: 'main', pipeline: pipe };
    releases.deploy_agent = 'fable';
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
    agent('fable', path.join(tmp, 'fable'));
  });

  afterEach(() => {
    setPipelineExecForTest(null);
    fs.rmSync(tmp, { recursive: true, force: true });
    delete projects.wave;
  });

  function branch(name: string, file: string, content: string): string {
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'checkout', '-q', '-B', name);
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', name);
    const sha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', `refs/remotes/origin/${name}`, sha);
    return sha;
  }

  /** Later lane contains the earlier SHA, so staging it does not roll the deploy back. */
  function contain(parent: string, child: string): string {
    git(repo, 'checkout', '-q', child);
    git(repo, 'merge', '--no-ff', '--no-edit', '-m', `merge ${parent}`, parent);
    const sha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', `refs/remotes/origin/${child}`, sha);
    return sha;
  }

  function moveMain(file: string, content: string): void {
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, file), content);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main moves');
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
  }

  function passNote(author: string, lane: string, sha: string, verdictPath = '/reviews/prev.md'): string {
    const file = path.join(freezeDir, `${author}-freeze-${sha.slice(0, 8)}.md`);
    fs.mkdirSync(freezeDir, { recursive: true });
    fs.writeFileSync(file, [
      `# ${lane} freeze note`,
      '',
      `Project: wave · Author: ${author}`,
      `- Lane: \`${lane}\``,
      `- Freeze SHA: \`${sha}\``,
      `- Review: @codex3 **VERDICT: PASS (gate pending)** on this exact SHA: ${verdictPath}`,
      'gate GREEN',
      '',
    ].join('\n'));
    return file;
  }

  it('aborts a dirty merge and tells the author the conflicting files', () => {
    const sha = branch('wc-ales', 'a.txt', 'lane');
    const author = agent('ales', repo);
    moveMain('a.txt', 'main');
    git(repo, 'checkout', '-q', 'wc-ales');
    pipe.auto_freeze = true;
    const result = onAuthorDone(author.id);
    expect(result.ok).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(messages(author.id).join('\n')).toMatch(/Your lane wc-ales is behind main\./);
    const written = fs.existsSync(freezeDir) ? fs.readdirSync(freezeDir).filter((name) => name.includes('auto-freeze')) : [];
    expect(written).toEqual([]);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('merges a clean main, pushes only the lane, and freezes the new SHA', () => {
    branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', repo);
    moveMain('main.txt', 'moved');
    git(repo, 'checkout', '-q', 'wc-ales');
    pipe.auto_freeze = true;
    const result = onAuthorDone(author.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sha).not.toBe('');
    expect(commitsBehind('wave', result.data.sha)).toBe(0);
    expect(getFreeze(result.data.sha)?.lane).toBe('wc-ales');
    const push = calls.find((argv) => argv[0] === 'push-lane');
    expect(push?.[1]).toBe('wc-ales');
    expect(push?.join(' ')).not.toMatch(/\bmain\b/);
    expect(calls.some((argv) => argv[0] === 'quick-check' && argv[1] === result.data.sha)).toBe(true);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('does not freeze when the quick check fails', () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', repo);
    pipe.auto_freeze = true;
    pipe.quick_check_command = ['quick-fail', '{sha}'];
    const result = onAuthorDone(author.id);
    expect(result.ok).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
    expect(messages(author.id).join('\n')).toMatch(/quick check failed/);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('does not merge or push main, a non-lane branch, or an unsafe ref', () => {
    const localMain = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-B', 'side');
    fs.writeFileSync(path.join(repo, 'later.txt'), 'later');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'origin moved');
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
    git(repo, 'checkout', '-q', 'main');
    const maintainer = agent('maintainer', repo);
    pipe.auto_merge_main = true;
    pipe.auto_freeze = true;
    onMainAdvanced('wave');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(localMain);
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    expect(calls.some((argv) => argv.join(' ').includes('main'))).toBe(false);
    expect(onAuthorDone(maintainer.id).ok).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(localMain);

    git(repo, 'checkout', '-q', '-B', 'topic');
    fs.writeFileSync(path.join(repo, 'topic.txt'), 'topic');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'topic');
    const topic = git(repo, 'rev-parse', 'HEAD');
    const topicAuthor = agent('topic', repo);
    expect(onAuthorDone(topicAuthor.id)).toMatchObject({ ok: false, error: 'refusing topic: not a developer lane' });
    onMainAdvanced('wave');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(topic);

    git(repo, 'checkout', '-q', '-B', 'wc-$(id)');
    fs.writeFileSync(path.join(repo, 'unsafe.txt'), 'unsafe');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'unsafe');
    const unsafe = git(repo, 'rev-parse', 'HEAD');
    const unsafeAuthor = agent('unsafe', repo);
    const refused = onAuthorDone(unsafeAuthor.id);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/not a safe branch name/);
    onMainAdvanced('wave');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(unsafe);
    expect(calls.filter((argv) => argv[0] === 'push-lane')).toEqual([]);
  });

  it('does nothing while auto-freeze is off', () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', repo);
    moveMain('main.txt', 'moved');
    git(repo, 'checkout', '-q', 'wc-ales');
    expect(onAuthorDone(author.id)).toMatchObject({ ok: false, error: 'auto-freeze off' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
  });

  it('refuses the author and a denied reviewer, then uses the ladder', () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', path.join(tmp, 'ales'));
    agent('codex1', path.join(tmp, 'codex1'));
    const reviewer = agent('codex3', path.join(tmp, 'codex3'));
    pipe.auto_review = true;
    pipe.review_routes = { ales: 'codex1' };
    const ingested = ingestFreezeFile(passNote('ales', 'wc-ales', sha));
    expect(ingested.ok).toBe(true);
    const sent = messages(reviewer.id).join('\n');
    expect(sent).toMatch(/Please review freeze/);
    expect(sent).toContain(path.join(freezeDir, `ales-freeze-${sha.slice(0, 8)}.md`));
    expect(messages(author.id).join('\n')).not.toMatch(/Please review/);
    expect(messages(db.listAgents().find((a) => a.name === 'codex1')!.id).join('\n')).not.toMatch(/Please review/);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('does not assign a reviewer when the only candidate is the author', () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', path.join(tmp, 'ales'));
    const pick = review.auto_pick;
    review.default_reviewer = 'ales';
    review.auto_pick = false;
    pipe.auto_review = true;
    pipe.review_routes = { ales: 'ales' };
    pipe.review_deny = [];
    try {
      ingestFreezeFile(passNote('ales', 'wc-ales', sha));
      expect(messages(author.id).join('\n')).toMatch(/author or a denied name/);
      expect(messages(author.id).join('\n')).not.toMatch(/Please review/);
    } finally {
      review.default_reviewer = 'codex3';
      review.auto_pick = pick;
    }
  });

  it('does not auto-stage a lane that is behind main', async () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    agent('ales', path.join(tmp, 'ales'));
    agent('codex3', path.join(tmp, 'codex3'));
    moveMain('main.txt', 'later');
    git(repo, 'checkout', '-q', 'wc-ales');
    ingestFreezeFile(passNote('ales', 'wc-ales', sha));
    pipe.auto_stage = true;
    await considerAutoStage(sha);
    expect(listReleases({ project: 'wave' })).toEqual([]);
    expect(latestPipelineNote('wave', 'wc-ales') ?? '').toMatch(/behind main/);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('does not auto-stage a protected path or an overlapping lane', async () => {
    const protectedSha = branch('wc-ales', 'src/version.ts', '9.9.9');
    agent('ales', path.join(tmp, 'ales'));
    agent('codex3', path.join(tmp, 'codex3'));
    projects.wave.protected_paths = ['src/version.ts'];
    ingestFreezeFile(passNote('ales', 'wc-ales', protectedSha));
    pipe.auto_stage = true;
    await considerAutoStage(protectedSha);
    expect(listReleases({ sha: protectedSha })).toEqual([]);
    expect(latestPipelineNote('wave', 'wc-ales')).toMatch(/src\/version\.ts/);
    expect(laneStatusLine({
      sha: protectedSha, behindMain: 0, gate: { state: 'green' }, autoNote: latestPipelineNote('wave', 'wc-ales'),
      freeze: { sha: protectedSha, verdict: 'pass', issues: 0, gate: 'GREEN' },
    })).toMatch(/auto: touches src\/version\.ts/);

    const other = branch('wc-other', 'same.txt', 'other');
    const sha = branch('wc-ben', 'same.txt', 'ben');
    agent('ben', path.join(tmp, 'ben'));
    db.getDb().prepare(
      `INSERT INTO release_requests (id, project, sha, lane, target, status, origin, requested_by, verified_by, verified_at)
       VALUES ('rel-other', 'wave', ?, 'wc-other', 'staging', 'deployed', 'local', 'human', 'dev', datetime('now'))`,
    ).run(other);
    ingestFreezeFile(passNote('ben', 'wc-ben', sha, '/reviews/ben.md'));
    await considerAutoStage(sha);
    expect(listReleases({ sha })).toEqual([]);
    expect(latestPipelineNote('wave', 'wc-ben')).toMatch(/overlaps lane wc-other/);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('hands a migration lane to deploy flagged for a pre-deploy dump', async () => {
    const sha = branch('wc-ales', 'db/migrations/001.sql', 'create table t(id int);');
    agent('ales', path.join(tmp, 'ales'));
    agent('codex3', path.join(tmp, 'codex3'));
    projects.wave.migrations_dir = 'db/migrations';
    ingestFreezeFile(passNote('ales', 'wc-ales', sha));
    pipe.auto_stage = true;
    await considerAutoStage(sha);
    const rows = listReleases({ project: 'wave', target: 'staging' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requested_by: 'auto', target: 'staging', report: 'needs pre-deploy dump' });
    expect(messages(db.listAgents().find((row) => row.name === 'fable')!.id).join('\n')).toMatch(/needs pre-deploy dump/);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'needs pre-deploy dump' }));
    expect(auditTrail().some((entry) => entry.who === 'auto' && /pre-deploy dump/.test(entry.detail ?? ''))).toBe(true);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('serializes staging until the pin expires, and never requests production', async () => {
    const first = branch('wc-ales', 'ales.txt', 'ales');
    branch('wc-ben', 'ben.txt', 'ben');
    const second = contain('wc-ales', 'wc-ben');
    agent('ales', path.join(tmp, 'ales'));
    agent('ben', path.join(tmp, 'ben'));
    agent('codex3', path.join(tmp, 'codex3'));
    ingestFreezeFile(passNote('ales', 'wc-ales', first));
    ingestFreezeFile(passNote('ben', 'wc-ben', second, '/reviews/ben.md'));
    pipe.auto_stage = true;
    await considerAutoStage(first);
    await considerAutoStage(second);
    expect(listReleases({ project: 'wave', target: 'staging' })).toHaveLength(1);
    const held = listReleases({ sha: first })[0];
    expect(held.requested_by).toBe('auto');
    reportRelease(held.id, { status: 'deployed', version: '1.4.0', sha: first, note: 'up' });
    db.getDb().prepare(`UPDATE release_requests SET pin_until = '2099-01-01T00:00:00Z', staging_url = 'https://staging.example/app' WHERE id = ?`).run(held.id);
    await drainStagingQueue('wave');
    expect(listReleases({ project: 'wave', target: 'staging' })).toHaveLength(1);
    db.getDb().prepare(`UPDATE release_requests SET pin_until = '2000-01-01T00:00:00Z' WHERE id = ?`).run(held.id);
    await drainStagingQueue('wave');
    const staged = listReleases({ project: 'wave', target: 'staging' });
    expect(staged).toHaveLength(2);
    expect(staged.map((row) => row.sha).sort()).toEqual([first, second].sort());
    expect(staged.every((row) => row.target === 'staging' && row.requested_by === 'auto')).toBe(true);
    expect(listReleases({ target: 'production' })).toEqual([]);
    expect(auditTrail().some((entry) => entry.who === 'auto' && entry.action === 'auto-stage')).toBe(true);
  });

  it('releases the next lane when the developer presses Ready for prod', async () => {
    const first = branch('wc-ales', 'ales.txt', 'ales');
    branch('wc-ben', 'ben.txt', 'ben');
    const second = contain('wc-ales', 'wc-ben');
    agent('ales', path.join(tmp, 'ales'));
    agent('ben', path.join(tmp, 'ben'));
    agent('codex3', path.join(tmp, 'codex3'));
    ingestFreezeFile(passNote('ales', 'wc-ales', first));
    ingestFreezeFile(passNote('ben', 'wc-ben', second, '/reviews/ben.md'));
    pipe.auto_stage = true;
    await considerAutoStage(first);
    await considerAutoStage(second);
    const held = listReleases({ sha: first })[0];
    db.getDb().prepare(`UPDATE release_requests SET staging_url = 'https://staging.example/app', pin_until = '2099-01-01T00:00:00Z' WHERE id = ?`).run(held.id);
    reportRelease(held.id, { status: 'deployed', version: '1.4.0', sha: first, note: 'up' });
    expect(listReleases({ project: 'wave', target: 'staging' })).toHaveLength(1);
    const verified = verifyStaging(held.id, { name: 'ales' }, 'looks good');
    expect(verified.ok).toBe(true);
    await drainStagingQueue('wave');
    expect(listReleases({ project: 'wave', target: 'staging' })).toHaveLength(2);
    expect(messages(db.listAgents().find((row) => row.name === 'ales')!.id).join('\n')).toMatch(/live on staging: https:\/\/staging\.example\/app v1\.4\.0/);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('merges main into an open lane and asks for a delta review', () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', repo);
    const reviewer = agent('codex3', path.join(tmp, 'codex3'));
    ingestFreezeFile(passNote('ales', 'wc-ales', sha, '/reviews/prev.md'));
    moveMain('main.txt', 'later');
    git(repo, 'checkout', '-q', 'wc-ales');
    pipe.auto_merge_main = true;
    pipe.auto_review = true;
    onMainAdvanced('wave');
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(head).not.toBe(sha);
    expect(commitsBehind('wave', head)).toBe(0);
    const text = messages(reviewer.id).join('\n');
    expect(text).toMatch(/delta review: merge only/);
    expect(text).toContain('/reviews/prev.md');
    expect(messages(author.id).join('\n')).toMatch(/Merged latest main into wc-ales/);
    expect(messages(author.id).join('\n')).not.toMatch(/behind main/);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('sends a main-move conflict back to the author seat', () => {
    branch('wc-ales', 'a.txt', 'lane');
    const author = agent('ales', repo);
    agent('codex3', path.join(tmp, 'codex3'));
    const sha = git(repo, 'rev-parse', 'HEAD');
    ingestFreezeFile(passNote('ales', 'wc-ales', sha));
    moveMain('a.txt', 'main');
    git(repo, 'checkout', '-q', 'wc-ales');
    pipe.auto_merge_main = true;
    onMainAdvanced('wave');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
    expect(messages(author.id).join('\n')).toMatch(/Your lane wc-ales is behind main\./);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('gives a denied lane and agent no ping, auto merge, freeze card, or reviewer', async () => {
    pipe.lane_deny = ['wc-codex1'];
    pipe.agent_deny = ['codex1'];
    pipe.review_deny = [];
    pipe.auto_merge_main = true;
    pipe.auto_freeze = true;
    pipe.auto_review = true;
    pipe.review_routes = { ales: 'codex1' };
    const sha = branch('wc-codex1', 'codex.txt', 'lane');
    const author = agent('codex1', repo);
    const reviewer = agent('codex3', path.join(tmp, 'codex3'));
    moveMain('main.txt', 'later');
    git(repo, 'checkout', '-q', 'wc-codex1');
    const mainSha = git(repo, 'rev-parse', 'origin/main');
    onMainAdvanced('wave');
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
    expect(messages(author.id)).toEqual([]);
    expect(pingLaneAboutMain({ lane: 'wc-codex1', project: 'wave', mainSha, kind: 'moved', authorName: 'codex1' })).toBe(false);
    expect(alertBehind({ lane: 'wc-codex1', project: 'wave', authorName: 'codex1' })).toBe(false);
    expect(alertMerged({ lane: 'wc-codex1', project: 'wave', mainSha, authorName: 'codex1' })).toBe(false);
    expect(messages(author.id)).toEqual([]);

    const frozen = onAuthorDone(author.id);
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) expect(frozen.error).toMatch(/denied/);
    const written = fs.existsSync(freezeDir) ? fs.readdirSync(freezeDir).filter((name) => name.includes('auto-freeze')) : [];
    expect(written).toEqual([]);
    const ingested = ingestFreezeFile(passNote('codex1', 'wc-codex1', sha));
    expect(ingested.ok).toBe(false);
    expect(getFreeze(sha)).toBeNull();
    expect(listPendingReviews()).toEqual([]);
    expect(messages(reviewer.id).join('\n')).not.toMatch(/Please review/);

    ensureReleaseFreezeTable();
    db.getDb().prepare(
      `INSERT INTO release_freezes (sha, project, lane, author_name, status) VALUES (?, 'wave', 'wc-codex1', 'codex1', 'open')`,
    ).run(sha);
    expect(listReviewFreezes().some((row) => row.lane === 'wc-codex1')).toBe(false);
    projects.wave.lane_glob = 'wc-ales';
    alertLanesPastStaging('wave', mainSha);
    expect(messages(author.id)).toEqual([]);

    const other = branch('wc-ales', 'ales.txt', 'ales');
    const ales = agent('ales', path.join(tmp, 'ales'));
    const allowed = ingestFreezeFile(passNote('ales', 'wc-ales', other));
    expect(allowed.ok).toBe(true);
    expect(listPendingReviews().some((item) => item.freeze?.lane === 'wc-ales')).toBe(true);
    expect(listPendingReviews().some((item) => item.freeze?.lane === 'wc-codex1')).toBe(false);
    expect(messages(author.id).join('\n')).not.toMatch(/Please review/);
    expect(messages(reviewer.id).join('\n')).toMatch(/Please review/);
    expect(messages(ales.id).join('\n')).not.toMatch(/Please review/);

    setFetchDisabledForTest(true);
    const lanes = await loadDevLanes();
    expect(lanes.some((lane) => lane.lane === 'wc-codex1')).toBe(false);
    const alesLane = lanes.find((lane) => lane.lane === 'wc-ales');
    expect(alesLane).toBeTruthy();
    expect(alesLane?.reviewers.some((row) => row.name === 'codex1')).toBe(false);
    expect(alesLane?.reviewers.some((row) => row.name === 'codex3')).toBe(true);
    const asked = await requestLaneReview({ project: 'wave', lane: 'wc-codex1', reviewer: 'codex3' });
    expect(asked.ok).toBe(false);
    setFetchDisabledForTest(false);
  });

  it('queues one full gate for a new freeze SHA', () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    agent('ales', path.join(tmp, 'ales'));
    pipe.auto_gate = true;
    const file = path.join(freezeDir, `ales-freeze-${sha.slice(0, 8)}.md`);
    fs.mkdirSync(freezeDir, { recursive: true });
    fs.writeFileSync(file, [
      `# wc-ales freeze note`,
      '',
      'Project: wave · Author: ales',
      '- Lane: `wc-ales`',
      `- Freeze SHA: \`${sha}\``,
      '',
    ].join('\n'));
    ingestFreezeFile(file);
    ingestFreezeFile(file);
    const gates = calls.filter((argv) => argv[0] === 'gate-run');
    expect(gates).toHaveLength(1);
    expect(gates[0]).toContain(sha);
    expect(getFreeze(sha)?.gate).toBe('GREEN');
    expect(latestPipelineNote('wave', 'wc-ales')).toMatch(/full gate GREEN/);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });
});
