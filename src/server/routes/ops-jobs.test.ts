import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaveConfig } from '../config.js';
import { resolveOpsLanes } from '../ops-lanes-config.js';

const FALLBACK = 'fallback-secret';
const SHA = 'a'.repeat(40);

function makeConfig(): WaveConfig {
  return { auth: { method: 'token', fallback_token: FALLBACK, trusted_proxies: [] } } as unknown as WaveConfig;
}

async function makeApp() {
  const { createAuthMiddleware } = await import('../auth.js');
  const { registerOpsJobRoutes } = await import('./ops-jobs.js');
  const app = new Hono<import('../auth.js').NodeAppEnv>();
  app.use('/api/*', createAuthMiddleware(() => makeConfig()));
  registerOpsJobRoutes(app);
  return app;
}

async function call(
  app: Hono<import('../auth.js').NodeAppEnv>,
  method: string,
  url: string,
  token: string | null,
  body?: unknown,
) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json() as Record<string, unknown>;
  return { status: res.status, json };
}

describe('ops job routes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-ops-routes-'));
    const db = await import('../db.js');
    db.resetDbForTest();
    db.initDb(path.join(dir, 'test.db'));
    const jobs = await import('../ops-jobs.js');
    jobs.setOpsLanesForTest(resolveOpsLanes({
      ops_lanes: { receipts_root: path.join(dir, 'receipts') },
    }));
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    const db = await import('../db.js');
    const jobs = await import('../ops-jobs.js');
    jobs.setOpsLanesForTest(null);
    db.resetDbForTest();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function user(name: string, role: 'admin' | 'developer' | 'observer' = 'developer') {
    const users = await import('../users.js');
    const created = users.createUser({ name, role });
    if (!created.ok) throw new Error(created.error);
    return created.data;
  }

  it('requires a token', async () => {
    const app = await makeApp();
    expect((await call(app, 'GET', '/api/ops/jobs', null)).status).toBe(401);
    expect((await call(app, 'POST', '/api/ops/jobs/claim', 'nope', { role: 'scout' })).status).toBe(401);
  });

  it('lets a bot claim only its own role', async () => {
    const app = await makeApp();
    const scout = await user('scout');
    const stager = await user('stager');
    const jobs = await import('../ops-jobs.js');
    const scoutJob = jobs.insertOpsJob({
      kind: 'ask_data', role: 'scout', status: 'queued', requester: 'denis', payload: { company: 'hipsl' },
    });
    jobs.insertOpsJob({
      kind: 'stage', role: 'stager', status: 'queued', requester: 'denis', payload: jobs.stagePayload(SHA),
    });

    expect((await call(app, 'POST', '/api/ops/jobs/claim', scout.token, { role: 'stager' })).status).toBe(403);
    const claimed = await call(app, 'POST', '/api/ops/jobs/claim', scout.token, { role: 'scout' });
    expect(claimed.status).toBe(200);
    expect(claimed.json.job).toMatchObject({ id: scoutJob.id, status: 'claimed', role: 'scout' });
    const again = await call(app, 'POST', '/api/ops/jobs/claim', scout.token, { role: 'scout' });
    expect(again.json.job).toBeNull();
    const stagerClaim = await call(app, 'POST', '/api/ops/jobs/claim', stager.token, { role: 'stager' });
    expect(stagerClaim.json.job).toMatchObject({ role: 'stager', status: 'claimed' });
    expect((await call(app, 'POST', '/api/ops/jobs/claim', FALLBACK, { role: 'scout' })).status).toBe(403);
  });

  it('rejects a receipt outside the role directory and stores only the path', async () => {
    const app = await makeApp();
    const stager = await user('stager');
    const jobs = await import('../ops-jobs.js');
    const job = jobs.insertOpsJob({
      kind: 'stage', role: 'stager', status: 'queued', requester: 'denis', payload: jobs.stagePayload(SHA),
    });
    await call(app, 'POST', '/api/ops/jobs/claim', stager.token, { role: 'stager' });
    const roleDir = path.join(dir, 'receipts', 'stager');
    fs.mkdirSync(roleDir, { recursive: true });
    const receipt = path.join(roleDir, 'done.txt');
    fs.writeFileSync(receipt, 'BODY_SHOULD_NOT_BE_STORED');
    fs.writeFileSync(path.join(dir, 'secret.txt'), 'OUTSIDE_SECRET');

    const escaped = await call(app, 'POST', `/api/ops/jobs/${job.id}/complete`, stager.token, {
      status: 'done',
      receipt_paths: [path.join(roleDir, '..', '..', 'secret.txt')],
    });
    expect(escaped.status).toBe(400);
    expect(JSON.stringify(escaped.json)).not.toContain('OUTSIDE_SECRET');
    expect(jobs.getOpsJob(job.id)?.status).toBe('claimed');

    const other = await user('scout');
    expect((await call(app, 'POST', `/api/ops/jobs/${job.id}/complete`, other.token, {
      status: 'done', receipt_paths: [receipt],
    })).status).toBe(403);

    const done = await call(app, 'POST', `/api/ops/jobs/${job.id}/complete`, stager.token, {
      status: 'done', receipt_paths: [receipt],
    });
    expect(done.status).toBe(200);
    const body = JSON.stringify(done.json);
    expect(body).toContain(await fs.promises.realpath(receipt));
    expect(body).not.toContain('BODY_SHOULD_NOT_BE_STORED');
    expect(jobs.getOpsJob(job.id)?.status).toBe('done');
  });

  it('queues a stager job only when the SHA passes, and dedups an open job', async () => {
    const app = await makeApp();
    const stage = await import('../ops-stage.js');
    const refusal = vi.spyOn(stage, 'opsStageRefusal');
    refusal.mockResolvedValue('needs green quick check on aaaaaaaa');
    const blocked = await call(app, 'POST', '/api/ops/stage', FALLBACK, { sha: SHA, steps: ['rm', '-rf'] });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe('needs green quick check on aaaaaaaa');
    const jobs = await import('../ops-jobs.js');
    expect(jobs.listOpsJobs()).toHaveLength(0);

    refusal.mockResolvedValue(null);
    const created = await call(app, 'POST', '/api/ops/stage', FALLBACK, { sha: SHA.toUpperCase(), steps: ['rm', '-rf', '/'] });
    expect(created.status).toBe(201);
    const job = created.json.job as { id: string; payload: { sha: string; steps: string[] } };
    expect(job.payload.steps).toEqual([...jobs.STAGE_STEPS]);
    expect(job.payload.sha).toBe(SHA);
    expect(JSON.stringify(created.json)).not.toContain('rm');

    const repeat = await call(app, 'POST', '/api/ops/stage', FALLBACK, { sha: SHA });
    expect(repeat.status).toBe(200);
    expect(repeat.json.deduped).toBe(true);
    expect((repeat.json.job as { id: string }).id).toBe(job.id);
    expect(jobs.listOpsJobs()).toHaveLength(1);
  });

  it('queues a read for the scout and holds a write for an owner', async () => {
    const app = await makeApp();
    const denis = await user('denis', 'admin');
    const ana = await user('ana');
    const read = await call(app, 'POST', '/api/ops/ask', ana.token, {
      company: 'hipsl', env: 'prod', question: 'what is the payroll total password=hunter2',
    });
    expect(read.status).toBe(201);
    expect(read.json.job).toMatchObject({
      kind: 'ask_data', role: 'scout', status: 'queued',
      payload: {
        read_only: true,
        answer_policy: { payroll: 'totals_only', gl: 'totals_only', no_personal_names: true },
      },
    });
    expect(JSON.stringify(read.json)).not.toContain('hunter2');
    expect(JSON.stringify(read.json)).toContain('[redacted]');

    const write = await call(app, 'POST', '/api/ops/ask', ana.token, {
      company: 'clients', env: 'staging', question: 'delete invoice 4',
    });
    expect(write.status).toBe(201);
    const held = write.json.job as { id: string; status: string; role: string; kind: string };
    expect(held).toMatchObject({ kind: 'scribe_write', role: 'scribe-clients', status: 'awaiting_owner' });

    expect((await call(app, 'POST', `/api/ops/jobs/${held.id}/approve`, ana.token)).status).toBe(403);
    expect((await call(app, 'POST', `/api/ops/jobs/${held.id}/approve`, FALLBACK)).status).toBe(403);

    const users = await import('../users.js');
    const db = await import('../db.js');
    db.updateUserSeat(denis.user.id, { seat_token_hash: users.hashToken('denis-seat') });
    const agent = await call(app, 'POST', `/api/ops/jobs/${held.id}/approve`, 'denis-seat');
    expect(agent.status).toBe(403);
    expect(agent.json.error).toMatch(/agents cannot approve/);

    const approved = await call(app, 'POST', `/api/ops/jobs/${held.id}/approve`, denis.token);
    expect(approved.status).toBe(200);
    expect(approved.json.job).toMatchObject({
      status: 'awaiting_owner',
      approval: { by: 'denis' },
    });
    const jobs = await import('../ops-jobs.js');
    expect(jobs.getOpsJob(held.id)?.status).toBe('awaiting_owner');

    const unknown = await call(app, 'POST', '/api/ops/ask', ana.token, {
      company: 'acme', env: 'staging', question: 'drop the table',
    });
    expect(unknown.status).toBe(400);
  });

  it('shows status, role, requester, receipts and approval', async () => {
    const app = await makeApp();
    const jobs = await import('../ops-jobs.js');
    jobs.insertOpsJob({
      kind: 'ask_data', role: 'scout', status: 'queued', requester: 'antonio', payload: { question: 'totals' },
    });
    const listed = await call(app, 'GET', '/api/ops/jobs', FALLBACK);
    expect(listed.status).toBe(200);
    const rows = listed.json as Array<{ role: string; requester: string; status: string; receipt_paths: string[]; approval: null }>;
    expect(rows[0]).toMatchObject({ role: 'scout', requester: 'antonio', status: 'queued', receipt_paths: [], approval: null });
  });
});
