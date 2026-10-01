/**
 * Multi-orchestrator spec §6 acceptance, end to end: real SQLite, real auth
 * middleware, real routes, real dispatcher + health monitor. Only tmux is
 * faked (session-manager / output-watcher / tmux).
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('./session-manager.js', async () => {
  const db = await vi.importActual<typeof import('./db.js')>('./db.js');
  return {
    get: (idOrName: string) => {
      const byId = db.getAgent(idOrName);
      return byId.ok ? byId : db.getAgentByName(idOrName);
    },
    sendKeys: vi.fn(() => ({ ok: true, data: undefined })),
    sendRawKeys: vi.fn(() => ({ ok: true, data: undefined })),
    capturePane: vi.fn(() => ({ ok: true, data: 'hello from the agent' })),
    capturePaneAnsi: vi.fn(() => ({ ok: true, data: '' })),
    kill: vi.fn(() => ({ ok: true, data: undefined })),
    detach: vi.fn(() => ({ ok: true, data: undefined })),
    stopAll: vi.fn(() => ({ killed: [], interrupted: [], errors: [] })),
    ensureSpawnedAgentSession: vi.fn(),
  };
});

vi.mock('./output-watcher.js', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  getLastOutputLine: vi.fn(() => null),
  getOutputVersion: vi.fn(() => 0),
  isWatching: vi.fn(() => false),
}));

vi.mock('./tmux.js', () => ({
  hasSession: vi.fn(() => true),
}));

vi.mock('./logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const FALLBACK = 'fallback-secret';

type App = Hono<import('./auth.js').NodeAppEnv>;

async function call(app: App, method: string, url: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('multi-orchestrator acceptance (spec §6)', () => {
  let tmpDir: string;
  let app: App;
  let db: typeof import('./db.js');
  let dispatcher: typeof import('./task-dispatcher.js');
  let anaToken: string;
  let bobToken: string;
  let obsToken: string;
  let anaId: string;
  let bobId: string;

  function agent(name: string, status: 'idle' | 'working' = 'idle') {
    const r = db.insertAgent({ name, runtime: 'claude-code', tmux_session: `wc-${name}`, workspace: null, mode: 'adopted', status });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  function fresh(id: string) {
    const r = db.getAgent(id);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  function task(id: string) {
    const r = db.getTask(id);
    if (!r.ok) throw new Error(r.error);
    return r.data;
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-accept-'));
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), [
      'auth:',
      '  method: token',
      `  fallback_token: ${FALLBACK}`,
      'autonomy:',
      '  auto_dispatch: false',
      'artifacts:',
      `  storage: ${path.join(tmpDir, 'artifacts')}`,
      '',
    ].join('\n'));
    const config = await import('./config.js');
    config.loadConfig(path.join(tmpDir, 'config.yaml'));

    db = await import('./db.js');
    db.resetDbForTest();
    db.initDb(path.join(tmpDir, 'test.db'));
    dispatcher = await import('./task-dispatcher.js');
    dispatcher.resetDispatcherForTest();

    const { createAuthMiddleware } = await import('./auth.js');
    const { registerAgentRoutes } = await import('./routes/agents.js');
    const { registerTaskRoutes } = await import('./routes/tasks.js');
    const { registerSystemRoutes } = await import('./routes/system.js');
    const { registerUserRoutes } = await import('./routes/users.js');
    const { registerReviewRoutes } = await import('./routes/reviews.js');
    app = new Hono();
    app.use('/api/*', createAuthMiddleware());
    registerSystemRoutes(app);
    registerAgentRoutes(app);
    registerTaskRoutes(app);
    registerReviewRoutes(app);
    registerUserRoutes(app);

    const ana = await call(app, 'POST', '/api/users', FALLBACK, { name: 'ana' });
    const bob = await call(app, 'POST', '/api/users', FALLBACK, { name: 'bob' });
    const obs = await call(app, 'POST', '/api/users', FALLBACK, { name: 'watcher', role: 'observer' });
    anaToken = ana.json.token; anaId = ana.json.id;
    bobToken = bob.json.token; bobId = bob.json.id;
    obsToken = obs.json.token;
  });

  afterEach(() => {
    dispatcher.resetDispatcherForTest();
    db.resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('B gets 403 sending to an agent dispatched for A\'s task, but can still read it', async () => {
    const seat = agent('claude-be');
    const created = await call(app, 'POST', '/api/tasks', anaToken, { prompt: 'build auth', hold: true });
    expect(created.status).toBe(201);
    expect(created.json.created_by).toBe(anaId);

    await dispatcher.dispatchNext({ manual: true });
    expect(task(created.json.id).status).toBe('running');
    expect(fresh(seat.id)).toMatchObject({ owner_id: anaId, lease_reason: 'task' });

    const denied = await call(app, 'POST', `/api/agents/${seat.id}/send`, bobToken, { text: 'hi' });
    expect(denied.status).toBe(403);
    expect(denied.json.error).toBe('Agent claude-be is owned by ana');
    expect((await call(app, 'POST', `/api/agents/${seat.id}/kill`, bobToken)).status).toBe(403);

    const read = await call(app, 'GET', `/api/agents/${seat.id}/output`, bobToken);
    expect(read.status).toBe(200);
    expect(read.json.output).toContain('hello from the agent');
    const listed = await call(app, 'GET', '/api/agents', bobToken);
    expect(listed.json[0]).toMatchObject({ owner: 'ana', owner_id: anaId, lease_reason: 'task' });

    expect((await call(app, 'POST', `/api/agents/${seat.id}/send`, anaToken, { text: 'hi' })).status).toBe(200);
    expect((await call(app, 'POST', `/api/agents/${seat.id}/send`, FALLBACK, { text: 'admin' })).status).toBe(200);
  });

  it('the task lease is released when the run completes and the agent is idle', async () => {
    const seat = agent('claude-be');
    const created = await call(app, 'POST', '/api/tasks', anaToken, { prompt: 'x', hold: true });
    await dispatcher.dispatchNext({ manual: true });
    await vi.waitFor(() => expect(db.listRuns({ task_id: created.json.id })).toHaveLength(1));

    const run = db.listRuns({ task_id: created.json.id })[0];
    db.updateAgentStatus(seat.id, 'idle');
    dispatcher.finalizeRun(run.id, seat.id, 1, 'test failure');
    await vi.waitFor(() => expect(fresh(seat.id).owner_id).toBeNull());
    expect(db.listEvents().some((e) => e.type === 'agent.released')).toBe(true);
  });

  it('A reserves grok-fe; B\'s task waits with task.waiting_for_agent and dispatches after A releases', async () => {
    const seat = agent('grok-fe');
    const reserved = await call(app, 'POST', `/api/agents/${seat.id}/reserve`, anaToken, { hours: 1 });
    expect(reserved.status).toBe(200);
    expect(reserved.json).toMatchObject({ owner: 'ana', lease_reason: 'reserved' });
    expect((await call(app, 'POST', `/api/agents/${seat.id}/reserve`, bobToken, {})).status).toBe(409);
    expect((await call(app, 'POST', `/api/agents/${seat.id}/release`, bobToken)).status).toBe(403);

    const queued = await call(app, 'POST', '/api/tasks', bobToken, { prompt: 'fe work', agent_id: 'grok-fe', hold: true });
    expect(queued.status).toBe(201);
    expect(queued.json.waiting_for_agent).toEqual({ owner: 'ana' });

    await dispatcher.dispatchNext({ manual: true });
    await dispatcher.dispatchNext({ manual: true });
    expect(task(queued.json.id).status).toBe('pending');
    const waiting = db.listEvents().filter((e) => e.type === 'task.waiting_for_agent');
    expect(waiting).toHaveLength(1); // deduped across cycles
    expect(JSON.parse(waiting[0].payload_json!)).toMatchObject({ owner: 'ana', agent_name: 'grok-fe' });

    expect((await call(app, 'POST', `/api/agents/${seat.id}/release`, anaToken)).status).toBe(200);
    await dispatcher.dispatchNext({ manual: true });
    expect(task(queued.json.id).status).toBe('running');
    expect(fresh(seat.id)).toMatchObject({ owner_id: bobId, lease_reason: 'task' });
  });

  it('an unassigned task from B never lands on A\'s reserved agent', async () => {
    const seat = agent('grok-fe');
    await call(app, 'POST', `/api/agents/${seat.id}/reserve`, anaToken, {});
    const queued = await call(app, 'POST', '/api/tasks', bobToken, { prompt: 'anything', hold: true });
    await dispatcher.dispatchNext({ manual: true });
    expect(task(queued.json.id).status).toBe('pending');

    const mine = await call(app, 'POST', '/api/tasks', anaToken, { prompt: 'mine', hold: true });
    await dispatcher.dispatchNext({ manual: true });
    expect(task(mine.json.id).status).toBe('running');
    expect(fresh(seat.id).lease_reason).toBe('reserved'); // reservation survives dispatch
  });

  it('the monitor tick releases an expired reservation on an idle agent but not on a working one', async () => {
    const idle = agent('idle-seat');
    const busy = agent('busy-seat');
    await call(app, 'POST', `/api/agents/${idle.id}/reserve`, anaToken, { hours: 1 });
    await call(app, 'POST', `/api/agents/${busy.id}/reserve`, anaToken, { hours: 1 });
    db.updateAgentStatus(busy.id, 'working');
    const past = new Date(Date.now() - 60_000).toISOString();
    db.getDb().prepare('UPDATE agents SET lease_expires_at = ?').run(past);

    const monitor = await import('./health-monitor.js');
    await monitor.checkAll();

    expect(fresh(idle.id).owner_id).toBeNull();
    expect(fresh(busy.id).owner_id).toBe(anaId);
    const expired = db.listEvents().filter((e) => e.type === 'agent.lease_expired');
    expect(expired.map((e) => e.entity_id)).toEqual([idle.id]);
  });

  it('events written through routes carry the caller\'s actor_id', async () => {
    const seat = agent('grok-fe');
    await call(app, 'POST', `/api/agents/${seat.id}/reserve`, anaToken, {});
    await call(app, 'POST', `/api/agents/${seat.id}/send`, anaToken, { text: 'go' });
    await call(app, 'POST', '/api/tasks', bobToken, { prompt: 'x', hold: true });
    await call(app, 'POST', `/api/agents/${seat.id}/release`, FALLBACK);

    const actorOf = (type: string) => db.listEvents().find((e) => e.type === type)?.actor_id;
    expect(actorOf('agent.reserved')).toBe(anaId);
    expect(actorOf('agent.prompt_sent')).toBe(anaId);
    expect(actorOf('task.created')).toBe(bobId);
    expect(actorOf('agent.released')).toBe('owner');

    const log = await call(app, 'GET', '/api/events/log?types=agent.*', bobToken);
    expect(log.json.events.map((e: { actor_id: string }) => e.actor_id)).toEqual([anaId, anaId, 'owner']);
  });

  it('observer tokens get 403 on every mutating route', async () => {
    const seat = agent('grok-fe');
    const mutations: Array<[string, string, unknown?]> = [
      ['POST', `/api/agents/${seat.id}/send`, { text: 'x' }],
      ['POST', `/api/agents/${seat.id}/reserve`, {}],
      ['POST', `/api/agents/${seat.id}/release`],
      ['POST', `/api/agents/${seat.id}/kill`],
      ['DELETE', `/api/agents/${seat.id}`],
      ['PATCH', `/api/agents/${seat.id}`, { model: null }],
      ['POST', '/api/tasks', { prompt: 'x' }],
      ['POST', '/api/system/stop-all'],
      ['POST', '/api/users', { name: 'z' }],
      ['POST', '/api/dispatch'],
    ];
    for (const [method, url, body] of mutations) {
      const res = await call(app, method, url, obsToken, body);
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    expect((await call(app, 'GET', '/api/agents', obsToken)).status).toBe(200);
    expect((await call(app, 'GET', `/api/agents/${seat.id}/output`, obsToken)).status).toBe(200);
  });

  it('stop-all is admin-only; the fallback token is the admin owner', async () => {
    expect((await call(app, 'POST', '/api/system/stop-all', anaToken)).status).toBe(403);
    expect((await call(app, 'GET', '/api/me', FALLBACK)).json).toMatchObject({ name: 'owner', role: 'admin' });
    const ok = await call(app, 'POST', '/api/system/stop-all', FALLBACK);
    expect(ok.status).toBe(200);
    expect(ok.json.auto_dispatch_disabled).toBe(true);
  });

  it('review handoff to an agent owned by someone else is 403', async () => {
    const seat = agent('grok-fe');
    await call(app, 'POST', `/api/agents/${seat.id}/reserve`, anaToken, {});
    const res = await call(app, 'POST', '/api/reviews/some-run/handoff', bobToken, { targetAgentId: seat.id });
    expect(res.status).toBe(403);
    expect(res.json.error).toContain('ana');
  });

  it('revoking a user releases their leases', async () => {
    const seat = agent('grok-fe');
    await call(app, 'POST', `/api/agents/${seat.id}/reserve`, anaToken, {});
    expect((await call(app, 'DELETE', `/api/users/${anaId}`, FALLBACK)).status).toBe(200);
    expect(fresh(seat.id).owner_id).toBeNull();
  });
});
