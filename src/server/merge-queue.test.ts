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
vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ review, projects, releases: {}, peers: {}, paths: {}, artifacts: { storage: '' }, notifications: {} })),
}));

import * as db from './db.js';
import { emit } from './event-bus.js';
import { getFreeze, ingestFreezeFile, listVerdicts } from './release-freezes.js';
import {
  askPathHit, checkStall, evaluate, getQueueRow, independentPasses, laneDeniedWhy, listQueue, mergeQueueTick, migrationCollision, prFromList,
  gateRefusal, killedExit, queueStall, queueSwitch, resetMergeQueueForTest, resultLine, setMergeQueueExecForTest, setQueuePriority, setQueueSwitch, tierFor, tierFromNote, type MergeQueueRow,
} from './merge-queue.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
}

describe('merge queue — pure rules', () => {
  it('reads the TIER line in its usual spellings', () => {
    expect(tierFromNote('# x\nTIER: show\n')).toBe('show');
    expect(tierFromNote('- **TIER**: ask')).toBe('ask');
    expect(tierFromNote('TIER: Ship')).toBe('ship');
    expect(tierFromNote('tier: ship or show')).toBe('ship');
    expect(tierFromNote('Risk: ask the reviewer')).toBeNull();
    expect(tierFromNote(null)).toBeNull();
  });

  it('forces ask for ask_paths globs and the migrations directory, else uses the note or the default', () => {
    const cfg = { ask_paths: ['**/payroll/**', 'src/server/vat/*', 'billing'] };
    expect(askPathHit(['src/server/payroll/run.ts'], cfg.ask_paths, 'migrations')).toBe('src/server/payroll/run.ts');
    expect(askPathHit(['payroll/x.ts'], cfg.ask_paths, null)).toBe('payroll/x.ts');
    expect(askPathHit(['src/server/vat/rates.ts'], cfg.ask_paths, null)).toBe('src/server/vat/rates.ts');
    expect(askPathHit(['src/server/vat/deep/rates.ts'], cfg.ask_paths, null)).toBeNull();
    expect(askPathHit(['billing/invoice.ts', 'README.md'], cfg.ask_paths, null)).toBe('billing/invoice.ts');
    expect(askPathHit(['migrations/0370_x.sql'], [], 'migrations')).toBe('migrations/0370_x.sql');
    expect(askPathHit(['src/ui/App.tsx'], cfg.ask_paths, 'migrations')).toBeNull();

    expect(tierFor('TIER: ship', ['src/ui/App.tsx'], cfg, 'migrations')).toEqual({ tier: 'ship', forced: null });
    expect(tierFor('TIER: ship', ['migrations/0370_x.sql'], cfg, 'migrations')).toEqual({ tier: 'ask', forced: 'migrations/0370_x.sql' });
    expect(tierFor('no tier here', [], cfg, null)).toEqual({ tier: 'show', forced: null }); // no TIER line: show, not a wait
    expect(tierFor('no tier here', [], { ...cfg, default_tier: 'show' }, null)).toEqual({ tier: 'show', forced: null });
  });

  it('one PASS counts when the reviewer is not the author and sits on another profile than the builder', () => {
    const v = (reviewer_name: string, profile: string | null, verdict: 'pass' | 'needs-fixes' = 'pass') => ({
      sha: 'x', reviewer_agent_id: null, reviewer_name, profile, verdict, path: `/inbox/${reviewer_name}.md`, created_at: 'now',
    });
    const author = { id: null, name: 'claude2', profile: 'denis20x' };
    expect(independentPasses([v('codex3', 'pool')], author)).toMatchObject({ ok: true, passes: [expect.objectContaining({ reviewer_name: 'codex3' })] });
    expect(independentPasses([v('codex4', 'denis20x')], author).why).toMatch(/@codex4: same as @claude2 on denis20x/);
    // a service pool profile is not a person: its seats review each other
    expect(independentPasses([v('codex4', 'denis20x')], author, ['denis20x']).ok).toBe(true);
    // the same person on two seats is one reviewer, whatever the profile
    expect(independentPasses([v('ales-claude2', 'pool')], { id: null, name: 'ales-claude1', profile: 'home' }).ok).toBe(false);
    expect(independentPasses([v('codex4', 'denis20x'), v('codex5', 'pool')], author).passes.map((p) => p.reviewer_name)).toEqual(['codex5']);
    expect(independentPasses([v('claude2', 'pool')], author).why).toMatch(/not the author/);
    expect(independentPasses([v('codex3', 'pool', 'needs-fixes')], author).ok).toBe(false);
    expect(independentPasses([], author).why).toMatch(/needs one PASS verdict on this exact SHA/);
    // the home-dir login is a profile too: two home seats are the same profile
    expect(independentPasses([v('codex3', null)], { id: null, name: 'ales', profile: null }).ok).toBe(false);
    expect(independentPasses([v('codex3', 'pool')], { id: null, name: 'ales', profile: null }).ok).toBe(true);
  });

  it('denies main, release and prod branches and nothing else: there is no allowlist', () => {
    const cfg = {};
    expect(laneDeniedWhy('wave', 'main', cfg)).toMatch(/on the deny list \(main\)/);
    expect(laneDeniedWhy('wave', 'master', cfg)).toMatch(/deny list/);
    expect(laneDeniedWhy('wave', 'release/1.2', cfg)).toMatch(/release\/\*/);
    expect(laneDeniedWhy('wave', 'prod-hotfix', cfg)).toMatch(/prod-\*/);
    expect(laneDeniedWhy('wave', 'bad name', cfg)).toMatch(/not a safe branch name/);
    expect(laneDeniedWhy('wave', 'claude6/overview-fixes', cfg)).toBeNull();
    expect(laneDeniedWhy('wave', 'wc-codex-antonio-overview-ui-staging', cfg)).toBeNull();
    expect(laneDeniedWhy('wave', 'codex3/hr-payroll-r4', cfg)).toBeNull();
    expect(laneDeniedWhy('wave', 'wc-x', { deny_lanes: ['wc-*'] })).toMatch(/wc-\*/);
  });

  it('new migrations must be numbered after main and not collide', () => {
    const main = ['migrations/0368_a.sql', 'migrations/0369_b.sql', 'migrations/README.md'];
    expect(migrationCollision(main, ['migrations/0370_c.sql'])).toBeNull();
    expect(migrationCollision(main, ['migrations/0369_c.sql'])).toMatch(/0369_c\.sql is not numbered after main's latest \(0369\)/);
    expect(migrationCollision(main, ['migrations/0370_c.sql', 'migrations/0370_d.sql'])).toMatch(/share a number/);
    expect(migrationCollision(main, ['migrations/notes.md'])).toBeNull();
  });

  it('finds the pull request by head SHA, then by branch, and only open ones', () => {
    const sha = 'a'.repeat(40);
    const json = JSON.stringify([
      { number: 101, headRefName: 'wc-old', headRefOid: 'b'.repeat(40), state: 'MERGED' },
      { number: 103, headRefName: 'wc-claude2-hr', headRefOid: sha, state: 'OPEN' },
      { number: 104, headRefName: 'wc-other', headRefOid: 'c'.repeat(40) },
    ]);
    expect(prFromList(json, sha, 'wc-claude2-hr')).toEqual({ number: '#103', labels: [] });
    expect(prFromList(json, 'd'.repeat(40), 'wc-other')?.number).toBe('#104');
    expect(prFromList(json, 'b'.repeat(40), 'wc-old')).toBeNull();
    expect(prFromList('not json', sha, 'x')).toBeNull();
    // gh prints labels as objects; a plain string list is accepted too
    const labelled = JSON.stringify([{ number: 9, headRefName: 'wc-l', headRefOid: sha, labels: [{ name: 'ask-tier-approved' }, 'migration-hold'] }]);
    expect(prFromList(labelled, sha, 'wc-l')?.labels).toEqual(['ask-tier-approved', 'migration-hold']);
  });
});

describe('merge queue — on a scratch repository', () => {
  let tmp: string;
  let repo: string;
  let bare: string;
  let inbox: string;
  let pipe: Record<string, unknown>;
  let mq: Record<string, unknown>;
  const gateSeen: Array<{ argv: string[]; env: Record<string, string> | undefined; cwd: string | undefined }> = [];
  let gateHook: ((env: Record<string, string> | undefined) => { code: number; stdout: string } | void) | null = null;
  let ghAuth = true;
  let prs: Array<{ number: number; headRefName: string; headRefOid: string; labels: Array<{ name: string }> }> = [];
  const ghSeen: string[][] = [];

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-mq-'));
    repo = path.join(tmp, 'repos', 'wave');
    bare = path.join(tmp, 'origin.git');
    inbox = path.join(tmp, 'inbox');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(inbox);
    db.initDb(path.join(tmp, 't.db'));
    resetMergeQueueForTest();
    gateSeen.length = 0;
    gateHook = null;
    ghAuth = true;
    prs = [];
    ghSeen.length = 0;
    setMergeQueueExecForTest((argv, opts) => {
      if (argv[0] === 'gh') {
        ghSeen.push(argv);
        if (!ghAuth) return { code: 1, stdout: '' };
        if (argv[1] === 'auth') return { code: 0, stdout: 'Logged in to github.com' };
        if (argv[1] === 'pr') return { code: 0, stdout: JSON.stringify(prs) };
        return { code: 2, stdout: '' };
      }
      if (argv[0] !== 'gate-run') return null;
      gateSeen.push({ argv, env: opts.env, cwd: opts.cwd });
      return gateHook?.(opts.env) ?? { code: 0, stdout: 'GREEN' };
    });
    mq = { enabled: true, require_pr: false, ask_paths: ['**/payroll/**'], maestro_log: path.join(tmp, 'maestro', 'merge-queue.log') };
    pipe = { gate_command: ['gate-run', '--suite', 'api'], gate_timeout_min: 5, merge_queue: mq };
    projects.wave = { repo, lane_glob: 'wc-*', main_remote: 'origin', main_branch: 'main', migrations_dir: 'migrations', pipeline: pipe };

    execFileSync('git', ['init', '-q', '--bare', bare], { env });
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base');
    fs.mkdirSync(path.join(repo, 'migrations'));
    fs.writeFileSync(path.join(repo, 'migrations', '0001_init.sql'), 'create table t;');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', '-u', 'origin', 'main');
  });

  afterEach(() => {
    resetMergeQueueForTest();
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete projects.wave;
  });

  function agent(name: string, profile: string | null = null, runtime = 'codex') {
    const row = db.insertAgent({ name, runtime, tmux_session: `tmux-${name}`, workspace: path.join(tmp, name), mode: 'spawned', status: 'idle', profile });
    if (!row.ok) throw new Error(row.error);
    return row.data;
  }

  function messages(agentId: string): string[] {
    return db.listAgentMessages({ to_agent_id: agentId }).map((row) => row.message);
  }

  /** A lane with one commit on top of main, pushed to origin. */
  function lane(name: string, files: Record<string, string>, from = 'main'): string {
    git(repo, 'checkout', '-q', from);
    git(repo, 'checkout', '-q', '-B', name);
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), content);
    }
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', `${name}: ${Object.keys(files).join(', ')}`);
    git(repo, 'push', '-q', 'origin', name);
    return git(repo, 'rev-parse', 'HEAD');
  }

  function originMain(): string {
    return git(bare, 'rev-parse', 'main');
  }

  async function freeze(author: string, laneName: string, sha: string, tier: string | null = 'ship', extra: string[] = []): Promise<void> {
    const file = path.join(inbox, `${author}-${laneName}-freeze-${sha.slice(0, 8)}.md`);
    fs.writeFileSync(file, [
      `# ${laneName} freeze: test`,
      `Project: wave · Author: @${author}`,
      `Lane: ${laneName}`,
      `Freeze SHA: ${sha}`,
      ...(tier ? [`TIER: ${tier}`] : []),
      'Tests: quick check: GREEN on this SHA',
      ...extra,
      '',
    ].join('\n'));
    const result = await ingestFreezeFile(file);
    if (!result.ok) throw new Error(result.error);
  }

  function gateGreen(sha: string): void {
    emit('pipeline.gate', 'run', `${sha}:full`, { sha, project: 'wave', gate: 'GREEN' }, null);
  }

  async function verdict(reviewer: string, author: string, sha: string, word = 'PASS'): Promise<void> {
    const file = path.join(inbox, `${reviewer}-verdict-${author}-${sha.slice(0, 8)}.md`);
    fs.writeFileSync(file, `# Verdict\nReviewer: @${reviewer}\nAuthor: @${author}\nFreeze SHA: ${sha}\n\nVERDICT: ${word}\n`);
    const result = await ingestFreezeFile(file);
    if (!result.ok) throw new Error(result.error);
  }

  /** Freeze, green gate and one independent PASS (codex3 on profile pool): the evidence every tier needs. */
  async function reviewed(author: string, laneName: string, sha: string, tier: string | null = 'ship'): Promise<void> {
    await freeze(author, laneName, sha, tier);
    gateGreen(sha);
    if (!db.listAgents().some((a) => a.name === 'codex3')) agent('codex3', 'pool');
    await verdict('codex3', author, sha);
  }

  async function tick(): Promise<void> {
    await mergeQueueTick({ wait: true });
  }

  it('refuses with one code and the missing evidence at each step, then queues; ask needs the OK label', async () => {
    const author = agent('ales');
    agent('codex3', 'pool');
    agent('codex5', 'denis20x');
    const sha = lane('wc-ales', { 'src/payroll/run.ts': 'x' });
    await freeze('ales', 'wc-ales', sha, null);
    // A payroll path forces ask: no TIER line is needed to know the tier.
    let state = await evaluate(getFreeze(sha)!);
    expect(state).toMatchObject({ state: 'waiting', tier: 'ask', code: 'GATE_NOT_GREEN', reason: `GATE_NOT_GREEN: quick green, api missing on ${sha.slice(0, 8)}` });

    gateGreen(sha);
    state = await evaluate(getFreeze(sha)!);
    expect(state).toMatchObject({ code: 'NO_PASS_ON_SHA', reason: 'NO_PASS_ON_SHA: needs one PASS verdict on this exact SHA from a reviewer who is not the author' });

    await verdict('codex3', 'ales', sha);
    state = await evaluate(getFreeze(sha)!);
    expect(state).toMatchObject({ code: 'ASK_TIER_NO_OK', reason: expect.stringMatching(/^ASK_TIER_NO_OK: ask because of src\/payroll\/run.ts; no github block in config/) });
    expect(listVerdicts(sha).map((v) => [v.reviewer_name, v.profile, v.verdict])).toEqual([['codex3', 'pool', 'pass']]);

    mq.github = { repo: 'dbenic/wave' };
    state = await evaluate(getFreeze(sha)!);
    expect(state.reason).toMatch(/^ASK_TIER_NO_OK: .*needs an open pull request with Denis's ask-tier-approved label/);
    prs = [{ number: 7, headRefName: 'wc-ales', headRefOid: sha, labels: [] }];
    state = await evaluate(getFreeze(sha)!);
    expect(state).toMatchObject({ pr: '#7', reason: 'ASK_TIER_NO_OK: ask because of src/payroll/run.ts; pull request #7 has no ask-tier-approved label from Denis' });
    prs[0].labels = [{ name: 'migration-hold' }, { name: 'ask-tier-approved' }];
    state = await evaluate(getFreeze(sha)!);
    expect(state).toMatchObject({ code: 'MIGRATION_HOLD', reason: 'MIGRATION_HOLD: pull request #7 carries the label migration-hold; remove it when the hold is over' });
    prs[0].labels = [{ name: 'Ask-Tier-Approved' }];
    state = await evaluate(getFreeze(sha)!);
    expect(state).toMatchObject({ state: 'queued', code: null, tier: 'ask', pr: '#7', reason: null });
    expect(state.verdictFiles).toHaveLength(1);

    await tick();
    expect(getQueueRow(sha)).toMatchObject({ state: 'merged', pr: '#7', tier: 'ask' });
    expect(messages(author.id).some((m) => /is in the merge queue \(tier ask\)/.test(m))).toBe(true);
    // gh was asked once for auth and once for the list per pass; the token never appears in argv
    expect(ghSeen.every((argv) => !argv.some((a) => /token/i.test(a)))).toBe(true);
  });

  it('require_pr is off by default; on, a missing pull request is NO_PR; a lane that already has a PASS needs no second review', async () => {
    agent('ales');
    const sha = lane('wc-ales', { 'p.txt': 'p' });
    await reviewed('ales', 'wc-ales', sha, 'show');
    expect((await evaluate(getFreeze(sha)!))).toMatchObject({ state: 'queued', tier: 'show', pr: null });
    mq.require_pr = true;
    expect((await evaluate(getFreeze(sha)!))).toMatchObject({ code: 'NO_PR', reason: `NO_PR: no open pull request for wc-ales at ${sha.slice(0, 8)}` });
    git(bare, 'update-ref', 'refs/pull/12/head', sha);
    expect((await evaluate(getFreeze(sha)!))).toMatchObject({ state: 'queued', pr: '#12' });
  });

  it('without the GitHub credential every lane is GH_AUTH_MISSING and the stall file goes out at once', async () => {
    agent('ales');
    const sha = lane('wc-ales', { 'g.txt': 'g' });
    await reviewed('ales', 'wc-ales', sha, 'ship');
    mq.github = { repo: 'dbenic/wave', token_file: path.join(tmp, 'no-such-token') };
    const main = originMain();
    await tick();
    expect(originMain()).toBe(main);
    expect(getQueueRow(sha)).toMatchObject({ state: 'waiting', reason: expect.stringMatching(/^GH_AUTH_MISSING: GitHub token file .*no-such-token is missing or empty; SystemOps stores the credential there/) });
    expect(ghSeen).toHaveLength(0); // no token, no gh call
    const stall = queueStall('wave');
    expect(stall).toMatchObject({ project: 'wave', code: 'GH_AUTH_MISSING', file: expect.stringMatching(/\/maestro\/wavecode-queue-stall-\d{8}-\d{4}\.md$/) });
    const body = fs.readFileSync(stall!.file!, 'utf8');
    expect(body).toContain('# WaveCode merge queue stall · wave');
    expect(body).toContain('Reason: GH_AUTH_MISSING:');
    expect(body).toContain(`| wc-ales | ${sha} | waiting |`);
    expect(fs.readFileSync(mq.maestro_log as string, 'utf8')).toMatch(/stall GH_AUTH_MISSING/);

    // a token file that gh rejects is the same refusal, with gh's exit code and no token in the reason
    fs.writeFileSync(path.join(tmp, 'token'), 'ghp_secret_value\n');
    mq.github = { repo: 'dbenic/wave', token_file: path.join(tmp, 'token') };
    ghAuth = false;
    await tick();
    expect(getQueueRow(sha)?.reason).toMatch(/^GH_AUTH_MISSING: gh auth status failed \(exit 1\); check the token in /);
    expect(getQueueRow(sha)?.reason).not.toContain('secret');
    expect(fs.readdirSync(path.join(tmp, 'maestro')).filter((f) => f.startsWith('wavecode-queue-stall-'))).toHaveLength(1); // throttled

    // the credential returns: the lane merges and the stall clears
    ghAuth = true;
    await tick();
    expect(getQueueRow(sha)?.state).toBe('merged');
    expect(queueStall('wave')).toBeNull();
  });

  it('an eligible lane that waits with no progress raises the stall file once per window; a merge clears it', async () => {
    agent('ales');
    const sha = lane('wc-ales', { 's.txt': 's' });
    await reviewed('ales', 'wc-ales', sha, 'ship');
    gateHook = () => ({ code: 7, stdout: 'QUEUED' });
    await tick();
    expect(getQueueRow(sha)).toMatchObject({ state: 'queued', attempts: 1 });
    expect(checkStall('wave', null)).toBeNull();
    const later = Date.now() + 31 * 60_000;
    const stall = checkStall('wave', null, later);
    expect(stall).toMatchObject({ code: 'STALLED_MERGE', text: expect.stringMatching(/^wc-ales [0-9a-f]{8} has been eligible for 31 min and nothing merged/) });
    expect(fs.existsSync(stall!.file!)).toBe(true);
    expect(checkStall('wave', null, later + 60_000)?.file).toBe(stall!.file); // same window: no second file
    const events = db.getDb().prepare("SELECT payload_json FROM events WHERE type = 'merge_queue.stall'").all() as Array<{ payload_json: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload_json)).toMatchObject({ project: 'wave', code: 'STALLED_MERGE' });
    gateHook = null;
    await tick();
    expect(getQueueRow(sha)?.state).toBe('merged');
    expect(queueStall('wave')).toBeNull();
  });

  it('a verdict that says NEEDS FIXES holds the merge, and a moved lane tip is waited on', async () => {
    agent('ales');
    agent('codex3', 'pool');
    const sha = lane('wc-ales', { 'b.txt': 'b' });
    await freeze('ales', 'wc-ales', sha, null);
    // no TIER line is no reason to wait: show unless config says otherwise
    expect((await evaluate(getFreeze(sha)!))).toMatchObject({ tier: 'show', code: 'GATE_NOT_GREEN' });
    mq.default_tier = 'ask';
    expect((await evaluate(getFreeze(sha)!)).tier).toBe('ask');
    delete mq.default_tier;
    await reviewed('ales', 'wc-ales', sha, 'ship');
    await verdict('codex3', 'ales', sha, 'NEEDS FIXES');
    expect((await evaluate(getFreeze(sha)!))).toMatchObject({ code: 'NEEDS_FIXES', reason: 'NEEDS_FIXES: reviewer @codex3 said NEEDS FIXES; fix, push and freeze a new SHA' });

    const sha2 = lane('wc-ales', { 'c.txt': 'c' }, 'wc-ales');
    await reviewed('ales', 'wc-ales', sha2, 'ship');
    lane('wc-ales', { 'd.txt': 'd' }, 'wc-ales');
    expect((await evaluate(getFreeze(sha2)!))).toMatchObject({ code: 'LANE_MOVED', reason: expect.stringMatching(/^LANE_MOVED: lane moved to [0-9a-f]{8} after the freeze/) });
  });

  it('parks a freeze older than two weeks instead of evaluating it every pass', async () => {
    agent('ales');
    const sha = lane('wc-ales', { 'old.txt': 'old' });
    await reviewed('ales', 'wc-ales', sha, 'ship');
    setQueueSwitch('wave', false, 'denis');
    await tick();
    expect(getQueueRow(sha)?.state).toBe('queued');
    db.getDb().prepare("UPDATE release_freezes SET created_at = datetime('now', '-15 days') WHERE sha = ?").run(sha);
    setQueueSwitch('wave', true, 'denis');
    await tick();
    expect(getQueueRow(sha)).toMatchObject({ state: 'waiting', reason: expect.stringMatching(/frozen more than 14 days ago/) });
    expect(originMain()).not.toBe(sha);
  });

  it('merges two queued lanes in order; the second is merged onto the new main and re-gated on the merge SHA', async () => {
    const ales = agent('ales');
    const toni = agent('toni');
    const base = originMain();
    const shaA = lane('wc-ales', { 'a-lane.txt': 'A' });
    const shaB = lane('wc-toni', { 'b-lane.txt': 'B' });
    await reviewed('ales', 'wc-ales', shaA, 'ship');
    await tick(); // A is queued and merged; B has no freeze yet
    const mainAfterA = originMain();
    expect(mainAfterA).not.toBe(base);
    expect(git(bare, 'rev-list', '--parents', '-1', 'main').split(' ')).toHaveLength(3); // a real merge commit
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe(`Merge wc-ales (${shaA.slice(0, 8)}) into main`);
    expect(git(bare, 'merge-base', '--is-ancestor', shaA, 'main')).toBe('');
    // the lane already contained main, yet the full suite still ran once on the merge result (the only full run)
    expect(gateSeen).toHaveLength(1);
    expect(gateSeen[0].env).toMatchObject({ WAVECODE_SHA: mainAfterA, WAVECODE_MERGE_OF: shaA, COUNTIX_REMOTE_TEST_WHO: 'ales' });
    expect(getQueueRow(shaA)).toMatchObject({ state: 'merged', merge_sha: mainAfterA, reason: `gate GREEN on ${mainAfterA.slice(0, 8)}` });
    expect(messages(ales.id).some((m) => m.includes(`merged wc-ales ${shaA.slice(0, 8)} into main as ${mainAfterA.slice(0, 8)}`))).toBe(true);

    await reviewed('toni', 'wc-toni', shaB, 'show');
    await tick();
    const mainAfterB = originMain();
    expect(mainAfterB).not.toBe(mainAfterA);
    expect(git(bare, 'merge-base', '--is-ancestor', shaB, 'main')).toBe('');
    expect(git(bare, 'merge-base', '--is-ancestor', mainAfterA, 'main')).toBe('');
    // the gate ran on B's merge result too, as the author
    expect(gateSeen).toHaveLength(2);
    expect(gateSeen[1].env).toMatchObject({ WAVECODE_SHA: mainAfterB, WAVECODE_LANE: 'wc-toni', WAVECODE_MERGE_OF: shaB, COUNTIX_REMOTE_TEST_WHO: 'toni' });
    expect(gateSeen[1].cwd).toContain(path.join('.wavecode-merges', 'wave-'));
    expect(fs.existsSync(gateSeen[1].cwd!)).toBe(false); // the checkout is removed afterwards
    expect(getQueueRow(shaB)).toMatchObject({ state: 'merged', merge_sha: mainAfterB, tier: 'show' });
    expect(messages(toni.id).some((m) => m.includes('merged wc-toni'))).toBe(true);

    const log = fs.readFileSync(mq.maestro_log as string, 'utf8').trim().split('\n');
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} CET merged wc-ales [0-9a-f]{8} -> main [0-9a-f]{8} \(tier ship, verdicts codex3-verdict-ales-[0-9a-f]{8}\.md\)$/);
    expect(log[1]).toMatch(/merged wc-toni .* \(tier show, verdicts /);
    const events = db.getDb().prepare("SELECT type, payload_json FROM events WHERE type LIKE 'merge_queue.%' ORDER BY id").all() as Array<{ type: string; payload_json: string }>;
    expect(events.map((e) => e.type)).toEqual(['merge_queue.queued', 'merge_queue.merged', 'merge_queue.queued', 'merge_queue.merged']);
    expect(JSON.parse(events[1].payload_json)).toMatchObject({ sha_in: shaA, sha_out: mainAfterA, main_before: base, tier: 'ship', author: 'ales' });
    // the working clone is untouched: no merge happened on a checked-out branch
    expect(git(repo, 'status', '--porcelain')).toBe('');
  });

  it('a conflict with main bounces to the author with the files; main is untouched', async () => {
    const ales = agent('ales');
    const sha = lane('wc-ales', { 'a.txt': 'lane version' });
    lane('wc-main-mover', { 'a.txt': 'main version' });
    git(repo, 'push', '-q', 'origin', 'wc-main-mover:main');
    const main = originMain();
    await reviewed('ales', 'wc-ales', sha, 'ship');
    await tick();
    expect(originMain()).toBe(main);
    expect(getQueueRow(sha)).toMatchObject({ state: 'bounced', reason: expect.stringMatching(/merge conflict with main in a\.txt/) });
    expect(messages(ales.id).some((m) => /merge queue bounced [0-9a-f]{8} on wc-ales: merge conflict with main in a\.txt/.test(m))).toBe(true);
    expect(fs.readFileSync(mq.maestro_log as string, 'utf8')).toMatch(/bounced wc-ales [0-9a-f]{8}: merge conflict/);
    expect(fs.existsSync(path.join(tmp, 'repos', '.wavecode-merges'))).toBe(true);
    expect(fs.readdirSync(path.join(tmp, 'repos', '.wavecode-merges'))).toEqual([]);
    // a bounced SHA stays bounced; the next tick does not retry it
    await tick();
    expect(getQueueRow(sha)?.state).toBe('bounced');
  });

  it('a gate tool that fails without a verdict is retried, not bounced; three failures bounce with GATE_DISPATCH_FAILED', async () => {
    const ales = agent('ales');
    lane('wc-base-shift', { 'shift.txt': 's' });
    git(repo, 'push', '-q', 'origin', 'wc-base-shift:main');
    const sha = lane('wc-ales', { 'a-lane.txt': 'A' });
    await reviewed('ales', 'wc-ales', sha, 'ship');
    gateHook = () => ({ code: 2, stdout: [
      'countix-remote-test: pushing 1234567 (merge) to countix-testing:refs/heads/rt/ales/x',
      'run: full suite is for freeze candidates only; use the quick check. Freeze candidates go through gate <sha>.',
      'countix-remote-test: remote exit 2 on host=countix-testing (0s total)',
    ].join('\n') });
    await tick();
    expect(getQueueRow(sha)).toMatchObject({ state: 'queued', attempts: 1, reason: expect.stringMatching(/^GATE_DISPATCH_FAILED: run: full suite is for freeze candidates only/) });
    expect(messages(ales.id).some((m) => /bounced/.test(m))).toBe(false);
    await tick();
    expect(getQueueRow(sha)).toMatchObject({ state: 'queued', attempts: 2 });
    await tick();
    expect(getQueueRow(sha)).toMatchObject({ state: 'bounced', reason: expect.stringMatching(/^GATE_DISPATCH_FAILED: run: full suite .* — after 3 tries$/) });
    expect(gateSeen.length).toBe(3);
    expect(fs.readdirSync(path.join(tmp, 'repos', '.wavecode-merges'))).toEqual([]);
  });

  it('a GREEN RESULT line counts even when the tool was killed after printing it; a kill without a RESULT line is retried', async () => {
    const ales = agent('ales');
    lane('wc-base-shift', { 'shift.txt': 's' });
    git(repo, 'push', '-q', 'origin', 'wc-base-shift:main');
    const sha = lane('wc-ales', { 'a-lane.txt': 'A' });
    await reviewed('ales', 'wc-ales', sha, 'ship');
    let calls = 0;
    gateHook = () => {
      calls++;
      if (calls === 1) return { code: 143, stdout: 'countix-remote-test: pushed in 1s; running suite tier1 on host=countix-testing\n===== abort =====\nphase: queued\nwhy: SIGTERM/INT with no recorded reason\ncountix-remote-test: remote exit 143 on host=countix-testing (6s total)' };
      return { code: 143, stdout: [
        'countix-remote-test: pushed in 1s; running suite tier1 on host=countix-testing',
        'note: reused result of 20261026-110012 (identical tree) - not run again',
        '=== RESULT GREEN sha=2658cb59e suite=tier1 who=wave.countix-dev.ales exit=0 host=runner-c ===',
        '===== abort =====',
        'phase: queued',
        'why: SIGTERM/INT with no recorded reason (sender pid unknown)',
        'countix-remote-test: remote exit 143 on host=countix-testing (6s total)',
      ].join('\n') };
    };
    await tick();
    expect(getQueueRow(sha)).toMatchObject({ state: 'queued', attempts: 1, reason: expect.stringMatching(/^GATE_DISPATCH_FAILED: gate tool killed \(exit 143\) before a RESULT line/) });
    await tick();
    expect(getQueueRow(sha)?.state).toBe('merged');
    expect(messages(ales.id).some((m) => /bounced/.test(m))).toBe(false);
  });

  it('gateRefusal tells a tool failure from a verdict', () => {
    expect(resultLine('x\n=== RESULT GREEN sha=1 suite=tier1 ===\nphase: queued')).toMatchObject({ word: 'GREEN' });
    expect(resultLine('countix-remote-test: pushed; running suite')).toBeNull();
    expect(gateRefusal({ code: 2, stdout: 'countix-remote-test: pushed in 1s; running suite tier1 on host=x\nrun: refused' })).toBe('run: refused');
    expect(gateRefusal({ code: 0, stdout: 'GREEN' })).toBeNull();
    expect(gateRefusal({ code: 1, stdout: 'step api failed\nRED' })).toBeNull();
    expect(gateRefusal({ code: 1, stdout: '=== RESULT RED host=countix-testing ===' })).toBeNull();
    expect(gateRefusal({ code: 90, stdout: 'countix-remote-test: cannot reach countix-testing:22 over the tailnet' })).toBe('countix-remote-test: cannot reach countix-testing:22 over the tailnet');
    expect(gateRefusal({ code: 2, stdout: '' })).toBe('gate tool exit 2 with no verdict');
  });

  it('a RED gate on the merge result bounces; a rejected push because main moved merges again', async () => {
    agent('ales');
    agent('toni');
    lane('wc-base-shift', { 'shift.txt': 's' });
    git(repo, 'push', '-q', 'origin', 'wc-base-shift:main');
    const sha = lane('wc-ales', { 'a-lane.txt': 'A' }); // local main is behind origin/main: the merge has a new tree, so the gate runs
    await reviewed('ales', 'wc-ales', sha, 'ship');
    gateHook = () => ({ code: 1, stdout: 'step api failed\nRED' });
    await tick();
    expect(getQueueRow(sha)).toMatchObject({ state: 'bounced', reason: expect.stringMatching(/gate RED on merge [0-9a-f]{8} — RED/) });

    const shaB = lane('wc-toni', { 'b-lane.txt': 'B' });
    await reviewed('toni', 'wc-toni', shaB, 'ship');
    let moved = false;
    gateHook = () => {
      if (!moved) {
        moved = true;
        lane('wc-racer', { 'race.txt': 'r' }, 'origin/main');
        git(repo, 'push', '-q', 'origin', 'wc-racer:main');
      }
      return { code: 0, stdout: 'GREEN' };
    };
    await tick();
    expect(getQueueRow(shaB)).toMatchObject({ state: 'queued', reason: expect.stringMatching(/main moved during the gate/), attempts: 1 });
    await tick();
    expect(getQueueRow(shaB)).toMatchObject({ state: 'merged' });
    expect(git(bare, 'merge-base', '--is-ancestor', shaB, 'main')).toBe('');
    expect(git(bare, 'log', '--format=%s', 'main')).toContain('wc-racer: race.txt');
    expect(gateSeen).toHaveLength(3);
  });

  it('the kill switch stops merging without losing the queue; config off means no queue at all', async () => {
    const ales = agent('ales');
    const sha = lane('wc-ales', { 'k.txt': 'k' });
    await reviewed('ales', 'wc-ales', sha, 'ship');
    const main = originMain();
    setQueueSwitch('wave', false, 'denis');
    expect(queueSwitch('wave')).toMatchObject({ project: 'wave', config_enabled: true, enabled: false, enabled_by: 'denis' });
    await tick();
    expect(originMain()).toBe(main);
    // Eligibility is still shown while the switch is off; nothing merges.
    expect(getQueueRow(sha)).toMatchObject({ state: 'queued', reason: 'QUEUE_OFF: merge queue is off' });
    expect((await evaluate(getFreeze(sha)!)).state).toBe('queued');

    setQueueSwitch('wave', true, 'denis');
    await tick();
    expect(originMain()).not.toBe(main);
    expect(getQueueRow(sha)).toMatchObject({ state: 'merged', enabled_by: 'denis' });
    expect(messages(ales.id).some((m) => m.includes('merged wc-ales'))).toBe(true);
    const switches = db.getDb().prepare("SELECT payload_json FROM events WHERE type = 'merge_queue.switch' ORDER BY id").all() as Array<{ payload_json: string }>;
    expect(switches.map((s) => JSON.parse(s.payload_json).enabled)).toEqual([false, true]);

    mq.enabled = false;
    const sha2 = lane('wc-ales', { 'k2.txt': 'k2' }, 'wc-ales');
    await reviewed('ales', 'wc-ales', sha2, 'ship');
    const mainNow = originMain();
    await tick();
    expect(originMain()).toBe(mainNow);
    expect(getQueueRow(sha2)).toBeNull();
    expect(queueSwitch('wave').config_enabled).toBe(false);
  });

  it('a migration numbered at or below main bounces; a later number goes through; the version command is folded into the merge commit', async () => {
    agent('ales');
    agent('toni');
    mq.github = { repo: 'dbenic/wave', ok_label: 'denis-ok' };
    const bad = lane('wc-ales', { 'migrations/0001_dup.sql': 'x' });
    await reviewed('ales', 'wc-ales', bad, 'ask'); // migrations force ask whatever the note says
    prs = [{ number: 1, headRefName: 'wc-ales', headRefOid: bad, labels: [{ name: 'denis-ok' }] }];
    await tick();
    expect(getQueueRow(bad)).toMatchObject({ state: 'bounced', tier: 'ask', reason: expect.stringMatching(/^MIGRATION_COLLISION: migration 0001_dup\.sql is not numbered after main's latest \(0001\)/) });

    mq.version_command = ['sh', '-c', 'echo "bumped {sha}" > VERSION'];
    const good = lane('wc-toni', { 'migrations/0002_ok.sql': 'y' });
    await reviewed('toni', 'wc-toni', good, 'ship');
    prs = [{ number: 2, headRefName: 'wc-toni', headRefOid: good, labels: [{ name: 'denis-ok' }] }];
    await tick();
    const row = getQueueRow(good) as MergeQueueRow;
    expect(row.state).toBe('merged');
    expect(git(bare, 'show', 'main:VERSION')).toBe(`bumped ${good}`);
    expect(git(bare, 'rev-list', '--parents', '-1', 'main').split(' ')).toHaveLength(3);
    // the version change made a new tree, so the gate ran on the merge result
    expect(gateSeen.map((g) => g.env?.WAVECODE_SHA)).toEqual([row.merge_sha]);
  });

  it('priority moves a lane to the front; a freeze that is no longer open leaves the queue', async () => {
    agent('ales');
    agent('toni');
    lane('wc-base-shift', { 'shift.txt': 's' });
    git(repo, 'push', '-q', 'origin', 'wc-base-shift:main'); // both lanes are behind origin/main, so their merges are gated
    const shaA = lane('wc-ales', { 'a1.txt': 'a' });
    const shaB = lane('wc-toni', { 'b1.txt': 'b' });
    const main = originMain();
    setQueueSwitch('wave', false, 'denis');
    await reviewed('ales', 'wc-ales', shaA, 'ship');
    await reviewed('toni', 'wc-toni', shaB, 'ship');
    setQueueSwitch('wave', true, 'denis');
    // A refresh with the gate blocked keeps both queued and nothing merges yet.
    gateHook = () => ({ code: 7, stdout: 'DUPLICATE' });
    await tick();
    const states = listQueue('wave').map((r) => [r.lane, r.state]);
    expect(states).toContainEqual(['wc-ales', 'queued']);
    expect(states).toContainEqual(['wc-toni', 'queued']);
    expect(originMain()).toBe(main);
    expect(setQueuePriority(shaB, 5)?.priority).toBe(5);
    gateHook = null;
    await tick();
    expect(getQueueRow(shaB)?.state).toBe('merged');
    expect(getQueueRow(shaA)?.state).toBe('queued');
    db.getDb().prepare("UPDATE release_freezes SET status = 'stale' WHERE sha = ?").run(shaA);
    await tick();
    expect(getQueueRow(shaA)).toMatchObject({ state: 'superseded', reason: 'freeze stale' });
  });
});
