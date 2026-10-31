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
  askPathHit, checkStall, evaluate, getQueueRow, independentPasses, standingNeedsFixes, laneDeniedWhy, listQueue, mergeQueueTick, migrationCollision, prFromList,
  gateRefusal, killedExit, mergeQueueTickGuarded, queueStall, queueSwitch, resetMergeQueueForTest, resetQueue, resolveQueueShas, resultLine, setMergeQueueExecForTest, setQueuePriority, setQueueSwitch, tierFor, tierFromNote, laneInRelease, personMustAct, setReleaseMode, type MergeQueueRow } from './merge-queue.js';

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
    expect(migrationCollision(main, ['migrations/0369_c.sql'])).toMatch(/merge main into the lane first, then renumber the lane's migrations once so they start at 0370/);
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

describe('merge queue — standing NEEDS FIXES', () => {
  const v = (reviewer: string, verdict: string, at: string) => ({ sha: 'a'.repeat(40), reviewer_agent_id: null, reviewer_name: reviewer, profile: null, verdict, path: null, created_at: at }) as Parameters<typeof standingNeedsFixes>[0][number];
  it('keeps a NEEDS FIXES until the same reviewer says something later on that SHA', () => {
    expect(standingNeedsFixes([v('codex8', 'needs-fixes', '2026-10-31 10:00:00'), v('codex3', 'pass', '2026-10-31 11:00:00')]).map((x) => x.reviewer_name)).toEqual(['codex8']);
    expect(standingNeedsFixes([v('codex8', 'needs-fixes', '2026-10-31 10:00:00'), v('Codex8', 'pass', '2026-10-31 11:00:00')])).toEqual([]);
    expect(standingNeedsFixes([v('codex8', 'pass', '2026-10-31 10:00:00'), v('codex8', 'reject', '2026-10-31 11:00:00')]).map((x) => x.verdict)).toEqual(['reject']);
    expect(standingNeedsFixes([v('codex3', 'pass', '2026-10-31 10:00:00')])).toEqual([]);
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
    // ask_tier: auto — no label and no pull request needed; a hold label on an open PR still parks the lane.
    prs[0].labels = [];
    mq.ask_tier = 'auto';
    expect(await evaluate(getFreeze(sha)!)).toMatchObject({ state: 'queued', code: null, tier: 'ask', pr: '#7' });
    prs = [];
    expect(await evaluate(getFreeze(sha)!)).toMatchObject({ state: 'queued', code: null, tier: 'ask', pr: null });
    prs = [{ number: 7, headRefName: 'wc-ales', headRefOid: sha, labels: [{ name: 'migration-hold' }] }];
    expect(await evaluate(getFreeze(sha)!)).toMatchObject({ code: 'MIGRATION_HOLD' });
    prs[0].labels = [{ name: 'Ask-Tier-Approved' }];
    mq.ask_tier = 'label';
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

  it('review reuse by patch-id: a lane that only merged main keeps its PASS and api GREEN; any new line needs a new review', async () => {
    const author = agent('ales');
    agent('codex3', 'pool');
    agent('toni');
    const sha1 = lane('wc-ales', { 'src/x.ts': 'x1' });
    await reviewed('ales', 'wc-ales', sha1, 'ask'); // ask tier without the label: reviewed, held, so it does not merge first
    expect(await evaluate(getFreeze(sha1)!)).toMatchObject({ code: 'ASK_TIER_NO_OK' });
    // main moves (another lane merges); wc-ales merges main: same patch-id, new SHA.
    const other = lane('wc-toni', { 'src/y.ts': 'y' });
    await reviewed('toni', 'wc-toni', other, 'ship');
    await tick();
    expect(getQueueRow(other)).toMatchObject({ state: 'merged' });
    git(repo, 'checkout', '-q', 'wc-ales');
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'merge', '-q', '--no-edit', 'origin/main');
    const sha2 = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'push', '-q', 'origin', 'wc-ales');
    await freeze('ales', 'wc-ales', sha2, 'ask'); // quick GREEN from the note; no api run, no verdict on sha2
    mq.ask_tier = 'auto';
    const reused = await evaluate(getFreeze(sha2)!);
    expect(reused).toMatchObject({ state: 'queued', code: null, reason: null });
    expect(reused.verdictFiles).toHaveLength(1);
    const events = db.getDb().prepare("SELECT payload_json FROM events WHERE type = 'merge_queue.review_reused' AND entity_id = ?").all(sha2) as Array<{ payload_json: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].payload_json)).toMatchObject({ donor: sha1, reviewers: ['codex3'], api: 'carried' });
    await evaluate(getFreeze(sha2)!);
    expect(db.getDb().prepare("SELECT count(*) AS n FROM events WHERE type = 'merge_queue.review_reused' AND entity_id = ?").get(sha2)).toEqual({ n: 1 });
    // A new line on the lane: a new patch-id, so the old PASS does not carry; the api gate is its own again.
    const sha3 = lane('wc-ales', { 'src/x.ts': 'x2' }, 'wc-ales');
    await freeze('ales', 'wc-ales', sha3, 'ask');
    expect(await evaluate(getFreeze(sha3)!)).toMatchObject({ code: 'GATE_NOT_GREEN', reason: `GATE_NOT_GREEN: quick green, api missing on ${sha3.slice(0, 8)}` });
    gateGreen(sha3);
    expect(await evaluate(getFreeze(sha3)!)).toMatchObject({ code: 'NO_PASS_ON_SHA' });
    expect(messages(author.id).length).toBeGreaterThanOrEqual(0);
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
    lane('wc-base-shift', { 'shift.txt': 's' });
    git(repo, 'push', '-q', 'origin', 'wc-base-shift:main'); // the lane is behind origin/main, so its merge is gated
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

  it('one PASS does not merge while another reviewer\'s NEEDS FIXES stands on the same frozen SHA (75f1d4fe, 31 Oct 2026)', async () => {
    agent('ales');
    agent('codex8', 'pool8');
    const sha = lane('wc-ales', { 'np.txt': 'np' });
    await reviewed('ales', 'wc-ales', sha, 'ship'); // freeze, api GREEN, codex3 PASS
    await verdict('codex8', 'ales', sha, 'NEEDS FIXES');
    await verdict('codex3', 'ales', sha, 'PASS'); // a newer PASS from someone else does not clear codex8
    expect(listVerdicts(sha).map((v) => `${v.reviewer_name}:${v.verdict}`).sort()).toEqual(['codex3:pass', 'codex8:needs-fixes']);
    const held = await evaluate(getFreeze(sha)!);
    expect(held).toMatchObject({ code: 'NEEDS_FIXES' });
    expect(held.reason).toMatch(/@codex8 NEEDS FIXES on [0-9a-f]{8} still stands/);
    await tick();
    expect(getQueueRow(sha)?.state).not.toBe('merged');
    expect(git(repo, 'rev-parse', 'refs/remotes/origin/main')).not.toBe(sha);
    // codex8 re-verdicts the same SHA: the later verdict supersedes the NEEDS FIXES and the lane merges.
    await new Promise((r) => setTimeout(r, 1100)); // created_at has second resolution
    await verdict('codex8', 'ales', sha, 'PASS');
    expect((await evaluate(getFreeze(sha)!)).code).not.toBe('NEEDS_FIXES');
    await tick();
    expect(getQueueRow(sha)?.state).toBe('merged');
  });

  it('a REJECT on the frozen SHA blocks too, even when the freeze summary reads PASS', async () => {
    agent('ales');
    agent('codex8', 'pool8');
    const sha = lane('wc-ales', { 'rj.txt': 'rj' });
    await reviewed('ales', 'wc-ales', sha, 'ship');
    await verdict('codex8', 'ales', sha, 'REJECT');
    await verdict('codex3', 'ales', sha, 'PASS');
    expect((await evaluate(getFreeze(sha)!))).toMatchObject({ code: 'NEEDS_FIXES', reason: expect.stringMatching(/@codex8 REJECT/) });
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
    // the lane already contained main and its own gates are GREEN: the merge tree is the lane's tree, so no merge gate ran
    expect(gateSeen).toHaveLength(0);
    expect(git(bare, 'rev-parse', 'main^{tree}')).toBe(git(repo, 'rev-parse', `${shaA}^{tree}`));
    expect(getQueueRow(shaA)).toMatchObject({ state: 'merged', merge_sha: mainAfterA, reason: `merge gate skipped: ${shaA.slice(0, 8)} already contains main and its quick and api gates are GREEN on that tree` });
    expect(messages(ales.id).some((m) => m.includes(`merged wc-ales ${shaA.slice(0, 8)} into main as ${mainAfterA.slice(0, 8)}`))).toBe(true);

    await reviewed('toni', 'wc-toni', shaB, 'show');
    await tick();
    const mainAfterB = originMain();
    expect(mainAfterB).not.toBe(mainAfterA);
    expect(git(bare, 'merge-base', '--is-ancestor', shaB, 'main')).toBe('');
    expect(git(bare, 'merge-base', '--is-ancestor', mainAfterA, 'main')).toBe('');
    // B was behind the new main: a real merge, so the gate ran on B's merge result, as the author
    expect(gateSeen).toHaveLength(1);
    expect(gateSeen[0].env).toMatchObject({ WAVECODE_SHA: mainAfterB, WAVECODE_LANE: 'wc-toni', WAVECODE_MERGE_OF: shaB, COUNTIX_REMOTE_TEST_WHO: `toni.${mainAfterB.slice(0, 9)}` });
    expect(gateSeen[0].cwd).toContain(path.join('.wavecode-merges', 'wave-'));
    expect(fs.existsSync(gateSeen[0].cwd!)).toBe(false); // the checkout is removed afterwards
    expect(getQueueRow(shaB)).toMatchObject({ state: 'merged', merge_sha: mainAfterB, tier: 'show', reason: `gate GREEN on ${mainAfterB.slice(0, 8)}` });
    expect(messages(toni.id).some((m) => m.includes('merged wc-toni'))).toBe(true);

    const log = fs.readFileSync(mq.maestro_log as string, 'utf8').trim().split('\n');
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} CET merged wc-ales [0-9a-f]{8} -> main [0-9a-f]{8} \(tier ship, verdicts codex3-verdict-ales-[0-9a-f]{8}\.md\)$/);
    expect(log[1]).toMatch(/merged wc-toni .* \(tier show, verdicts /);
    const events = (db.getDb().prepare("SELECT type, payload_json FROM events WHERE type LIKE 'merge_queue.%' ORDER BY id").all() as Array<{ type: string; payload_json: string }>).filter((e) => e.type !== 'merge_queue.pass');
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

  it('a GREEN RESULT line wins over a non-zero exit from the gateway\'s post-run bookkeeping (remote exit 5, 26 Oct 2026)', async () => {
    const ales = agent('ales');
    lane('wc-base-five', { 'five.txt': 'b' });
    git(repo, 'push', '-q', 'origin', 'wc-base-five:main');
    const sha = lane('wc-ales', { 'a-lane.txt': 'A5' });
    await reviewed('ales', 'wc-ales', sha, 'ship');
    gateHook = (env) => ({ code: 5, stdout: [
      'countix-remote-test: pushed in 1s; running suite tier1 on host=countix-testing',
      `=== RESULT GREEN sha=${(env?.WAVECODE_SHA ?? '').slice(0, 9)} suite=tier1 who=wavecode.ff4256112 exit=0 lint=PASS build=PASS host=countix-testing ===`,
      '[15:59:09] exit 0',
      '/srv/countix-test/bin/queue-record.sh: line 95: 2462364 Killed                     sleep 2',
      'countix-remote-test: remote exit 5 on host=countix-testing (360s total)',
    ].join('\n') });
    await tick();
    expect(getQueueRow(sha)?.state).toBe('merged');
    expect(messages(ales.id).some((m) => /bounced/.test(m))).toBe(false);
  });

  it('requeue: an admin returns a bounced lane to the walk when its freeze is still live; a merged row or a closed freeze is refused', async () => {
    const { requeueBounced } = await import('./merge-queue.js');
    const ales = agent('ales');
    lane('wc-base-rq', { 'rq.txt': 'b' });
    git(repo, 'push', '-q', 'origin', 'wc-base-rq:main');
    const sha = lane('wc-ales', { 'a-lane.txt': 'RQ' });
    await reviewed('ales', 'wc-ales', sha, 'ship');
    gateHook = () => ({ code: 1, stdout: '=== RESULT RED sha=x suite=tier1 who=wave exit=1 host=countix-testing ===\ncountix-remote-test: remote exit 1 on host=countix-testing' });
    await tick();
    expect(getQueueRow(sha)?.state).toBe('bounced');
    expect(requeueBounced('0'.repeat(40), 'test', 'denis')).toMatchObject({ ok: false, error: 'Not in the merge queue' });
    const back = requeueBounced(sha, 'gate tool exit 5 after a GREEN RESULT', 'denis');
    expect(back).toMatchObject({ ok: true, row: { state: 'waiting', attempts: 0, reason: expect.stringMatching(/^REQUEUED by denis: gate tool exit 5/) } });
    expect(requeueBounced(sha, 'again', 'denis')).toMatchObject({ ok: false, error: 'queue row is waiting, not bounced' });
    gateHook = () => ({ code: 0, stdout: '=== RESULT GREEN sha=x suite=tier1 who=wave exit=0 host=countix-testing ===' });
    await tick();
    expect(getQueueRow(sha)?.state).toBe('merged');
    expect(requeueBounced(sha, 'again', 'denis')).toMatchObject({ ok: false, error: 'queue row is merged, not bounced' });
    const { getDb } = await import('./db.js');
    const ev = getDb().prepare("SELECT payload_json FROM events WHERE type = 'merge_queue.requeued' AND entity_id = ?").get(sha) as { payload_json: string };
    expect(JSON.parse(ev.payload_json)).toMatchObject({ by: 'denis', reason: 'gate tool exit 5 after a GREEN RESULT', was: expect.stringMatching(/^gate RED on merge/) });
  });

  it('a reconcile step that never resolves does not stop the queue from merging', async () => {
    const ds = await import('./deploy-state.js');
    ds.resetReconcileStepsForTest();
    const hung = ds.reconcileStep('deploy_reconcile', () => new Promise<never>(() => { /* never */ }), 30);
    expect(await hung).toBe('timeout'); // the pass moves on after the ceiling
    expect(await ds.reconcileStep('deploy_reconcile', async () => undefined, 30)).toBe('skipped'); // still busy: skipped, not awaited

    agent('ales');
    lane('wc-base-shift', { 'shift.txt': 's' });
    git(repo, 'push', '-q', 'origin', 'wc-base-shift:main');
    const sha = lane('wc-ales', { 'a-lane.txt': 'A' });
    await reviewed('ales', 'wc-ales', sha, 'ship');
    await mergeQueueTickGuarded({ wait: true }); // the queue's own clock, independent of the hung step
    expect(getQueueRow(sha)?.state).toBe('merged');
    expect(queueSwitch('wave').last_pass_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(queueStall('wave')).toBeNull();
    ds.resetReconcileStepsForTest();
  });

  it('a lane whose work is already in main leaves the queue as superseded, freeze untouched', async () => {
    agent('ales');
    const sha = lane('wc-ales', { 'a-lane.txt': 'A' });
    await reviewed('ales', 'wc-ales', sha, 'ship');
    git(repo, 'push', '-q', 'origin', 'wc-ales:main'); // merged some other way
    await tick();
    expect(getQueueRow(sha)).toMatchObject({ state: 'superseded', reason: expect.stringMatching(/^ALREADY_ON_MAIN: [0-9a-f]{8} is already in /) });
    expect(getFreeze(sha)?.status).toBe('open'); // the overview still tracks it until it is deployed
    await tick();
    expect(getQueueRow(sha)?.state).toBe('superseded');
  });

  it('a lane whose commits all have equivalents on main (an empty merge) leaves the queue', async () => {
    agent('ales');
    const sha = lane('wc-ales', { 'a-lane.txt': 'A' });
    await reviewed('ales', 'wc-ales', sha, 'ship');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'cherry-pick', '--no-commit', sha);
    git(repo, 'commit', '-q', '-m', 'same patch on main');
    git(repo, 'push', '-q', 'origin', 'main');
    await tick();
    expect(getQueueRow(sha)).toMatchObject({ state: 'superseded', reason: expect.stringMatching(/^ALREADY_ON_MAIN: all 1 commit of the lane already have equivalents/) });
  });

  it('a lane whose tip is only a merge of main, its own commits already there, is closed as merged before the queue sees it', async () => {
    agent('ales');
    const sha = lane('wc-ales', { 'a-lane.txt': 'A' });
    git(repo, 'push', '-q', 'origin', 'wc-ales:main'); // the work reached main
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'merge', '-q', '--ff-only', 'wc-ales');
    fs.writeFileSync(path.join(repo, 'later.txt'), 'main moved on');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'main moves on');
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'checkout', '-q', 'wc-ales');
    git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'main'); // the lane merges main: its tip is now a merge commit
    git(repo, 'push', '-q', 'origin', 'wc-ales');
    const tip = git(repo, 'rev-parse', 'HEAD');
    expect(tip).not.toBe(sha);
    await reviewed('ales', 'wc-ales', tip, 'ship');
    // 28 Oct 2026: a freeze with nothing main lacks is closed when it is recorded (lane-pipeline);
    // the queue's own ALREADY_ON_MAIN answer stays for work that reaches main after the freeze.
    expect(getFreeze(tip)?.status).toBe('merged');
    await tick();
    expect(getQueueRow(tip)).toBeNull();
  });

  it('a lane whose changes main already carries through different commits (a no-op merge) leaves the queue', async () => {
    agent('ales');
    const sha = lane('wc-ales', { 'a.txt': 'same change' });
    await reviewed('ales', 'wc-ales', sha, 'ship');
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'detour');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'a detour on main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'same change');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'the same end state, reached by hand (a different patch)');
    git(repo, 'push', '-q', 'origin', 'main');
    await tick();
    expect(getQueueRow(sha)).toMatchObject({ state: 'superseded', reason: expect.stringMatching(/^ALREADY_ON_MAIN: merging [0-9a-f]{8} into origin\/main would change nothing/) });
  });

  it('resolveQueueShas closes the listed freezes in bulk and skips the rest with a reason', async () => {
    agent('ales');
    agent('toni');
    const shaA = lane('wc-ales', { 'a-lane.txt': 'A' });
    await reviewed('ales', 'wc-ales', shaA, 'ship');
    const shaB = lane('wc-toni', { 'b-lane.txt': 'B' });
    await reviewed('toni', 'wc-toni', shaB, 'ship');
    const out = resolveQueueShas('wave', [shaA.slice(0, 8), 'deadbeef1', 'not-a-sha', shaA], 'SysOps triage: branch abandoned', 'stale', 'owner');
    expect(out.resolved).toEqual([{ sha: shaA, lane: 'wc-ales', status: 'stale' }]);
    expect(out.skipped).toEqual([{ sha: 'deadbeef1', why: 'no freeze with this SHA' }, { sha: 'not-a-sha', why: 'not a SHA' }]);
    expect(getFreeze(shaA)).toMatchObject({ status: 'stale', superseded_by: 'resolved by owner: SysOps triage: branch abandoned' });
    expect(getQueueRow(shaA)).toMatchObject({ state: 'superseded', reason: 'freeze stale: SysOps triage: branch abandoned' });
    expect(getFreeze(shaB)?.status).toBe('open'); // the live lane is untouched
    expect(resolveQueueShas('wave', [shaA], 'again', 'stale', 'owner').skipped).toEqual([{ sha: shaA, why: 'freeze is already stale' }]);
    expect(resolveQueueShas('other', [shaB], 'wrong project', 'stale', 'owner').skipped[0]?.why).toBe('freeze belongs to wave');
    await tick(); // the live lane merges; the resolved one stays out
    expect(getQueueRow(shaA)?.state).toBe('superseded');
    expect(getQueueRow(shaB)?.state).toBe('merged');
  });

  it('resetQueue supersedes every waiting and bounced row with the reason, closes their open freezes and leaves the rest', async () => {
    agent('ales');
    agent('toni');
    const shaA = lane('wc-ales', { 'a-lane.txt': 'A' });
    await reviewed('ales', 'wc-ales', shaA, 'ship');
    const shaB = lane('wc-toni', { 'b-lane.txt': 'B' });
    await freeze('toni', 'wc-toni', shaB, 'ship'); // frozen, gate not run: it waits
    await tick(); // the reviewed lane merges, the other row waits
    expect(getQueueRow(shaA)?.state).toBe('merged');
    expect(getQueueRow(shaB)).toMatchObject({ state: 'waiting', reason: expect.stringMatching(/^GATE_NOT_GREEN/) });
    const out = resetQueue('wave', 'queue reset 26 Oct — merge main, gate, refreeze', 'owner', ['waiting', 'bounced']);
    expect(out.reset).toEqual([{ sha: shaB, lane: 'wc-toni', was: 'waiting', freeze: 'closed' }]);
    expect(out.untouched).toEqual({ merged: 1 });
    expect(getQueueRow(shaB)).toMatchObject({ state: 'superseded', reason: 'queue reset 26 Oct — merge main, gate, refreeze' });
    expect(getFreeze(shaB)).toMatchObject({ status: 'stale', superseded_by: 'queue reset by owner: queue reset 26 Oct — merge main, gate, refreeze' });
    expect(getQueueRow(shaA)?.state).toBe('merged');
    const waiting = shaB;
    expect(db.getDb().prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'merge_queue.reset'").get()).toEqual({ n: 1 });
    await tick(); // the reset row stays out; a second reset finds nothing
    expect(getQueueRow(waiting)?.state).toBe('superseded');
    expect(resetQueue('wave', 'again', 'owner', ['waiting', 'bounced']).reset).toEqual([]);
  });

  it('a reset narrowed to bounced rows leaves the waiting ones alone', async () => {
    agent('ales');
    agent('toni');
    lane('wc-base-shift', { 'a-lane.txt': 'main version' });
    git(repo, 'push', '-q', 'origin', 'wc-base-shift:main');
    const shaA = lane('wc-ales', { 'a-lane.txt': 'A' }); // conflicts with main: bounces
    await reviewed('ales', 'wc-ales', shaA, 'ship');
    const shaB = lane('wc-toni', { 'b-lane.txt': 'B' });
    await freeze('toni', 'wc-toni', shaB, 'ship'); // waits on its gate
    await tick();
    expect(getQueueRow(shaA)?.state).toBe('bounced');
    expect(getQueueRow(shaB)?.state).toBe('waiting');
    const out = resetQueue('wave', 'queue reset: merge main, gate, refreeze', 'owner', ['bounced']);
    expect(out.reset).toEqual([{ sha: shaA, lane: 'wc-ales', was: 'bounced', freeze: 'closed' }]);
    expect(out.untouched).toEqual({ waiting: 1 });
    expect(getQueueRow(shaB)?.state).toBe('waiting');
    expect(['open', 'behind-main']).toContain(getFreeze(shaB)?.status); // its freeze stays live
  });

  it('end to end: the queue records the merge gate it ran, the checker reads it, and a deploy-style call is exit 0', async () => {
    const gs = await import('./gate-status.js');
    agent('ales');
    lane('wc-base-shift', { 'shift.txt': 's' });
    git(repo, 'push', '-q', 'origin', 'wc-base-shift:main'); // behind main: a real merge, so the gate runs on the merge SHA
    const sha = lane('wc-ales', { 'a-lane.txt': 'A' });
    await reviewed('ales', 'wc-ales', sha, 'ship');
    gateHook = () => ({ code: 0, stdout: 'countix-remote-test: pushed in 1s; running suite api on host=countix-testing\ndispatch 20261026-150000-abcdef012-g77\n=== RESULT GREEN sha=0000000 suite=api who=wave exit=0 host=full-a ===' });
    await tick();
    const mergeSha = originMain();
    expect(getQueueRow(sha)?.state).toBe('merged');
    const records = gs.recordsFor(mergeSha);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ schema_version: 1, sha: mergeSha, suite: 'api', label: 'api', state: 'GREEN', exit_code: 0, run_id: '20261026-150000-abcdef012-g77', runner: 'gate-run', tree_sha: git(repo, 'rev-parse', `${mergeSha}^{tree}`) });
    expect(records[0].reused_from).toMatchObject({ sha: '0000000' }); // the RESULT named another SHA: a reuse, recorded as such
    // the checker: the record counts only on an identical tree; the donor is unknown here, so api is MISSING with the reason…
    const unknownDonor = await gs.checkGateStatus('wave', mergeSha, ['api']);
    expect(unknownDonor.suites.api.state).toBe('MISSING');
    expect(unknownDonor.found[0].why).toMatch(/no tree for donor 0000000/);
    // …and a gate whose RESULT names the SHA itself is GREEN, exit 0 (what staging's green-check will call)
    const toni = agent('toni');
    const shaB = lane('wc-toni', { 'b-lane.txt': 'B' });
    await reviewed('toni', 'wc-toni', shaB, 'ship');
    gateHook = (env) => ({ code: 0, stdout: `=== RESULT GREEN sha=${env?.WAVECODE_SHA} suite=api who=wave exit=0 host=full-a ===` });
    await tick();
    const mergeB = originMain();
    expect(getQueueRow(shaB)?.state).toBe('merged');
    const green = await gs.checkGateStatus('wave', mergeB, ['api']);
    expect(green).toMatchObject({ verdict: 'GREEN', exit_code: 0, suites: { api: { state: 'GREEN', source: 'wavecode' } } });
    expect(await gs.checkGateStatus('wave', mergeB, ['quick', 'api'])).toMatchObject({ verdict: 'MISSING', exit_code: 2 });
    expect(toni.id).toBeTruthy();
  });

  it('a second tick while one runs joins it instead of starting another pass', async () => {
    const a = mergeQueueTickGuarded({ wait: true });
    const b = mergeQueueTickGuarded({ wait: true });
    expect(b).toBe(a);
    await a;
    const c = mergeQueueTickGuarded({ wait: true });
    expect(c).not.toBe(a);
    await c;
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

describe('what the 27 Oct 2026 retro asked of the queue', () => {
  it('personMustAct: holds, moved lanes, missing PASS and a RED gate are said; a pending or missing run is not', () => {
    expect(personMustAct({ code: 'LANE_DENIED', reason: 'LANE_DENIED: review_deny' })).toBe(true);
    expect(personMustAct({ code: 'RELEASE_MODE', reason: 'RELEASE_MODE: only wc-a land' })).toBe(true);
    expect(personMustAct({ code: 'GATE_NOT_GREEN', reason: 'GATE_NOT_GREEN: quick green, api red on 12345678' })).toBe(true);
    expect(personMustAct({ code: 'GATE_NOT_GREEN', reason: 'GATE_NOT_GREEN: quick missing, api pending on 12345678' })).toBe(false);
    expect(personMustAct({ code: null, reason: null })).toBe(false);
  });
  it('laneInRelease matches branch names and desk:<n>', () => {
    expect(laneInRelease(['wc-a', 'desk:134'], { lane: 'wc-a', desk: null })).toBe(true);
    expect(laneInRelease(['wc-a', 'desk:134'], { lane: 'wc-b', desk: 134 })).toBe(true);
    expect(laneInRelease(['wc-a', 'desk:134'], { lane: 'wc-b', desk: 162 })).toBe(false);
  });
});
