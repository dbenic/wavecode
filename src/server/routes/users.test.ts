import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WaveConfig } from '../config.js';

const FALLBACK = 'fallback-secret';

function makeConfig(): WaveConfig {
  return {
    auth: { method: 'token', fallback_token: FALLBACK, trusted_proxies: [] },
  } as unknown as WaveConfig;
}

async function makeApp() {
  const { createAuthMiddleware } = await import('../auth.js');
  const { registerUserRoutes } = await import('./users.js');
  const app = new Hono<import('../auth.js').NodeAppEnv>();
  app.use('/api/*', createAuthMiddleware(() => makeConfig()));
  registerUserRoutes(app);
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
  return { status: res.status, json: await res.json() as any };
}

describe('user routes', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-user-routes-'));
    const { initDb, resetDbForTest } = await import('../db.js');
    resetDbForTest();
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(async () => {
    const { resetDbForTest } = await import('../db.js');
    resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/me returns the synthetic owner admin for the fallback token', async () => {
    const app = await makeApp();
    const res = await call(app, 'GET', '/api/me', FALLBACK);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: 'owner', name: 'owner', role: 'admin', color: expect.any(String), profile: null, seat: { status: 'none' } });
  });

  it('rejects unknown tokens with 401', async () => {
    const app = await makeApp();
    expect((await call(app, 'GET', '/api/me', 'bogus')).status).toBe(401);
    expect((await call(app, 'GET', '/api/me', null)).status).toBe(401);
  });

  it('admin creates a user; the token is returned once and authenticates as that user', async () => {
    const app = await makeApp();
    const created = await call(app, 'POST', '/api/users', FALLBACK, { name: 'ana', role: 'developer', color: '#2563eb' });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: 'ana', role: 'developer', color: '#2563eb' });
    expect(created.json.token).toMatch(/^wc_/);

    const me = await call(app, 'GET', '/api/me', created.json.token);
    expect(me.json).toEqual({ id: created.json.id, name: 'ana', role: 'developer', color: '#2563eb', profile: 'ana', seat: { status: 'none' } });

    const list = await call(app, 'GET', '/api/users', created.json.token);
    expect(list.status).toBe(200);
    expect(list.json.map((u: { name: string }) => u.name)).toEqual(['owner', 'ana']);
    for (const u of list.json) {
      expect(u).not.toHaveProperty('token_hash');
      expect(u).not.toHaveProperty('token');
    }
  });

  it('attributes route events to the calling user (actor_id)', async () => {
    const app = await makeApp();
    const created = await call(app, 'POST', '/api/users', FALLBACK, { name: 'ana', role: 'admin' });
    await call(app, 'POST', '/api/users', created.json.token, { name: 'bob' });

    const { listEvents } = await import('../db.js');
    const events = listEvents().filter((e) => e.type === 'user.created');
    expect(events.map((e) => e.actor_id)).toEqual(['owner', created.json.id]);
  });

  it('validates input: duplicate name → 409, bad role → 400', async () => {
    const app = await makeApp();
    await call(app, 'POST', '/api/users', FALLBACK, { name: 'ana' });
    expect((await call(app, 'POST', '/api/users', FALLBACK, { name: 'ana' })).status).toBe(409);
    expect((await call(app, 'POST', '/api/users', FALLBACK, { name: 'bob', role: 'root' })).status).toBe(400);
  });

  it('POST /api/users answers malformed or non-object JSON with 400, not 500', async () => {
    const app = await makeApp();
    const malformed = await app.request('/api/users', {
      method: 'POST',
      headers: { Authorization: `Bearer ${FALLBACK}`, 'Content-Type': 'application/json' },
      body: '{"name": "ana",',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'Malformed JSON body' });

    for (const body of ['[]', 'null', '"ana"']) {
      const res = await app.request('/api/users', {
        method: 'POST',
        headers: { Authorization: `Bearer ${FALLBACK}`, 'Content-Type': 'application/json' },
        body,
      });
      expect(res.status, body).toBe(400);
    }
  });

  it('only admins may create or revoke users', async () => {
    const app = await makeApp();
    const dev = await call(app, 'POST', '/api/users', FALLBACK, { name: 'dev', role: 'developer' });
    const target = await call(app, 'POST', '/api/users', FALLBACK, { name: 'target' });

    expect((await call(app, 'POST', '/api/users', dev.json.token, { name: 'x' })).status).toBe(403);
    expect((await call(app, 'DELETE', `/api/users/${target.json.id}`, dev.json.token)).status).toBe(403);
  });

  it('observers are read-only: GET works, every mutating method is 403', async () => {
    const app = await makeApp();
    const obs = await call(app, 'POST', '/api/users', FALLBACK, { name: 'watcher', role: 'observer' });

    expect((await call(app, 'GET', '/api/me', obs.json.token)).json.role).toBe('observer');
    expect((await call(app, 'GET', '/api/users', obs.json.token)).status).toBe(200);
    const denied = await call(app, 'POST', '/api/users', obs.json.token, { name: 'x' });
    expect(denied.status).toBe(403);
    expect(denied.json.error).toMatch(/observer/);
    expect((await call(app, 'DELETE', `/api/users/${obs.json.id}`, obs.json.token)).status).toBe(403);
  });

  it('DELETE /api/users/:id revokes the token; owner and self cannot be revoked', async () => {
    const app = await makeApp();
    const ana = await call(app, 'POST', '/api/users', FALLBACK, { name: 'ana', role: 'admin' });

    expect((await call(app, 'DELETE', '/api/users/owner', ana.json.token)).status).toBe(400);
    expect((await call(app, 'DELETE', `/api/users/${ana.json.id}`, ana.json.token)).status).toBe(400);
    expect((await call(app, 'DELETE', '/api/users/nope', FALLBACK)).status).toBe(404);

    expect((await call(app, 'DELETE', `/api/users/${ana.json.id}`, FALLBACK)).json).toEqual({ ok: true });
    expect((await call(app, 'GET', '/api/me', ana.json.token)).status).toBe(401);
  });
});
