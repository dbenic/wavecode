import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined) }));

const projects: Record<string, Record<string, unknown>> = {};
const releasesCfg: { deploy_agent?: string } = {};
vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({ projects, releases: releasesCfg, review: { freeze_inbox: [] }, peers: {}, paths: {}, artifacts: { storage: '' } })),
}));

import * as db from './db.js';
import { notify } from './notifications.js';
import { auditTrail, listReleases, reportRelease, requestRelease } from './releases.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
}

describe('forward-only staging', () => {
  let tmp: string;
  let repo: string;
  let older: string;
  let newer: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-forward-'));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    db.initDb(path.join(tmp, 't.db'));
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'base');
    older = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', older);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'staging moved');
    newer = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/heads/main', older);
    git(repo, 'checkout', '-q', 'main');
    projects.demo = { workspace_match: '**/*', repo };
    releasesCfg.deploy_agent = 'fable';
    db.insertAgent({ name: 'fable', runtime: 'claude-code', tmux_session: 'wc-fable', workspace: repo, mode: 'adopted', status: 'idle' });
    db.insertAgent({ name: 'ales', runtime: 'codex', tmux_session: 'wc-ales', workspace: repo, mode: 'spawned', status: 'idle' });
    vi.mocked(notify).mockClear();
  });

  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete projects.demo;
    delete releasesCfg.deploy_agent;
  });

  async function deploy(sha: string, version: string) {
    const sent = await requestRelease({ project: 'demo', sha, lane: 'wc-ales', target: 'staging', actorName: 'denis', actorIsAdmin: true });
    expect(sent.ok).toBe(true);
    if (!sent.ok) throw new Error(sent.error);
    const reported = reportRelease(sent.data.id, { status: 'deployed', sha, version, note: 'up' });
    expect(reported.ok).toBe(true);
    return sent.data.id;
  }

  it('refuses an ancestor, accepts a descendant, and audits an admin force with a reason', async () => {
    await deploy(newer, '1.4.0');
    const refused = await requestRelease({ project: 'demo', sha: older, lane: 'wc-ales', target: 'staging', actorName: 'denis', actorIsAdmin: true });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe(`would roll staging back: ${older.slice(0, 8)} is missing 1 commits now on staging (v1.4.0, wc-ales)`);
    const messages = db.listAgentMessages({ limit: 10 }).map((m) => m.message);
    expect(messages.some((m) => m.includes('Your lane wc-ales is behind main.'))).toBe(true);

    const forcedBare = await requestRelease({
      project: 'demo', sha: older, lane: 'wc-ales', target: 'staging', actorName: 'denis',
      actorIsAdmin: true, forceRollback: true,
    });
    expect(forcedBare.ok).toBe(false);
    if (!forcedBare.ok) expect(forcedBare.error).toBe('force_rollback requires a reason');

    const notAdmin = await requestRelease({
      project: 'demo', sha: older, lane: 'wc-ales', target: 'staging', actorName: 'dev',
      forceRollback: true, forceReason: 'oops',
    });
    expect(notAdmin.ok).toBe(false);
    if (!notAdmin.ok) expect(notAdmin.error).toBe('force_rollback is admin only');

    const forced = await requestRelease({
      project: 'demo', sha: older, lane: 'wc-ales', target: 'staging', actorName: 'denis',
      actorIsAdmin: true, forceRollback: true, forceReason: 'staging was bad',
    });
    expect(forced.ok).toBe(true);
    const audit = auditTrail();
    expect(audit.some((entry) => entry.action === 'rollback' && entry.detail === 'staging was bad' && entry.who === 'denis')).toBe(true);
    expect(vi.mocked(notify).mock.calls.some((call) => String(call[0]?.title ?? '').includes('rollback'))).toBe(true);

    git(repo, 'checkout', '-q', newer);
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'after staging');
    const child = git(repo, 'rev-parse', 'HEAD');
    const accepted = await requestRelease({ project: 'demo', sha: child, lane: 'wc-ales', target: 'staging', actorName: 'denis', actorIsAdmin: true });
    expect(accepted.ok).toBe(true);
  });

  it('rejects a queued staging request once staging has moved past it', async () => {
    const queued = await requestRelease({ project: 'demo', sha: older, lane: 'wc-old', target: 'staging', actorName: 'denis' });
    expect(queued.ok).toBe(true);
    if (!queued.ok) return;
    expect(queued.data.status === 'sent' || queued.data.status === 'requested').toBe(true);
    await deploy(newer, '1.5.0');
    const stale = listReleases({ sha: older, target: 'staging', limit: 5 })[0];
    expect(stale?.status).toBe('rejected');
    expect(stale?.error).toContain('would roll staging back:');
  });

  it('does not block staging when main ancestry is unknowable and nothing is deployed', async () => {
    delete projects.demo.repo;
    const sha = 'd'.repeat(40);
    const sent = await requestRelease({ project: 'demo', sha, target: 'staging', actorName: 'denis' });
    expect(sent.ok).toBe(true);
  });
});
