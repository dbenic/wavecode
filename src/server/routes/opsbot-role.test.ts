import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WaveConfig } from '../config.js';
import { resolveOpsLanes } from '../ops-lanes-config.js';

const FALLBACK = 'fallback-secret';
const SHA = 'b'.repeat(40);

async function makeApp() {
  const { createAuthMiddleware } = await import('../auth.js');
  const { registerOpsJobRoutes } = await import('./ops-jobs.js');
  const { registerUserRoutes } = await import('./users.js');
  const app = new Hono<import('../auth.js').NodeAppEnv>();
  const cfg = { auth: { method: 'token', fallback_token: FALLBACK, trusted_proxies: [] } } as unknown as WaveConfig;
  app.use('/api/*', createAuthMiddleware(() => cfg));
  app.use('/mcp', createAuthMiddleware(() => cfg));
  registerOpsJobRoutes(app);
  registerUserRoutes(app);
  app.get('/api/ops-lanes', (c) => c.json({ lanes: [] }));
  app.post('/api/tasks', (c) => c.json({ ok: true }, 201));
  app.get('/api/tasks', (c) => c.json([]));
  app.post('/mcp', (c) => c.json({ ok: true }));
  return app;
}

async function call(app: Hono<import('../auth.js').NodeAppEnv>, method: string, url: string, token: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() as Record<string, unknown> & unknown[] };
}

describe('opsbot role', () => {
  let dir: string;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-opsbot-'));
    const db = await import('../db.js');
    db.resetDbForTest();
    db.initDb(path.join(dir, 'test.db'));
    (await import('../ops-jobs.js')).setOpsLanesForTest(resolveOpsLanes({ ops_lanes: { receipts_root: path.join(dir, 'receipts') } }));
    vi.restoreAllMocks();
    vi.spyOn(await import('../ops-stage.js'), 'opsStageRefusal').mockResolvedValue(null);
  });
  afterEach(async () => {
    (await import('../ops-jobs.js')).setOpsLanesForTest(null);
    (await import('../db.js')).resetDbForTest();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function user(name: string, role: string) {
    const created = (await import('../users.js')).createUser({ name, role });
    if (!created.ok) throw new Error(created.error);
    return created.data;
  }

  it('is a valid role and cannot mutate like a developer', async () => {
    const { isUserRole } = await import('../db.js');
    const { canMutate, isOpsBot } = await import('../users.js');
    expect(isUserRole('opsbot')).toBe(true);
    expect(canMutate({ role: 'opsbot' })).toBe(false);
    expect(isOpsBot({ role: 'opsbot' })).toBe(true);
    expect((await user('stager', 'opsbot')).user.role).toBe('opsbot');
  });

  it('claims, completes with a receipt, and reads only its own lane', async () => {
    const app = await makeApp();
    const stager = await user('stager', 'opsbot');
    const jobs = await import('../ops-jobs.js');
    const stage = jobs.insertStageJob({ requester: 'denis', sha: SHA }).job;
    jobs.insertOpsJob({ kind: 'ask_data', role: 'scout', status: 'queued', requester: 'denis', payload: {} });

    expect((await call(app, 'GET', '/api/ops-lanes', stager.token)).status).toBe(200);
    const list = await call(app, 'GET', '/api/ops/jobs', stager.token);
    expect(list.status).toBe(200);
    expect((list.json as unknown as { role: string }[]).map((j) => j.role)).toEqual(['stager']);

    expect((await call(app, 'POST', '/api/ops/jobs/claim', stager.token, { role: 'scout' })).status).toBe(403);
    const claimed = await call(app, 'POST', '/api/ops/jobs/claim', stager.token, { role: 'stager' });
    expect(claimed.status).toBe(200);
    expect((claimed.json.job as { id: string }).id).toBe(stage.id);

    const roleDir = path.join(dir, 'receipts', 'stager');
    fs.mkdirSync(roleDir, { recursive: true });
    const receipt = path.join(roleDir, 'r.md');
    fs.writeFileSync(receipt, 'ok');
    const done = await call(app, 'POST', `/api/ops/jobs/${stage.id}/complete`, stager.token, { status: 'done', receipt_paths: [receipt] });
    expect(done.status).toBe(200);
    expect(jobs.getOpsJob(stage.id)?.status).toBe('done');
  });

  it('cannot create tasks, stage, ask, approve, manage users, or use MCP', async () => {
    const app = await makeApp();
    const bot = await user('scout', 'opsbot');
    const jobs = await import('../ops-jobs.js');
    const waiting = jobs.insertOpsJob({ kind: 'scribe_write', role: 'scribe-hipsl', status: 'awaiting_owner', requester: 'denis', payload: {} });
    const denied: [string, string, unknown?][] = [
      ['POST', '/api/tasks', { prompt: 'x' }],
      ['GET', '/api/tasks'],
      ['POST', '/api/ops/stage', { sha: SHA }],
      ['POST', '/api/ops/ask', { company: 'hipsl', env: 'staging', question: 'q', intent: 'read' }],
      ['POST', `/api/ops/jobs/${waiting.id}/approve`, {}],
      ['POST', '/api/users', { name: 'x' }],
      ['PUT', `/api/users/${bot.user.id}/role`, { role: 'developer' }],
      ['POST', '/mcp', {}],
    ];
    for (const [method, url, body] of denied) {
      expect({ url, status: (await call(app, method, url, bot.token, body)).status }).toEqual({ url, status: 403 });
    }
  });

  it('observers still cannot claim', async () => {
    const app = await makeApp();
    const obs = await user('stager', 'observer');
    expect((await call(app, 'POST', '/api/ops/jobs/claim', obs.token, { role: 'stager' })).status).toBe(403);
  });

  it('admin can set a role over the API; others cannot', async () => {
    const app = await makeApp();
    const bot = await user('stager', 'developer');
    const dev = await user('ana', 'developer');
    expect((await call(app, 'PUT', `/api/users/${bot.user.id}/role`, dev.token, { role: 'opsbot' })).status).toBe(403);
    expect((await call(app, 'PUT', `/api/users/${bot.user.id}/role`, FALLBACK, { role: 'root' })).status).toBe(400);
    expect((await call(app, 'PUT', '/api/users/nobody/role', FALLBACK, { role: 'opsbot' })).status).toBe(404);
    const res = await call(app, 'PUT', `/api/users/${bot.user.id}/role`, FALLBACK, { role: 'opsbot' });
    expect(res.status).toBe(200);
    expect(res.json.role).toBe('opsbot');
    expect(JSON.stringify(res.json)).not.toContain(bot.token);
    // The same token keeps working, now narrowed.
    expect((await call(app, 'GET', '/api/me', bot.token)).json.role).toBe('opsbot');
    expect((await call(app, 'POST', '/api/ops/stage', bot.token, { sha: SHA })).status).toBe(403);
  });

  it('CLI set-role works by name and rejects unknown roles', async () => {
    await user('pilot', 'developer');
    await user('scribe-hipsl', 'developer');
    const { setRoleCommand } = await import('../../cli/user-command.js');
    expect(setRoleCommand('scribe-hipsl', 'opsbot')).toMatchObject({ ok: true, data: { name: 'scribe-hipsl', role: 'opsbot' } });
    expect(setRoleCommand('pilot', 'observer')).toMatchObject({ ok: true, data: { role: 'observer' } });
    expect(setRoleCommand('pilot', 'superuser').ok).toBe(false);
    expect(setRoleCommand('ghost', 'opsbot').ok).toBe(false);
  });
});
