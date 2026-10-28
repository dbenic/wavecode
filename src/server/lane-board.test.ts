/**
 * GET /api/reviews reads a cached lane board. Git runs on the refresher,
 * once per (lane tip, main tip), not once per lane per request.
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

const projects: Record<string, { repo?: string; workspace_match?: string; lane_glob?: string }> = {};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => ({ projects, paths: {}, artifacts: { storage: '' }, review: {}, releases: {} })) }));

import { setFetchDisabledForTest } from './release-freezes.js';
import { ensureReleaseTables } from './releases.js';
import { resetLaneGitCacheForTest } from './lane-main.js';
import { gitRun, resetGitMemoForTest, setGitExecForTest, type GitResult } from './git-memo.js';
import { lanesForRequest, refreshLaneBoard, resetLaneBoardForTest } from './dev-lanes.js';
import * as db from './db.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const calls: string[][] = [];

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
}

function realGit(repo: string, args: string[], timeout: number): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, ...args], { timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const code = err ? (err as NodeJS.ErrnoException).code : 0;
      const status = typeof code === 'number' ? code : null;
      const text = String(stdout ?? '').trim();
      resolve({ stdout: text || (status === 0 ? '' : null), status });
    });
  });
}

describe('review lane board', () => {
  let tmp: string;
  let repo: string;

  beforeEach(() => {
    calls.length = 0;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-board-'));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    db.initDb(path.join(tmp, 't.db'));
    projects.demo = { repo, workspace_match: '**/*', lane_glob: 'wc-*' };
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
    for (const lane of ['wc-a', 'wc-b']) {
      git(repo, 'checkout', '-q', '-B', lane, base);
      fs.writeFileSync(path.join(repo, `${lane}.txt`), lane);
      git(repo, 'add', '.');
      git(repo, 'commit', '-q', '-m', lane);
      git(repo, 'update-ref', `refs/remotes/origin/${lane}`, git(repo, 'rev-parse', 'HEAD'));
    }
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'm');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main moved');
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
  });

  afterEach(() => {
    resetLaneBoardForTest();
    resetLaneGitCacheForTest();
    resetGitMemoForTest();
    setFetchDisabledForTest(false);
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete projects.demo;
  });

  function heavy(args: string[]): boolean {
    return args.includes('merge-base') || args.includes('diff') || args.includes('rev-list');
  }

  it('caches lane facts and does not run git per lane on the request', async () => {
    const first = await refreshLaneBoard();
    expect(first.map((lane) => lane.lane).sort()).toEqual(['wc-a', 'wc-b']);
    expect(first.every((lane) => /behind main/.test(lane.status_line))).toBe(true);
    expect(calls.filter(heavy).length).toBeGreaterThan(0);
    const lines = first.map((lane) => `${lane.lane}:${lane.status_line}`);

    const beforeSecond = calls.length;
    const second = await refreshLaneBoard();
    const again = calls.slice(beforeSecond);
    expect(again.filter(heavy)).toEqual([]);
    expect(second.map((lane) => `${lane.lane}:${lane.status_line}`)).toEqual(lines);

    const beforeRequest = calls.length;
    const served = await lanesForRequest();
    expect(calls.length).toBe(beforeRequest);
    expect(served.map((lane) => `${lane.lane}:${lane.status_line}`)).toEqual(lines);
  });

  it('reads each lane tip once per pass, deployed lanes included (the overlap check used to ask per lane x release)', async () => {
    ensureReleaseTables();
    const tipA = git(repo, 'rev-parse', 'refs/remotes/origin/wc-a');
    const tipB = git(repo, 'rev-parse', 'refs/remotes/origin/wc-b');
    const ins = db.getDb().prepare("INSERT INTO release_requests (id, project, sha, lane, target, origin, status, deployed_sha) VALUES (?, 'demo', ?, ?, 'staging', 'local', 'deployed', ?)");
    for (let i = 0; i < 6; i++) ins.run(`rel-a-${i}`, tipA, 'wc-a', tipA);
    for (let i = 0; i < 6; i++) ins.run(`rel-b-${i}`, tipB, 'wc-b', tipB);
    calls.length = 0;
    await refreshLaneBoard();
    const tipReads = calls.filter((args) => args[0] === 'rev-parse' && args.includes('--verify') && /refs\/remotes\/origin\/wc-/.test(args[args.length - 1]));
    const perLane = new Map<string, number>();
    for (const args of tipReads) perLane.set(args[args.length - 1], (perLane.get(args[args.length - 1]) ?? 0) + 1);
    expect([...perLane.values()].every((n) => n === 1)).toBe(true);
    expect(perLane.size).toBe(2);
  });

  it('fetches at most once per refresh and gives up inside the request budget', async () => {
    setFetchDisabledForTest(false);
    await refreshLaneBoard();
    const fetches = calls.filter((args) => args.includes('fetch'));
    expect(fetches.length).toBeLessThanOrEqual(1);
    calls.length = 0;
    await refreshLaneBoard();
    expect(calls.filter((args) => args.includes('fetch'))).toEqual([]);

    resetLaneBoardForTest();
    resetGitMemoForTest();
    setGitExecForTest(() => new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ stdout: null, status: 1 }), 10_000);
      timer.unref();
    }));
    const started = Date.now();
    const cold = await lanesForRequest();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(cold).toEqual([]);
    expect(typeof gitRun).toBe('function');
  });
});
