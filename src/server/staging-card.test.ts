/**
 * The review card uses the deploy box's staging tip for the forward check,
 * and reads GREEN / RED from the freeze note when the test status command
 * does not already name that SHA.
 */

import { execFile } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })), sendRawKeys: vi.fn(() => ({ ok: true })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined) }));

const projects: Record<string, Record<string, unknown>> = {};
const peers: Record<string, { url: string; token: string; agents?: string[] }> = {};
const releasesCfg: { staging_health_command?: string[]; deploy_agent?: string } = {};
vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ projects, peers, releases: releasesCfg, paths: {}, artifacts: { storage: '' }, review: {} })),
}));

import { setFetchDisabledForTest } from './release-freezes.js';
import { parseNoteChecks, viewShaChecks } from './release-freezes.js';
import { promoteFullBlock, requestRelease, resetStagingTipCacheForTest, resolveStagingTip, stageGateBlock } from './releases.js';
import { resetForwardMemoForTest, stagingForwardBlock } from './staging-forward.js';
import { setGitExecForTest, type GitResult } from './git-memo.js';
import { refreshLaneBoard, resetLaneBoardForTest } from './dev-lanes.js';
import { setPeerFetchForTest } from './peers.js';
import { setTestRunExecForTest } from './test-runs.js';
import * as db from './db.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const SHA = '2431f684b9e960b84e73a4e98b5068869664ffb4';
const OTHER = 'e65a2ab5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function note(body: string): string {
  return `# Desk #7 freeze note\n\nProject: demo · Author: ales\n- Lane: \`wc-a\`\n- Freeze SHA: \`${SHA}\`\n${body}\n`;
}

