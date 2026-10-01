/**
 * Tests for the MCP tool layer: every tool maps to the right REST call,
 * arguments pass through faithfully, and API errors surface as tool errors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WAVECODE_TOOLS } from './tools.js';
import { WaveCodeClient } from './client.js';

// Integration section below drives the real routes; only tmux-facing
// modules are faked. Pure tool-mapping tests never import them.
vi.mock('../server/session-manager.js', async () => {
  const db = await vi.importActual<typeof import('../server/db.js')>('../server/db.js');
  return {
    get: (idOrName: string) => {
      const byId = db.getAgent(idOrName);
      return byId.ok ? byId : db.getAgentByName(idOrName);
    },
    spawnAgent: vi.fn((opts: { name: string; runtime: string }) => db.insertAgent({
      name: opts.name, runtime: opts.runtime, tmux_session: `wc-${opts.name}`, workspace: '/tmp/ws', mode: 'spawned', status: 'idle',
    })),
    sendKeys: vi.fn(() => ({ ok: true, data: undefined })),
    sendRawKeys: vi.fn(() => ({ ok: true, data: undefined })),
    capturePane: vi.fn(() => ({ ok: true, data: 'output' })),
    capturePaneAnsi: vi.fn(() => ({ ok: true, data: '' })),
    kill: vi.fn(() => ({ ok: true, data: undefined })),
    detach: vi.fn(() => ({ ok: true, data: undefined })),
    stopAll: vi.fn(() => ({ killed: [], interrupted: [], errors: [] })),
  };
});

vi.mock('../server/output-watcher.js', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  getLastOutputLine: vi.fn(() => null),
  getOutputVersion: vi.fn(() => 0),
  isWatching: vi.fn(() => false),
}));

vi.mock('../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeClient(response: unknown = { ok: true }, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), { status }));
  const client = new WaveCodeClient({
    baseUrl: 'http://wavecode.test:3777',
    token: 'secret-token',
    fetchImpl: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

function tool(name: string) {
  const def = WAVECODE_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`Tool ${name} not defined`);
  return def;
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls.at(-1)! as [string, RequestInit];
  return { url, init, body: init.body ? JSON.parse(init.body as string) : undefined };
}

describe('mcp tools', () => {
  it('covers the full orchestration surface', () => {
    const names = WAVECODE_TOOLS.map((t) => t.name);
    for (const required of [
      'list_agents', 'spawn_agent', 'pin_agent', 'kill_agent', 'stop_all',
      'send_prompt', 'get_agent_output', 'create_task', 'list_tasks', 'get_task',
      'get_run_result',
      'list_reviews', 'request_ai_review', 'get_ai_reviews',
      'promote_run', 'retry_run', 'handoff_run', 'reject_run',
      'send_message', 'list_messages',
      'list_goals', 'get_goal', 'create_goal',
      'list_artifacts', 'upload_artifact', 'attach_artifact', 'share_artifact',
      'list_decisions', 'record_decision',
      'whoami', 'reserve_agent', 'release_agent',
    ]) {
      expect(names).toContain(required);
    }
    // No duplicate names
    expect(new Set(names).size).toBe(names.length);
  });

  it('sends the bearer token on every request', async () => {
    const { client, fetchMock } = makeClient([]);
    await tool('list_agents').handler(client, {});

    const { init } = lastCall(fetchMock);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
  });

  it('spawn_agent posts the pin along with name/runtime', async () => {
    const { client, fetchMock } = makeClient({ id: 'a1' });
    await tool('spawn_agent').handler(client, {
      name: 'grok-fe',
      runtime: 'grok',
      model: 'grok-4.6',
      effort: 'xhigh',
    });

    const { url, init, body } = lastCall(fetchMock);
    expect(url).toBe('http://wavecode.test:3777/api/agents/spawn');
    expect(init.method).toBe('POST');
    // spec §3: the spawned agent is reserved for the calling seat (default 4h)
    expect(body).toEqual({ name: 'grok-fe', runtime: 'grok', model: 'grok-4.6', effort: 'xhigh', reserve_hours: 4 });
  });

  it('pin_agent PATCHes the agent with model/effort', async () => {
    const { client, fetchMock } = makeClient({});
    await tool('pin_agent').handler(client, { agent_id: 'a1', model: 'claude-opus-5', effort: 'high' });

    const { url, init, body } = lastCall(fetchMock);
    expect(url).toBe('http://wavecode.test:3777/api/agents/a1');
    expect(init.method).toBe('PATCH');
    expect(body).toEqual({ model: 'claude-opus-5', effort: 'high' });
  });

  it('promote_run forwards the override reason in the expected casing', async () => {
    const { client, fetchMock } = makeClient({});
    await tool('promote_run').handler(client, {
      run_id: 'r1',
      override_reason: 'known-red baseline accepted',
    });

    const { url, body } = lastCall(fetchMock);
    expect(url).toBe('http://wavecode.test:3777/api/reviews/r1/promote');
    expect(body).toEqual({ overrideReason: 'known-red baseline accepted' });
  });

  it('kill_agent and stop_all hit the safety endpoints', async () => {
    const { client, fetchMock } = makeClient({});
    await tool('kill_agent').handler(client, { agent_id: 'a9' });
    expect(lastCall(fetchMock).url).toBe('http://wavecode.test:3777/api/agents/a9/kill');

    await tool('stop_all').handler(client, {});
    expect(lastCall(fetchMock).url).toBe('http://wavecode.test:3777/api/system/stop-all');
  });

  it('await_events converts wait_seconds to wait_ms and forwards filters', async () => {
    const { client, fetchMock } = makeClient({ events: [], last_id: 12 });
    await tool('await_events').handler(client, {
      since_id: 12,
      wait_seconds: 30,
      types: 'run.*,message.created',
    });
    expect(lastCall(fetchMock).url).toBe(
      'http://wavecode.test:3777/api/events/log?since=12&wait_ms=30000&types=run.*%2Cmessage.created',
    );
  });

  it('create_goal posts the goal plus optional external_id', async () => {
    const { client, fetchMock } = makeClient({ goal: { id: 'g1' } });
    await tool('create_goal').handler(client, {
      goal: 'Employee incoming view',
      external_id: 'F-16',
    });

    const { url, init, body } = lastCall(fetchMock);
    expect(url).toBe('http://wavecode.test:3777/api/goals');
    expect(init.method).toBe('POST');
    expect(body).toEqual({ goal: 'Employee incoming view', external_id: 'F-16' });
  });

  it('create_goal forwards decompose:false for persist-only seeding', async () => {
    const { client, fetchMock } = makeClient({ persist_only: true });
    await tool('create_goal').handler(client, {
      title: 'W0 seed',
      external_id: 'W0',
      decompose: false,
    });

    const { body } = lastCall(fetchMock);
    expect(body).toEqual({ title: 'W0 seed', external_id: 'W0', decompose: false });
  });

  it('get_task fetches the task with runs', async () => {
    const { client, fetchMock } = makeClient({ id: 't1', runs: [] });
    await tool('get_task').handler(client, { task_id: '01TASK' });
    const { url } = lastCall(fetchMock);
    expect(url).toBe('http://wavecode.test:3777/api/tasks/01TASK');
  });

  it('get_run_result wraps GET /api/runs/:id/result', async () => {
    const { client, fetchMock } = makeClient({
      run_id: 'run-1',
      exists: false,
      result: null,
    });
    const payload = await tool('get_run_result').handler(client, { run_id: 'run-1' });
    expect(lastCall(fetchMock).url).toBe('http://wavecode.test:3777/api/runs/run-1/result');
    expect(payload).toMatchObject({ exists: false, result: null });
    expect(payload).not.toMatchObject({ result: 'PASS' });
  });

  it('create_task documents agent_id as existing ID or name', () => {
    const create = tool('create_task');
    expect(create.description).toMatch(/ULID or the name/i);
    expect(create.description).toMatch(/does not spawn/i);
    const agentId = create.schema.agent_id as { description?: string };
    expect(agentId.description).toMatch(/ID or name/i);
  });

  it('create_task forwards goal_id and hold', async () => {
    const { client, fetchMock } = makeClient({ id: 't1' });
    await tool('create_task').handler(client, {
      prompt: 'Add /incoming',
      goal_id: 'W0',
      hold: true,
      agent_id: 'agent-1',
    });

    const { url, body } = lastCall(fetchMock);
    expect(url).toBe('http://wavecode.test:3777/api/tasks');
    expect(body).toEqual({
      prompt: 'Add /incoming',
      goal_id: 'W0',
      hold: true,
      agent_id: 'agent-1',
    });
  });

  it('upload_artifact posts JSON base64 and list/attach wrap REST', async () => {
    const { client, fetchMock } = makeClient({ id: 'art-1' });
    await tool('upload_artifact').handler(client, {
      filename: 'brief.md',
      content_base64: Buffer.from('# hi').toString('base64'),
      agent_id: 'agent-1',
    });
    const uploaded = lastCall(fetchMock);
    expect(uploaded.url).toBe('http://wavecode.test:3777/api/artifacts/upload');
    expect(uploaded.init.method).toBe('POST');
    expect(uploaded.body).toEqual({
      filename: 'brief.md',
      content_base64: Buffer.from('# hi').toString('base64'),
      agent_id: 'agent-1',
    });

    await tool('list_artifacts').handler(client, { agent_id: 'agent-1' });
    expect(lastCall(fetchMock).url).toBe(
      'http://wavecode.test:3777/api/artifacts?agent_id=agent-1',
    );

    await tool('attach_artifact').handler(client, {
      artifact_id: 'art-1',
      agent_id: 'agent-1',
    });
    const attached = lastCall(fetchMock);
    expect(attached.url).toBe('http://wavecode.test:3777/api/artifacts/art-1/attach');
    expect(attached.body).toEqual({ agent_id: 'agent-1' });

    await tool('share_artifact').handler(client, {
      artifact_id: 'art-1',
      agent_id: 'agent-1',
    });
    const shared = lastCall(fetchMock);
    expect(shared.url).toBe('http://wavecode.test:3777/api/artifacts/art-1/share');
    expect(shared.body).toEqual({ agent_id: 'agent-1', targetAgentId: 'agent-1' });
  });

  it('upload_artifact reads a local path and posts base64', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-mcp-art-'));
    const filePath = path.join(tmp, 'drop.txt');
    fs.writeFileSync(filePath, 'from chat');
    const { client, fetchMock } = makeClient({ id: 'art-2' });

    await tool('upload_artifact').handler(client, { path: filePath, agent_id: 'agent-9' });

    const { body } = lastCall(fetchMock);
    expect(body).toEqual({
      filename: 'drop.txt',
      content_base64: Buffer.from('from chat').toString('base64'),
      agent_id: 'agent-9',
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('get_goal and list_goals hit the goals API', async () => {
    const { client, fetchMock } = makeClient([]);
    await tool('list_goals').handler(client, {});
    expect(lastCall(fetchMock).url).toBe('http://wavecode.test:3777/api/goals');

    await tool('get_goal').handler(client, { goal_id: 'F-16' });
    expect(lastCall(fetchMock).url).toBe('http://wavecode.test:3777/api/goals/F-16');
  });

  it('record_decision and list_decisions wrap the decisions API', async () => {
    const { client, fetchMock } = makeClient([]);
    await tool('record_decision').handler(client, {
      workspace: '/ws/countix',
      summary: 'employee view IS /incoming, stripped by role',
    });
    const posted = lastCall(fetchMock);
    expect(posted.url).toBe('http://wavecode.test:3777/api/decisions');
    expect(posted.init.method).toBe('POST');
    expect(posted.body).toEqual({
      workspace: '/ws/countix',
      summary: 'employee view IS /incoming, stripped by role',
    });

    await tool('list_decisions').handler(client, { workspace: '/ws/countix' });
    expect(lastCall(fetchMock).url).toBe(
      'http://wavecode.test:3777/api/decisions?workspace=%2Fws%2Fcountix',
    );
  });

  it('list_messages builds query params from filters', async () => {
    const { client, fetchMock } = makeClient([]);
    await tool('list_messages').handler(client, { to_agent_id: 'a1', limit: 10 });
    expect(lastCall(fetchMock).url).toBe(
      'http://wavecode.test:3777/api/messages?to_agent_id=a1&limit=10',
    );
  });

  it('surfaces daemon errors with the server-provided message', async () => {
    const { client } = makeClient({ error: 'Promotion blocked: no completed review exists for this run.' }, 400);

    await expect(tool('promote_run').handler(client, { run_id: 'r1' }))
      .rejects.toThrow(/Promotion blocked/);
  });

  it('every tool declares a description and a handler', () => {
    for (const def of WAVECODE_TOOLS) {
      expect(def.description.length).toBeGreaterThan(20);
      expect(typeof def.handler).toBe('function');
      expect(def.schema).toBeDefined();
    }
  });
});


describe('mcp tools — identity & leases (spec §3)', () => {
  it('whoami GETs /api/me', async () => {
    const { client, fetchMock } = makeClient({ id: 'u1', name: 'ana', role: 'developer' });
    const me = await tool('whoami').handler(client, {});
    expect(me).toEqual({ id: 'u1', name: 'ana', role: 'developer' });
    expect(lastCall(fetchMock).url).toBe('http://wavecode.test:3777/api/me');
  });

  it('reserve_agent posts hours (or nothing) and release_agent posts release', async () => {
    const { client, fetchMock } = makeClient({});
    await tool('reserve_agent').handler(client, { agent: 'grok-fe', hours: 2 });
    expect(lastCall(fetchMock)).toMatchObject({ url: 'http://wavecode.test:3777/api/agents/grok-fe/reserve', body: { hours: 2 } });
    await tool('reserve_agent').handler(client, { agent: 'grok-fe' });
    expect(lastCall(fetchMock).body).toEqual({});
    await tool('release_agent').handler(client, { agent: 'grok fe' });
    expect(lastCall(fetchMock).url).toBe('http://wavecode.test:3777/api/agents/grok%20fe/release');
  });

  it('spawn_agent honors an explicit reserve_hours', async () => {
    const { client, fetchMock } = makeClient({ id: 'a1' });
    await tool('spawn_agent').handler(client, { name: 'x', runtime: 'codex', reserve_hours: 12 });
    expect(lastCall(fetchMock).body).toEqual({ name: 'x', runtime: 'codex', reserve_hours: 12 });
  });
});

/**
 * End to end: tools → WaveCodeClient → real auth middleware + routes + SQLite.
 * Each user gets its own client bearing its own token, exactly like an MCP seat.
 */
