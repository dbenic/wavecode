import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
const projects: Record<string, Record<string, unknown>> = {};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => ({ projects, releases: { main_only: true } })) }));

import * as db from './db.js';
import { emit } from './event-bus.js';
import { GATE_RESULT_EVENT, type GateRecord } from './gate-status.js';
import { checkDeployable, formatDeployable, prodDrift, productionSha, setProductionSha } from './deployable.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
}

describe('deployable: main is the only road to prod', () => {
  let tmp: string;
  let repo: string;
  function commit(file: string, content: string): string {
    fs.writeFileSync(path.join(repo, file), content);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', file);
    return git(repo, 'rev-parse', 'HEAD');
  }
  function tree(sha: string): string { return git(repo, 'rev-parse', `${sha}^{tree}`); }
  function green(sha: string, suite: 'quick' | 'api'): void {
    const rec: GateRecord = {
      schema_version: 1, sha, tree_sha: tree(sha), suite, label: suite === 'quick' ? 'tier1' : 'api', state: 'GREEN', exit_code: 0, run_id: `r-${sha.slice(0, 6)}-${suite}`, runner: 'countix-remote-test',
      started_at: '2026-10-26T13:49:52.000Z', finished_at: '2026-10-26T13:59:00.000Z', duration_s: 548, steps: { result_line: null, tail: [] }, reused_from: null, wavecode_build: 'test',
    };
    emit(GATE_RESULT_EVENT, 'run', sha, rec, null);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-deployable-'));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    db.initDb(path.join(tmp, 't.db'));
    projects.wave = { repo, lane_glob: 'wc-*', main_remote: 'origin', main_branch: 'main' };
    git(repo, 'init', '-q', '-b', 'main');
  });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('YES only when the SHA is on main, contains what prod runs, and quick + api are GREEN on it', async () => {
    const prod = commit('a.txt', 'v1');
    const main = commit('b.txt', 'v2');
    git(repo, 'update-ref', 'refs/remotes/origin/main', main);
    // Nothing recorded about prod: NO, and the report says who records it.
    let r = await checkDeployable('wave', main);
    expect(r.deployable).toBe(false);
    expect(r.exit_code).toBe(2);
    expect(r.checks.on_main).toMatchObject({ ok: true });
    expect(r.checks.contains_prod.text).toMatch(/wavecode prod-sha/);
    expect(r.checks.quick.ok).toBe(false);
    expect(setProductionSha('wave', 'abc', 'denis')).toMatchObject({ ok: false });
    expect(setProductionSha('wave', prod, 'denis')).toEqual({ ok: true, sha: prod });
    expect(productionSha('wave')).toMatchObject({ sha: prod, source: 'recorded', by: 'denis' });
    r = await checkDeployable('wave', main);
    expect(r.checks.contains_prod).toMatchObject({ ok: true });
    expect(r.reasons).toEqual([expect.stringMatching(/^quick has no result/), expect.stringMatching(/^api has no result/)]);
    green(main, 'quick');
    green(main, 'api');
    r = await checkDeployable('wave', main);
    expect(r).toMatchObject({ deployable: true, exit_code: 0, main_sha: main, prod_sha: prod, reasons: [] });
    expect(formatDeployable(r)).toMatch(/^YES [0-9a-f]{8} deployable to production/);
    // The prod SHA itself is deployable again (equal, not behind).
    green(prod, 'quick'); green(prod, 'api');
    expect((await checkDeployable('wave', prod)).checks.contains_prod).toMatchObject({ ok: true });
    expect(await prodDrift('wave')).toBeNull();
  });

  it('NO for a SHA off main, for one behind prod (no rollback), and for an abbreviated SHA (exit 1)', async () => {
    const base = commit('a.txt', 'v1');
    const prodSha = commit('p.txt', 'prod');
    git(repo, 'checkout', '-q', '-b', 'wc-lane', base);
    const lane = commit('l.txt', 'lane');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'update-ref', 'refs/remotes/origin/main', prodSha);
    setProductionSha('wave', prodSha, 'sysops');
    green(lane, 'quick'); green(lane, 'api'); green(base, 'quick'); green(base, 'api');
    const off = await checkDeployable('wave', lane);
    expect(off.deployable).toBe(false);
    expect(off.checks.on_main.text).toMatch(/is not on origin\/main: merge it through the queue first/);
    expect(off.checks.contains_prod.ok).toBe(false);
    const behind = await checkDeployable('wave', base);
    expect(behind.checks.on_main.ok).toBe(true);
    expect(behind.checks.contains_prod.text).toMatch(/does not contain production's/);
    expect(behind.exit_code).toBe(2);
    expect((await checkDeployable('wave', lane.slice(0, 8))).exit_code).toBe(1);
    expect((await checkDeployable('wave', 'f'.repeat(40))).reasons[0]).toMatch(/is not a commit/);
  });

  it('prod drift: production on a SHA that is not on main is reported, and cleared once main contains it', async () => {
    const base = commit('a.txt', 'v1');
    git(repo, 'checkout', '-q', '-b', 'hotfix', base);
    const hot = commit('h.txt', 'hotfix');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'update-ref', 'refs/remotes/origin/main', base);
    setProductionSha('wave', hot, 'sysops');
    const drift = await prodDrift('wave');
    expect(drift).toMatchObject({ project: 'wave', prod_sha: hot, main_sha: base });
    expect(drift!.text).toMatch(/not on origin\/main: nothing is deployable until a sync lane/);
    git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'hotfix');
    git(repo, 'update-ref', 'refs/remotes/origin/main', git(repo, 'rev-parse', 'HEAD'));
    expect(await prodDrift('wave')).toBeNull();
  });
});