describe('freeze note checks', () => {
  const lane = { project: 'demo', sha: SHA, lane: 'wc-a', gate: null as string | null, freeze_path: null as string | null };

  afterEach(() => {
    setTestRunExecForTest(null);
    delete projects.demo;
  });

  it('reads RESULT / GATE / quick lines only when they name this SHA or the note is for it', () => {
    expect(parseNoteChecks(note('- RESULT GREEN'), SHA)).toEqual({ quick: null, full: 'green' });
    expect(parseNoteChecks(note('- RESULT: RED'), SHA).full).toBe('red');
    expect(parseNoteChecks(note('- GATE GREEN'), SHA).full).toBe('green');
    expect(parseNoteChecks(note('- quick check GREEN'), SHA)).toEqual({ quick: 'green', full: null });
    expect(parseNoteChecks(note('- tier1 RED'), SHA)).toEqual({ quick: 'red', full: null });
    expect(parseNoteChecks(note(`- RESULT GREEN sha=${OTHER}`), SHA).full).toBeNull();
    expect(parseNoteChecks(`# freeze\n- Freeze SHA: \`${OTHER}\`\nRESULT GREEN\n`, SHA).full).toBeNull();
    expect(parseNoteChecks(`# freeze\n- Freeze SHA: \`${OTHER}\`\nRESULT: GREEN sha=${SHA}\n`, SHA).full).toBe('green');
    expect(parseNoteChecks(note(`- RESULT GREEN ${SHA.slice(0, 8)}`), SHA).full).toBe('green');
    expect(parseNoteChecks(note('- RESULT GREEN or RED'), SHA).full).toBeNull();
  });

  it('rejects a result line that also names another SHA', () => {
    const prefix = SHA.slice(0, 8);
    expect(parseNoteChecks(note(`- RESULT GREEN sha=${OTHER} ${prefix}`), SHA).full).toBeNull();
    expect(parseNoteChecks(note(`- RESULT GREEN sha=${OTHER} (rebased onto ${prefix})`), SHA).full).toBeNull();
    expect(parseNoteChecks(note(`- GATE GREEN ${OTHER.slice(0, 7)} ${SHA.slice(0, 7)}`), SHA).full).toBeNull();
    expect(parseNoteChecks(note(`- quick check GREEN ${prefix} ${OTHER.slice(0, 7)}`), SHA).quick).toBeNull();
    expect(parseNoteChecks(note(`- RESULT GREEN ${SHA.slice(0, 7)}`), SHA).full).toBe('green');
  });

  it('does not keep a stored GREEN when the note for this SHA is missing or conflicting', async () => {
    const file = path.join(os.tmpdir(), `wc-stale-${SHA.slice(0, 8)}.md`);
    projects.demo = { workspace_match: '**/*', tests: { status_command: ['status', '{sha}'] } };
    setTestRunExecForTest(() => JSON.stringify({ v: 1, runs: [] }));
    fs.writeFileSync(file, note(`- RESULT GREEN sha=${OTHER} ${SHA.slice(0, 8)}`));
    const conflicting = { ...lane, gate: 'GREEN', freeze_path: file };
    expect((await viewShaChecks(conflicting))).toMatchObject({ full: 'missing', gate: null });
    expect((await promoteFullBlock(conflicting))).toMatch(/needs green full gate/);

    fs.writeFileSync(file, note('- reviewed, no result on this SHA'));
    const missing = { ...lane, gate: 'GREEN', freeze_path: file };
    expect((await viewShaChecks(missing))).toMatchObject({ full: 'missing', gate: null });
    expect((await promoteFullBlock(missing))).toMatch(/needs green full gate/);

    expect((await viewShaChecks({ ...lane, gate: 'GREEN', freeze_path: null })).gate).toBe('GREEN');
    fs.rmSync(file, { force: true });
  });

  it('prefers a status command that names the SHA, and keeps quick and full apart', async () => {
    const file = path.join(os.tmpdir(), `wc-note-${SHA.slice(0, 8)}.md`);
    fs.writeFileSync(file, note('- RESULT RED\n- quick check RED'));
    projects.demo = { workspace_match: '**/*', tests: { status_command: ['status', '{sha}'] } };
    setTestRunExecForTest(() => JSON.stringify({
      v: 1,
      runs: [{ id: 'q1', sha: SHA, state: 'pass', kind: 'dev', suite: 'quick', who: 'wave.h.wc-a' }],
    }));
    const view = (await viewShaChecks({ ...lane, freeze_path: file }));
    expect(view.quick).toBe('green');
    expect(view.full).toBe('red');
    expect(view.gate).toBe('RED');
    expect((await stageGateBlock({ ...lane, freeze_path: file }))).toBeNull();
    expect((await promoteFullBlock({ ...lane, freeze_path: file }))).toMatch(/needs green full gate/);

    setTestRunExecForTest(() => JSON.stringify({
      v: 1,
      runs: [{ id: 'g1', sha: SHA, state: 'pass', kind: 'gate', suite: 'full' }],
    }));
    const full = (await viewShaChecks({ ...lane, freeze_path: file }));
    expect(full.full).toBe('green');
    expect(full.gate).toBe('GREEN');
    expect((await promoteFullBlock({ ...lane, freeze_path: file }))).toBeNull();
    fs.rmSync(file, { force: true });
  });

  it('a quick GREEN in the note stages, and only a full GREEN promotes', async () => {
    const file = path.join(os.tmpdir(), `wc-quick-${SHA.slice(0, 8)}.md`);
    fs.writeFileSync(file, note('- quick check: GREEN'));
    const row = { ...lane, freeze_path: file };
    expect((await stageGateBlock(row))).toBeNull();
    expect((await promoteFullBlock(row))).toMatch(/needs green full gate/);
    fs.writeFileSync(file, note('- RESULT GREEN'));
    expect((await stageGateBlock(row))).toBeNull();
    expect((await promoteFullBlock(row))).toBeNull();
    expect((await viewShaChecks(row)).gate).toBe('GREEN');
    fs.rmSync(file, { force: true });
  });
});