describe('mcp tools — acting as the token\'s user (end to end)', () => {
  const FALLBACK = 'fallback-admin';
  let tmpDir: string;
  let db: typeof import('../server/db.js');
  let seats: Record<'admin' | 'ana' | 'bob' | 'watcher', WaveCodeClient>;
  let ids: Record<'ana' | 'bob', string>;

  async function call(seat: WaveCodeClient, name: string, args: Record<string, unknown> = {}) {
    return tool(name).handler(seat, args) as Promise<any>;
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-mcp-e2e-'));
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), [
      'auth:', '  method: token', `  fallback_token: ${FALLBACK}`,
      'autonomy:', '  auto_dispatch: false',
      'artifacts:', `  storage: ${path.join(tmpDir, 'artifacts')}`, '',
    ].join('\n'));
    const config = await import('../server/config.js');
    config.loadConfig(path.join(tmpDir, 'config.yaml'));
    db = await import('../server/db.js');
    db.resetDbForTest();
    db.initDb(path.join(tmpDir, 'test.db'));

    const { createAuthMiddleware } = await import('../server/auth.js');
    const { registerAgentRoutes } = await import('../server/routes/agents.js');
    const { registerSystemRoutes } = await import('../server/routes/system.js');
    const { registerReviewRoutes } = await import('../server/routes/reviews.js');
    const { registerTaskRoutes } = await import('../server/routes/tasks.js');
    const { registerUserRoutes } = await import('../server/routes/users.js');
    const app = new Hono<import('../server/auth.js').NodeAppEnv>();
    app.use('/api/*', createAuthMiddleware());
    registerSystemRoutes(app);
    registerAgentRoutes(app);
    registerReviewRoutes(app);
    registerTaskRoutes(app);
    registerUserRoutes(app);

    const { createUser } = await import('../server/users.js');
    const mk = (name: string, role: 'developer' | 'observer') => {
      const r = createUser({ name, role });
      if (!r.ok) throw new Error(r.error);
      return r.data;
    };
    const ana = mk('ana', 'developer');
    const bob = mk('bob', 'developer');
    const watcher = mk('watcher', 'observer');
    ids = { ana: ana.user.id, bob: bob.user.id };

    const fetchImpl = ((input: string, init?: RequestInit) => app.request(input, init)) as unknown as typeof fetch;
    const seat = (token: string) => new WaveCodeClient({ baseUrl: 'http://daemon.test', token, fetchImpl });
    seats = { admin: seat(FALLBACK), ana: seat(ana.token), bob: seat(bob.token), watcher: seat(watcher.token) };
  });

  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('whoami reports the token\'s user', async () => {
    expect(await call(seats.ana, 'whoami')).toMatchObject({ name: 'ana', role: 'developer' });
    expect(await call(seats.admin, 'whoami')).toMatchObject({ name: 'owner', role: 'admin' });
  });

  it('spawn_agent leaves the new agent reserved for the caller for 4h', async () => {
    const before = Date.now();
    const spawned = await call(seats.ana, 'spawn_agent', { name: 'grok-fe', runtime: 'grok' });
    expect(spawned).toMatchObject({ owner: 'ana', lease: { owner: 'ana', owner_id: ids.ana, reason: 'reserved' }, can_act: true });
    const hours = (Date.parse(spawned.lease.expires_at) - before) / 3_600_000;
    expect(hours).toBeGreaterThan(3.99);
    expect(hours).toBeLessThan(4.01);

    // A teammate cannot grab it
    await expect(call(seats.bob, 'send_prompt', { agent_id: 'grok-fe', text: 'mine now' }))
      .rejects.toThrow('Agent grok-fe is owned by ana');
    await expect(call(seats.bob, 'reserve_agent', { agent: 'grok-fe' })).rejects.toThrow(/owned by ana/);
  });

  it('list_agents returns owner, lease and per-caller can_act', async () => {
    await call(seats.ana, 'spawn_agent', { name: 'grok-fe', runtime: 'grok' });
    await call(seats.admin, 'spawn_agent', { name: 'free-one', runtime: 'codex' });
    await call(seats.admin, 'release_agent', { agent: 'free-one' });

    const asBob = await call(seats.bob, 'list_agents') as Array<Record<string, any>>;
    const byName = Object.fromEntries(asBob.map((a) => [a.name, a]));
    expect(byName['grok-fe']).toMatchObject({ owner: 'ana', lease: { reason: 'reserved' }, can_act: false });
    expect(byName['free-one']).toMatchObject({ owner: null, lease: null, can_act: true });

    const asAna = await call(seats.ana, 'list_agents') as Array<Record<string, any>>;
    expect(asAna.find((a) => a.name === 'grok-fe')?.can_act).toBe(true);
  });

  it('reserve_agent / release_agent round-trip', async () => {
    await call(seats.admin, 'spawn_agent', { name: 'seat', runtime: 'codex', reserve_hours: 1 });
    await call(seats.admin, 'release_agent', { agent: 'seat' });

    const reserved = await call(seats.bob, 'reserve_agent', { agent: 'seat', hours: 2 });
    expect(reserved).toMatchObject({ owner: 'bob', lease: { reason: 'reserved' } });
    await expect(call(seats.ana, 'release_agent', { agent: 'seat' })).rejects.toThrow(/owned by bob/);
    const released = await call(seats.bob, 'release_agent', { agent: 'seat' });
    expect(released).toMatchObject({ owner: null, lease: null });
  });

  it('stop_all is refused for non-admin tokens with a clear error, allowed for admin', async () => {
    await expect(call(seats.ana, 'stop_all')).rejects.toThrow(
      'Forbidden: stop-all is admin only (you are ana, developer)',
    );
    expect(await call(seats.admin, 'stop_all')).toMatchObject({ ok: true, auto_dispatch_disabled: true });
  });

  it('promote_run with override_reason is refused for non-admin tokens', async () => {
    await expect(call(seats.ana, 'promote_run', { run_id: 'run-1', override_reason: 'ship it' })).rejects.toThrow(
      /override-promote is admin only \(you are ana, developer\)/,
    );
    // Without an override the request reaches the normal promote path (unknown run → 400, not 403)
    await expect(call(seats.ana, 'promote_run', { run_id: 'run-1' })).rejects.not.toThrow(/admin only/);
  });

  it('observer tokens can read but every mutating tool is refused', async () => {
    await call(seats.admin, 'spawn_agent', { name: 'seat', runtime: 'codex' });
    expect(await call(seats.watcher, 'whoami')).toMatchObject({ role: 'observer' });
    expect(Array.isArray(await call(seats.watcher, 'list_agents'))).toBe(true);
    expect(await call(seats.watcher, 'get_agent_output', { agent_id: 'seat' })).toMatchObject({ output: 'output' });

    for (const [name, args] of [
      ['send_prompt', { agent_id: 'seat', text: 'x' }],
      ['reserve_agent', { agent: 'seat' }],
      ['release_agent', { agent: 'seat' }],
      ['kill_agent', { agent_id: 'seat' }],
      ['spawn_agent', { name: 'n', runtime: 'codex' }],
      ['create_task', { prompt: 'x' }],
      ['stop_all', {}],
      ['promote_run', { run_id: 'r' }],
    ] as const) {
      await expect(call(seats.watcher, name, args as Record<string, unknown>), name).rejects.toThrow(/observer/);
    }
  });

  it('events written through MCP tools carry the seat\'s actor_id', async () => {
    await call(seats.ana, 'spawn_agent', { name: 'grok-fe', runtime: 'grok' });
    await call(seats.ana, 'send_prompt', { agent_id: 'grok-fe', text: 'go' });
    const actors = Object.fromEntries(db.listEvents().map((e) => [e.type, e.actor_id]));
    expect(actors['agent.spawned']).toBe(ids.ana);
    expect(actors['agent.reserved']).toBe(ids.ana);
    expect(actors['agent.prompt_sent']).toBe(ids.ana);
  });
});
