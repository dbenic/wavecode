import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaveConfig } from './config.js';

vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(async () => ({ ok: true, data: undefined })) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined) }));

const projects: Record<string, { repo?: string; workspace_match?: string; lane_glob?: string }> = {};
const releasesCfg: { deploy_agent?: string } = {};
vi.mock('./config.js', () => ({
  getConfig: vi.fn(() => ({
    projects,
    releases: releasesCfg,
    paths: {},
    artifacts: { storage: '' },
    review: {},
    product_desk: {},
  })),
}));

import * as db from './db.js';
import { presentLaneSyncResult, runLaneSyncNoticesCommand } from '../cli/lane-sync-notices-command.js';
import {
  alertMerged,
  behindMainAlert,
  MAIN_PING,
  mergedMainAlert,
  pingLaneAboutMain,
  reconcileBehindFreezes,
  setLaneAlertNowForTest,
} from './lane-main.js';
import {
  getSyncNotice,
  pauseSyncNotices,
  resumeSyncNotices,
  STAGE_CLEAR_REASON,
  SYNC_NOTICE_EVENT,
  syncNoticesPaused,
} from './lane-sync-notices.js';
import { setDeskCacheForTest, resetDeskForTest, type DeskItem } from './product-desk.js';
import { ensureReleaseFreezeTable } from './release-freezes.js';
import { requestRelease } from './releases.js';
import { deliverSystemLine } from './wire-lines.js';

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const FALLBACK = 'fallback-secret';

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env }).trim();
}

function noticeEvents(): Array<{ entity_id: string; actor_id: string | null; payload_json: string }> {
  return db.getDb().prepare(
    'SELECT entity_id, actor_id, payload_json FROM events WHERE type = ? ORDER BY id',
  ).all(SYNC_NOTICE_EVENT) as Array<{ entity_id: string; actor_id: string | null; payload_json: string }>;
}

function desk(id: number, status: string): DeskItem {
  return {
    id, status, title: `Desk ${id}`, area: null, priority: null, target_version: null, source: null,
    requester_name: null, received_at: null, updated_at: null, file_count: 0, message_count: 0,
    last_agent: null, last_summary: null, merged_into_id: null,
  };
}

