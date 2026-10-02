/**
 * Login seats (spec §5): open → adopted agent on the profile, reserved for
 * the requester; reaped on exit; killed after 15 min; orphans swept; never
 * dispatched to. Plus the HTTP routes and the dispatcher's profile rule.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmuxHarness = vi.hoisted(() => ({
  sessions: new Set<string>(),
  launched: [] as Array<{ session: string; dir: string; command?: string }>,
}));

vi.mock('./tmux.js', () => ({
  hasSession: vi.fn((s: string) => tmuxHarness.sessions.has(s)),
  newSession: vi.fn((session: string, dir: string, command?: string) => {
    tmuxHarness.sessions.add(session);
    tmuxHarness.launched.push({ session, dir, command });
  }),
  killSession: vi.fn((s: string) => tmuxHarness.sessions.delete(s)),
  sendTextAndEnter: vi.fn(),
  capturePane: vi.fn(() => ({ ok: true, data: '╭─╮\n│ > │\n  ? for shortcuts' })),
  isValidSessionName: vi.fn((s: string) => /^[a-zA-Z0-9._-]+$/.test(s)),
}));

vi.mock('./output-watcher.js', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  getLastOutputLine: vi.fn(() => null),
  getOutputVersion: vi.fn(() => 0),
  isWatching: vi.fn(() => false),
}));

vi.mock('./runner.js', () => ({ startRunner: vi.fn(), stopRunner: vi.fn(), executeRun: vi.fn(async () => ({ ok: true, data: { id: 'r' } })) }));

vi.mock('./logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const FALLBACK = 'fallback-admin';

describe('login seats', () => {
  let tmpDir: string;
  let root: string;
  let db: typeof import('./db.js');
  let seats: typeof import('./login-seats.js');
  let ana: { id: string; token: string; user: import('./db.js').User };
  let bob: { id: string; token: string; user: import('./db.js').User };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    tmuxHarness.sessions.clear();
    tmuxHarness.launched.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-login-'));
    root = path.join(tmpDir, 'profiles');
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), [
      'auth:', '  method: token', `  fallback_token: ${FALLBACK}`,
      'autonomy:', '  auto_dispatch: false',
      `profiles_root: ${root}`,
      'profiles:', '  ana: {}', '  bob: {}', '  service: { shared: true }',
      'artifacts:', `  storage: ${path.join(tmpDir, 'artifacts')}`, '',
    ].join('\n'));
    (await import('./config.js')).loadConfig(path.join(tmpDir, 'config.yaml'));
    db = await import('./db.js');
    db.resetDbForTest();
    db.initDb(path.join(tmpDir, 'test.db'));
    seats = await import('./login-seats.js');
    seats.resetLoginSeatsForTest();

    const { createUser } = await import('./users.js');
    const mk = (name: string) => {
      const r = createUser({ name });
      if (!r.ok) throw new Error(r.error);
      return { id: r.data.user.id, token: r.data.token, user: r.data.user };
    };
    ana = mk('ana');
    bob = mk('bob');
  });

  afterEach(() => {
    seats.resetLoginSeatsForTest();
    vi.useRealTimers();
    db.resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function open(profile = 'ana', runtime = 'claude-code', user = ana.user) {
    return seats.openLoginSeat({ profile, runtime, user });
  }

  it('opens wc-login-<profile>-<runtime> with the profile env and `; exit`, as an adopted agent reserved for the requester', () => {
    const res = open();
    if (!res.ok) throw new Error(res.error);
    expect(res.data.session).toBe('wc-login-ana-claude-code');
    expect(tmuxHarness.launched[0]).toEqual({
      session: 'wc-login-ana-claude-code',
      dir: path.join(root, 'ana'),
      command: `env CLAUDE_CONFIG_DIR=${root}/ana/claude claude /login; exit`,
    });
    expect(fs.existsSync(path.join(root, 'ana', 'claude'))).toBe(true); // dirs created on first login
    expect(res.data.agent).toMatchObject({
      name: 'login-ana-claude-code', mode: 'adopted', profile: 'ana',
      owner_id: ana.id, lease_reason: 'reserved',
    });
    expect(seats.isLoginSeat(res.data.agent)).toBe(true);
    expect(db.listEvents().map((e) => e.type)).toContain('profile.login_started');
  });

  it('per-runtime login commands', () => {
    expect(open('ana', 'codex').ok).toBe(true);
    expect(tmuxHarness.launched.at(-1)?.command).toBe(`env CODEX_HOME=${root}/ana/codex codex login; exit`);
    expect(open('ana', 'grok').ok).toBe(true);
    expect(tmuxHarness.launched.at(-1)?.command).toBe(`env HOME=${root}/ana/grok-home grok; exit`);
  });

  it('only the profile owner or an admin; shared profiles admin-only', async () => {
    const { OWNER_USER } = await import('./users.js');
    expect(open('ana', 'claude-code', bob.user)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(open('service', 'claude-code', ana.user)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(open('service', 'claude-code', OWNER_USER).ok).toBe(true);
    expect(open('bob', 'codex', OWNER_USER).ok).toBe(true);
  });

  it('rejects unknown profiles/runtimes and a second open seat', () => {
    expect(open('carol')).toMatchObject({ ok: false, code: 'invalid' });
    expect(open('ana', 'aider')).toMatchObject({ ok: false, code: 'invalid', error: expect.stringMatching(/login_command/) });
    expect(open().ok).toBe(true);
    expect(open()).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('is reaped when the login command exits (session gone)', () => {
    const res = open();
    if (!res.ok) throw new Error(res.error);
    vi.advanceTimersByTime(seats.LOGIN_SEAT_POLL_MS);
    expect(db.getAgent(res.data.agent.id).ok).toBe(true); // still running

    tmuxHarness.sessions.delete(res.data.session); // `; exit` after login
    vi.advanceTimersByTime(seats.LOGIN_SEAT_POLL_MS);
    expect(db.getAgent(res.data.agent.id).ok).toBe(false);
    const finished = db.listEvents().find((e) => e.type === 'profile.login_finished');
    expect(JSON.parse(finished!.payload_json!)).toMatchObject({ profile: 'ana', runtime: 'claude-code', reason: 'exited', logged_in: false });
  });

  it('is killed after 15 minutes and reports whether a credential now exists', () => {
    const res = open();
    if (!res.ok) throw new Error(res.error);
    fs.writeFileSync(path.join(root, 'ana', 'claude', '.credentials.json'), '{}');

    vi.advanceTimersByTime(seats.LOGIN_SEAT_TTL_MS - seats.LOGIN_SEAT_POLL_MS);
    expect(tmuxHarness.sessions.has(res.data.session)).toBe(true);
    vi.advanceTimersByTime(seats.LOGIN_SEAT_POLL_MS);
    expect(tmuxHarness.sessions.has(res.data.session)).toBe(false);
    expect(db.getAgent(res.data.agent.id).ok).toBe(false);
    const finished = db.listEvents().find((e) => e.type === 'profile.login_finished');
    expect(JSON.parse(finished!.payload_json!)).toMatchObject({ reason: 'timeout', logged_in: true });
  });

  it('sweeps orphaned seats after a daemon restart (no watcher)', () => {
    const res = open();
    if (!res.ok) throw new Error(res.error);
    seats.resetLoginSeatsForTest(); // watcher lost
    expect(seats.sweepLoginSeats(db.listAgents())).toEqual([]); // still within its lease, session alive
    tmuxHarness.sessions.delete(res.data.session);
    expect(seats.sweepLoginSeats(db.listAgents())).toEqual([res.data.agent.id]);
    expect(db.listAgents()).toHaveLength(0);
  });

  it('the dispatcher never sends work to a login seat', async () => {
    const res = open();
    if (!res.ok) throw new Error(res.error);
    const task = db.insertTask({ prompt: 'work', created_by: ana.id });
    if (!task.ok) throw new Error(task.error);
    const dispatcher = await import('./task-dispatcher.js');
    dispatcher.resetDispatcherForTest();
    await dispatcher.dispatchNext({ manual: true });
    expect(db.getTask(task.data.id).ok && (db.getTask(task.data.id) as { data: { status: string } }).data.status).toBe('pending');
  });

  describe('dispatcher free rule', () => {
    it("a free agent on ana's profile takes ana's task, never bob's; bob's assigned task waits with reason profile", async () => {
      const seat = db.insertAgent({ name: 'ana-cc', runtime: 'claude-code', tmux_session: 'wc-ana-cc', workspace: null, mode: 'spawned', status: 'idle', profile: 'ana' });
      if (!seat.ok) throw new Error(seat.error);
      tmuxHarness.sessions.add('wc-ana-cc');
      const dispatcher = await import('./task-dispatcher.js');
      dispatcher.resetDispatcherForTest();

      const bobsFree = db.insertTask({ prompt: 'bob unassigned', created_by: bob.id });
      const bobsPinned = db.insertTask({ prompt: 'bob pinned', created_by: bob.id, agent_id: seat.data.id });
      if (!bobsFree.ok || !bobsPinned.ok) throw new Error('tasks');
      await dispatcher.dispatchNext({ manual: true });
      expect((db.getTask(bobsFree.data.id) as { data: { status: string } }).data.status).toBe('pending');
      expect((db.getTask(bobsPinned.data.id) as { data: { status: string } }).data.status).toBe('pending');
      const waiting = db.listEvents().filter((e) => e.type === 'task.waiting_for_agent');
      expect(waiting).toHaveLength(1);
      expect(JSON.parse(waiting[0].payload_json!)).toMatchObject({ reason: 'profile', profile: 'ana', agent_name: 'ana-cc' });

      const anas = db.insertTask({ prompt: 'ana work', created_by: ana.id });
      if (!anas.ok) throw new Error(anas.error);
      await dispatcher.dispatchNext({ manual: true });
      expect((db.getTask(anas.data.id) as { data: { status: string } }).data.status).toBe('running');
    });
  });

  describe('routes', () => {
    async function makeApp() {
      const { createAuthMiddleware } = await import('./auth.js');
      const app = new Hono<import('./auth.js').NodeAppEnv>();
      app.use('/api/*', createAuthMiddleware());
      (await import('./routes/profiles.js')).registerProfileRoutes(app);
      (await import('./routes/agents.js')).registerAgentRoutes(app);
      return app;
    }
    async function call(app: Hono<import('./auth.js').NodeAppEnv>, method: string, url: string, token: string, body?: unknown) {
      const res = await app.request(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json() as any };
    }

    it('GET /api/profiles: presence per runtime, "mine", never contents or paths', async () => {
      fs.mkdirSync(path.join(root, 'ana', 'codex'), { recursive: true });
      fs.writeFileSync(path.join(root, 'ana', 'codex', 'auth.json'), '{"token":"sk-secret"}');
      const app = await makeApp();
      const res = await call(app, 'GET', '/api/profiles', ana.token);
      expect(res.status).toBe(200);
      const mine = res.json.find((p: { name: string }) => p.name === 'ana');
      expect(mine).toMatchObject({ mine: true, shared: false, runtimes: { codex: { logged_in: true }, 'claude-code': { logged_in: false } } });
      expect(JSON.stringify(res.json)).not.toMatch(/sk-secret|auth\.json/);
    });

    it('POST /api/profiles/:name/login opens a watched seat; others get 403', async () => {
      const app = await makeApp();
      const out = await import('./output-watcher.js');
      expect((await call(app, 'POST', '/api/profiles/ana/login', bob.token, { runtime: 'codex' })).status).toBe(403);
      expect((await call(app, 'POST', '/api/profiles/ana/login', ana.token, {})).status).toBe(400);
      const res = await call(app, 'POST', '/api/profiles/ana/login', ana.token, { runtime: 'codex' });
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({ session: 'wc-login-ana-codex', agent: { profile: 'ana', mode: 'adopted' } });
      expect(out.startWatching).toHaveBeenCalledWith(res.json.agent.id);
      expect((await call(app, 'POST', '/api/profiles/ana/login', ana.token, { runtime: 'codex' })).status).toBe(409);
    });

    it('POST /api/agents/spawn uses the caller profile; only admins override', async () => {
      const app = await makeApp();
      const sm = await import('./session-manager.js');
      const spawnSpy = vi.spyOn(sm, 'spawnAgent').mockImplementation((opts) => db.insertAgent({
        name: opts.name, runtime: opts.runtime, tmux_session: `wc-${opts.name}`, workspace: '/w', mode: 'spawned', status: 'idle', profile: opts.profile ?? null,
      }));
      // Not logged in yet → refused with the fix, nothing spawned
      const early = await call(app, 'POST', '/api/agents/spawn', ana.token, { name: 'a0', runtime: 'codex' });
      expect(early.status).toBe(409);
      expect(early.json.error).toMatch(/not logged in for codex.*wave-login codex ana/);
      expect(spawnSpy).not.toHaveBeenCalled();
      for (const profile of ['ana', 'bob']) {
        fs.mkdirSync(path.join(root, profile, 'codex'), { recursive: true });
        fs.writeFileSync(path.join(root, profile, 'codex', 'auth.json'), '{}');
      }
      const mine = await call(app, 'POST', '/api/agents/spawn', ana.token, { name: 'a1', runtime: 'codex' });
      expect(mine.status).toBe(201);
      expect(spawnSpy).toHaveBeenLastCalledWith(expect.objectContaining({ profile: 'ana' }));

      expect((await call(app, 'POST', '/api/agents/spawn', ana.token, { name: 'a2', runtime: 'codex', profile: 'bob' })).status).toBe(403);
      const admin = await call(app, 'POST', '/api/agents/spawn', FALLBACK, { name: 'a3', runtime: 'codex', profile: 'bob' });
      expect(admin.status).toBe(201);
      expect(spawnSpy).toHaveBeenLastCalledWith(expect.objectContaining({ profile: 'bob' }));

      // listed as free (other subscription) for ana
      const listed = await call(app, 'GET', '/api/agents', ana.token);
      const a3 = listed.json.find((a: { name: string }) => a.name === 'a3');
      expect(a3).toMatchObject({ profile: 'bob', owner: null, profile_compatible: false, subscription: { account: null, plan: null } });
    });
  });
});
