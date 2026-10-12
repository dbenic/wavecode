import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const projects: Record<string, { repo?: string; workspace_match?: string; lane_glob?: string }> = {};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => ({ projects, paths: {}, artifacts: { storage: '' }, review: {} })) }));

import * as db from './db.js';
import { commitsBehind, isMergeOnlyDelta, MAIN_PING, observeRepo, pingLaneAboutMain } from './lane-main.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
}

describe('lane main ancestry', () => {
  let tmp: string;
  let repo: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-lane-main-'));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    db.initDb(path.join(tmp, 't.db'));
    projects.wave = { repo, workspace_match: '**/*', lane_glob: 'wc-*' };
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', base);
    git(repo, 'checkout', '-q', '-b', 'wc-ales');
    fs.writeFileSync(path.join(repo, 'lane.txt'), 'lane');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'lane work');
    git(repo, 'update-ref', 'refs/remotes/origin/wc-ales', git(repo, 'rev-parse', 'HEAD'));
    db.insertAgent({ name: 'ales', runtime: 'codex', tmux_session: 'wc-ales', workspace: repo, mode: 'spawned', status: 'idle' });
  });

  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete projects.wave;
  });

  it('counts zero when the lane contains main, then the commits main gained', () => {
    const lane = git(repo, 'rev-parse', 'wc-ales');
    expect(commitsBehind('wave', lane)).toBe(0);
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'm');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main moved');
    const mainSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
    expect(commitsBehind('wave', lane)).toBe(1);
  });

  it('pings an author once per main SHA', () => {
    const lane = git(repo, 'rev-parse', 'wc-ales');
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'm1');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'first advance');
    const first = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', first);
    db.getDb().prepare('INSERT INTO kv_settings (key, value) VALUES (?, ?)').run('main_tip:wave', lane);
    observeRepo(repo);
    const pings = () => db.getDb().prepare('SELECT entity_id, payload_json FROM events WHERE type = ?').all(MAIN_PING) as { entity_id: string; payload_json: string }[];
    expect(pings()).toHaveLength(1);
    expect(pings()[0].entity_id).toBe(`wc-ales:${first}`);
    expect(JSON.parse(pings()[0].payload_json).kind).toBe('moved');
    const messages = db.listAgentMessages({ limit: 10 });
    expect(messages.some((m) => m.message.includes(`main moved to ${first.slice(0, 8)}`))).toBe(true);
    observeRepo(repo);
    expect(pings()).toHaveLength(1);
    expect(pingLaneAboutMain({ lane: 'wc-ales', project: 'wave', mainSha: first, kind: 'freeze' })).toBe(false);
  });

  it('treats a clean merge of main as a merge-only delta, and a further lane commit as not', () => {
    const oldSha = git(repo, 'rev-parse', 'wc-ales');
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'm.txt'), 'main-only');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main feature');
    const mainSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
    git(repo, 'checkout', '-q', 'wc-ales');
    git(repo, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-edit', '-m', 'merge main', 'origin/main');
    const merged = git(repo, 'rev-parse', 'HEAD');
    expect(isMergeOnlyDelta(repo, oldSha, merged, 'origin/main')).toBe(true);
    fs.writeFileSync(path.join(repo, 'extra.txt'), 'more');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'more lane work');
    expect(isMergeOnlyDelta(repo, oldSha, git(repo, 'rev-parse', 'HEAD'), 'origin/main')).toBe(false);
  });
});