describe('sync notice pause', () => {
  let tmp: string;
  let repo: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sync-notices-'));
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
    setLaneAlertNowForTest(null);
    resetDeskForTest();
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete projects.wave;
    delete releasesCfg.deploy_agent;
  });

  function advanceMain(): string {
    git(repo, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(repo, 'm.txt'), `m-${Date.now()}`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'main moved');
    const mainSha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', mainSha);
    return mainSha;
  }

  it('skips behind-main and merge notices for a paused lane and still marks the freeze', async () => {
    const laneSha = git(repo, 'rev-parse', 'wc-ales');
    const mainSha = advanceMain();
    ensureReleaseFreezeTable();
    const ales = db.getAgentByName('ales');
    if (!ales.ok) throw new Error(ales.error);
    db.getDb().prepare(
      `INSERT INTO release_freezes (sha, project, lane, author_agent_id, author_name, status) VALUES (?, 'wave', 'wc-ales', ?, 'ales', 'open')`,
    ).run(laneSha, ales.data.id);
    const paused = pauseSyncNotices(['wc-ales'], 'denis', 'quiet while they land', ales.data.id);
    expect(paused.ok && paused.data).toEqual(['wc-ales']);

    expect(await pingLaneAboutMain({ lane: 'wc-ales', project: 'wave', mainSha, kind: 'moved' })).toBe(false);
    expect(await alertMerged({ lane: 'wc-ales', project: 'wave', mainSha, authorAgentId: ales.data.id, authorName: 'ales' })).toBe(false);
    await reconcileBehindFreezes();

    const status = db.getDb().prepare('SELECT status FROM release_freezes WHERE sha = ?').get(laneSha) as { status: string };
    expect(status.status).toBe('behind-main');
    const pings = db.getDb().prepare('SELECT entity_id FROM events WHERE type = ?').all(MAIN_PING);
    expect(pings).toHaveLength(0);
    const messages = db.listAgentMessages({ limit: 20 }).map((m) => m.message);
    expect(messages.some((m) => m === behindMainAlert('wc-ales'))).toBe(false);
    expect(messages.some((m) => m === mergedMainAlert('wc-ales'))).toBe(false);

    await deliverSystemLine(ales.data, 'Reviewer asked for a rename.', { kind: 'info', source: 'review' });
    const after = db.listAgentMessages({ limit: 20 }).map((m) => m.message);
    expect(after).toContain('Reviewer asked for a rename.');

    const audit = noticeEvents();
    expect(audit).toHaveLength(1);
    expect(audit[0].entity_id).toBe('wc-ales');
    expect(audit[0].actor_id).toBe(ales.data.id);
    expect(JSON.parse(audit[0].payload_json)).toMatchObject({
      action: 'pause', lane: 'wc-ales', reason: 'quiet while they land', by: 'denis',
    });
  });

  it('still damps an unpaused lane for 30 minutes', async () => {
    let now = 1_700_000_000_000;
    setLaneAlertNowForTest(() => now);
    git(repo, 'checkout', '-q', 'wc-ales');
    git(repo, 'checkout', '-q', '-b', 'wc-bora');
    fs.writeFileSync(path.join(repo, 'bora.txt'), 'bora');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'bora lane');
    git(repo, 'update-ref', 'refs/remotes/origin/wc-bora', git(repo, 'rev-parse', 'HEAD'));
    const bora = db.insertAgent({ name: 'bora', runtime: 'codex', tmux_session: 'wc-bora', workspace: repo, mode: 'spawned', status: 'idle' });
    if (!bora.ok) throw new Error(bora.error);
    const mainSha = advanceMain();
    expect(pauseSyncNotices(['wc-bora'], 'denis', 'hold bora', bora.data.id).ok).toBe(true);

    const ping = (lane: string) => pingLaneAboutMain({ lane, project: 'wave', mainSha, kind: 'moved' });
    expect(await ping('wc-ales')).toBe(true);
    expect(await ping('wc-ales')).toBe(false);
    expect(await ping('wc-bora')).toBe(false);
    now += 30 * 60 * 1000 - 1;
    expect(await ping('wc-ales')).toBe(false);
    now += 1;
    expect(await ping('wc-ales')).toBe(true);
    expect(await ping('wc-bora')).toBe(false);

    const pings = db.getDb().prepare('SELECT entity_id FROM events WHERE type = ?').all(MAIN_PING) as { entity_id: string }[];
    expect(pings.map((row) => row.entity_id)).toEqual([`wc-ales:${mainSha}`, `wc-ales:${mainSha}`]);
    const messages = db.listAgentMessages({ limit: 20 }).map((m) => m.message);
    expect(messages.filter((m) => m === behindMainAlert('wc-ales'))).toHaveLength(2);
    expect(messages.filter((m) => m === behindMainAlert('wc-bora'))).toHaveLength(0);
  });

  it('clears the pause when a Stage request is accepted, and keeps it when Stage is refused', async () => {
    const sha = git(repo, 'rev-parse', 'wc-ales');
    const deployer = db.insertAgent({ name: 'fable', runtime: 'claude-code', tmux_session: 'wc-fable', workspace: repo, mode: 'adopted', status: 'idle' });
    if (!deployer.ok) throw new Error(deployer.error);
    releasesCfg.deploy_agent = 'fable';
    expect(pauseSyncNotices(['wc-ales'], 'denis', 'quiet until stage', null).ok).toBe(true);

    const staged = await requestRelease({ project: 'wave', sha, lane: 'wc-ales', target: 'staging', actorName: 'denis', actorIsAdmin: true });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(syncNoticesPaused('wc-ales')).toBe(false);
    const cleared = noticeEvents().map((row) => JSON.parse(row.payload_json) as { action: string; by: string; reason: string; previous_reason: string });
    expect(cleared).toContainEqual(expect.objectContaining({
      action: 'stage_clear', by: 'denis', reason: STAGE_CLEAR_REASON, previous_reason: 'quiet until stage',
    }));

    expect(pauseSyncNotices(['wc-ales'], 'denis', 'quiet again', null).ok).toBe(true);
    advanceMain();
    const refused = await requestRelease({ project: 'wave', sha, lane: 'wc-ales', target: 'staging', actorName: 'denis', actorIsAdmin: true });
    expect(refused.ok).toBe(false);
    expect(syncNoticesPaused('wc-ales')).toBe(true);
    expect(getSyncNotice('wc-ales')?.reason).toBe('quiet again');
    const clears = noticeEvents().filter((row) => JSON.parse(row.payload_json).action === 'stage_clear');
    expect(clears).toHaveLength(1);
  });

  it('pauses claude1/foo, and pingLaneAboutMain skips that lane until it is resumed', async () => {
    const seat = db.insertAgent({ name: 'claude1', runtime: 'claude-code', tmux_session: 'claude1/foo', workspace: repo, mode: 'spawned', status: 'idle' });
    if (!seat.ok) throw new Error(seat.error);
    const mainSha = 'a'.repeat(40);
    expect(pauseSyncNotices(['claude1/foo'], 'denis', 'slash lane', null).ok).toBe(true);
    expect(syncNoticesPaused('claude1/foo')).toBe(true);
    expect(getSyncNotice('claude1/foo')).toMatchObject({ sync_notices_paused: 1, reason: 'slash lane' });
    expect(await pingLaneAboutMain({ lane: 'claude1/foo', project: null, mainSha, kind: 'moved', authorName: 'claude1' })).toBe(false);
    const pings = () => db.getDb().prepare('SELECT COUNT(*) AS n FROM events WHERE type = ?').get(MAIN_PING) as { n: number };
    expect(pings().n).toBe(0);
    expect(db.listAgentMessages({ limit: 10 }).some((m) => m.message === behindMainAlert('claude1/foo'))).toBe(false);

    expect(resumeSyncNotices(['claude1/foo'], 'denis', 'back', null).ok).toBe(true);
    expect(await pingLaneAboutMain({ lane: 'claude1/foo', project: null, mainSha, kind: 'moved', authorName: 'claude1' })).toBe(true);
    expect(pings().n).toBe(1);
  });
});