describe('staging tip on the card', () => {
  let tmp: string;
  let repo: string;
  const calls: string[][] = [];
  let fetches = 0;

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
  }

  function realGit(root: string, args: string[], timeout: number): Promise<GitResult> {
    return new Promise((resolve) => {
      execFile('git', ['-C', root, ...args], { timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        const code = err ? (err as NodeJS.ErrnoException).code : 0;
        const status = typeof code === 'number' ? code : null;
        const text = String(stdout ?? '').trim();
        resolve({ stdout: text || (status === 0 ? '' : null), status });
      });
    });
  }

  beforeEach(() => {
    calls.length = 0;
    fetches = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-forward-card-'));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    db.initDb(path.join(tmp, 't.db'));
    setFetchDisabledForTest(true);
    setGitExecForTest(async (root, args, timeout) => {
      calls.push(args);
      return realGit(root, args, timeout);
    });
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', '-B', 'wc-a', base);
    fs.writeFileSync(path.join(repo, 'lane.txt'), 'lane');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'lane');
    const laneSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/wc-a', laneSha);
    git(repo, 'checkout', '-q', '-B', 'staging', base);
    fs.writeFileSync(path.join(repo, 's.txt'), 's1');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'staging 1');
    fs.writeFileSync(path.join(repo, 's2.txt'), 's2');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'staging 2');
    const stagingSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'update-ref', 'refs/remotes/origin/main', base);
    projects.demo = { repo, workspace_match: '**/*', lane_glob: 'wc-*', release_peer: 'deploy/fable' };
    peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789', agents: ['fable'] };
    setPeerFetchForTest(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/releases/staging-tip') {
        fetches += 1;
        return Response.json({ sha: stagingSha, version: '1.4.0', lane: 'wc-ship' });
      }
      return Response.json({ id: 'R000000000000000000000001', status: 'sent' }, { status: 201 });
    });
  });

  afterEach(() => {
    resetLaneBoardForTest();
    resetForwardMemoForTest();
    resetStagingTipCacheForTest();
    setGitExecForTest(null);
    setPeerFetchForTest(null);
    setFetchDisabledForTest(false);
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete projects.demo;
    delete peers.deploy;
    delete releasesCfg.staging_health_command;
    delete releasesCfg.deploy_agent;
  });

  function heavy(args: string[]): boolean {
    return args.includes('merge-base') || args.includes('rev-list') || args.includes('diff');
  }

  it('disables Stage from the peer tip and does not re-run git for the same pair', async () => {
    const first = await refreshLaneBoard();
    expect(first.map((lane) => lane.lane)).toEqual(['wc-a']);
    expect(first[0].stage_block).toMatch(/would roll staging back: .*missing \d+ commits now on staging/);
    expect(first[0].status_line).toBe(first[0].stage_block);
    expect(fetches).toBe(1);
    const before = calls.filter(heavy).length;
    expect(before).toBeGreaterThan(0);
    const second = await refreshLaneBoard();
    expect(second[0].stage_block).toBe(first[0].stage_block);
    expect(calls.filter(heavy).length).toBe(before);
    expect(fetches).toBe(1);
  });

  it('keeps Stage enabled and says the tip is unknown when the peer is down', async () => {
    setPeerFetchForTest(async () => { throw new Error('down'); });
    const lanes = await refreshLaneBoard();
    expect(lanes[0].status_line).toMatch(/staging tip unknown/);
    expect(lanes[0].stage_block).toBeNull();
  });

  it('asks the peer even when a local health command is set, because releases are forwarded', async () => {
    releasesCfg.staging_health_command = ['true'];
    resetStagingTipCacheForTest();
    const lanes = await refreshLaneBoard();
    expect(fetches).toBe(1);
    expect(lanes[0].stage_block).toMatch(/would roll staging back: .*missing \d+ commits now on staging/);
  });

  it('uses the health command and does not ask a peer when this box deploys the release', async () => {
    delete projects.demo.release_peer;
    releasesCfg.staging_health_command = ['true'];
    releasesCfg.deploy_agent = 'fable';
    resetStagingTipCacheForTest();
    await refreshLaneBoard();
    expect(fetches).toBe(0);
  });

  it('caches a failed peer ask for 5 seconds and a successful one for 15', async () => {
    const start = 1_700_000_000_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      setPeerFetchForTest(async () => { fetches += 1; throw new Error('down'); });
      expect((await resolveStagingTip('demo')).state).toBe('unknown');
      now.mockReturnValue(start + 4_999);
      await resolveStagingTip('demo');
      expect(fetches).toBe(1);
      now.mockReturnValue(start + 5_000);
      await resolveStagingTip('demo');
      expect(fetches).toBe(2);

      fetches = 0;
      resetStagingTipCacheForTest();
      now.mockReturnValue(start);
      const stagingSha = git(repo, 'rev-parse', 'HEAD');
      setPeerFetchForTest(async (input, init) => {
        fetches += 1;
        const url = new URL(String(input));
        expect(url.searchParams.get('local')).toBe('1');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Response.json({ sha: stagingSha, version: '1.4.0', lane: 'wc-ship' });
      });
      expect((await resolveStagingTip('demo')).tip?.sha).toBe(stagingSha);
      now.mockReturnValue(start + 5_000);
      await resolveStagingTip('demo');
      expect(fetches).toBe(1);
      now.mockReturnValue(start + 15_000);
      await resolveStagingTip('demo');
      expect(fetches).toBe(2);
    } finally {
      now.mockRestore();
    }
  });

  it('requestRelease refuses from the peer tip even when the local record would allow it', async () => {
    const laneSha = git(repo, 'rev-parse', 'refs/remotes/origin/wc-a');
    db.insertAgent({ name: 'fable', runtime: 'claude-code', tmux_session: 'wc-fable', workspace: repo, mode: 'adopted', status: 'idle' });
    const sent = await requestRelease({ project: 'demo', sha: laneSha, lane: 'wc-a', target: 'staging', actorName: 'denis' });
    expect(sent.ok).toBe(false);
    if (!sent.ok) expect(sent.error).toMatch(/would roll staging back: .*missing \d+ commits now on staging/);
    expect(await stagingForwardBlock('demo', laneSha, { sha: laneSha, version: null, lane: null })).toBeNull();
  });
});
