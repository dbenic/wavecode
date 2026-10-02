/**
 * One orchestrator seat per user (spec §5d), end to end: real SQLite, auth,
 * routes, spawn path, reply capture; tmux is simulated.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmuxHarness = vi.hoisted(() => ({
  sessions: new Set<string>(),
  panes: new Map<string, string>(),
  typed: [] as Array<{ session: string; text: string }>,
}));

vi.mock('./tmux.js', () => ({
  hasSession: vi.fn((s: string) => tmuxHarness.sessions.has(s)),
  newSession: vi.fn((session: string) => { tmuxHarness.sessions.add(session); }),
  killSession: vi.fn((s: string) => tmuxHarness.sessions.delete(s)),
  sendTextAndEnter: vi.fn((session: string, text: string) => { tmuxHarness.typed.push({ session, text }); }),
  capturePane: vi.fn((s: string) => ({ ok: true, data: tmuxHarness.panes.get(s) ?? '❯ \n  ⏵⏵ bypass permissions on' })),
  isValidSessionName: vi.fn(() => true),
  isAllowedRawKey: vi.fn(() => true),
}));

vi.mock('./runner.js', () => ({ startRunner: vi.fn(), stopRunner: vi.fn(), executeRun: vi.fn() }));
vi.mock('./output-watcher.js', () => ({
  startWatching: vi.fn(), stopWatching: vi.fn(), getLastOutputLine: vi.fn(() => null), getOutputVersion: vi.fn(() => 0), isWatching: vi.fn(() => false),
  isClaudeBypassAcceptDialog: vi.fn(() => false),
}));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const FALLBACK = 'fallback-admin';
type App = Hono<import('./auth.js').NodeAppEnv>;
interface Person { id: string; token: string }

describe('one orchestrator seat per user (spec §5d)', () => {
  let tmpDir: string;
  let root: string;
  let app: App;
  let db: typeof import('./db.js');
  let ana: Person;
  let denis: Person;
  let watcher: Person;

  async function call(method: string, url: string, token: string, body?: unknown) {
    const res = await app.request(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  /** The seat token, as only the seat sees it: read back from its MCP config. */
  function seatTokenOf(user: string): string {
    const cfg = JSON.parse(fs.readFileSync(path.join(tmpDir, '.wavecode-data', 'seats', `pm-${user}`, '.mcp.json'), 'utf8'));
    return cfg.mcpServers.wavecode.headers.Authorization.replace('Bearer ', '');
  }

  const typedInto = (agentName: string) => tmuxHarness.typed.filter((t) => t.session === `wc-${agentName}`).map((t) => t.text);

  async function createSeat(person: Person) {
    const res = await call('POST', '/api/users/me/seat', person.token, {});
    expect(res.status).toBe(201);
    await vi.waitFor(() => expect(typedInto(res.json.agent.name).length).toBeGreaterThan(0)); // briefed once up
    return res.json.agent as import('./db.js').Agent;
  }

  beforeEach(async () => {
    tmuxHarness.sessions.clear();
    tmuxHarness.panes.clear();
    tmuxHarness.typed.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-seats-'));
    root = path.join(tmpDir, 'profiles');
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), [
      'auth:', '  method: token', `  fallback_token: ${FALLBACK}`,
      'autonomy:', '  auto_dispatch: false',
      'orchestrator_agent: pm',
      `profiles_root: ${root}`, 'profiles:', '  ana: {}', '  denis: {}',
      'artifacts:', `  storage: ${path.join(tmpDir, 'artifacts')}`, '',
    ].join('\n'));
    (await import('./config.js')).loadConfig(path.join(tmpDir, 'config.yaml'));
    db = await import('./db.js');
    db.resetDbForTest();
    db.initDb(path.join(tmpDir, 'test.db'));
    (await import('./reply-capture.js')).resetReplyCaptureForTest();

    const { createAuthMiddleware } = await import('./auth.js');
    app = new Hono();
    app.use('/api/*', createAuthMiddleware());
    (await import('./routes/seat.js')).registerSeatRoutes(app);
    (await import('./routes/agents.js')).registerAgentRoutes(app);
    (await import('./routes/users.js')).registerUserRoutes(app);
    (await import('./routes/thread.js')).registerThreadRoutes(app);

    const { createUser } = await import('./users.js');
    const mk = (name: string, role: 'developer' | 'observer' = 'developer') => {
      const r = createUser({ name, role });
      if (!r.ok) throw new Error(r.error);
      return { id: r.data.user.id, token: r.data.token };
    };
    ana = mk('ana');
    denis = mk('denis');
    watcher = mk('watcher', 'observer');

    for (const name of ['builder', 'pm']) {
      const a = db.insertAgent({ name, runtime: 'claude-code', tmux_session: `wc-${name}`, workspace: null, mode: 'spawned', status: 'idle' });
      if (!a.ok) throw new Error(a.error);
      tmuxHarness.sessions.add(`wc-${name}`);
    }
  });

  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('creation', () => {
    it('spawns pm-<user>: orchestrator, owned by the user with a never-expiring seat lease, on their profile, briefed with SEAT.md', async () => {
      const seat = await createSeat(ana);
      expect(seat).toMatchObject({ name: 'pm-ana', role: 'orchestrator', owner_id: ana.id, lease_reason: 'seat', lease_expires_at: null, profile: 'ana', mode: 'spawned' });
      expect((db.getUser(ana.id) as { data: { seat_agent_id: string } }).data.seat_agent_id).toBe(seat.id);

      const brief = typedInto('pm-ana')[0];
      expect(brief).toMatch(/^env CLAUDE_CONFIG_DIR=|You are/); // launch command, then the brief
      const briefText = typedInto('pm-ana').find((t) => t.includes('orchestrator seat'))!;
      expect(briefText).toContain("@ana's own orchestrator seat");
      expect(briefText).toContain(path.join(seat.workspace!, 'SEAT.md'));
      expect(briefText).not.toContain('\n');
      expect(fs.existsSync(path.join(seat.workspace!, 'SEAT.md'))).toBe(true);

      // MCP registered inside ana's profile with a seat token that acts as ana
      const me = await call('GET', '/api/me', seatTokenOf('ana'));
      expect(me.json).toMatchObject({ name: 'ana', seat: { status: 'ok', agent_id: seat.id } });
    });

    it('one seat per user (409), observers get none (403), the fallback owner is told to create a user', async () => {
      await createSeat(ana);
      expect((await call('POST', '/api/users/me/seat', ana.token, {})).status).toBe(409);
      expect((await call('POST', '/api/users/me/seat', watcher.token, {})).status).toBe(403);
      expect((await call('GET', '/api/users/me/seat', watcher.token)).json).toMatchObject({ status: 'none', eligible: false });
      expect((await call('POST', '/api/users/me/seat', FALLBACK, {})).status).toBe(400);
      expect((await call('POST', '/api/users/me/seat', denis.token, { runtime: 'nope' })).status).toBe(400);
    });
  });

  describe('routing: Ask goes to your own seat', () => {
    it('each viewer\'s default target is their own seat; without one, the shared seat — never someone else\'s', async () => {
      const orchestratorFor = async (p: Person) =>
        ((await call('GET', '/api/agents', p.token)).json as Array<{ name: string; orchestrator: boolean }>).filter((a) => a.orchestrator).map((a) => a.name);

      expect(await orchestratorFor(ana)).toEqual(['pm']);
      await createSeat(ana);
      expect(await orchestratorFor(ana)).toEqual(['pm-ana']);
      expect(await orchestratorFor(denis)).toEqual(['pm']); // not pm-ana
      await createSeat(denis);
      expect(await orchestratorFor(denis)).toEqual(['pm-denis']);
    });

    it('acceptance: Ana and Denis ask "what is @builder doing?" at the same time → two seats answer, each in their own thread', async () => {
      const anaSeat = await createSeat(ana);
      const denisSeat = await createSeat(denis);
      await Promise.all([
        call('POST', `/api/agents/${anaSeat.id}/send`, ana.token, { text: 'what is @builder doing?' }),
        call('POST', `/api/agents/${denisSeat.id}/send`, denis.token, { text: 'what is @builder doing?' }),
      ]);
      tmuxHarness.panes.set('wc-pm-ana', '> what is @builder doing?\n\n● Builder is on T10 (seats), tests green so far.\n\n❯ ');
      tmuxHarness.panes.set('wc-pm-denis', '> what is @builder doing?\n\n● builder dela na T10, testi so zeleni.\n\n❯ ');
      const rc = await import('./reply-capture.js');
      expect(rc.onAgentIdle(anaSeat.id, { transitioned: true, outputChanged: true })).toBe(true);
      expect(rc.onAgentIdle(denisSeat.id, { transitioned: true, outputChanged: true })).toBe(true);

      // (the seats' briefs were superseded unanswered — dropped quietly, no placeholder bubbles)
      const replies = db.listAgentMessages({}).filter((m) => m.message_type === 'reply');
      expect(replies.map((r) => [r.from_agent_id, r.ref_prompt_actor, r.message]).sort()).toEqual([
        [anaSeat.id, ana.id, 'Builder is on T10 (seats), tests green so far.'],
        [denisSeat.id, denis.id, 'builder dela na T10, testi so zeleni.'],
      ].sort());

      // Ana's thread: her question and her seat's answer under it
      const items = (await call('GET', '/api/thread', ana.token)).json.items as Array<Record<string, any>>;
      const anaPrompt = items.find((i) => i.kind === 'prompt' && i.actor_id === ana.id && i.body === 'what is @builder doing?')!;
      const anaReply = items.find((i) => i.kind === 'reply' && i.agent_id === anaSeat.id)!;
      expect(anaReply.refs.prompt_event_id).toBe(anaPrompt.event_id);
    });

    it('only the owner may type into a seat', async () => {
      const anaSeat = await createSeat(ana);
      const res = await call('POST', `/api/agents/${anaSeat.id}/send`, denis.token, { text: 'hi' });
      expect(res.status).toBe(403);
      expect(res.json.error).toBe('Agent pm-ana is owned by ana');
    });
  });

  it('acceptance: Ana\'s seat gets 403 sending to an agent Denis reserved (it acts as Ana)', async () => {
    await createSeat(ana);
    expect((await call('POST', '/api/agents/builder/reserve', denis.token, { hours: 1 })).status).toBe(200);
    const res = await call('POST', '/api/agents/builder/send', seatTokenOf('ana'), { text: 'run the tests' });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('Agent builder is owned by denis');
  });

  it('acceptance: editing Ana\'s rules and re-briefing changes what her seat is told', async () => {
    const seat = await createSeat(ana);
    expect(typedInto(seat.name).some((t) => t.includes('Slovene'))).toBe(false);

    const rules = await call('PUT', '/api/users/me/seat/rules', ana.token, { rules: 'always answer in Slovene; never promote without asking me' });
    expect(rules.json).toEqual({ rules: 'always answer in Slovene; never promote without asking me' });
    expect((await call('POST', '/api/users/me/seat/brief', ana.token)).status).toBe(200);
    const latest = typedInto(seat.name).at(-1)!;
    expect(latest).toContain("ana's standing rules — always follow them: always answer in Slovene; never promote without asking me");

    expect((await call('PUT', '/api/users/me/seat/rules', ana.token, { rules: 'x'.repeat(2001) })).status).toBe(400);
    expect((await call('GET', '/api/users/me/seat', ana.token)).json).toMatchObject({ status: 'ok', rules: expect.stringContaining('Slovene'), has_token: true });
  });

  it('acceptance: revoking the seat token stops the seat\'s MCP calls but not Ana\'s login; rotating issues a new one', async () => {
    await createSeat(ana);
    const seatToken = seatTokenOf('ana');
    expect((await call('GET', '/api/me', seatToken)).status).toBe(200);

    expect((await call('DELETE', '/api/users/me/seat/token', ana.token)).json).toEqual({ ok: true, has_token: false });
    expect((await call('GET', '/api/me', seatToken)).status).toBe(401);
    expect((await call('GET', '/api/me', ana.token)).status).toBe(200);
    expect((await call('DELETE', '/api/users/me/seat/token', ana.token)).status).toBe(404);

    expect((await call('POST', '/api/users/me/seat/token', ana.token)).json).toMatchObject({ ok: true, mcp: { registered: true } });
    const rotated = seatTokenOf('ana');
    expect(rotated).not.toBe(seatToken);
    expect((await call('GET', '/api/me', rotated)).json.name).toBe('ana');
    expect((await call('GET', '/api/me', seatToken)).status).toBe(401);
  });

  describe('review fixes: the seat token is narrower than the person', () => {
    it('cannot manage users, seats, settings or the system, and never carries admin powers', async () => {
      const { createUser } = await import('./users.js');
      const boss = createUser({ name: 'boss', role: 'admin', profile: 'denis' });
      if (!boss.ok) throw new Error(boss.error);
      expect((await call('POST', '/api/users/me/seat', boss.data.token, {})).status).toBe(201);
      const seatToken = seatTokenOf('boss');

      expect((await call('GET', '/api/me', seatToken)).json.name).toBe('boss');
      expect((await call('GET', '/api/users', seatToken)).status).toBe(200);
      for (const [method, url, body] of [
        ['POST', '/api/users', { name: 'evil' }],
        ['DELETE', `/api/users/${ana.id}`],
        ['DELETE', '/api/users/me/seat/token'],
        ['PUT', '/api/users/me/seat/rules', { rules: 'x' }],
        ['POST', '/api/system/stop-all'],
      ] as const) {
        const res = await call(method, url, seatToken, body);
        expect(res.status, `${method} ${url}`).toBe(403);
        expect(res.json.error).toMatch(/seat token cannot/);
      }
      // admin powers capped: boss's own login could take over ana's reserved agent; the seat cannot
      await call('POST', '/api/agents/builder/reserve', ana.token, { hours: 1 });
      expect((await call('POST', '/api/agents/builder/send', boss.data.token, { text: 'x' })).status).toBe(200);
      expect((await call('POST', '/api/agents/builder/send', seatToken, { text: 'x' })).status).toBe(403);
    });

    it('revoking a user removes their seat instead of leaving an ownerless orchestrator', async () => {
      const seat = await createSeat(ana);
      expect((await call('DELETE', `/api/users/${ana.id}`, FALLBACK)).status).toBe(200);
      expect(db.getAgent(seat.id).ok).toBe(false);
      expect(tmuxHarness.sessions.has('wc-pm-ana')).toBe(false);
      expect(db.listEvents().some((e) => e.type === 'seat.removed')).toBe(true);
    });

    it('a leftover pm-<user> of this user is re-linked as the seat (no permanent 409); someone else\'s is refused', async () => {
      const leftover = db.insertAgent({ name: 'pm-ana', runtime: 'claude-code', tmux_session: 'wc-pm-ana', workspace: path.join(tmpDir, 'ws-leftover'), mode: 'spawned', status: 'idle' });
      if (!leftover.ok) throw new Error(leftover.error);
      db.setAgentLease(leftover.data.id, { owner_id: ana.id, reason: 'reserved', expires_at: null });
      tmuxHarness.sessions.add('wc-pm-ana');
      const res = await call('POST', '/api/users/me/seat', ana.token, {});
      expect(res.status).toBe(201);
      expect(res.json.agent).toMatchObject({ id: leftover.data.id, role: 'orchestrator', lease_reason: 'seat', owner_id: ana.id });
      expect((await call('GET', '/api/users/me/seat', ana.token)).json).toMatchObject({ status: 'ok' });

      db.insertAgent({ name: 'pm-denis', runtime: 'claude-code', tmux_session: 'wc-pm-denis', workspace: null, mode: 'spawned', status: 'idle' });
      db.setAgentLease((db.getAgentByName('pm-denis') as { data: { id: string } }).data.id, { owner_id: ana.id, reason: 'reserved', expires_at: null });
      expect((await call('POST', '/api/users/me/seat', denis.token, {})).status).toBe(409);
    });

    it('rotation says the running seat needs a restart to pick up the new token', async () => {
      await createSeat(ana);
      expect((await call('POST', '/api/users/me/seat/token', ana.token)).json).toMatchObject({ restart_required: true });
    });
  });

  describe('the seat lease', () => {
    it('cannot be reserved, released or swept, and the dispatcher never gives the seat worker tasks', async () => {
      const seat = await createSeat(ana);
      expect((await call('POST', `/api/agents/${seat.id}/reserve`, ana.token, { hours: 2 })).status).toBe(409);
      expect((await call('POST', `/api/agents/${seat.id}/release`, ana.token)).status).toBe(409);
      const { sweepLeases } = await import('./leases.js');
      expect(sweepLeases(Date.now() + 365 * 24 * 3_600_000)).not.toContain(seat.id);

      db.updateAgentStatus(db.getAgentByName('builder').ok ? (db.getAgentByName('builder') as { data: { id: string } }).data.id : '', 'working');
      db.updateAgentStatus(db.getAgentByName('pm').ok ? (db.getAgentByName('pm') as { data: { id: string } }).data.id : '', 'working');
      const task = db.insertTask({ prompt: 'implement it', created_by: ana.id });
      if (!task.ok) throw new Error(task.error);
      const dispatcher = await import('./task-dispatcher.js');
      dispatcher.resetDispatcherForTest();
      await dispatcher.dispatchNext({ manual: true });
      expect((db.getTask(task.data.id) as { data: { status: string } }).data.status).toBe('pending');
    });
  });

  it('a missing seat is reported (no silent fallback) and can be recreated', async () => {
    const seat = await createSeat(ana);
    db.deleteAgent(seat.id);
    expect((await call('GET', '/api/users/me/seat', ana.token)).json).toMatchObject({ status: 'missing', agent_id: seat.id });
    expect((await call('GET', '/api/me', ana.token)).json.seat).toEqual({ status: 'missing', agent_id: seat.id });
    const listed = (await call('GET', '/api/agents', ana.token)).json as Array<{ orchestrator: boolean }>;
    expect(listed.filter((a) => a.orchestrator)).toEqual([]); // not the shared pm

    tmuxHarness.sessions.delete('wc-pm-ana');
    const again = await createSeat(ana);
    expect(again.id).not.toBe(seat.id);
    expect((await call('GET', '/api/users/me/seat', ana.token)).json).toMatchObject({ status: 'ok' });
  });
});
