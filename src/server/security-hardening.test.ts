/**
 * Regression tests for the 2026-10-07 security review: fail-closed
 * restrictions, token expiry, denial audit rows, raw-key privilege, peer
 * questions bound to their caller, loopback-owner guard.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('./session-manager.js', async () => {
  const db = await import('./db.js');
  return {
    get: vi.fn((id: string) => db.getAgent(id)),
    sendKeys: vi.fn(() => ({ ok: true, data: undefined })),
    sendRawKeys: vi.fn(() => ({ ok: true, data: undefined })),
    capturePane: vi.fn(() => ({ ok: true, data: 'pane' })),
    capturePaneAnsi: vi.fn(() => ({ ok: true, data: 'pane' })),
    spawnAgent: vi.fn(), scan: vi.fn(() => ({ ok: true, data: [] })),
  };
});
vi.mock('./output-watcher.js', () => ({ getLastOutputLine: vi.fn(() => null), getOutputVersion: vi.fn(() => 0), isWatching: vi.fn(() => false), startWatching: vi.fn(), stopWatching: vi.fn() }));
const runtimeState = { value: 'alive' as 'alive' | 'dead' | 'unknown' };
vi.mock('./runtime-liveness.js', () => ({ getRuntimeState: vi.fn(() => runtimeState.value), RUNTIME_NOT_RUNNING: 'Runtime is not running' }));
vi.mock('./reply-capture.js', () => ({ trackPrompt: vi.fn(), parseReplyQuestion: vi.fn(() => null) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import * as db from './db.js';
import { createUser, isExpired, parseExpiry, resolveUserByToken, restrictedAgentRefs, agentAllowedFor } from './users.js';
import * as peers from './peers.js';

const FALLBACK = 'fallback-admin-token-0123456789';
let tmp: string;
let app: Hono<import('./auth.js').NodeAppEnv>;
let fable: db.Agent;
let other: db.Agent;

async function call(method: string, url: string, token: string | null, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}
const mk = (name: string, extra: Record<string, unknown> = {}) => {
  const r = createUser({ name, role: 'developer', ...extra });
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-sec-'));
  fs.writeFileSync(path.join(tmp, 'config.yaml'), ['auth:', '  method: token', `  fallback_token: ${FALLBACK}`, 'peers:', '  deploy:', '    url: http://100.100.165.71:3777', '    token: peer-token-0123456789', 'artifacts:', `  storage: ${path.join(tmp, 'art')}`, ''].join('\n'));
  (await import('./config.js')).loadConfig(path.join(tmp, 'config.yaml'));
  db.resetDbForTest();
  db.initDb(path.join(tmp, 't.db'));
  peers.ensurePeerTables();
  runtimeState.value = 'alive';
  const { createAuthMiddleware } = await import('./auth.js');
  app = new Hono();
  app.use('/api/*', createAuthMiddleware());
  (await import('./routes/agents.js')).registerAgentRoutes(app);
  (await import('./routes/peers.js')).registerPeerRoutes(app);
  (await import('./routes/tasks.js')).registerTaskRoutes(app);
  const a1 = db.insertAgent({ name: 'fable', runtime: 'claude-code', tmux_session: 'wc-fable', workspace: null, mode: 'adopted', status: 'idle' });
  const a2 = db.insertAgent({ name: 'deployer', runtime: 'codex', tmux_session: 'wc-deployer', workspace: null, mode: 'adopted', status: 'idle' });
  if (!a1.ok || !a2.ok) throw new Error('seed');
  fable = a1.data; other = a2.data;
});
afterEach(() => { peers.stopPeerPollers(); peers.setPeerFetchForTest(null); db.resetDbForTest(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('1. restrictions fail closed; token expiry', () => {
  it('a malformed, non-array or empty allowed_agents denies every agent instead of lifting the restriction', async () => {
    const u = mk('peer', { only_agents: ['fable'] });
    for (const bad of ['not json', '{"a":1}', '[]', '[1,2]', '""']) {
      db.getDb().prepare('UPDATE users SET allowed_agents = ? WHERE id = ?').run(bad, u.user.id);
      const user = db.getUser(u.user.id).data!;
      expect(restrictedAgentRefs(user), bad).toEqual([]);
      expect(agentAllowedFor(user, fable), bad).toBe(false);
      expect((await call('GET', `/api/agents/${fable.id}`, u.token)).status, bad).toBe(403);
      expect((await call('POST', `/api/agents/${fable.id}/send`, u.token, { text: 'hi' })).status, bad).toBe(403);
    }
    // null = genuinely unrestricted
    db.getDb().prepare('UPDATE users SET allowed_agents = NULL WHERE id = ?').run(u.user.id);
    expect(restrictedAgentRefs(db.getUser(u.user.id).data!)).toBeNull();
  });

  it('expiry: exact UTC boundary, unparseable fails closed, seat tokens expire with their person', async () => {
    const ok = parseExpiry('12h', Date.parse('2026-10-07T10:00:00Z'));
    expect(ok).toEqual({ ok: true, data: '2026-10-07T22:00:00.000Z' });
    expect(parseExpiry('yesterday').ok).toBe(false);
    expect(parseExpiry('0d').ok).toBe(false);
    const at = Date.parse('2026-10-07T12:00:00Z');
    expect(isExpired({ expires_at: '2026-10-07T12:00:00.000Z' }, at - 1)).toBe(false);
    expect(isExpired({ expires_at: '2026-10-07T12:00:00.000Z' }, at)).toBe(true);
    expect(isExpired({ expires_at: 'garbage' })).toBe(true);
    expect(isExpired({ expires_at: null })).toBe(false);

    const u = mk('temp', { expires: '1h' });
    expect((await call('GET', '/api/agents', u.token)).status).toBe(200);
    db.getDb().prepare("UPDATE users SET expires_at = datetime('now', '-1 minute') WHERE id = ?").run(u.user.id);
    expect(resolveUserByToken(u.token, FALLBACK)).toBeNull();
    const denied = await call('GET', '/api/agents', u.token);
    expect(denied.status).toBe(401);
    // audit row, without the bearer value
    const rows = db.listEvents({ limit: 20 }).filter((e) => e.type === 'auth.denied');
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(u.token);
    expect(JSON.parse(rows[0].payload_json!)).toMatchObject({ status: 401, reason: 'token unknown, revoked or expired', path: '/api/agents' });
  });
});

describe('4. denials are audited with the resolved actor', () => {
  it('a 403 for a restricted token records actor, method, path and reason — never the token', async () => {
    const u = mk('peer', { only_agents: ['fable'] });
    expect((await call('GET', '/api/tasks', u.token)).status).toBe(403);
    const row = db.listEvents({ limit: 10 }).find((e) => e.type === 'auth.denied')!;
    const p = JSON.parse(row.payload_json!);
    expect(p).toMatchObject({ status: 403, method: 'GET', path: '/api/tasks', actor: 'peer' });
    expect(p.reason).toMatch(/limited to agents fable/);
    expect(JSON.stringify(p)).not.toContain(u.token);
  });
});

describe('5. raw keys are a privilege; unknown runtime state is denied', () => {
  it('restricted and seat tokens cannot send raw keys; an unknown state refuses typed prompts', async () => {
    const peer = mk('peer', { only_agents: ['fable'] });
    const raw = await call('POST', `/api/agents/${fable.id}/send`, peer.token, { text: 'C-c', raw: true });
    expect(raw.status).toBe(403);
    const sm = await import('./session-manager.js');
    expect(vi.mocked(sm.sendRawKeys)).not.toHaveBeenCalled();
    runtimeState.value = 'unknown';
    expect((await call('POST', `/api/agents/${fable.id}/send`, FALLBACK, { text: 'hello' })).status).toBe(409);
    runtimeState.value = 'alive';
    expect((await call('POST', `/api/agents/${fable.id}/send`, FALLBACK, { text: 'hello' })).status).toBe(200);
    expect((await call('POST', `/api/agents/${fable.id}/send`, FALLBACK, { text: 'C-c', raw: true })).status).toBe(200);
  });
});

describe('2. peer questions are bound to their caller', () => {
  it('forged reply target is refused; questions are visible to their asker and admins only', async () => {
    const fp = (await import('./peers.test-helpers.js')).fakePeer();
    peers.setPeerFetchForTest(fp.fetchImpl);
    const ana = mk('ana');
    const bob = mk('bob');
    // bob reserves an agent; ana may not point an answer at it
    const { reserveAgent } = await import('./leases.js');
    expect(reserveAgent(other.id, bob.user, 1).ok).toBe(true);
    const forged = await call('POST', '/api/peers/deploy/ask', ana.token, { agent: 'fable', question: 'hello?', from_agent_id: other.id });
    expect(forged.status).toBe(403);
    expect(fp.state.sends).toHaveLength(0);

    const mine = await call('POST', '/api/peers/deploy/ask', ana.token, { agent: 'fable', question: 'is staging migrated?' });
    expect(mine.status).toBe(202);
    const id = mine.json.id as string;
    expect((await call('GET', `/api/peers/questions/${id}`, ana.token)).status).toBe(200);
    expect((await call('GET', `/api/peers/questions/${id}`, bob.token)).status).toBe(404);
    expect((await call('GET', `/api/peers/questions/${id}`, FALLBACK)).status).toBe(200);
    expect((await call('GET', '/api/peers/questions', bob.token)).json).toEqual([]);
    expect((await call('GET', '/api/peers/questions', ana.token)).json.map((q: { id: string }) => q.id)).toEqual([id]);
  });
});
