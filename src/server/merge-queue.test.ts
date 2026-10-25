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
  askPathHit, askVerdicts, evaluate, getQueueRow, listQueue, mergeQueueTick, migrationCollision, prFromList, queueSwitch,
  resetMergeQueueForTest, setMergeQueueExecForTest, setQueuePriority, setQueueSwitch, tierFor, tierFromNote, type MergeQueueRow,
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
    expect(tierFor('no tier here', [], cfg, null)).toEqual({ tier: null, forced: null });
    expect(tierFor('no tier here', [], { ...cfg, default_tier: 'show' }, null)).toEqual({ tier: 'show', forced: null });
  });

  it('ask needs two PASS verdicts from non-authors on different profiles', () => {
    const v = (reviewer_name: string, profile: string | null, verdict: 'pass' | 'needs-fixes' = 'pass') => ({
      sha: 'x', reviewer_agent_id: null, reviewer_name, profile, verdict, path: `/inbox/${reviewer_name}.md`, created_at: 'now',
    });
    const author = { id: null, name: 'claude2' };
    expect(askVerdicts([v('codex3', 'pool')], author).ok).toBe(false);
    expect(askVerdicts([v('codex4', 'denis20x'), v('codex5', 'denis20x')], author).why).toMatch(/different profiles, has 1/);
    expect(askVerdicts([v('codex3', 'pool'), v('codex5', 'denis20x')], author).ok).toBe(true);
    expect(askVerdicts([v('claude2', 'pool'), v('codex5', 'denis20x')], author).ok).toBe(false);
    expect(askVerdicts([v('codex3', 'pool', 'needs-fixes'), v('codex5', 'denis20x')], author).ok).toBe(false);
    expect(askVerdicts([v('codex3', null), v('codex5', 'denis20x')], author).ok).toBe(true);
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
    expect(prFromList(json, sha, 'wc-claude2-hr')).toBe('#103');
    expect(prFromList(json, 'd'.repeat(40), 'wc-other')).toBe('#104');
    expect(prFromList(json, 'b'.repeat(40), 'wc-old')).toBeNull();
    expect(prFromList('not json', sha, 'x')).toBeNull();
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
    setMergeQueueExecForTest((argv, opts) => {
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

  async function tick(): Promise<void> {
    await mergeQueueTick({ wait: true });
  }

  it('waits for TIER, the gate, the reviews and a pull request; then queues', async () => {
    const author = agent('ales');
    agent('codex3', 'pool');
    agent('codex5', 'denis20x');
    const sha = lane('wc-ales', { 'src/payroll/run.ts': 'x' });
    await freeze('ales', 'wc-ales', sha, null);
    // A payroll path forces ask: no TIER line is needed to know the tier.
    let state = await evaluate(getFreeze(sha)!);
    expect(state).toMatchObject({ state: 'waiting', tier: 'ask', reason: expect.stringMatching(/waiting gate: quick green, api missing/) });

    await freeze('ales', 'wc-ales', sha, 'ship');
    state = await evaluate(getFreeze(sha)!);
    expect(state).toMatchObject({ state: 'waiting', tier: 'ask' });

    gateGreen(sha);
    state = await evaluate(getFreeze(sha)!);
    expect(state.reason).toMatch(/ask tier needs 2 PASS verdicts on different profiles, has 0 — ask because of src\/payroll\/run.ts/);

    await verdict('codex3', 'ales', sha);
    state = await evaluate(getFreeze(sha)!);
    expect(state.reason).toMatch(/has 1 \(@codex3\)/);

    await verdict('codex5', 'ales', sha);
    expect(listVerdicts(sha).map((v) => [v.reviewer_name, v.profile, v.verdict])).toEqual([['codex3', 'pool', 'pass'], ['codex5', 'denis20x', 'pass']]);
    mq.require_pr = true;
    state = await evaluate(getFreeze(sha)!);
    expect(state).toMatchObject({ state: 'waiting', reason: expect.stringMatching(/no pull request for wc-ales/) });

    git(bare, 'update-ref', 'refs/pull/7/head', sha);
    state = await evaluate(getFreeze(sha)!);
    expect(state).toMatchObject({ state: 'queued', tier: 'ask', pr: '#7', reason: null });
    expect(state.verdictFiles).toHaveLength(2);

    await tick();
    expect(getQueueRow(sha)).toMatchObject({ state: 'merged', pr: '#7', tier: 'ask' });
    expect(messages(author.id).some((m) => /is in the merge queue \(tier ask\)/.test(m))).toBe(true);
  });

  it('a verdict that says NEEDS FIXES holds the merge, and a moved lane tip is waited on', async () => {
    agent('ales');
    agent('codex3', 'pool');
    const sha = lane('wc-ales', { 'b.txt': 'b' });
    await freeze('ales', 'wc-ales', sha, null);
    expect((await evaluate(getFreeze(sha)!)).reason).toMatch(/no TIER line \(ship, show or ask\)/);
    mq.default_tier = 'show';
    expect((await evaluate(getFreeze(sha)!))).toMatchObject({ tier: 'show', reason: expect.stringMatching(/waiting gate/) });
    delete mq.default_tier;
    await freeze('ales', 'wc-ales', sha, 'ship');
    gateGreen(sha);
    await verdict('codex3', 'ales', sha, 'NEEDS FIXES');
    expect((await evaluate(getFreeze(sha)!)).reason).toMatch(/@codex3 said NEEDS FIXES/);

    const sha2 = lane('wc-ales', { 'c.txt': 'c' }, 'wc-ales');
    await freeze('ales', 'wc-ales', sha2, 'ship');
    gateGreen(sha2);
    lane('wc-ales', { 'd.txt': 'd' }, 'wc-ales');
    expect((await evaluate(getFreeze(sha2)!)).reason).toMatch(/lane moved to [0-9a-f]{8} after the freeze/);
  });

  it('merges two queued lanes in order; the second is merged onto the new main and re-gated on the merge SHA', async () => {
    const ales = agent('ales');
    const toni = agent('toni');
    const base = originMain();
    const shaA = lane('wc-ales', { 'a-lane.txt': 'A' });
    const shaB = lane('wc-toni', { 'b-lane.txt': 'B' });
    await freeze('ales', 'wc-ales', shaA, 'ship');
    gateGreen(shaA);
    await tick(); // A is queued and merged; B has no freeze yet
    const mainAfterA = originMain();
    expect(mainAfterA).not.toBe(base);
    expect(git(bare, 'rev-list', '--parents', '-1', 'main').split(' ')).toHaveLength(3); // a real merge commit
    expect(git(bare, 'log', '-1', '--format=%s', 'main')).toBe(`Merge wc-ales (${shaA.slice(0, 8)}) into main`);
    expect(git(bare, 'merge-base', '--is-ancestor', shaA, 'main')).toBe('');
    // same tree as the lane (lane already contained main): the gate was reused, not re-run
    expect(gateSeen).toHaveLength(0);
    expect(getQueueRow(shaA)).toMatchObject({ state: 'merged', merge_sha: mainAfterA, reason: expect.stringMatching(/gate reused/) });
    expect(messages(ales.id).some((m) => m.includes(`merged wc-ales ${shaA.slice(0, 8)} into main as ${mainAfterA.slice(0, 8)}`))).toBe(true);

    await freeze('toni', 'wc-toni', shaB, 'show');
    gateGreen(shaB);
    await tick();
    const mainAfterB = originMain();
    expect(mainAfterB).not.toBe(mainAfterA);
    expect(git(bare, 'merge-base', '--is-ancestor', shaB, 'main')).toBe('');
    expect(git(bare, 'merge-base', '--is-ancestor', mainAfterA, 'main')).toBe('');
    // B did not contain A's merge: a new tree, so the gate ran on the merge result, as the author
    expect(gateSeen).toHaveLength(1);
    expect(gateSeen[0].env).toMatchObject({ WAVECODE_SHA: mainAfterB, WAVECODE_LANE: 'wc-toni', WAVECODE_MERGE_OF: shaB, COUNTIX_REMOTE_TEST_WHO: 'toni' });
    expect(gateSeen[0].cwd).toContain(path.join('.wavecode-merges', 'wave-'));
    expect(fs.existsSync(gateSeen[0].cwd!)).toBe(false); // the checkout is removed afterwards
    expect(getQueueRow(shaB)).toMatchObject({ state: 'merged', merge_sha: mainAfterB, tier: 'show' });
    expect(messages(toni.id).some((m) => m.includes('merged wc-toni'))).toBe(true);

    const log = fs.readFileSync(mq.maestro_log as string, 'utf8').trim().split('\n');
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} CET merged wc-ales [0-9a-f]{8} -> main [0-9a-f]{8} \(tier ship\)$/);
    expect(log[1]).toMatch(/merged wc-toni .* \(tier show\)/);
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
    await freeze('ales', 'wc-ales', sha, 'ship');
    gateGreen(sha);
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

  it('a RED gate on the merge result bounces; a rejected push because main moved merges again', async () => {
    agent('ales');
    agent('toni');
    lane('wc-base-shift', { 'shift.txt': 's' });
    git(repo, 'push', '-q', 'origin', 'wc-base-shift:main');
    const sha = lane('wc-ales', { 'a-lane.txt': 'A' }); // local main is behind origin/main: the merge has a new tree, so the gate runs
    await freeze('ales', 'wc-ales', sha, 'ship');
    gateGreen(sha);
    gateHook = () => ({ code: 1, stdout: 'step api failed\nRED' });
    await tick();
    expect(getQueueRow(sha)).toMatchObject({ state: 'bounced', reason: expect.stringMatching(/gate RED on merge [0-9a-f]{8} — RED/) });

    const shaB = lane('wc-toni', { 'b-lane.txt': 'B' });
    await freeze('toni', 'wc-toni', shaB, 'ship');
    gateGreen(shaB);
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
    await freeze('ales', 'wc-ales', sha, 'ship');
    gateGreen(sha);
    const main = originMain();
    setQueueSwitch('wave', false, 'denis');
    expect(queueSwitch('wave')).toMatchObject({ project: 'wave', config_enabled: true, enabled: false, enabled_by: 'denis' });
    await tick();
    expect(originMain()).toBe(main);
    expect(getQueueRow(sha)).toBeNull();
    expect((await evaluate(getFreeze(sha)!)).reason).toBe('merge queue is off');

    setQueueSwitch('wave', true, 'denis');
    await tick();
    expect(originMain()).not.toBe(main);
    expect(getQueueRow(sha)).toMatchObject({ state: 'merged', enabled_by: 'denis' });
    expect(messages(ales.id).some((m) => m.includes('merged wc-ales'))).toBe(true);
    const switches = db.getDb().prepare("SELECT payload_json FROM events WHERE type = 'merge_queue.switch' ORDER BY id").all() as Array<{ payload_json: string }>;
    expect(switches.map((s) => JSON.parse(s.payload_json).enabled)).toEqual([false, true]);

    mq.enabled = false;
    const sha2 = lane('wc-ales', { 'k2.txt': 'k2' }, 'wc-ales');
    await freeze('ales', 'wc-ales', sha2, 'ship');
    gateGreen(sha2);
    const mainNow = originMain();
    await tick();
    expect(originMain()).toBe(mainNow);
    expect(getQueueRow(sha2)).toBeNull();
    expect(queueSwitch('wave').config_enabled).toBe(false);
  });

  it('a migration numbered at or below main bounces; a later number goes through; the version command is folded into the merge commit', async () => {
    agent('ales');
    agent('toni');
    const bad = lane('wc-ales', { 'migrations/0001_dup.sql': 'x' });
    await freeze('ales', 'wc-ales', bad, 'ask');
    gateGreen(bad);
    agent('codex3', 'pool');
    agent('codex5', 'denis20x');
    await verdict('codex3', 'ales', bad);
    await verdict('codex5', 'ales', bad);
    await tick();
    expect(getQueueRow(bad)).toMatchObject({ state: 'bounced', tier: 'ask', reason: expect.stringMatching(/0001_dup\.sql is not numbered after main's latest \(0001\)/) });

    mq.version_command = ['sh', '-c', 'echo "bumped {sha}" > VERSION'];
    const good = lane('wc-toni', { 'migrations/0002_ok.sql': 'y' });
    await freeze('toni', 'wc-toni', good, 'ask');
    gateGreen(good);
    await verdict('codex3', 'toni', good);
    await verdict('codex5', 'toni', good);
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
    await freeze('ales', 'wc-ales', shaA, 'ship');
    await freeze('toni', 'wc-toni', shaB, 'ship');
    gateGreen(shaA);
    gateGreen(shaB);
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
