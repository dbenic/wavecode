/**
 * Spec §5c server side: aliases, personas, tag groups, alias → name → id
 * resolution across routes, people addressing, task numbers and the
 * thread items commands produce. Real SQLite + auth + routes; tmux faked.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const harness = vi.hoisted(() => ({ typed: [] as Array<{ agentId: string; text: string }> }));

vi.mock('./session-manager.js', async () => {
  const db = await vi.importActual<typeof import('./db.js')>('./db.js');
  return {
    get: (ref: string) => db.resolveAgent(ref),
    sendKeys: vi.fn((agentId: string, text: string) => {
      harness.typed.push({ agentId, text });
      return { ok: true, data: undefined };
    }),
    sendRawKeys: vi.fn(() => ({ ok: true, data: undefined })),
    capturePane: vi.fn(() => ({ ok: true, data: '❯ ' })),
    kill: vi.fn(() => ({ ok: true, data: undefined })),
    detach: vi.fn(() => ({ ok: true, data: undefined })),
  };
});

vi.mock('./tmux.js', () => ({
  hasSession: vi.fn(() => true),
  capturePane: vi.fn(() => ({ ok: true, data: '❯ \n  ⏵⏵ bypass permissions on' })),
  sendTextAndEnter: vi.fn(),
  isAllowedRawKey: vi.fn(() => true),
}));

vi.mock('./output-watcher.js', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  getLastOutputLine: vi.fn(() => null),
  getOutputVersion: vi.fn(() => 0),
  isWatching: vi.fn(() => false),
}));

vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined) }));

vi.mock('./logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const FALLBACK = 'fallback-admin';
type App = Hono<import('./auth.js').NodeAppEnv>;

describe('aliases, personas, groups, people (spec §5c)', () => {
  let tmpDir: string;
  let db: typeof import('./db.js');
  let identity: typeof import('./agent-identity.js');
  let app: App;
  let ana: { id: string; token: string };
  let bob: { id: string; token: string };
  const agents: Record<string, import('./db.js').Agent> = {};

  async function call(method: string, url: string, body?: unknown, token = ana.token) {
    const res = await app.request(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  beforeEach(async () => {
    harness.typed.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-5c-'));
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), [
      'auth:', '  method: token', `  fallback_token: ${FALLBACK}`,
      'autonomy:', '  auto_dispatch: false',
      'artifacts:', `  storage: ${path.join(tmpDir, 'artifacts')}`, '',
    ].join('\n'));
    (await import('./config.js')).loadConfig(path.join(tmpDir, 'config.yaml'));
    db = await import('./db.js');
    db.resetDbForTest();
    db.initDb(path.join(tmpDir, 'test.db'));
    identity = await import('./agent-identity.js');

    const { createAuthMiddleware } = await import('./auth.js');
    app = new Hono();
    app.use('/api/*', createAuthMiddleware());
    (await import('./routes/agents.js')).registerAgentRoutes(app);
    (await import('./routes/messages.js')).registerMessageRoutes(app);
    (await import('./routes/tasks.js')).registerTaskRoutes(app);
    (await import('./routes/thread.js')).registerThreadRoutes(app);

    const { createUser } = await import('./users.js');
    const mk = (name: string) => {
      const r = createUser({ name });
      if (!r.ok) throw new Error(r.error);
      return { id: r.data.user.id, token: r.data.token };
    };
    ana = mk('ana');
    bob = mk('bob');

    for (const name of ['claude-fe-1', 'codex-be-2', 'grok-x']) {
      const a = db.insertAgent({ name, runtime: 'claude-code', tmux_session: `wc-${name}`, workspace: null, mode: 'spawned', status: 'idle' });
      if (!a.ok) throw new Error(a.error);
      agents[name] = a.data;
    }
  });

  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('validation', () => {
    it('alias: pattern, reserved words, and no clash with agents, tags or people', () => {
      expect(identity.validateAlias('toni', agents['grok-x'].id)).toEqual({ ok: true, data: 'toni' });
      expect(identity.validateAlias(null, agents['grok-x'].id)).toEqual({ ok: true, data: null });
      for (const bad of ['T', 'toni!', '1toni', 'a', 'x'.repeat(25), 'Toni']) {
        expect(identity.validateAlias(bad, agents['grok-x'].id).ok, bad).toBe(false);
      }
      expect(identity.validateAlias('all', agents['grok-x'].id)).toMatchObject({ ok: false, error: expect.stringMatching(/reserved/) });
      expect(identity.validateAlias('claude-fe-1', agents['grok-x'].id)).toMatchObject({ ok: false, error: expect.stringMatching(/already used/) });
      expect(identity.validateAlias('claude-fe-1', agents['claude-fe-1'].id).ok).toBe(true); // its own name is fine
      expect(identity.validateAlias('ana', agents['grok-x'].id)).toMatchObject({ ok: false, error: expect.stringMatching(/person/) });
      db.addAgentTag(agents['grok-x'].id, 'frontend');
      expect(identity.validateAlias('frontend', agents['codex-be-2'].id)).toMatchObject({ ok: false, error: expect.stringMatching(/group tag/) });
    });

    it('tag and persona rules', () => {
      expect(identity.validateTag('frontend')).toEqual({ ok: true, data: 'frontend' });
      expect(identity.validateTag('grok-x').ok).toBe(false);
      expect(identity.validateTag('bob').ok).toBe(false);
      expect(identity.validatePersona('frontend lead')).toEqual({ ok: true, data: 'frontend lead' });
      expect(identity.validatePersona('a\nb').ok).toBe(false);
      expect(identity.validatePersona('x'.repeat(81)).ok).toBe(false);
      expect(identity.validatePersona('')).toEqual({ ok: true, data: null });
    });

    it('withPersona prefixes `[you are @alias — persona]` only when a persona is set', () => {
      expect(identity.withPersona({ alias: 'toni', name: 'claude-fe-1', persona: 'frontend lead' }, 'go'))
        .toBe('[you are @toni — frontend lead] go');
      expect(identity.withPersona({ alias: null, name: 'claude-fe-1', persona: 'lead' }, 'go')).toBe('[you are @claude-fe-1 — lead] go');
      expect(identity.withPersona({ alias: 'toni', name: 'x', persona: null }, 'go')).toBe('go');
    });
  });

  describe('resolution: alias → name → id', () => {
    it('resolveAgent and resolveAddress (agent → group → person)', () => {
      db.updateAgentIdentity(agents['claude-fe-1'].id, { alias: 'toni' });
      expect(db.resolveAgent('toni').ok && (db.resolveAgent('toni') as { data: { name: string } }).data.name).toBe('claude-fe-1');
      expect((db.resolveAgent('@toni') as { data: { name: string } }).data.name).toBe('claude-fe-1');
      expect((db.resolveAgent('codex-be-2') as { data: { name: string } }).data.name).toBe('codex-be-2');
      expect((db.resolveAgent(agents['grok-x'].id) as { data: { name: string } }).data.name).toBe('grok-x');
      expect(db.resolveAgent('nobody').ok).toBe(false);

      db.addAgentTag(agents['claude-fe-1'].id, 'frontend');
      db.addAgentTag(agents['grok-x'].id, 'frontend');
      expect(identity.resolveAddress('@toni')).toMatchObject({ kind: 'agent', agent: { name: 'claude-fe-1' } });
      const group = identity.resolveAddress('@frontend');
      expect(group?.kind === 'group' && group.agents.map((a) => a.name)).toEqual(['claude-fe-1', 'grok-x']);
      expect(identity.resolveAddress('@ana')).toMatchObject({ kind: 'user', user: { name: 'ana' } });
      expect(identity.resolveAddress('@owner')).toMatchObject({ kind: 'user', user: { id: 'owner' } });
      expect(identity.resolveAddress('@ghost')).toBeNull();
    });

    it('routes accept the alias anywhere an agent is named', async () => {
      expect((await call('PATCH', `/api/agents/${agents['claude-fe-1'].id}`, { alias: 'toni' })).status).toBe(200);
      expect((await call('GET', '/api/agents/toni')).json).toMatchObject({ name: 'claude-fe-1', alias: 'toni' });
      expect((await call('POST', '/api/agents/toni/send', { text: 'hi' })).status).toBe(200);
      expect(harness.typed.at(-1)).toEqual({ agentId: agents['claude-fe-1'].id, text: 'hi' });
      const task = await call('POST', '/api/tasks', { prompt: 'x', agent_id: '@toni', hold: true });
      expect(task.json.agent_id).toBe(agents['claude-fe-1'].id);
      const msg = await call('POST', '/api/messages', { to: 'toni', message: 'ping' });
      expect(msg.json.to_agent_id).toBe(agents['claude-fe-1'].id);
    });
  });

  describe('PATCH alias / persona', () => {
    it('sets, conflicts (409), validates (400), clears, and is owner/admin only', async () => {
      const id = agents['claude-fe-1'].id;
      const res = await call('PATCH', `/api/agents/${id}`, { alias: 'toni', persona: 'frontend lead' });
      expect(res.json).toMatchObject({ alias: 'toni', persona: 'frontend lead' });
      expect((await call('PATCH', `/api/agents/${agents['grok-x'].id}`, { alias: 'toni' })).status).toBe(409);
      expect((await call('PATCH', `/api/agents/${id}`, { alias: 'Bad!' })).status).toBe(400);
      expect((await call('PATCH', `/api/agents/${id}`, { persona: 'two\nlines' })).status).toBe(400);

      await call('POST', `/api/agents/${id}/reserve`, {});
      expect((await call('PATCH', `/api/agents/${id}`, { alias: 'mine' }, bob.token)).status).toBe(403);
      expect((await call('PATCH', `/api/agents/${id}`, { alias: null })).json.alias).toBeNull();
      expect((await call('PATCH', `/api/agents/${id}`, {})).status).toBe(400);
    });

    it('the persona is prepended to what is typed; the thread shows what the person wrote', async () => {
      const id = agents['claude-fe-1'].id;
      await call('PATCH', `/api/agents/${id}`, { alias: 'toni', persona: 'frontend lead' });
      await call('POST', '/api/agents/toni/send', { text: 'what are you on?' });
      expect(harness.typed.at(-1)?.text).toBe('[you are @toni — frontend lead] what are you on?');
      const prompt = (await call('GET', '/api/thread')).json.items.find((i: { kind: string }) => i.kind === 'prompt');
      expect(prompt.body).toBe('what are you on?');

      await call('POST', '/api/messages', { to: 'toni', message: 'use the new tokens' });
      expect(harness.typed.at(-1)?.text).toBe('[you are @toni — frontend lead] [from ana] use the new tokens');
    });

    it('a rename shows as the user\'s command item', async () => {
      await call('PATCH', `/api/agents/${agents['claude-fe-1'].id}`, { alias: 'toni', persona: 'frontend lead' });
      const item = (await call('GET', '/api/thread')).json.items.find((i: { kind: string }) => i.kind === 'command');
      expect(item).toMatchObject({ title: 'rename claude-fe-1 → @toni', body: 'frontend lead', actor_id: ana.id });
    });
  });

  describe('tag groups', () => {
    it('add/remove tags, listed on agents, owner/admin only, validated', async () => {
      const id = agents['claude-fe-1'].id;
      expect((await call('POST', `/api/agents/${id}/tags`, { tag: 'frontend' })).json.tags).toEqual(['frontend']);
      await call('POST', `/api/agents/${agents['grok-x'].id}/tags`, { tag: 'frontend' });
      const listed = (await call('GET', '/api/agents')).json as Array<{ name: string; tags: string[] }>;
      expect(listed.filter((a) => a.tags.includes('frontend')).map((a) => a.name)).toEqual(['claude-fe-1', 'grok-x']);
      expect((await call('POST', `/api/agents/${id}/tags`, { tag: 'grok-x' })).status).toBe(400);

      const items = (await call('GET', '/api/thread')).json.items as Array<{ kind: string; title: string }>;
      expect(items.filter((i) => i.kind === 'command').map((i) => i.title)).toEqual(['#tag @claude-fe-1 frontend', '#tag @grok-x frontend']);

      await call('POST', `/api/agents/${id}/reserve`, {});
      expect((await call('POST', `/api/agents/${id}/tags`, { tag: 'mine' }, bob.token)).status).toBe(403);
      expect((await call('DELETE', `/api/agents/${id}/tags/frontend`)).json.tags).toEqual([]);
      expect((await call('DELETE', `/api/agents/${id}/tags/frontend`)).status).toBe(404);
    });
  });

  describe('commands appear as the user\'s thread items', () => {
    it('#reserve @toni 2h → one request, lease on the card, command item', async () => {
      await call('PATCH', `/api/agents/${agents['claude-fe-1'].id}`, { alias: 'toni' });
      const reserved = await call('POST', '/api/agents/toni/reserve', { hours: 2 });
      expect(reserved.status).toBe(200);
      const card = ((await call('GET', '/api/agents')).json as Array<Record<string, any>>).find((a) => a.alias === 'toni')!;
      expect(card.lease).toMatchObject({ owner: 'ana', reason: 'reserved' });
      expect((Date.parse(card.lease.expires_at) - Date.now()) / 3_600_000).toBeCloseTo(2, 1);

      await call('POST', '/api/agents/toni/release');
      await call('POST', `/api/agents/${agents['grok-x'].id}/kill`);
      const titles = ((await call('GET', '/api/thread')).json.items as Array<{ kind: string; title: string; actor_id: string }>)
        .filter((i) => i.kind === 'command');
      expect(titles.map((i) => i.title.replace(/ · until .*/, ' · until …'))).toEqual([
        'rename claude-fe-1 → @toni', '#reserve @toni · until …', '#release @toni', '#kill @grok-x',
      ]);
      expect(titles.every((i) => i.actor_id === ana.id)).toBe(true);
    });

    it('system leases (task auto-lease, expiry) are not shown as commands', async () => {
      const { emit } = await import('./event-bus.js');
      emit('agent.reserved', 'agent', agents['grok-x'].id, { reason: 'task', owner: 'ana' }, null);
      expect(((await call('GET', '/api/thread')).json.items as Array<{ kind: string }>).filter((i) => i.kind === 'command')).toEqual([]);
    });
  });

  describe('task numbers', () => {
    it('tasks get sequential numbers; #n works in depends_on', async () => {
      const t1 = await call('POST', '/api/tasks', { prompt: 'one', hold: true });
      const t2 = await call('POST', '/api/tasks', { prompt: 'two', hold: true, depends_on: [`#${t1.json.num}`] });
      expect(t1.json.num).toBe(1);
      expect(t2.json.num).toBe(2);
      expect(t2.json.dependencies).toEqual([t1.json.id]);
      expect((await call('POST', '/api/tasks', { prompt: 'x', depends_on: ['#99'] })).status).toBe(400);
      expect((db.getTaskByNum(2) as { data: { prompt: string } }).data.prompt).toBe('two');
    });
  });

  describe('people', () => {
    it('@user: stored for the person, in their Attention inbox only, mirrored to notifications', async () => {
      const { notify } = await import('./notifications.js');
      const res = await call('POST', '/api/messages', { to_user: '@bob', message: 'can you approve T7?' });
      expect(res.status).toBe(201);
      expect(res.json.to_user_id).toBe(bob.id);
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'ana → @bob', body: 'can you approve T7?' }));
      expect(harness.typed).toEqual([]); // a person, not a pane

      const forBob = (await call('GET', '/api/thread', undefined, bob.token)).json.items.find((i: { title: string }) => i.title === 'Message for @bob');
      expect(forBob).toMatchObject({ needs_attention: true, body: 'can you approve T7?', actor_id: ana.id });
      const forAna = (await call('GET', '/api/thread')).json.items.find((i: { title: string }) => i.title === 'Message for @bob');
      expect(forAna.needs_attention).toBe(false);

      expect((await call('POST', '/api/messages', { to_user: 'ghost', message: 'x' })).status).toBe(400);
      expect((await call('POST', '/api/messages', { to_user: 'bob', to: 'grok-x', message: 'x' })).status).toBe(400);
    });

    it('wavecode msg resolves @person, @group and aliases', async () => {
      const { resolveMsgTarget } = await import('../cli/msg-command.js');
      db.updateAgentIdentity(agents['claude-fe-1'].id, { alias: 'toni' });
      db.addAgentTag(agents['claude-fe-1'].id, 'frontend');
      db.addAgentTag(agents['grok-x'].id, 'frontend');
      expect(resolveMsgTarget('all')).toEqual({ ok: true, data: { kind: 'all' } });
      expect(resolveMsgTarget('toni')).toEqual({ ok: true, data: { kind: 'agents', agentIds: [agents['claude-fe-1'].id], label: 'toni' } });
      expect(resolveMsgTarget('@frontend')).toEqual({ ok: true, data: { kind: 'agents', agentIds: [agents['claude-fe-1'].id, agents['grok-x'].id], label: '@frontend' } });
      expect(resolveMsgTarget('@bob')).toEqual({ ok: true, data: { kind: 'user', userId: bob.id, name: 'bob' } });
      expect(resolveMsgTarget('@ghost').ok).toBe(false);
    });
  });
});