describe('sync notice API and CLI', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sync-api-'));
    db.resetDbForTest();
    db.initDb(path.join(tmp, 't.db'));
  });

  afterEach(() => {
    resetDeskForTest();
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function makeConfig(): WaveConfig {
    return { auth: { method: 'token', fallback_token: FALLBACK, trusted_proxies: [] } } as unknown as WaveConfig;
  }

  async function makeApp() {
    const { createAuthMiddleware } = await import('./auth.js');
    const { registerLaneRoutes } = await import('./routes/lanes.js');
    const app = new Hono<import('./auth.js').NodeAppEnv>();
    app.use('/api/*', createAuthMiddleware(() => makeConfig()));
    registerLaneRoutes(app);
    return app;
  }

  async function call(app: Hono<import('./auth.js').NodeAppEnv>, method: string, url: string, token: string, body?: unknown, form = false) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = form ? 'application/x-www-form-urlencoded' : 'application/json';
      payload = form ? new URLSearchParams(body as Record<string, string>).toString() : JSON.stringify(body);
    }
    const res = await app.request(url, { method, headers, body: payload });
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  }

  function seedLanes() {
    ensureReleaseFreezeTable();
    const ales = db.insertAgent({ name: 'ales', runtime: 'codex', tmux_session: 'wc-ales', workspace: null, mode: 'spawned', status: 'idle' });
    const bora = db.insertAgent({ name: 'bora', runtime: 'codex', tmux_session: 'wc-bora', workspace: null, mode: 'spawned', status: 'idle' });
    if (!ales.ok || !bora.ok) throw new Error('agent');
    const insert = db.getDb().prepare(
      `INSERT INTO release_freezes (sha, project, lane, desk, author_agent_id, author_name, status, created_at)
       VALUES (?, 'wave', ?, ?, ?, ?, 'open', ?)`,
    );
    insert.run('a'.repeat(40), 'wc-ales', 1, ales.data.id, 'ales', '2026-10-01 00:00:00');
    insert.run('b'.repeat(40), 'wc-ales-side', 2, ales.data.id, 'ales', '2026-10-02 00:00:00');
    insert.run('c'.repeat(40), 'wc-bora', 3, bora.data.id, 'bora', '2026-10-03 00:00:00');
    setDeskCacheForTest([desk(1, 'deferred'), desk(2, 'implementing'), desk(3, 'deferred')]);
    return { ales: ales.data.id, bora: bora.data.id };
  }

  it('refuses a non-admin and a missing reason', async () => {
    const app = await makeApp();
    const { createUser } = await import('./users.js');
    const dev = createUser({ name: 'ada' });
    if (!dev.ok) throw new Error(dev.error);

    const forbidden = await call(app, 'POST', '/api/lanes/wc-ales/sync-notices/pause', dev.data.token, { reason: 'please' });
    expect(forbidden.status).toBe(403);
    expect(getSyncNotice('wc-ales')).toBeNull();
    expect(noticeEvents()).toHaveLength(0);

    const missing = await call(app, 'POST', '/api/lanes/' + encodeURIComponent('claude1/foo') + '/sync-notices/pause', FALLBACK, {});
    const blank = await call(app, 'POST', '/api/lanes/wc-ales/sync-notices/resume', FALLBACK, { reason: '   ' });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toBe('reason is required');
    expect(blank.status).toBe(400);
    expect(blank.json.error).toBe('reason is required');
    expect(noticeEvents()).toHaveLength(0);

    const bulkForbidden = await call(app, 'POST', '/api/lanes/sync-notices/pause', dev.data.token, { lanes: ['claude1/foo'], reason: 'please' });
    expect(bulkForbidden.status).toBe(403);
    expect(getSyncNotice('claude1/foo')).toBeNull();
  });

  it('accepts claude1/foo via a %2F path and a bulk lane list, and an invalid name writes nothing', async () => {
    const app = await makeApp();
    const encoded = await call(app, 'POST', '/api/lanes/' + encodeURIComponent('claude1/foo') + '/sync-notices/pause', FALLBACK, { reason: 'path' });
    expect(encoded.status).toBe(200);
    expect(encoded.json.results).toEqual([{ lane: 'claude1/foo', status: 'paused' }]);
    expect(syncNoticesPaused('claude1/foo')).toBe(true);
    expect(getSyncNotice('claude1/foo')).toMatchObject({ paused_by: 'owner', reason: 'path', sync_notices_paused: 1 });

    const bulk = await call(app, 'POST', '/api/lanes/sync-notices/pause', FALLBACK, {
      lanes: ['claude1/bar', 'wc-ales'], reason: 'list',
    });
    expect(bulk.status).toBe(200);
    expect(bulk.json.lanes).toEqual(['claude1/bar', 'wc-ales']);
    expect(bulk.json.results).toEqual([
      { lane: 'claude1/bar', status: 'paused' },
      { lane: 'wc-ales', status: 'paused' },
    ]);
    expect(syncNoticesPaused('claude1/bar')).toBe(true);
    expect(syncNoticesPaused('wc-ales')).toBe(true);

    const missing = await call(app, 'POST', '/api/lanes/sync-notices/resume', FALLBACK, {
      lanes: ['claude1/missing'], reason: 'no row',
    });
    expect(missing.status).toBe(200);
    expect(missing.json.lanes).toEqual([]);
    expect(missing.json.results).toEqual([{ lane: 'claude1/missing', status: 'not found' }]);
    expect(getSyncNotice('claude1/missing')).toBeNull();

    const bad = await call(app, 'POST', '/api/lanes/sync-notices/pause', FALLBACK, {
      lanes: ['claude1/baz', 'bad name'], reason: 'no',
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('invalid lane name');
    expect(bad.json.results).toEqual([{ lane: 'bad name', status: 'invalid' }]);
    expect(getSyncNotice('claude1/baz')).toBeNull();
    expect(getSyncNotice('bad name')).toBeNull();
    expect(syncNoticesPaused('claude1/foo')).toBe(true);
  });

  it('posts named lanes to the bulk endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      lanes: ['claude1/foo'],
      results: [{ lane: 'claude1/foo', status: 'paused' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await runLaneSyncNoticesCommand('pause', ['claude1/foo'], { reason: 'slash' }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveConnection: () => ({ url: 'http://daemon.test', token: 't' }),
    });
    expect(result.ok && result.data).toEqual(['claude1/foo']);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://daemon.test/api/lanes/sync-notices/pause');
    expect(JSON.parse(String(init.body))).toEqual({ lanes: ['claude1/foo'], reason: 'slash' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
    expect(getSyncNotice('claude1/foo')).toBeNull();
  });

  it('bulk form pauses and resumes only that agent\'s deferred lanes', async () => {
    const { ales } = seedLanes();
    const app = await makeApp();
    const paused = await call(app, 'POST', '/api/lanes/sync-notices/pause', FALLBACK, {
      agent_id: ales, deferred: 'true', reason: 'desk is deferred',
    }, true);
    expect(paused.status).toBe(200);
    expect(paused.json.lanes).toEqual(['wc-ales']);
    expect(syncNoticesPaused('wc-ales')).toBe(true);
    expect(syncNoticesPaused('wc-ales-side')).toBe(false);
    expect(syncNoticesPaused('wc-bora')).toBe(false);
    expect(getSyncNotice('wc-ales')).toMatchObject({ paused_by: 'owner', reason: 'desk is deferred', sync_notices_paused: 1 });
    expect(noticeEvents()[0].actor_id).toBe('owner');

    expect(pauseSyncNotices(['wc-bora'], 'owner', 'bora too', 'owner').ok).toBe(true);
    const resumed = await call(app, 'POST', '/api/lanes/sync-notices/resume', FALLBACK, {
      agent_id: ales, deferred: 'true', reason: 'desk moved',
    }, true);
    expect(resumed.status).toBe(200);
    expect(resumed.json.lanes).toEqual(['wc-ales']);
    expect(syncNoticesPaused('wc-ales')).toBe(false);
    expect(syncNoticesPaused('wc-ales-side')).toBe(false);
    expect(syncNoticesPaused('wc-bora')).toBe(true);
  });

  it('writes nothing and exits 1 when the daemon is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connect ECONNREFUSED');
    });
    const result = await runLaneSyncNoticesCommand('pause', ['claude1/foo'], { reason: 'quiet' }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      resolveConnection: () => ({ url: 'http://127.0.0.1:9', token: 't' }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not reachable at http:\/\/127\.0\.0\.1:9/);
    expect(result.error).toMatch(/Nothing was changed/);
    expect(getSyncNotice('claude1/foo')).toBeNull();
    const stderr: string[] = [];
    const codes: number[] = [];
    presentLaneSyncResult(result, {
      stderr: { write: (chunk: string) => { stderr.push(chunk); } },
      exit: (code: number) => { codes.push(code); },
    });
    expect(codes).toEqual([1]);
    expect(stderr.join('')).toContain('Nothing was changed');
    expect(getSyncNotice('claude1/foo')).toBeNull();
  });

  it('--agent --deferred posts the bulk body and writes nothing locally', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      lanes: ['wc-ales'],
      results: [{ lane: 'wc-ales', status: 'paused' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const result = await runLaneSyncNoticesCommand(
      'pause',
      [],
      { agent: 'agt-1', deferred: true, reason: 'desk' },
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        resolveConnection: () => ({ url: 'http://daemon.test', token: 'secret' }),
      },
    );
    expect(result.ok && result.data).toEqual(['wc-ales']);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://daemon.test/api/lanes/sync-notices/pause');
    expect(JSON.parse(String(init.body))).toEqual({ agent_id: 'agt-1', deferred: true, reason: 'desk' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret');
    expect(getSyncNotice('wc-ales')).toBeNull();
    expect(getSyncNotice('agt-1')).toBeNull();
  });

  it('rejects mixed flags before calling the daemon', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('should not fetch');
    });
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch };
    const both = await runLaneSyncNoticesCommand('pause', ['wc-ales'], { agent: 'agt', deferred: true, reason: 'both' }, deps);
    const noFlag = await runLaneSyncNoticesCommand('pause', [], { agent: 'agt', reason: 'no flag' }, deps);
    expect(both.ok).toBe(false);
    expect(noFlag.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getSyncNotice('wc-ales')).toBeNull();
  });
});
