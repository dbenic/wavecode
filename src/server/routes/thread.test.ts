/**
 * GET /api/thread over HTTP (auth, query parsing, long-poll) and the
 * reply-injection / restart endpoints its actions point at.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pane = { state: 'alive' as 'alive' | 'dead' | 'unknown' };

vi.mock('../session-manager.js', async () => {
  const db = await vi.importActual<typeof import('../db.js')>('../db.js');
  return {
    // reply-capture snapshots the pane when a prompt is tracked (baseline for unanchored answers)
    capturePane: vi.fn(() => ({ ok: true, data: '' })),
    get: (idOrName: string) => {
      const byId = db.getAgent(idOrName);
      return byId.ok ? byId : db.getAgentByName(idOrName);
    },
    sendKeys: vi.fn(() => ({ ok: true, data: undefined })),
    ensureSpawnedAgentSession: vi.fn(),
    kill: vi.fn(() => ({ ok: true, data: undefined })),
  };
});

vi.mock('../runtime-liveness.js', () => ({
  getRuntimeState: vi.fn(() => pane.state),
  relaunchRuntime: vi.fn(() => ({ ok: true, data: { sent: true } })),
}));

vi.mock('../output-watcher.js', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  getLastOutputLine: vi.fn(() => null),
  getOutputVersion: vi.fn(() => 0),
  isWatching: vi.fn(() => false),
}));

vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const FALLBACK = 'fallback-admin';
type App = Hono<import('../auth.js').NodeAppEnv>;

async function call(app: App, method: string, url: string, token: string, body?: unknown) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe('thread + reply routes', () => {
  let tmpDir: string;
  let app: App;
  let db: typeof import('../db.js');
  let sm: typeof import('../session-manager.js');
  let liveness: typeof import('../runtime-liveness.js');
  let ana: { id: string; token: string };
  let bob: { id: string; token: string };
  let watcher: { id: string; token: string };
  let seat: import('../db.js').Agent;

  beforeEach(async () => {
    vi.clearAllMocks();
    pane.state = 'alive';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-thread-routes-'));
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), [
      'auth:', '  method: token', `  fallback_token: ${FALLBACK}`,
      'autonomy:', '  auto_dispatch: false',
      'artifacts:', `  storage: ${path.join(tmpDir, 'artifacts')}`, '',
    ].join('\n'));
    (await import('../config.js')).loadConfig(path.join(tmpDir, 'config.yaml'));
    db = await import('../db.js');
    db.resetDbForTest();
    db.initDb(path.join(tmpDir, 'test.db'));
    sm = await import('../session-manager.js');
    liveness = await import('../runtime-liveness.js');

    const { createAuthMiddleware } = await import('../auth.js');
    app = new Hono();
    app.use('/api/*', createAuthMiddleware());
    (await import('./thread.js')).registerThreadRoutes(app);
    (await import('./messages.js')).registerMessageRoutes(app);
    (await import('./agents.js')).registerAgentRoutes(app);

    const { createUser } = await import('../users.js');
    const mk = (name: string, role: 'developer' | 'observer') => {
      const r = createUser({ name, role });
      if (!r.ok) throw new Error(r.error);
      return { id: r.data.user.id, token: r.data.token };
    };
    ana = mk('ana', 'developer');
    bob = mk('bob', 'developer');
    watcher = mk('watcher', 'observer');

    const created = db.insertAgent({ name: 'grok-fe', runtime: 'grok', tmux_session: 'wc-grok-fe', workspace: null, mode: 'spawned', status: 'idle' });
    if (!created.ok) throw new Error(created.error);
    seat = created.data;
    const { reserveAgent } = await import('../leases.js');
    reserveAgent(seat.id, { id: ana.id });
  });

  afterEach(() => {
    vi.useRealTimers();
    db.resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /api/thread', () => {
    it('returns typed items with per-viewer actions', async () => {
      db.insertEvent({ type: 'agent.crashed', entity_type: 'agent', entity_id: seat.id, payload: {} });

      const asAna = await call(app, 'GET', '/api/thread', ana.token);
      expect(asAna.status).toBe(200);
      const crash = asAna.json.items.find((i: { kind: string }) => i.kind === 'alert');
      expect(crash.actions.map((a: { id: string }) => a.id)).toEqual(['restart', 'kill']);

      const asBob = await call(app, 'GET', '/api/thread?kinds=alert', bob.token);
      expect(asBob.json.items).toHaveLength(1);
      expect(asBob.json.items[0].actions).toEqual([]);
      expect(typeof asBob.json.cursor).toBe('number');
    });

    it('filters by agent and attention, rejects unknown kinds', async () => {
      db.insertEvent({ type: 'agent.prompt_sent', entity_type: 'agent', entity_id: seat.id, payload: { text: 'hi' } });
      db.insertEvent({ type: 'agent.crashed', entity_type: 'agent', entity_id: 'other', payload: {} });
      const page = await call(app, 'GET', `/api/thread?agent=${seat.id}`, ana.token);
      expect(page.json.items.map((i: { kind: string }) => i.kind)).toEqual(['prompt']);
      const attention = await call(app, 'GET', '/api/thread?attention=1', ana.token);
      expect(attention.json.items.map((i: { kind: string }) => i.kind)).toEqual(['alert']);
      expect((await call(app, 'GET', '/api/thread?kinds=bogus', ana.token)).status).toBe(400);
    });

    it('observers may read the thread', async () => {
      expect((await call(app, 'GET', '/api/thread', watcher.token)).status).toBe(200);
    });

    it('long-polls with since + wait_ms until something new arrives', async () => {
      const first = await call(app, 'GET', '/api/thread', ana.token);
      const pending = call(app, 'GET', `/api/thread?since=${first.json.cursor}&wait_ms=5000`, ana.token);
      setTimeout(() => {
        db.insertEvent({ type: 'agent.hung', entity_type: 'agent', entity_id: seat.id, payload: { stale_minutes: 3 } });
      }, 700);
      const started = Date.now();
      const res = await pending;
      expect(res.json.items.map((i: { title: string }) => i.title)).toEqual(['Agent appears hung (3m silent)']);
      expect(Date.now() - started).toBeLessThan(4000);
    });

    it('returns an empty page when wait_ms expires', async () => {
      const first = await call(app, 'GET', '/api/thread', ana.token);
      const res = await call(app, 'GET', `/api/thread?since=${first.json.cursor}&wait_ms=600`, ana.token);
      expect(res.json).toEqual({ items: [], cursor: first.json.cursor });
    });
  });

  describe('POST /api/messages reply injection', () => {
    it('to=<agent name> persists the message and types [from <user>] … into its tmux', async () => {
      const res = await call(app, 'POST', '/api/messages', ana.token, { to: 'grok-fe', message: 'use wavecode.db', ref_task_id: 't1' });
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({ to_agent_id: seat.id, message: 'use wavecode.db', ref_task_id: 't1', injected: true });
      expect(sm.sendKeys).toHaveBeenCalledWith(seat.id, '[from ana] use wavecode.db');

      const thread = await call(app, 'GET', `/api/thread?agent=${seat.id}`, ana.token);
      expect(thread.json.items.at(-1)).toMatchObject({ kind: 'report', title: 'Reply', actor_id: ana.id, body: 'use wavecode.db' });
    });

    it('refuses a reply into an agent someone else owns (rule 2) without persisting it', async () => {
      const res = await call(app, 'POST', '/api/messages', bob.token, { to: seat.id, message: 'hijack' });
      expect(res.status).toBe(403);
      expect(res.json.error).toBe('Agent grok-fe is owned by ana');
      expect(sm.sendKeys).not.toHaveBeenCalled();
      expect(db.listAgentMessages({})).toHaveLength(0);
    });

    it('never types into a bare shell — the message is kept and the failure reported', async () => {
      pane.state = 'dead';
      const res = await call(app, 'POST', '/api/messages', ana.token, { to: seat.id, message: 'hello?' });
      expect(res.status).toBe(201);
      expect(res.json).toMatchObject({ injected: false, inject_error: 'runtime not running' });
      expect(sm.sendKeys).not.toHaveBeenCalled();
    });

    it('agent-originated messages (from_agent_id) are wire traffic, not injected', async () => {
      const res = await call(app, 'POST', '/api/messages', bob.token, { from_agent_id: 'x', to_agent_id: seat.id, message: 'done', message_type: 'result' });
      expect(res.status).toBe(201);
      expect(res.json.injected).toBeUndefined();
      expect(sm.sendKeys).not.toHaveBeenCalled();
    });

    it('unknown `to` is a 400', async () => {
      expect((await call(app, 'POST', '/api/messages', ana.token, { to: 'nobody', message: 'x' })).status).toBe(400);
    });
  });

  describe('POST /api/agents/:id/restart (alert action)', () => {
    it('relaunches a dead runtime for the owner; refuses others', async () => {
      vi.mocked(sm.ensureSpawnedAgentSession).mockReturnValue({ ok: true, data: { agent: seat, createdSession: false } });
      pane.state = 'dead';
      expect((await call(app, 'POST', `/api/agents/${seat.id}/restart`, bob.token)).status).toBe(403);
      const res = await call(app, 'POST', `/api/agents/${seat.id}/restart`, ana.token);
      expect(res.json).toEqual({ ok: true, action: 'runtime_relaunched' });
      expect(liveness.relaunchRuntime).toHaveBeenCalledWith(expect.objectContaining({ id: seat.id }), 'manual');
    });

    it('recreates a missing spawned session', async () => {
      vi.mocked(sm.ensureSpawnedAgentSession).mockReturnValue({ ok: true, data: { agent: seat, createdSession: true } });
      const res = await call(app, 'POST', `/api/agents/${seat.id}/restart`, ana.token);
      expect(res.json).toEqual({ ok: true, action: 'session_recreated' });
      expect(db.listEvents().some((e) => e.type === 'agent.restarted')).toBe(true);
    });

    it('reports already_running for a live TUI', async () => {
      vi.mocked(sm.ensureSpawnedAgentSession).mockReturnValue({ ok: true, data: { agent: seat, createdSession: false } });
      expect((await call(app, 'POST', `/api/agents/${seat.id}/restart`, ana.token)).json).toEqual({ ok: true, action: 'already_running' });
    });
  });
});
