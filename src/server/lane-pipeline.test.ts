import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined) }));

const review: {
  auto_review: boolean; default_reviewer: string; self_review: boolean; max_fix_loops: number;
  require_pass_to_promote: boolean; gate_dependents_on_approval: boolean; auto_pick: boolean; freeze_inbox: string[];
  min_capacity_pct?: number;
  first_pass?: { enabled?: boolean; seats?: string[]; dir?: string; timeout_min?: number };
} = {
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
  considerAutoStage, drainStagingQueue, gateLoadForTest, gateOutcome, latestPipelineNote, mergeMainClean, onAuthorDone, onMainAdvanced, pipelineTick, pushedShaError,
  setPublishRefusalQuietMsForTest,
  authorLoadForTest, cancelStateForTest, ensureMainGate, ensureProdSyncLane, mainApiState, quickLoadForTest, reassignWaitingReviews, resetPipelineForTest, runRefusal, setPipelineExecForTest, setRefusedRetryMsForTest, type ExecOptions, ingestReviewRequestFile } from './lane-pipeline.js';
import { recordCandidateReviewFile } from './candidate-review.js';
import { emit } from './event-bus.js';
import { backfillFreezes, setFreezeGate } from './release-freezes.js';
import { setTestRunExecForTest } from './test-runs.js';
import { firstPassFor, recordFirstPassFile } from './first-pass.js';
import { listPendingReviews } from './review-queue.js';
import { ensureReleaseFreezeTable, getFreeze, ingestFreezeFile, listReviewFreezes, setFetchDisabledForTest } from './release-freezes.js';
import { loadDevLanes, requestLaneReview } from './dev-lanes.js';
import { auditTrail, listReleases, reportRelease, verifyStaging } from './releases.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const calls: string[][] = [];
const optsSeen: Array<{ argv: string[]; opts: ExecOptions }> = [];

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
    optsSeen.length = 0;
    resetPipelineForTest();
    setPipelineExecForTest((argv, opts) => {
      calls.push(argv);
      optsSeen.push({ argv, opts: { ...opts, ...(opts.cwd ? { cwd: opts.cwd, cwdExisted: fs.existsSync(opts.cwd) } : {}) } as ExecOptions });
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

  it('aborts a dirty merge and tells the author the conflicting files', async () => {
    const sha = branch('wc-ales', 'a.txt', 'lane');
    const author = agent('ales', repo);
    moveMain('a.txt', 'main');
    git(repo, 'checkout', '-q', 'wc-ales');
    pipe.auto_freeze = true;
    const result = (await onAuthorDone(author.id));
    expect(result.ok).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(messages(author.id).join('\n')).toMatch(/Your lane wc-ales is behind main\./);
    const written = fs.existsSync(freezeDir) ? fs.readdirSync(freezeDir).filter((name) => name.includes('auto-freeze')) : [];
    expect(written).toEqual([]);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('merges a clean main, pushes only the lane, and freezes the new SHA', async () => {
    branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', repo);
    moveMain('main.txt', 'moved');
    git(repo, 'checkout', '-q', 'wc-ales');
    pipe.auto_freeze = true;
    const result = (await onAuthorDone(author.id));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.sha).not.toBe('');
    expect((await commitsBehind('wave', result.data.sha))).toBe(0);
    expect(getFreeze(result.data.sha)?.lane).toBe('wc-ales');
    const push = calls.find((argv) => argv[0] === 'push-lane');
    expect(push?.[1]).toBe('wc-ales');
    expect(push?.join(' ')).not.toMatch(/\bmain\b/);
    expect(calls.some((argv) => argv[0] === 'quick-check' && argv[1] === result.data.sha)).toBe(true);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('does not freeze when the quick check fails', async () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', repo);
    pipe.auto_freeze = true;
    pipe.quick_check_command = ['quick-fail', '{sha}'];
    const result = (await onAuthorDone(author.id));
    expect(result.ok).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
    expect(messages(author.id).join('\n')).toMatch(/quick check failed/);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('does not merge or push main, a non-lane branch, or an unsafe ref', async () => {
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
    (await onMainAdvanced('wave'));
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(localMain);
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    expect(calls.some((argv) => argv.join(' ').includes('main'))).toBe(false);
    expect((await onAuthorDone(maintainer.id)).ok).toBe(false);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(localMain);

    git(repo, 'checkout', '-q', '-B', 'topic');
    fs.writeFileSync(path.join(repo, 'topic.txt'), 'topic');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'topic');
    const topic = git(repo, 'rev-parse', 'HEAD');
    const topicAuthor = agent('topic', repo);
    expect((await onAuthorDone(topicAuthor.id))).toMatchObject({ ok: false, error: 'refusing topic: not a developer lane' });
    (await onMainAdvanced('wave'));
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(topic);

    git(repo, 'checkout', '-q', '-B', 'wc-$(id)');
    fs.writeFileSync(path.join(repo, 'unsafe.txt'), 'unsafe');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'unsafe');
    const unsafe = git(repo, 'rev-parse', 'HEAD');
    const unsafeAuthor = agent('unsafe', repo);
    const refused = (await onAuthorDone(unsafeAuthor.id));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/not a safe branch name/);
    (await onMainAdvanced('wave'));
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(unsafe);
    expect(calls.filter((argv) => argv[0] === 'push-lane')).toEqual([]);
  });

  it('does nothing while auto-freeze is off', async () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', repo);
    moveMain('main.txt', 'moved');
    git(repo, 'checkout', '-q', 'wc-ales');
    expect((await onAuthorDone(author.id))).toMatchObject({ ok: false, error: 'auto-freeze off' });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
  });

  it('refuses the author and a denied reviewer, then uses the ladder', async () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', path.join(tmp, 'ales'));
    agent('codex1', path.join(tmp, 'codex1'));
    const reviewer = agent('codex3', path.join(tmp, 'codex3'));
    pipe.auto_review = true;
    pipe.review_routes = { ales: 'codex1' };
    const ingested = (await ingestFreezeFile(passNote('ales', 'wc-ales', sha)));
    expect(ingested.ok).toBe(true);
    const sent = messages(reviewer.id).join('\n');
    expect(sent).toMatch(/Please review freeze/);
    expect(sent).toContain(path.join(freezeDir, `ales-freeze-${sha.slice(0, 8)}.md`));
    expect(messages(author.id).join('\n')).not.toMatch(/Please review/);
    expect(messages(db.listAgents().find((a) => a.name === 'codex1')!.id).join('\n')).not.toMatch(/Please review/);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('an agent asks for a review itself: the inbox request pings a seat whether auto_review is on or not', async () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', path.join(tmp, 'ales'));
    const reviewer = agent('codex3', path.join(tmp, 'codex3'));
    pipe.auto_review = false;
    fs.mkdirSync(freezeDir, { recursive: true });
    const note = path.join(freezeDir, `ales-freeze-${sha.slice(0, 8)}.md`);
    fs.writeFileSync(note, `# wc-ales freeze\nProject: wave · Author: ales\n- Lane: wc-ales\n- Freeze SHA: ${sha}\n`);
    expect((await ingestFreezeFile(note)).ok).toBe(true);
    expect(messages(reviewer.id)).toEqual([]);

    const request = path.join(freezeDir, `ales-wc-ales-review-request-${sha.slice(0, 8)}.md`);
    fs.writeFileSync(request, `Lane: wc-ales\nSHA: ${sha}\n`);
    expect(await ingestReviewRequestFile(request)).toMatchObject({ ok: true, data: { reviewer: 'codex3', sha } });
    expect(messages(reviewer.id).join('\n')).toMatch(/@ales asks for a review of freeze/);
    expect(messages(author.id).join('\n')).toMatch(/review of [0-9a-f]{8} asked from @codex3/);
    expect(getFreeze(sha)?.reviewer_name).toBe('codex3');
    const events = db.getDb().prepare("SELECT entity_id, payload_json FROM events WHERE type = 'pipeline.review'").all() as Array<{ entity_id: string; payload_json: string }>;
    expect(events).toHaveLength(1);
    expect(events[0].entity_id).toBe(`${sha}:request`);
    expect(JSON.parse(events[0].payload_json)).toMatchObject({ kind: 'request', by: 'ales', reviewer_id: reviewer.id });

    // a named seat goes through the ladder's checks: the author is never the reviewer
    fs.writeFileSync(request, `Lane: wc-ales\nSHA: ${sha}\nReviewer: @ales\n`);
    expect((await ingestReviewRequestFile(request)).ok).toBe(false);
    expect(messages(author.id).join('\n')).toMatch(/review request .* not sent/);

    // no SHA and no open freeze on the lane: told, nothing sent
    const other = path.join(freezeDir, 'ales-wc-none-review-request-x.md');
    fs.writeFileSync(other, 'Lane: wc-none\n');
    expect(await ingestReviewRequestFile(other)).toMatchObject({ ok: false, error: expect.stringMatching(/no exact SHA and no open freeze on wc-none/) });
  });

  it('does not assign a reviewer when the only candidate is the author', async () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', path.join(tmp, 'ales'));
    const pick = review.auto_pick;
    review.default_reviewer = 'ales';
    review.auto_pick = false;
    pipe.auto_review = true;
    pipe.review_routes = { ales: 'ales' };
    pipe.review_deny = [];
    try {
      (await ingestFreezeFile(passNote('ales', 'wc-ales', sha)));
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
    (await ingestFreezeFile(passNote('ales', 'wc-ales', sha)));
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
    (await ingestFreezeFile(passNote('ales', 'wc-ales', protectedSha)));
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
    (await ingestFreezeFile(passNote('ben', 'wc-ben', sha, '/reviews/ben.md')));
    await considerAutoStage(sha);
    expect(listReleases({ sha })).toEqual([]);
    expect(latestPipelineNote('wave', 'wc-ben')).toMatch(/overlaps lane wc-other/);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('does not auto-stage a retracted note GREEN unless the latest command word is GREEN', async () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    agent('ales', path.join(tmp, 'ales'));
    agent('codex3', path.join(tmp, 'codex3'));
    const file = passNote('ales', 'wc-ales', sha);
    (await ingestFreezeFile(file));
    expect(getFreeze(sha)?.gate).toBe('GREEN');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('gate GREEN\n', ''));
    const event = (gate: string) => {
      const saved = db.insertEvent({
        type: 'pipeline.gate', entity_type: 'run', entity_id: `${sha}:full`, payload: { sha, gate },
      });
      expect(saved.ok).toBe(true);
    };
    event('QUEUED');
    (await ingestFreezeFile(file));
    expect(getFreeze(sha)?.gate).toBe('QUEUED');
    pipe.auto_stage = true;
    await considerAutoStage(sha);
    expect(listReleases({ sha })).toEqual([]);
    expect(latestPipelineNote('wave', 'wc-ales')).toMatch(/waiting for GREEN/);

    event('RED');
    (await ingestFreezeFile(file));
    expect(getFreeze(sha)?.gate).toBe('RED');
    await considerAutoStage(sha);
    expect(listReleases({ sha })).toEqual([]);

    event('GREEN');
    (await ingestFreezeFile(file));
    expect(getFreeze(sha)?.gate).toBe('GREEN');
    await considerAutoStage(sha);
    expect(listReleases({ project: 'wave', target: 'staging' })).toHaveLength(1);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('hands a migration lane to deploy flagged for a pre-deploy dump', async () => {
    const sha = branch('wc-ales', 'db/migrations/001.sql', 'create table t(id int);');
    agent('ales', path.join(tmp, 'ales'));
    agent('codex3', path.join(tmp, 'codex3'));
    projects.wave.migrations_dir = 'db/migrations';
    (await ingestFreezeFile(passNote('ales', 'wc-ales', sha)));
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
    (await ingestFreezeFile(passNote('ales', 'wc-ales', first)));
    (await ingestFreezeFile(passNote('ben', 'wc-ben', second, '/reviews/ben.md')));
    pipe.auto_stage = true;
    await considerAutoStage(first);
    await considerAutoStage(second);
    expect(listReleases({ project: 'wave', target: 'staging' })).toHaveLength(1);
    const held = listReleases({ sha: first })[0];
    expect(held.requested_by).toBe('auto');
    (await reportRelease(held.id, { status: 'deployed', version: '1.4.0', sha: first, note: 'up' }));
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
    (await ingestFreezeFile(passNote('ales', 'wc-ales', first)));
    (await ingestFreezeFile(passNote('ben', 'wc-ben', second, '/reviews/ben.md')));
    pipe.auto_stage = true;
    await considerAutoStage(first);
    await considerAutoStage(second);
    const held = listReleases({ sha: first })[0];
    db.getDb().prepare(`UPDATE release_requests SET staging_url = 'https://staging.example/app', pin_until = '2099-01-01T00:00:00Z' WHERE id = ?`).run(held.id);
    (await reportRelease(held.id, { status: 'deployed', version: '1.4.0', sha: first, note: 'up' }));
    expect(listReleases({ project: 'wave', target: 'staging' })).toHaveLength(1);
    const verified = verifyStaging(held.id, { name: 'ales' }, 'looks good');
    expect(verified.ok).toBe(true);
    await drainStagingQueue('wave');
    expect(listReleases({ project: 'wave', target: 'staging' })).toHaveLength(2);
    expect(messages(db.listAgents().find((row) => row.name === 'ales')!.id).join('\n')).toMatch(/live on staging: https:\/\/staging\.example\/app v1\.4\.0/);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('merges main into an open lane; the merge-only SHA carries the PASS, so no reviewer or first pass is asked', async () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', repo);
    const reviewer = agent('codex3', path.join(tmp, 'codex3'));
    (await ingestFreezeFile(passNote('ales', 'wc-ales', sha, '/reviews/prev.md')));
    moveMain('main.txt', 'later');
    git(repo, 'checkout', '-q', 'wc-ales');
    pipe.auto_merge_main = true;
    pipe.auto_review = true;
    (await onMainAdvanced('wave'));
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(head).not.toBe(sha);
    expect((await commitsBehind('wave', head))).toBe(0);
    // The merge-only SHA repeats the reviewed patch: the queue carries the PASS, so no reviewer ask.
    expect(messages(reviewer.id).join('\n')).not.toMatch(/delta review|Please review/);
    const notes = (db.getDb().prepare("SELECT payload_json FROM events WHERE type = 'pipeline.action'").all() as { payload_json: string }[]).map((r) => JSON.parse(r.payload_json).note as string);
    expect(notes).toContain(`auto: merge-only delta from ${sha.slice(0, 8)} — its PASS carries over; no first pass or review asked on ${head.slice(0, 8)}`);
    expect(notes.some((n) => /first pass asked/.test(n))).toBe(false);
    expect(messages(author.id).join('\n')).toMatch(/Merged latest main into wc-ales/);
    expect(messages(author.id).join('\n')).not.toMatch(/behind main/);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('a lane with nothing main lacks is retired when main moves, not merged into and refrozen; the author hears it once', async () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', repo);
    (await ingestFreezeFile(passNote('ales', 'wc-ales', sha, '/reviews/prev.md')));
    // The lane lands on main (merge), then main moves on: the lane is behind but has nothing main lacks.
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '--no-ff', '--no-edit', '-m', 'land wc-ales', 'wc-ales');
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
    moveMain('main.txt', 'later');
    git(repo, 'checkout', '-q', 'wc-ales');
    pipe.auto_merge_main = true;
    pipe.auto_review = true;
    calls.length = 0;
    (await onMainAdvanced('wave'));
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha); // untouched checkout
    expect(calls.filter((argv) => argv[0] === 'push-lane')).toEqual([]);
    expect(listReviewFreezes().filter((f) => f.lane === 'wc-ales').map((f) => f.status)).toEqual(['merged']);
    const retired = db.getDb().prepare("SELECT entity_id FROM events WHERE type = 'lane.retired'").all() as { entity_id: string }[];
    expect(retired.map((r) => r.entity_id)).toEqual([`wc-ales@${sha.slice(0, 8)}`]);
    expect(messages(author.id).filter((m) => /wc-ales is fully on main/.test(m))).toHaveLength(1);
    expect(latestPipelineNote('wave', 'wc-ales')).toMatch(/nothing main lacks — retired, not synced/);
    // Main moves again: still nothing to do, and the author is not told twice.
    moveMain('main.txt', 'later still');
    git(repo, 'checkout', '-q', 'wc-ales');
    (await onMainAdvanced('wave'));
    expect(calls.filter((argv) => argv[0] === 'push-lane')).toEqual([]);
    expect(messages(author.id).filter((m) => /wc-ales is fully on main/.test(m))).toHaveLength(1);
  });

  it('a hand-written freeze on a lane with nothing main lacks is closed as merged: no quick, gate or review, the author told once', async () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', repo);
    const codex3 = agent('codex3', path.join(tmp, 'codex3'));
    (await ingestFreezeFile(passNote('ales', 'wc-ales', sha, '/reviews/prev.md')));
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '--no-ff', '--no-edit', '-m', 'land wc-ales', 'wc-ales');
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
    moveMain('main.txt', 'later');
    // The seat merges main into its already-merged lane by hand and freezes the merge commit
    // (28 Oct 2026: 14 such freezes on 7 lanes in an hour, each a quick run, a gate run and two review pings).
    const mergeOnly = contain('main', 'wc-ales');
    pipe.auto_gate = true;
    pipe.auto_review = true;
    pipe.reviewer_prefer = { codex: ['codex3'] };
    calls.length = 0;
    (await ingestFreezeFile(openNote('ales', 'wc-ales', mergeOnly)));
    expect(getFreeze(mergeOnly)?.status).toBe('merged');
    expect(getFreeze(mergeOnly)?.reviewer_agent_id).toBeNull();
    expect(calls.filter((argv) => argv[0] === 'gate-run' || argv[0] === 'quick-check')).toEqual([]);
    const closed = () => messages(author.id).filter((m) => /every commit of the lane is already on main/.test(m));
    expect(closed()).toHaveLength(1);
    expect(messages(codex3.id).join('\n')).not.toMatch(/Please review/);
    expect(latestPipelineNote('wave', 'wc-ales')).toMatch(/closed — every commit of wc-ales is already on main/);
    // The same file delivered again: still closed, not told twice.
    (await ingestFreezeFile(openNote('ales', 'wc-ales', mergeOnly)));
    expect(closed()).toHaveLength(1);
    expect(calls.filter((argv) => argv[0] === 'gate-run' || argv[0] === 'quick-check')).toEqual([]);
    // Real new work on the lane is frozen as usual.
    git(repo, 'checkout', '-q', 'wc-ales');
    fs.writeFileSync(path.join(repo, 'more.txt'), 'more');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'more lane work');
    const more = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/wc-ales', more);
    (await ingestFreezeFile(openNote('ales', 'wc-ales', more)));
    expect(getFreeze(more)?.status).toBe('open');
    expect(closed()).toHaveLength(1);
  });

  it('every new main tip gets the api suite once, recorded under the main SHA; a RED main is named to owners of RED lanes', async () => {
    pipe.auto_gate = true;
    ensureReleaseFreezeTable();
    setPipelineExecForTest((argv) => { calls.push(argv); return argv[0] === 'gate-run' ? { code: 1, stdout: '=== RESULT RED sha=x suite=api ===' } : { code: 0, stdout: 'ok' }; });
    moveMain('main.txt', 'later');
    const main = git(repo, 'rev-parse', 'refs/remotes/origin/main');
    await ensureMainGate('wave', main);
    await ensureMainGate('wave', main); // once per tip
    await vi.waitFor(() => expect(calls.filter((a) => a[0] === 'gate-run' && a[2] === main)).toHaveLength(1));
    await vi.waitFor(() => expect(mainApiState('wave', main)).toBe('RED'));
    expect(latestPipelineNote('wave', '')).toMatch(/full gate RED on/);
    // A lane gate RED while main is RED: the owner is told it is probably not the lane.
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', path.join(tmp, 'wc-ales'));
    await ingestFreezeFile(passNote('ales', 'wc-ales', sha));
    await vi.waitFor(() => expect(messages(author.id).join('\n')).toMatch(/main itself \([0-9a-f]{8}\) is api RED right now: this is probably not your lane/), { timeout: 10_000 });
    expect(latestPipelineNote('wave', 'wc-ales')).toMatch(/\[MAIN_RED\]/);
    await vi.waitFor(() => expect(authorLoadForTest()).toEqual({}), { timeout: 10_000 }); // nothing left running into the next test
  });

  it('prod drift: production on a SHA off main opens one sync lane (main + prod), pushed and frozen under wavecode; an open lane that already contains prod is used instead', async () => {
    const { setProductionSha } = await import('./deployable.js');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-b', 'hotfix', base);
    fs.writeFileSync(path.join(repo, 'hot.txt'), 'hotfix');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'hotfix');
    const prod = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    setProductionSha('wave', prod, 'sysops');
    const lane = await ensureProdSyncLane('wave');
    expect(lane).toMatch(/^wc-wavecode-prod-sync-\d{8}$/);
    const push = calls.find((a) => a[0] === 'git' && a[1] === 'push');
    expect(push).toEqual(['git', 'push', 'origin', `HEAD:refs/heads/${lane}`]);
    const frozen = db.getDb().prepare("SELECT sha, lane, author_name FROM release_freezes WHERE lane = ?").all(lane) as Array<{ sha: string; lane: string; author_name: string }>;
    expect(frozen).toHaveLength(1);
    expect(frozen[0].author_name).toBe('wavecode');
    expect(git(repo, 'merge-base', '--is-ancestor', prod, frozen[0].sha)).toBe('');
    expect(await ensureProdSyncLane('wave')).toBeNull(); // once per prod SHA
    expect(latestPipelineNote('wave', lane!)).toMatch(/opened wc-wavecode-prod-sync-.* and froze it/);
    await vi.waitFor(() => expect(authorLoadForTest()).toEqual({}), { timeout: 10_000 }); // the lane's own gate runs are done before the next test
  });

  it('syncs only a clean lane at its origin tip: pushes the merge first, then freezes; otherwise tells the owner once', async () => {
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', repo);
    (await ingestFreezeFile(passNote('ales', 'wc-ales', sha, '/reviews/prev.md')));
    moveMain('main.txt', 'later');
    git(repo, 'checkout', '-q', 'wc-ales');
    pipe.auto_merge_main = true;
    // Uncommitted change: no merge, one plain message, not repeated on the next tick.
    fs.writeFileSync(path.join(repo, 'lane.txt'), 'edited');
    (await onMainAdvanced('wave'));
    (await onMainAdvanced('wave'));
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
    const dirty = () => messages(author.id).filter((m) => /uncommitted changes/.test(m));
    await vi.waitFor(() => expect(dirty()).toHaveLength(1)); // delivery is asynchronous
    expect(dirty()[0]).toMatch(/\[LANE_DIRTY\]/);
    git(repo, 'checkout', '-q', '--', 'lane.txt');
    // Local commit not on origin: no merge, the owner pushes first.
    fs.writeFileSync(path.join(repo, 'more.txt'), 'more');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'local only');
    const ahead = git(repo, 'rev-parse', 'HEAD');
    (await onMainAdvanced('wave'));
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(ahead);
    await vi.waitFor(() => expect(messages(author.id).filter((m) => /not at its origin tip/.test(m))).toHaveLength(1));
    expect(dirty()).toHaveLength(1);
    expect(calls.some((argv) => argv[0] === 'git' && argv[1] === 'push')).toBe(false);
    // At the tip and clean: merge, plain push of the lane (never force), then the freeze.
    git(repo, 'update-ref', 'refs/remotes/origin/wc-ales', ahead);
    (await onMainAdvanced('wave'));
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(head).not.toBe(ahead);
    const pushes = calls.filter((argv) => argv[0] === 'push-lane'); // the configured push command (sync, then the freeze's own); plain git push without one
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    expect(pushes.every((argv) => argv[1] === 'wc-ales')).toBe(true);
    expect(calls.some((argv) => argv[0] === 'git' && argv[1] === 'push')).toBe(false);
    expect(getFreeze(head)).toBeTruthy(); // the freeze came after the push
    // Main moves again within 30 minutes: the lane is not synced again.
    moveMain('main.txt', 'even later');
    git(repo, 'checkout', '-q', 'wc-ales');
    (await onMainAdvanced('wave'));
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(latestPipelineNote('wave', 'wc-ales')).toMatch(/was synced 0 min ago/);
  });

  it('does not auto-merge or ping a review_deny agent', async () => {
    const sha = branch('wc-codex1', 'codex.txt', 'lane');
    const seat = agent('chatgpt-countix', repo);
    db.updateAgentIdentity(seat.id, { alias: 'codex1' });
    moveMain('main.txt', 'later');
    git(repo, 'checkout', '-q', 'wc-codex1');
    pipe.auto_merge_main = true;
    pipe.auto_freeze = true;
    (await onMainAdvanced('wave'));
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect((await mergeMainClean(repo, 'origin/main'))).toMatchObject({ ok: false, skipped: true });
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
    expect(messages(seat.id).join('\n')).not.toMatch(/behind main|Merged latest main/);
    expect(latestPipelineNote('wave', 'wc-codex1')).toBeNull();
    const written = fs.existsSync(freezeDir) ? fs.readdirSync(freezeDir).filter((name) => name.includes('auto-freeze')) : [];
    expect(written).toEqual([]);
    expect(calls.filter((argv) => argv[0] === 'push-lane')).toEqual([]);
    expect(listReleases({ target: 'production' })).toEqual([]);
  });

  it('sends a main-move conflict back to the author seat', async () => {
    branch('wc-ales', 'a.txt', 'lane');
    const author = agent('ales', repo);
    agent('codex3', path.join(tmp, 'codex3'));
    const sha = git(repo, 'rev-parse', 'HEAD');
    (await ingestFreezeFile(passNote('ales', 'wc-ales', sha)));
    moveMain('a.txt', 'main');
    git(repo, 'checkout', '-q', 'wc-ales');
    pipe.auto_merge_main = true;
    (await onMainAdvanced('wave'));
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
    (await onMainAdvanced('wave'));
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(sha);
    expect(messages(author.id)).toEqual([]);
    expect((await pingLaneAboutMain({ lane: 'wc-codex1', project: 'wave', mainSha, kind: 'moved', authorName: 'codex1' }))).toBe(false);
    expect((await alertBehind({ lane: 'wc-codex1', project: 'wave', authorName: 'codex1' }))).toBe(false);
    expect((await alertMerged({ lane: 'wc-codex1', project: 'wave', mainSha, authorName: 'codex1' }))).toBe(false);
    expect(messages(author.id)).toEqual([]);

    const frozen = (await onAuthorDone(author.id));
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) expect(frozen.error).toMatch(/denied/);
    const written = fs.existsSync(freezeDir) ? fs.readdirSync(freezeDir).filter((name) => name.includes('auto-freeze')) : [];
    expect(written).toEqual([]);
    const ingested = (await ingestFreezeFile(passNote('codex1', 'wc-codex1', sha)));
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
    (await alertLanesPastStaging('wave', mainSha));
    expect(messages(author.id)).toEqual([]);

    const other = branch('wc-ales', 'ales.txt', 'ales');
    const ales = agent('ales', path.join(tmp, 'ales'));
    const allowed = (await ingestFreezeFile(passNote('ales', 'wc-ales', other)));
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

  it('queues one full gate for a new freeze SHA', async () => {
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
    (await ingestFreezeFile(file));
    // Submitted at once, run in the background: QUEUED first, the word when the command returns.
    expect(getFreeze(sha)?.gate).toBe('QUEUED');
    (await ingestFreezeFile(file)); // the same note again submits nothing
    await vi.waitFor(() => expect(getFreeze(sha)?.gate).toBe('GREEN'), { timeout: 10_000 });
    const gates = calls.filter((argv) => argv[0] === 'gate-run');
    expect(gates).toHaveLength(1);
    expect(gates[0]).toContain(sha);
    expect(latestPipelineNote('wave', 'wc-ales')).toMatch(/full gate GREEN/);
    expect(listReleases({ target: 'production' })).toEqual([]);
    // The gate ran in a clean detached checkout of the exact SHA, as the author, and the checkout is gone.
    const gateOpts = optsSeen.find((o) => o.argv[0] === 'gate-run')?.opts;
    expect(gateOpts?.cwd).toContain('.wavecode-gates');
    expect(gateOpts?.env?.COUNTIX_REMOTE_TEST_WHO).toBe(`ales.${sha.slice(0, 9)}`); // one queued run per who on the gateway
    expect(gateOpts?.env?.WAVECODE_SHA).toBe(sha);
    expect(fs.existsSync(gateOpts?.cwd ?? '/nonexistent')).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain('.wavecode-gates');
  });

  it('the startup backfill records freezes without starting gates; a live note still gets one', async () => {
    const shaA = branch('wc-ales', 'a1.txt', 'a');
    const shaB = branch('wc-toni', 'b1.txt', 'b');
    agent('ales', path.join(tmp, 'ales'));
    agent('toni', path.join(tmp, 'toni'));
    pipe.auto_gate = true;
    openNote('ales', 'wc-ales', shaA);
    openNote('toni', 'wc-toni', shaB);
    expect(await backfillFreezes([freezeDir])).toBe(2);
    expect(getFreeze(shaA)?.status).toBe('open');
    expect(getFreeze(shaB)?.status).toBe('open');
    expect(calls.filter((argv) => argv[0] === 'gate-run')).toHaveLength(0);
    expect(getFreeze(shaA)?.gate).toBeNull();

    const shaC = branch('wc-ales', 'a2.txt', 'a2');
    await ingestFreezeFile(openNote('ales', 'wc-ales', shaC));
    await vi.waitFor(() => expect(getFreeze(shaC)?.gate).toBe('GREEN'), { timeout: 10_000 });
    expect(calls.filter((argv) => argv[0] === 'gate-run')).toHaveLength(1);
  });

  it('runs at most gate_max_inflight gates at once; the rest wait in WaveCode and start when a slot frees', async () => {
    const resolvers: Array<(r: { code: number; stdout: string }) => void> = [];
    setPipelineExecForTest((argv) => {
      calls.push(argv);
      if (argv[0] === 'gate-run') return new Promise<{ code: number; stdout: string }>((resolve) => { resolvers.push(resolve); });
      return { code: 0, stdout: 'ok' };
    });
    pipe.auto_gate = true;
    pipe.gate_max_inflight = 1;
    const lanes = ['wc-a', 'wc-b', 'wc-c'];
    const shas = lanes.map((lane, i) => { agent(`dev${'abc'[i]}`, path.join(tmp, lane)); return branch(lane, `${lane}.txt`, String(i)); });
    for (const [i, sha] of shas.entries()) await ingestFreezeFile(openNote(`dev${'abc'[i]}`, lanes[i], sha));
    const gates = () => calls.filter((a) => a[0] === 'gate-run');
    await vi.waitFor(() => expect(gates()).toHaveLength(1), { timeout: 10_000 });
    expect(shas.map((s) => getFreeze(s)?.gate)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
    expect(gateLoadForTest()).toEqual({ inflight: { wave: [shas[0]] }, pending: [shas[1], shas[2]] });
    expect(latestPipelineNote('wave', 'wc-b')).toMatch(/waits for a slot \(1 running, 1 waiting\)/);

    resolvers.shift()!({ code: 0, stdout: 'GREEN' });
    await vi.waitFor(() => expect(getFreeze(shas[0])?.gate).toBe('GREEN'), { timeout: 10_000 });
    await vi.waitFor(() => expect(gates()).toHaveLength(2), { timeout: 10_000 });
    expect(gateLoadForTest().pending).toEqual([shas[2]]);
    resolvers.shift()!({ code: 1, stdout: 'RED' });
    await vi.waitFor(() => expect(getFreeze(shas[1])?.gate).toBe('RED'), { timeout: 10_000 });
    await vi.waitFor(() => expect(gates()).toHaveLength(3), { timeout: 10_000 });
    resolvers.shift()!({ code: 0, stdout: 'GREEN' });
    await vi.waitFor(() => expect(getFreeze(shas[2])?.gate).toBe('GREEN'), { timeout: 10_000 });
    expect(gateLoadForTest()).toEqual({ inflight: { wave: [] }, pending: [] });
  });

  it('a lane with a merge-queue priority takes the next free gate slot ahead of older waiting gates', async () => {
    const resolvers: Array<(r: { code: number; stdout: string }) => void> = [];
    setPipelineExecForTest((argv) => {
      calls.push(argv);
      if (argv[0] === 'gate-run') return new Promise<{ code: number; stdout: string }>((resolve) => { resolvers.push(resolve); });
      return { code: 0, stdout: 'ok' };
    });
    pipe.auto_gate = true;
    pipe.gate_max_inflight = 1;
    const lanes = ['wc-a', 'wc-b', 'wc-c'];
    const shas = lanes.map((lane, i) => { agent(`dev${'abc'[i]}`, path.join(tmp, lane)); return branch(lane, `${lane}.txt`, String(i)); });
    for (const [i, sha] of shas.entries()) await ingestFreezeFile(openNote(`dev${'abc'[i]}`, lanes[i], sha));
    await vi.waitFor(() => expect(calls.filter((a) => a[0] === 'gate-run')).toHaveLength(1), { timeout: 10_000 });
    expect(gateLoadForTest().pending).toEqual([shas[1], shas[2]]);
    // Denis labels the third lane priority 9 while its gate waits.
    const mq = await import('./merge-queue.js');
    mq.listQueue('wave');
    db.getDb().prepare("INSERT INTO merge_queue (sha, project, lane, state, priority) VALUES (?, 'wave', 'wc-c', 'waiting', 9)").run(shas[2]);
    resolvers.shift()!({ code: 0, stdout: 'GREEN' });
    await vi.waitFor(() => expect(calls.filter((a) => a[0] === 'gate-run')).toHaveLength(2), { timeout: 10_000 });
    expect(gateLoadForTest().inflight.wave).toEqual([shas[2]]);
    expect(gateLoadForTest().pending).toEqual([shas[1]]);
    resolvers.shift()!({ code: 0, stdout: 'GREEN' });
    await vi.waitFor(() => expect(calls.filter((a) => a[0] === 'gate-run')).toHaveLength(3), { timeout: 10_000 });
    expect(gateLoadForTest().pending).toEqual([]);
    resolvers.shift()!({ code: 0, stdout: 'GREEN' });
    await vi.waitFor(() => expect(gateLoadForTest().inflight.wave).toEqual([]), { timeout: 10_000 });
  });

  it('with gate_with_quick, WaveCode runs the quick check on a frozen SHA that has none, records it, and tells the author when it is RED', async () => {
    setPipelineExecForTest((argv) => {
      calls.push(argv);
      if (argv[0] === 'quick-check') return { code: argv.includes('wc-red') ? 1 : 0, stdout: argv.includes('wc-red') ? '=== RESULT RED sha=x suite=tier1 who=w exit=1 host=h ===' : '=== RESULT GREEN sha=x suite=tier1 who=w exit=0 host=h ===' };
      if (argv[0] === 'gate-run') return { code: 0, stdout: 'GREEN' };
      return { code: 0, stdout: 'ok' };
    });
    pipe.auto_gate = true;
    pipe.gate_with_quick = true;
    const green = branch('wc-green', 'g.txt', 'g');
    const red = branch('wc-red', 'r.txt', 'r');
    const author = agent('toni', path.join(tmp, 'wc-red'));
    agent('ales', path.join(tmp, 'wc-green'));
    await ingestFreezeFile(openNote('ales', 'wc-green', green));
    await ingestFreezeFile(openNote('toni', 'wc-red', red));
    const quicks = () => calls.filter((a) => a[0] === 'quick-check');
    await vi.waitFor(() => expect(quicks()).toHaveLength(2), { timeout: 10_000 });
    expect(quicks().map((a) => a[1])).toEqual([green, red]);
    const quickWords = (sha: string) => (db.getDb().prepare("SELECT payload_json FROM events WHERE type = 'pipeline.quick' AND entity_id = ? ORDER BY id").all(`${sha}:quick`) as Array<{ payload_json: string }>).map((r) => (JSON.parse(r.payload_json) as { quick: string }).quick);
    await vi.waitFor(() => expect(quickWords(green)).toEqual(['QUEUED', 'GREEN']), { timeout: 10_000 });
    await vi.waitFor(() => expect(quickWords(red)).toEqual(['QUEUED', 'RED']), { timeout: 10_000 });
    const gs = await import('./gate-status.js');
    expect(gs.recordsFor(green).map((r) => [r.suite, r.state])).toContainEqual(['quick', 'GREEN']);
    await vi.waitFor(() => expect(messages(author.id).some((m) => /quick check RED on .*the full gate was not submitted/.test(m))).toBe(true), { timeout: 10_000 });
    // Quick first, gate after: the green lane's full gate was submitted only once its quick was GREEN; the red lane gets no gate at all.
    const gates = () => calls.filter((a) => a[0] === 'gate-run').map((a) => a[2]);
    await vi.waitFor(() => expect(gates()).toEqual([green]), { timeout: 10_000 });
    expect(calls.findIndex((a) => a[0] === 'gate-run')).toBeGreaterThan(calls.findIndex((a) => a[0] === 'quick-check' && a[1] === green));
    await vi.waitFor(() => expect(getFreeze(green)?.gate).toBe('GREEN'), { timeout: 10_000 });
    expect(getFreeze(red)?.gate ?? null).toBeNull();
    expect(latestPipelineNote('wave', 'wc-red')).toMatch(/full gate not submitted on .* — the quick check is RED/);
    // A second ingest of the same note runs nothing again.
    await ingestFreezeFile(openNote('ales', 'wc-green', green));
    expect(quicks()).toHaveLength(2);
    expect(gates()).toEqual([green]);
    expect(quickLoadForTest()).toEqual({ inflight: { wave: [] }, pending: [] });
  });

  it('a SHA whose quick check is already known skips straight to the gate (GREEN) or gets none (RED); a quick WaveCode cannot run after three refusals lets the gate run anyway', async () => {
    setRefusedRetryMsForTest(300);
    const refused = { code: 143, stdout: 'CANCELLED: no runner (one queued run per agent) — not run\ncountix-remote-test: remote exit 143 on host=countix-testing' };
    setPipelineExecForTest((argv) => {
      calls.push(argv);
      if (argv[0] === 'quick-check') return refused;
      if (argv[0] === 'gate-run') return { code: 0, stdout: '=== RESULT GREEN sha=x suite=api who=w exit=0 host=h ===' };
      return { code: 0, stdout: 'ok' };
    });
    pipe.auto_gate = true;
    pipe.gate_with_quick = true;
    agent('ales', path.join(tmp, 'wc-known-green'));
    agent('toni', path.join(tmp, 'wc-known-red'));
    agent('mira', path.join(tmp, 'wc-refused'));
    const knownGreen = branch('wc-known-green', 'kg.txt', 'kg');
    const knownRed = branch('wc-known-red', 'kr.txt', 'kr');
    const stuck = branch('wc-refused', 'st.txt', 'st');
    const gs = await import('./gate-status.js');
    const t0 = new Date();
    await gs.recordGateResult({ project: 'wave', sha: knownGreen, argv: ['countix-remote-test', '--suite', 'tier1', knownGreen], stdout: `=== RESULT GREEN sha=${knownGreen} suite=tier1 who=ales exit=0 host=h ===`, exit_code: 0, started_at: t0, finished_at: t0 });
    await gs.recordGateResult({ project: 'wave', sha: knownRed, argv: ['countix-remote-test', '--suite', 'tier1', knownRed], stdout: `=== RESULT RED sha=${knownRed} suite=tier1 who=toni exit=1 host=h ===`, exit_code: 1, started_at: t0, finished_at: t0 });
    await ingestFreezeFile(openNote('ales', 'wc-known-green', knownGreen));
    await ingestFreezeFile(openNote('toni', 'wc-known-red', knownRed));
    await ingestFreezeFile(openNote('mira', 'wc-refused', stuck));
    const gates = () => calls.filter((a) => a[0] === 'gate-run').map((a) => a[2]);
    await vi.waitFor(() => expect(gates()).toEqual([knownGreen]), { timeout: 10_000 }); // the author's own GREEN quick counts; no quick run by WaveCode
    await vi.waitFor(() => expect(calls.filter((a) => a[0] === 'quick-check').map((a) => a[1])).toEqual([stuck]), { timeout: 10_000 });
    await vi.waitFor(() => expect(getFreeze(knownGreen)?.gate).toBe('GREEN'), { timeout: 10_000 });
    expect(getFreeze(knownRed)?.gate ?? null).toBeNull();
    expect(latestPipelineNote('wave', 'wc-known-red')).toMatch(/full gate not submitted on .* — the quick check on it is RED/);
    // Three refusals of the quick: WaveCode gives up on it and submits the full gate anyway.
    for (let i = 0; i < 12 && calls.filter((a) => a[0] === 'quick-check').length < 3; i++) { await new Promise((r) => setTimeout(r, 400)); await pipelineTick(); }
    await vi.waitFor(() => expect(calls.filter((a) => a[0] === 'quick-check')).toHaveLength(3), { timeout: 10_000 });
    await vi.waitFor(() => expect(gates()).toEqual([knownGreen, stuck]), { timeout: 10_000 });
    await vi.waitFor(() => expect(getFreeze(stuck)?.gate).toBe('GREEN'), { timeout: 10_000 });
    const notes = (db.getDb().prepare("SELECT payload_json FROM events WHERE type = 'pipeline.action' AND entity_id = 'wave:wc-refused' ORDER BY id").all() as Array<{ payload_json: string }>).map((r) => (JSON.parse(r.payload_json) as { note: string }).note);
    expect(notes.some((n) => /quick check on .* could not run; submitting the full gate anyway/.test(n))).toBe(true);
  });

  it('a run the gateway cancelled or refused (no RESULT line) is not RED: it is retried after a wait, and the author is not told', async () => {
    setRefusedRetryMsForTest(1500);
    const tries: Record<string, number> = {};
    setPipelineExecForTest((argv) => {
      calls.push(argv);
      if (argv[0] === 'quick-check' || argv[0] === 'gate-run') {
        tries[argv[0]] = (tries[argv[0]] ?? 0) + 1;
        if (tries[argv[0]] === 1) return { code: 143, stdout: '[16:44:36] queued: position 1 (all 2 slots busy)\n[16:44:42] CANCELLED: superseded by 537982bb1 tier1 (one queued run per agent claude5) — not run\ncountix-remote-test: remote exit 143 on host=countix-testing (9s total)' };
        return { code: 0, stdout: `=== RESULT GREEN sha=x suite=${argv[0] === 'quick-check' ? 'tier1' : 'api'} who=w exit=0 host=h ===` };
      }
      return { code: 0, stdout: 'ok' };
    });
    expect(runRefusal({ code: 143, stdout: 'a\nCANCELLED: superseded by x\ncountix-remote-test: remote exit 143 on host=countix-testing' })).toBe('CANCELLED: superseded by x');
    expect(runRefusal({ code: 5, stdout: '=== RESULT GREEN sha=x suite=tier1 exit=0 host=h ===\nremote exit 5' })).toBeNull();
    pipe.auto_gate = true;
    pipe.gate_with_quick = true;
    const sha = branch('wc-toni', 't.txt', 't');
    const author = agent('toni', path.join(tmp, 'wc-toni'));
    await ingestFreezeFile(openNote('toni', 'wc-toni', sha));
    const runs = () => calls.filter((a) => a[0] === 'quick-check' || a[0] === 'gate-run').map((a) => a[0]);
    await vi.waitFor(() => expect(runs()).toEqual(['quick-check']), { timeout: 10_000 }); // quick first; the full gate waits for a GREEN quick
    const refusalNotes = () => (db.getDb().prepare("SELECT payload_json FROM events WHERE type = 'pipeline.action' AND entity_id = 'wave:wc-toni' ORDER BY id").all() as Array<{ payload_json: string }>).map((r) => (JSON.parse(r.payload_json) as { note: string }).note).filter((n) => /not run \(.*CANCELLED: superseded by 537982bb1 tier1/.test(n));
    await vi.waitFor(() => expect(refusalNotes()).toHaveLength(1), { timeout: 10_000 });
    expect(getFreeze(sha)?.gate ?? null).toBeNull(); // not submitted yet
    expect(messages(author.id).some((m) => /RED/.test(m))).toBe(false);
    // the retry wait holds the quick back, then one tick resubmits it; GREEN releases the gate, itself refused once and retried
    await pipelineTick();
    expect(runs()).toEqual(['quick-check']);
    await new Promise((r) => setTimeout(r, 1600));
    await pipelineTick();
    await vi.waitFor(() => expect(runs()).toEqual(['quick-check', 'quick-check', 'gate-run']), { timeout: 10_000 });
    await vi.waitFor(() => expect(refusalNotes()).toHaveLength(2), { timeout: 10_000 }); // the quick and the full gate, both refused once
    expect(getFreeze(sha)?.gate).toBe('QUEUED');
    await new Promise((r) => setTimeout(r, 1600));
    await pipelineTick();
    await vi.waitFor(() => expect(getFreeze(sha)?.gate).toBe('GREEN'), { timeout: 10_000 });
    expect(runs()).toEqual(['quick-check', 'quick-check', 'gate-run', 'gate-run']);
    const quickWords = () => (db.getDb().prepare("SELECT payload_json FROM events WHERE type = 'pipeline.quick' AND entity_id = ? ORDER BY id").all(`${sha}:quick`) as Array<{ payload_json: string }>).map((r) => (JSON.parse(r.payload_json) as { quick: string }).quick);
    await vi.waitFor(() => expect(quickWords()).toEqual(['QUEUED', 'QUEUED', 'GREEN']), { timeout: 10_000 });
    expect(messages(author.id).some((m) => /RED/.test(m))).toBe(false);
  });

  it('a newer freeze on the same lane stops the old SHA\'s running quick and gate (cancelled, never RED), asks the gateway to cancel, and the new SHA runs next', async () => {
    // The tool blocks until the daemon aborts it (a real gate takes 20+ minutes).
    setPipelineExecForTest((argv, opts) => {
      calls.push(argv);
      if (argv[0] === 'cancel-run') return { code: 0, stdout: `CANCELLED 20261028-0001-${argv[1].slice(0, 9)}` };
      if ((argv[0] === 'quick-check' || argv[0] === 'gate-run') && argv.some((a) => a === shaA)) {
        return new Promise((resolve) => {
          opts.signal?.addEventListener('abort', () => resolve({ code: 1, stdout: '' }));
        });
      }
      if (argv[0] === 'quick-check') return { code: 0, stdout: '=== RESULT GREEN sha=x suite=tier1 exit=0 host=h ===' };
      if (argv[0] === 'gate-run') return { code: 0, stdout: '=== RESULT GREEN sha=x suite=api exit=0 host=h ===' };
      return { code: 0, stdout: 'ok' };
    });
    pipe.auto_gate = true;
    pipe.gate_with_quick = true;
    pipe.cancel_command = ['cancel-run', '{sha}'];
    const shaA = branch('wc-toni', 't1.txt', 'one');
    const author = agent('toni', path.join(tmp, 'wc-toni'));
    await ingestFreezeFile(openNote('toni', 'wc-toni', shaA));
    // Quick first: A's quick runs, its full gate is not submitted until the quick is GREEN.
    await vi.waitFor(() => expect(cancelStateForTest().live).toEqual([`${shaA}:quick`]), { timeout: 10_000 });
    expect(getFreeze(shaA)?.gate ?? null).toBeNull();
    expect(calls.filter((a) => a[0] === 'gate-run')).toHaveLength(0);

    const shaB = branch('wc-toni', 't2.txt', 'two');
    await ingestFreezeFile(openNote('toni', 'wc-toni', shaB));
    expect(getFreeze(shaA)?.status).toBe('stale');
    await vi.waitFor(() => expect(getFreeze(shaB)?.gate).toBe('GREEN'), { timeout: 10_000 });
    expect(calls.filter((a) => a[0] === 'cancel-run').map((a) => a[1])).toEqual([shaA]);
    // A's quick: recorded as a dispatch failure (never RED) with one CANCELLED word; its gate never ran, so no gate record for it and nobody told the author RED.
    const results = (db.getDb().prepare("SELECT payload_json FROM events WHERE type = 'gate.result' AND entity_id = ? ORDER BY id").all(shaA) as Array<{ payload_json: string }>).map((r) => JSON.parse(r.payload_json) as { suite: string; state: string; steps: { tail: string[] } });
    expect(results.map((r) => [r.suite, r.state])).toEqual([['quick', 'ERROR']]);
    expect(results.map((r) => r.steps.tail.slice(-1)[0])).toEqual([`CANCELLED by WaveCode: superseded by ${shaB.slice(0, 8)}`]);
    const words = (type: string, key: string) => (db.getDb().prepare('SELECT payload_json FROM events WHERE type = ? AND entity_id = ? ORDER BY id').all(type, key) as Array<{ payload_json: string }>).map((r) => (JSON.parse(r.payload_json) as { quick?: string; gate?: string }));
    expect(words('pipeline.quick', `${shaA}:quick`).map((w) => w.quick)).toEqual(['QUEUED', 'CANCELLED']);
    expect(words('pipeline.gate', `${shaA}:full`)).toHaveLength(0);
    expect(calls.filter((a) => a[0] === 'gate-run' && a.includes(shaA))).toHaveLength(0);
    expect(messages(author.id).some((m) => /RED/.test(m))).toBe(false);
    const notes = (db.getDb().prepare("SELECT payload_json FROM events WHERE type = 'pipeline.action' AND entity_id = 'wave:wc-toni' ORDER BY id").all() as Array<{ payload_json: string }>).map((r) => (JSON.parse(r.payload_json) as { note: string }).note);
    expect(notes.some((n) => new RegExp(`stopped — superseded by ${shaB.slice(0, 8)}, which goes next`).test(n))).toBe(true);
    expect(cancelStateForTest().jumped).toEqual([shaB]);
    expect(cancelStateForTest().live).toEqual([]);
    // B went through: its quick and its gate both ran, A's never finished.
    await vi.waitFor(() => expect(calls.filter((a) => a[0] === 'quick-check' && a.includes(shaB))).toHaveLength(1), { timeout: 10_000 });
    expect(calls.filter((a) => a[0] === 'gate-run' && a.includes(shaB))).toHaveLength(1);
  });

  it('after a queue merge the pipeline asks one seat for the rolling candidate review and announces NEEDS FIXES to the author', async () => {
    pipe.auto_review = true;
    const base = git(repo, 'rev-parse', 'HEAD');
    const laneSha = branch('wc-ales-x', 'x.txt', 'x');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge wc-ales-x', laneSha);
    const mainSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
    const author = agent('ales', path.join(tmp, 'ales'));
    const toni = agent('toni', path.join(tmp, 'toni'));
    emit('merge_queue.merged', 'run', laneSha, { project: 'wave', lane: 'wc-ales-x', sha_in: laneSha, sha_out: mainSha, main_before: base, author: 'ales' }, null);
    await onMainAdvanced('wave', mainSha);
    const asked = (db.getDb().prepare("SELECT payload_json FROM events WHERE type = 'pipeline.candidate_review' AND entity_id = ?").all(mainSha) as Array<{ payload_json: string }>).map((r) => JSON.parse(r.payload_json) as { kind: string; base: string; reviewer: string; reviewer_id: string; file: string; lane: string; author: string });
    expect(asked.map((a) => a.kind)).toEqual(['assign']);
    expect(asked[0].base).toBe(base);
    expect(asked[0].lane).toBe('wc-ales-x');
    expect(asked[0].author).toBe('ales');
    expect(asked[0].reviewer).not.toBe('ales');
    expect(messages(asked[0].reviewer_id).some((m) => /Candidate review: main is at/.test(m))).toBe(true);
    expect(fs.existsSync(asked[0].file)).toBe(true);
    expect(latestPipelineNote('wave', 'wc-ales-x')).toMatch(/candidate review of .* asked from @/);
    await onMainAdvanced('wave', mainSha); // once per main SHA
    expect((db.getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'pipeline.candidate_review'").get() as { n: number }).n).toBe(1);

    fs.appendFileSync(asked[0].file, `\nISSUES:\n- [HIGH] x.txt:1 — wrong\nSeat: @${asked[0].reviewer}\nCANDIDATE REVIEW: NEEDS FIXES\n`);
    expect(recordCandidateReviewFile(asked[0].file)).toMatchObject({ sha: mainSha, result: 'needs-fixes', issues: 1 });
    expect(messages(author.id).some((m) => /Candidate review of main .*NEEDS FIXES \(1 issue\)/.test(m))).toBe(true);
    expect(messages(toni.id).filter((m) => /NEEDS FIXES/.test(m))).toHaveLength(toni.id === asked[0].reviewer_id ? 0 : 0);
    expect(latestPipelineNote('wave', 'wc-ales-x')).toMatch(/candidate review by @.* — NEEDS FIXES \(1 issue\)/);
  });

  it('WaveCode submits one run per author at a time (the gateway cancels a second queued run per agent); other authors run alongside', async () => {
    const resolvers: Array<(r: { code: number; stdout: string }) => void> = [];
    setPipelineExecForTest((argv) => {
      calls.push(argv);
      if (argv[0] === 'gate-run') return new Promise<{ code: number; stdout: string }>((resolve) => { resolvers.push(resolve); });
      return { code: 0, stdout: 'ok' };
    });
    pipe.auto_gate = true;
    pipe.gate_max_inflight = 3;
    agent('ales', path.join(tmp, 'wc-ales-1'));
    agent('toni', path.join(tmp, 'wc-toni-1'));
    const a1 = branch('wc-ales-1', 'a1.txt', '1');
    const a2 = branch('wc-ales-2', 'a2.txt', '2');
    const t1 = branch('wc-toni-1', 't1.txt', '3');
    await ingestFreezeFile(openNote('ales', 'wc-ales-1', a1));
    await ingestFreezeFile(openNote('ales', 'wc-ales-2', a2));
    await ingestFreezeFile(openNote('toni', 'wc-toni-1', t1));
    const gates = () => calls.filter((a) => a[0] === 'gate-run').map((a) => a[2]);
    await vi.waitFor(() => expect(gates()).toEqual([a1, t1]), { timeout: 10_000 }); // ales's second waits, toni's runs alongside
    expect(gateLoadForTest().pending).toEqual([a2]);
    expect(authorLoadForTest()).toEqual({ ales: 1, toni: 1 });
    expect(latestPipelineNote('wave', 'wc-ales-2')).toMatch(/waits for @ales's other run/);
    resolvers.shift()!({ code: 0, stdout: 'GREEN' }); // a1 done
    await vi.waitFor(() => expect(gates()).toEqual([a1, t1, a2]), { timeout: 10_000 });
    resolvers.shift()!({ code: 0, stdout: 'GREEN' });
    resolvers.shift()!({ code: 0, stdout: 'GREEN' });
    await vi.waitFor(() => expect(authorLoadForTest()).toEqual({}), { timeout: 10_000 });
  });

  it('after a restart, a QUEUED freeze is settled from the test history, or resubmitted once when the dispatcher never saw it', async () => {
    const sha = branch('wc-ales', 'a.txt', 'lane');
    const lost = branch('wc-toni', 'b.txt', 'lane');
    agent('ales', path.join(tmp, 'ales'));
    agent('toni', path.join(tmp, 'toni'));
    // The freezes landed while the gate was off, like a daemon whose submitters were killed.
    await ingestFreezeFile(openNote('ales', 'wc-ales', sha));
    await ingestFreezeFile(openNote('toni', 'wc-toni', lost));
    for (const s of [sha, lost]) {
      setFreezeGate(s, 'QUEUED');
      emit('pipeline.gate', 'run', `${s}:full`, { sha: s, project: 'wave', gate: 'QUEUED' }, null);
    }
    pipe.auto_gate = true;
    projects.wave.tests = { history_command: ['hist', '--sha', '{sha}'], full_suites: ['api'] };
    setTestRunExecForTest((argv) => JSON.stringify({
      v: 1,
      runs: argv.includes(sha)
        ? [{ id: 'r-1', sha, who: 'ales', kind: 'dev', suite: 'api', state: 'pass', queued_at: '2026-10-25T16:00:00Z', ended_at: '2026-10-25T17:00:00Z' }]
        : [],
    }));
    try {
      await pipelineTick();
      expect(getFreeze(sha)?.gate).toBe('GREEN');
      expect(latestPipelineNote('wave', 'wc-ales')).toMatch(/full gate GREEN/);
      await vi.waitFor(() => expect(getFreeze(lost)?.gate).toBe('GREEN'), { timeout: 10_000 });
      expect(calls.filter((a) => a[0] === 'gate-run')).toHaveLength(1);
      await pipelineTick();
      expect(calls.filter((a) => a[0] === 'gate-run')).toHaveLength(1);
    } finally {
      setTestRunExecForTest(null);
      delete projects.wave.tests;
    }
  });

  it('gateOutcome: exit code decides for a tool that waits on the suite; 7 is the dispatcher duplicate', () => {
    expect(gateOutcome({ code: 0, stdout: 'queued #2: sha abc\nRESULT: PASS' })).toBe('GREEN');
    expect(gateOutcome({ code: 1, stdout: 'RESULT: FAIL' })).toBe('RED');
    expect(gateOutcome({ code: 7, stdout: 'DUPLICATE: sha already running' })).toBe('QUEUED');
    expect(gateOutcome({ code: 0, stdout: 'QUEUED' })).toBe('QUEUED');
    expect(gateOutcome({ code: 2, stdout: '' })).toBe('RED');
    // The suite's own RESULT line wins over the exit code (gateway exit 5 after a GREEN, 26 Oct 2026).
    expect(gateOutcome({ code: 5, stdout: '=== RESULT GREEN sha=a9117d36c suite=tier1 who=wavecode exit=0 host=countix-testing ===\n/srv/countix-test/bin/queue-record.sh: line 95: Killed sleep 2\ncountix-remote-test: remote exit 5 on host=countix-testing (360s total)' })).toBe('GREEN');
    expect(gateOutcome({ code: 0, stdout: '=== RESULT RED sha=a9117d36c suite=api exit=1 host=countix-testing ===\ndone' })).toBe('RED');
  });

  function openNote(authorName: string, lane: string, sha: string): string {
    const file = path.join(freezeDir, `${authorName}-freeze-${sha.slice(0, 8)}.md`);
    fs.mkdirSync(freezeDir, { recursive: true });
    fs.writeFileSync(file, [
      `# ${lane} freeze note`,
      '',
      `Project: wave · Author: ${authorName}`,
      `- Lane: \`${lane}\``,
      `- Freeze SHA: \`${sha}\``,
      '',
    ].join('\n'));
    return file;
  }

  it('assigns the least-loaded preferred reviewer and reassigns a busy seat', async () => {
    const sha = branch('wc-claude1', 'lane.txt', 'lane');
    const author = agent('claude1', path.join(tmp, 'claude1'), 'claude-code');
    const codex1 = agent('codex1', path.join(tmp, 'codex1'));
    const codex2 = agent('codex2', path.join(tmp, 'codex2'));
    const codex3 = agent('codex3', path.join(tmp, 'codex3'));
    const ownSeat = agent('claude1-codex', path.join(tmp, 'claude1-codex'));
    const claude2 = agent('claude2', path.join(tmp, 'claude2'), 'claude-code');
    db.updateAgentStatus(codex2.id, 'working');
    pipe.auto_review = true;
    pipe.reviewer_prefer = { claude: ['codex2', 'codex3', 'codex1', 'claude1-codex'] };
    const ingested = (await ingestFreezeFile(openNote('claude1', 'wc-claude1', sha)));
    expect(ingested.ok).toBe(true);
    expect(getFreeze(sha)?.reviewer_agent_id).toBe(codex3.id);
    expect(getFreeze(sha)?.verdict).toBeNull();
    expect(messages(codex3.id).join('\n')).toMatch(/Please review freeze/);
    for (const skipped of [author, codex1, codex2, ownSeat, claude2]) {
      expect(messages(skipped.id).join('\n')).not.toMatch(/Please review/);
    }

    db.updateAgentStatus(codex3.id, 'working');
    db.updateAgentStatus(codex2.id, 'idle');
    expect(reassignWaitingReviews(Date.now() + 14 * 60 * 1000)).toBe(0);
    expect(getFreeze(sha)?.reviewer_agent_id).toBe(codex3.id);

    expect(reassignWaitingReviews(Date.now() + 16 * 60 * 1000)).toBe(1);
    expect(getFreeze(sha)?.reviewer_name).toBe('codex2');
    expect(messages(codex2.id).join('\n')).toMatch(/Please review freeze/);
    expect(latestPipelineNote('wave', 'wc-claude1')).toMatch(/reassigned @codex3 → @codex2 \(busy, no verdict\)/);

    db.updateAgentStatus(codex2.id, 'working');
    db.updateAgentStatus(codex3.id, 'working');
    expect(reassignWaitingReviews(Date.now() + 16 * 60 * 1000)).toBe(0);
    expect(getFreeze(sha)?.reviewer_agent_id).toBe(codex2.id);

    db.updateAgentStatus(codex3.id, 'idle');
    expect(reassignWaitingReviews(Date.now() + 16 * 60 * 1000)).toBe(1);
    expect(getFreeze(sha)?.reviewer_name).toBe('codex3');
    expect(latestPipelineNote('wave', 'wc-claude1')).toMatch(/reassigned @codex2 → @codex3 \(busy, no verdict\)/);
    expect(messages(ownSeat.id).join('\n')).not.toMatch(/Please review/);
    expect(messages(claude2.id).join('\n')).not.toMatch(/Please review/);
    expect(messages(codex1.id).join('\n')).not.toMatch(/Please review/);
  });

  it('does not reassign when review_reassign_minutes is 0', async () => {
    const sha = branch('wc-claude1', 'lane.txt', 'lane');
    agent('claude1', path.join(tmp, 'claude1'), 'claude-code');
    const codex2 = agent('codex2', path.join(tmp, 'codex2'));
    const codex3 = agent('codex3', path.join(tmp, 'codex3'));
    db.updateAgentStatus(codex2.id, 'working');
    pipe.auto_review = true;
    pipe.review_reassign_minutes = 0;
    pipe.reviewer_prefer = { claude: ['codex2', 'codex3'] };
    (await ingestFreezeFile(openNote('claude1', 'wc-claude1', sha)));
    expect(getFreeze(sha)?.reviewer_agent_id).toBe(codex3.id);
    db.updateAgentStatus(codex3.id, 'working');
    db.updateAgentStatus(codex2.id, 'idle');
    expect(reassignWaitingReviews(Date.now() + 60 * 60 * 1000)).toBe(0);
    expect(getFreeze(sha)?.reviewer_agent_id).toBe(codex3.id);
  });

  it('holds a freeze whose SHA is not on the remote lane, and continues once it is pushed', async () => {
    // A real remote: the fixture's fake origin refs are not enough for a fetch.
    const bare = path.join(tmp, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', bare], { env });
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', 'origin', 'main');
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', path.join(tmp, 'ales'));
    const codex3 = agent('codex3', path.join(tmp, 'codex3'));
    pipe.auto_gate = true;
    pipe.auto_review = true;
    pipe.reviewer_prefer = { codex: ['codex3'] };

    expect(await pushedShaError('wave', 'wc-ales', sha)).toMatch(/not on origin/);
    (await ingestFreezeFile(openNote('ales', 'wc-ales', sha)));
    expect(getFreeze(sha)?.gate).toBeNull();
    expect(getFreeze(sha)?.reviewer_agent_id).toBeNull();
    expect(messages(author.id).join('\n')).toMatch(/on hold: wc-ales is not on origin/);
    expect(messages(codex3.id).join('\n')).not.toMatch(/Please review/);
    expect(latestPipelineNote('wave', 'wc-ales')).toMatch(/freeze refused/);
    expect(calls.some((argv) => argv[0] === 'gate-run')).toBe(false);

    git(repo, 'push', '-q', 'origin', 'wc-ales');
    expect(await pushedShaError('wave', 'wc-ales', sha)).toBeNull();
    await pipelineTick(Date.now() + 3 * 60_000);
    expect(getFreeze(sha)?.reviewer_agent_id).toBe(codex3.id);
    await vi.waitFor(() => expect(getFreeze(sha)?.gate).toBe('GREEN'), { timeout: 10_000 });
    expect(messages(codex3.id).join('\n')).toMatch(/Please review freeze/);

    // A SHA behind the pushed tip is fine; a SHA the remote never saw is not.
    const newer = branch('wc-ales', 'lane2.txt', 'more');
    expect(await pushedShaError('wave', 'wc-ales', newer)).toMatch(/is not on origin\/wc-ales/);
  });

  it('says a refused auto-freeze once: the pane polls that retry it inside the quiet period are silent', async () => {
    const bare = path.join(tmp, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', bare], { env });
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', 'origin', 'main');
    const sha = branch('wc-ales', 'lane.txt', 'lane');
    const author = agent('ales', repo);
    pipe.auto_freeze = true;
    delete pipe.push_command; // the author pushes; the exact SHA must be on the remote lane
    const refusals = () => messages(author.id).filter((m) => /freeze refused: wc-ales is not on origin/.test(m));
    expect((await onAuthorDone(author.id))).toMatchObject({ ok: false, error: expect.stringMatching(/not on origin/) });
    // 28 Oct 2026: one lane drew 16 refusal notes in two minutes, one per pane poll.
    expect((await onAuthorDone(author.id))).toMatchObject({ ok: false, error: 'refused recently' });
    (await onAuthorDone(author.id));
    expect(refusals()).toHaveLength(1);
    const notes = db.getDb().prepare("SELECT 1 FROM events WHERE type = 'pipeline.action' AND json_extract(payload_json, '$.note') LIKE '%freeze refused%'").all();
    expect(notes).toHaveLength(1);
    expect(getFreeze(sha)).toBeFalsy();
    // Pushed and the quiet period over: the next poll freezes it.
    git(repo, 'push', '-q', 'origin', 'wc-ales');
    setPublishRefusalQuietMsForTest(0);
    expect((await onAuthorDone(author.id))).toMatchObject({ ok: true, data: { sha } });
    expect(getFreeze(sha)?.status).toBe('open');
    expect(refusals()).toHaveLength(1);
  });

  it('skips a reviewer whose plan is below the capacity floor', async () => {
    const { ensureUsageTable } = await import('./usage-probe.js');
    ensureUsageTable();
    const store = (runtime: string, profile: string, left: number) => db.getDb().prepare(
      'INSERT OR REPLACE INTO profile_usage (runtime, profile, data, probed_at) VALUES (?, ?, ?, ?)',
    ).run(runtime, profile, JSON.stringify({ runtime, profile, summary: `${left}% left`, probed_at: 'now', metrics: [{ label: 'weekly', left_pct: left, used_pct: 100 - left, resets: null }] }), 'now');
    store('codex', 'low', 4);
    store('codex', 'ok', 60);
    const sha = branch('wc-claude1', 'lane.txt', 'lane');
    agent('claude1', path.join(tmp, 'claude1'), 'claude-code');
    const codex2 = db.getAgent(agent('codex2', path.join(tmp, 'codex2')).id).data!;
    const codex3 = agent('codex3', path.join(tmp, 'codex3'));
    db.getDb().prepare('UPDATE agents SET profile = ? WHERE id = ?').run('low', codex2.id);
    db.getDb().prepare('UPDATE agents SET profile = ? WHERE id = ?').run('ok', codex3.id);
    pipe.auto_review = true;
    pipe.reviewer_prefer = { claude: ['codex2', 'codex3'] };
    (await ingestFreezeFile(openNote('claude1', 'wc-claude1', sha)));
    expect(getFreeze(sha)?.reviewer_agent_id).toBe(codex3.id);
    expect(messages(codex2.id).join('\n')).not.toMatch(/Please review/);
  });

  it('seats on a service profile review each other; the open ladder honours reviewer_allow', async () => {
    const sha = branch('wc-claude3', 'lane.txt', 'lane');
    const author = agent('claude3', path.join(tmp, 'claude3'), 'claude-code');
    const codex4 = agent('codex4', path.join(tmp, 'codex4'));
    const alesCodex = agent('ales-codex2', path.join(tmp, 'ales-codex2'));
    for (const a of [author, codex4]) db.getDb().prepare('UPDATE agents SET profile = ? WHERE id = ?').run('denis20x', a.id);
    pipe.auto_review = true;
    pipe.reviewer_allow = ['codex4'];
    // Without the service profile, codex4 is "the author's other seat" and nobody is left.
    (await ingestFreezeFile(openNote('claude3', 'wc-claude3', sha)));
    expect(getFreeze(sha)?.reviewer_agent_id).toBeNull();
    expect(messages(alesCodex.id).join('\n')).not.toMatch(/Please review/);

    pipe.service_profiles = ['denis20x'];
    const sha2 = branch('wc-claude3', 'lane2.txt', 'lane2');
    (await ingestFreezeFile(openNote('claude3', 'wc-claude3', sha2)));
    expect(getFreeze(sha2)?.reviewer_agent_id).toBe(codex4.id);
    expect(messages(alesCodex.id).join('\n')).not.toMatch(/Please review/);
  });

  it('asks a listed seat for a first pass, announces the file to reviewer and author, and notes a missing one', async () => {
    const sha = branch('wc-claude1', 'lane.txt', 'lane');
    const author = agent('claude1', path.join(tmp, 'claude1'), 'claude-code');
    const codex3 = agent('codex3', path.join(tmp, 'codex3'));
    const codex9 = agent('codex9', path.join(tmp, 'codex9'));
    pipe.auto_review = true;
    pipe.reviewer_prefer = { claude: ['codex3'] };
    review.first_pass = { enabled: true, seats: ['codex9'], dir: freezeDir, timeout_min: 20 };
    try {
      (await ingestFreezeFile(openNote('claude1', 'wc-claude1', sha)));
      expect(getFreeze(sha)?.reviewer_agent_id).toBe(codex3.id);
      const ask = messages(codex9.id).join('\n');
      expect(ask).toMatch(/First pass, one pass only/);
      const file = ask.match(/Write (\S+wave-firstpass-[0-9a-f]{8}-\d{8}\.md)/)?.[1];
      expect(file).toBeTruthy();
      expect(ask).toMatch(/Never write the word VERDICT/);
      expect(messages(codex3.id).join('\n')).not.toMatch(/First pass/);
      expect(latestPipelineNote('wave', 'wc-claude1')).toMatch(/review requested/);

      fs.writeFileSync(file!, [
        '# First pass: wc-claude1',
        `SHA: ${sha}`,
        'Lane: wc-claude1',
        'Author: @claude1',
        'Seat: @codex9',
        'ISSUES:',
        '- [HIGH] src/a.ts:12 — null deref when the list is empty',
        '- [LOW] src/b.ts:3 — test does not cover the error branch',
        'FIRST PASS: NEEDS FIXES',
        '',
      ].join('\n'));
      // The file is not a freeze note or a verdict: the ingester refuses it.
      expect((await ingestFreezeFile(file!)).ok).toBe(false);
      const recorded = recordFirstPassFile(file!);
      expect(recorded).toMatchObject({ sha, result: 'needs-fixes', issues: 2, seat: 'codex9' });
      expect(firstPassFor(sha)?.issues).toBe(2);
      expect(messages(codex3.id).join('\n')).toMatch(/First pass on \w{8} by @codex9: NEEDS FIXES \(2 issues\)/);
      expect(messages(author.id).join('\n')).toMatch(/First pass on \w{8} by @codex9: NEEDS FIXES, 2 issues/);
      expect(getFreeze(sha)?.verdict).toBeNull();
      expect(latestPipelineNote('wave', 'wc-claude1')).toMatch(/first pass by @codex9 — NEEDS FIXES/);

      // A second freeze whose first pass never arrives is noted once after the timeout.
      const sha2 = branch('wc-claude1', 'lane2.txt', 'lane2');
      (await ingestFreezeFile(openNote('claude1', 'wc-claude1', sha2)));
      await pipelineTick(Date.now() + 21 * 60_000);
      expect(latestPipelineNote('wave', 'wc-claude1')).toMatch(/no first pass from @codex9 after 21 min/);
      await pipelineTick(Date.now() + 22 * 60_000);
      expect(latestPipelineNote('wave', 'wc-claude1')).toMatch(/no first pass from @codex9 after 21 min/);
    } finally {
      review.first_pass = undefined;
    }
  });
});
