/**
 * A dev box that forwards releases and a deploy box with a health tip,
 * in one process. The dev box must report the peer tip and block the card
 * even when its own deployed row is a SHA the lane already contains.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const holders = vi.hoisted(() => ({
  getConfig: (): Record<string, unknown> => {
    throw new Error('config not ready');
  },
}));

vi.mock('./config.js', () => ({
  getConfig: () => holders.getConfig(),
}));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('./session-manager.js', () => ({
  sendKeys: vi.fn(() => ({ ok: true, data: undefined })),
  sendRawKeys: vi.fn(() => ({ ok: true })),
}));

import { ensureReviewTable } from './code-review.js';
import { refreshLaneBoard, resetLaneBoardForTest } from './dev-lanes.js';
import * as db from './db.js';
import logger from './logger.js';
import { setPeerFetchForTest } from './peers.js';
import { ensureReleaseFreezeTable, setFetchDisabledForTest } from './release-freezes.js';
import { currentStagingTip, ensureReleaseTables, logStagingTipSources, resetStagingTipCacheForTest, stagingTipStatuses } from './releases.js';
import { registerReleaseRoutes } from './routes/releases.js';
import { registerReviewRoutes } from './routes/reviews.js';
import { resetForwardMemoForTest } from './staging-forward.js';

const als = new AsyncLocalStorage<'dev' | 'deploy'>();
const devConfig = {
  projects: {} as Record<string, Record<string, unknown>>,
  peers: {} as Record<string, { url: string; token: string; agents?: string[] }>,
  releases: {} as { staging_health_command?: string[]; deploy_agent?: string },
  paths: {},
  artifacts: { storage: '' },
  review: {},
};
const deployConfig = {
  projects: {} as Record<string, Record<string, unknown>>,
  peers: {} as Record<string, { url: string; token: string }>,
  releases: {} as { staging_health_command?: string[]; deploy_agent?: string },
  paths: {},
  artifacts: { storage: '' },
  review: {},
};
holders.getConfig = () => (als.getStore() === 'deploy' ? deployConfig : devConfig);

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env }).trim();
}

function box(role: 'dev' | 'deploy'): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    await als.run(role, async () => { await next(); });
  });
  registerReleaseRoutes(app as never);
  registerReviewRoutes(app as never);
  return app;
}

describe('staging tip is proxied from the release peer', () => {
  let tmp: string;
  let repo: string;
  let dev: Hono;
  let deploy: Hono;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-tip-proxy-'));
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    db.initDb(path.join(tmp, 't.db'));
    ensureReleaseTables();
    ensureReleaseFreezeTable();
    ensureReviewTable();
    setFetchDisabledForTest(true);

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

    const health = path.join(tmp, 'health.cjs');
    fs.writeFileSync(health, `process.stdout.write(${JSON.stringify(stagingSha)} + '\\n');\n`);

    devConfig.projects.wavepulse = { repo, workspace_match: '**/*', lane_glob: 'wc-*', release_peer: 'deploy/fable' };
    devConfig.peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789', agents: ['fable'] };
    devConfig.releases = {};
    deployConfig.projects.wavepulse = { repo, workspace_match: '**/*' };
    deployConfig.releases = { deploy_agent: 'fable', staging_health_command: [process.execPath, health] };

    db.getDb().prepare(`INSERT INTO release_requests (id, project, sha, lane, target, origin, status, version, deployed_sha)
      VALUES ('01STALESTALESTALESTALESTALE', 'wavepulse', ?, 'wc-a', 'staging', 'local', 'deployed', '0.9.0', ?)`).run(laneSha, laneSha);

    const author = db.insertAgent({ name: 'claude2', runtime: 'claude-code', tmux_session: 'wc-a', workspace: repo, mode: 'adopted', status: 'idle' });
    if (!author.ok) throw new Error(author.error);
    const task = db.insertTask({ agent_id: author.data.id, prompt: 'freeze wc-a', created_by: null });
    if (!task.ok) throw new Error(task.error);
    const run = db.insertRun({ task_id: task.data.id, agent_id: author.data.id });
    if (!run.ok) throw new Error(run.error);
    const done = db.finishRun(run.data.id, 0);
    if (!done.ok) throw new Error(done.error);
    const otherTask = db.insertTask({ agent_id: author.data.id, prompt: 'unrelated', created_by: null });
    if (!otherTask.ok) throw new Error(otherTask.error);
    const other = db.insertRun({ task_id: otherTask.data.id, agent_id: author.data.id });
    if (!other.ok) throw new Error(other.error);
    const otherDone = db.finishRun(other.data.id, 0);
    if (!otherDone.ok) throw new Error(otherDone.error);
    db.getDb().prepare(`INSERT INTO release_freezes (sha, run_id, project, lane, author_agent_id, author_name, verdict, gate, status)
      VALUES (?, ?, 'wavepulse', 'wc-a', ?, 'claude2', 'pass', 'GREEN', 'open')`).run(laneSha, run.data.id, author.data.id);

    dev = box('dev');
    deploy = box('deploy');
    setPeerFetchForTest(async (input, init) => {
      const url = new URL(String(input));
      return deploy.fetch(new Request(`http://deploy.local${url.pathname}${url.search}`, {
        method: init?.method ?? 'GET',
        headers: init?.headers,
      }));
    });
  });

  afterEach(() => {
    resetLaneBoardForTest();
    resetForwardMemoForTest();
    resetStagingTipCacheForTest();
    setPeerFetchForTest(null);
    setFetchDisabledForTest(false);
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
    delete devConfig.projects.wavepulse;
    delete devConfig.peers.deploy;
    devConfig.releases = {};
    delete deployConfig.projects.wavepulse;
    deployConfig.releases = {};
  });

  it('the forwarding box reports the peer health tip and blocks the card', async () => {
    const laneSha = git(repo, 'rev-parse', 'refs/remotes/origin/wc-a');
    const stagingSha = git(repo, 'rev-parse', 'staging');
    expect(currentStagingTip('wavepulse')?.sha).toBe(laneSha);

    const devRes = await dev.fetch(new Request('http://dev.local/api/releases/staging-tip?project=wavepulse'));
    expect(devRes.status).toBe(200);
    const devTip = await devRes.json() as { sha: string; source: string; version: string | null };
    expect(devTip).toMatchObject({ sha: stagingSha, source: 'peer' });
    expect(devTip.sha).not.toBe(laneSha);

    const deployRes = await deploy.fetch(new Request('http://deploy.local/api/releases/staging-tip?project=wavepulse'));
    expect(await deployRes.json()).toMatchObject({ sha: stagingSha, source: 'health' });

    const lanes = await refreshLaneBoard();
    expect(lanes.map((lane) => lane.lane)).toEqual(['wc-a']);
    expect(lanes[0].stage_block).toMatch(/would roll staging back: .*missing \d+ commits now on staging/);

    const reviews = await dev.fetch(new Request('http://dev.local/api/reviews'));
    expect(reviews.status).toBe(200);
    const cards = await reviews.json() as Array<{ task: { prompt: string }; stage_block: string | null }>;
    const laneCard = cards.find((card) => card.task.prompt === 'freeze wc-a');
    const otherCard = cards.find((card) => card.task.prompt === 'unrelated');
    expect(laneCard?.stage_block).toBe(lanes[0].stage_block);
    expect(otherCard).toMatchObject({ stage_block: null });
    expect(Object.prototype.hasOwnProperty.call(otherCard, 'stage_block')).toBe(true);

    const reported = await logStagingTipSources();
    expect(reported).toEqual([
      { project: 'wavepulse', source: 'peer', sha: stagingSha, peer: 'deploy' },
    ]);
    expect(stagingTipStatuses()).toEqual(reported);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      { staging_tips: reported },
      'Staging tip source',
    );
  });

  it('does not recurse when both boxes forward, and each answers from the other local tip', async () => {
    const shaA = '1111111111111111111111111111111111111111';
    const shaB = '2222222222222222222222222222222222222222';
    const healthA = path.join(tmp, 'health-a.cjs');
    const healthB = path.join(tmp, 'health-b.cjs');
    fs.writeFileSync(healthA, `process.stdout.write(${JSON.stringify(shaA)} + '\\n');\n`);
    fs.writeFileSync(healthB, `process.stdout.write(${JSON.stringify(shaB)} + '\\n');\n`);
    devConfig.projects.wavepulse = { ...devConfig.projects.wavepulse, release_peer: 'deploy/fable' };
    devConfig.peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789', agents: ['fable'] };
    devConfig.releases = { staging_health_command: [process.execPath, healthA] };
    deployConfig.projects.wavepulse = { ...deployConfig.projects.wavepulse, release_peer: 'dev/fable' };
    deployConfig.peers.dev = { url: 'http://dev.test', token: 'peer-token-0123456789' };
    deployConfig.releases = { deploy_agent: 'fable', staging_health_command: [process.execPath, healthB] };
    resetStagingTipCacheForTest();

    const calls: string[] = [];
    setPeerFetchForTest(async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${url.hostname}${url.pathname}${url.search}`);
      if (calls.length > 4) return Response.json({ error: 'proxy loop' }, { status: 508 });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const target = url.hostname === 'dev.test' ? dev : deploy;
      return target.fetch(new Request(`http://box.local${url.pathname}${url.search}`, {
        method: init?.method ?? 'GET',
        headers: init?.headers,
      }));
    });

    const fromDev = await dev.fetch(new Request('http://dev.local/api/releases/staging-tip?project=wavepulse'));
    expect(await fromDev.json()).toMatchObject({ sha: shaB, source: 'peer' });
    expect(calls).toEqual(['deploy.test/api/releases/staging-tip?project=wavepulse&local=1']);

    calls.length = 0;
    resetStagingTipCacheForTest();
    const fromDeploy = await deploy.fetch(new Request('http://deploy.local/api/releases/staging-tip?project=wavepulse'));
    expect(await fromDeploy.json()).toMatchObject({ sha: shaA, source: 'peer' });
    expect(calls).toEqual(['dev.test/api/releases/staging-tip?project=wavepulse&local=1']);

    calls.length = 0;
    const localDev = await dev.fetch(new Request('http://dev.local/api/releases/staging-tip?project=wavepulse&local=1'));
    expect(await localDev.json()).toMatchObject({ sha: shaA, source: 'health' });
    const viaHeader = await dev.fetch(new Request('http://dev.local/api/releases/staging-tip?project=wavepulse', {
      headers: { 'X-WaveCode-Proxied': '1' },
    }));
    expect(await viaHeader.json()).toMatchObject({ sha: shaA, source: 'health' });
    expect(calls).toEqual([]);
    delete deployConfig.peers.dev;
  });
});
