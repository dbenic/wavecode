/**
 * Restricted users (docs/peers.md): a token limited to named agents — the
 * "ask-only" token a peer WaveCode uses. It can list/read/prompt those agents
 * and read their messages and events, and nothing else.
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
    capturePane: vi.fn(() => ({ ok: true, data: 'pane text' })),
    capturePaneAnsi: vi.fn(() => ({ ok: true, data: 'pane text' })),
    spawnAgent: vi.fn(),
    scan: vi.fn(() => ({ ok: true, data: [] })),
  };
});
vi.mock('./output-watcher.js', () => ({
  getLastOutputLine: vi.fn(() => null), getOutputVersion: vi.fn(() => 0), isWatching: vi.fn(() => false), startWatching: vi.fn(), stopWatching: vi.fn(),
}));
vi.mock('./runtime-liveness.js', () => ({ getRuntimeState: vi.fn(() => 'alive'), RUNTIME_NOT_RUNNING: 'Runtime is not running' }));
vi.mock('./reply-capture.js', () => ({ trackPrompt: vi.fn(), parseReplyQuestion: vi.fn(() => null) }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

import * as db from './db.js';
import { createUser, restrictedAgentRefs, agentAllowedFor } from './users.js';
import { restrictedPathAllowed } from './auth.js';

const FALLBACK = 'fallback-admin-token-0123456789';
let tmp: string;
let app: Hono<import('./auth.js').NodeAppEnv>;
let fable: db.Agent;
let other: db.Agent;
let peerToken: string;

async function call(method: string, url: string, token: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-restricted-'));
  fs.writeFileSync(path.join(tmp, 'config.yaml'), ['auth:', '  method: token', `  fallback_token: ${FALLBACK}`, 'artifacts:', `  storage: ${path.join(tmp, 'art')}`, ''].join('\n'));
  (await import('./config.js')).loadConfig(path.join(tmp, 'config.yaml'));
  db.resetDbForTest();
  db.initDb(path.join(tmp, 't.db'));
  const { createAuthMiddleware } = await import('./auth.js');
  app = new Hono();
  app.use('/api/*', createAuthMiddleware());
  (await import('./routes/agents.js')).registerAgentRoutes(app);
  (await import('./routes/messages.js')).registerMessageRoutes(app);
  (await import('./routes/system.js')).registerSystemRoutes(app);
  (await import('./routes/users.js')).registerUserRoutes(app);
  (await import('./routes/tasks.js')).registerTaskRoutes(app);

  const a1 = db.insertAgent({ name: 'fable', runtime: 'claude-code', tmux_session: 'wc-fable', workspace: null, mode: 'adopted', status: 'idle' });
  const a2 = db.insertAgent({ name: 'deployer', runtime: 'codex', tmux_session: 'wc-deployer', workspace: null, mode: 'adopted', status: 'idle' });
  if (!a1.ok || !a2.ok) throw new Error('seed');
  fable = a1.data; other = a2.data;
  db.updateAgentIdentity(fable.id, { alias: 'fable' });
  const u = createUser({ name: 'peer-countix-dev', role: 'developer', only_agents: ['fable'] });
  if (!u.ok) throw new Error(u.error);
  peerToken = u.data.token;
});
afterEach(() => { db.resetDbForTest(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('restricted users', () => {
  it('createUser validates only_agents; admins cannot be restricted; /api/me shows the restriction', async () => {
    expect(createUser({ name: 'x1', only_agents: [] }).ok).toBe(false);
    expect(createUser({ name: 'x2', role: 'admin', only_agents: ['fable'] }).ok).toBe(false);
    const csv = createUser({ name: 'x3', only_agents: '@fable, deployer' });
    expect(csv.ok && restrictedAgentRefs(csv.data.user)).toEqual(['fable', 'deployer']);
    const me = await call('GET', '/api/me', peerToken);
    expect(me.json).toMatchObject({ name: 'peer-countix-dev', role: 'developer', allowed_agents: ['fable'] });
    expect(agentAllowedFor({ allowed_agents: '["fable"]' }, fable)).toBe(true);
    expect(agentAllowedFor({ allowed_agents: '["fable"]' }, other)).toBe(false);
    expect(agentAllowedFor({ allowed_agents: null }, other)).toBe(true);
  });

  it('sees, reads and prompts only its agents', async () => {
    const list = await call('GET', '/api/agents', peerToken);
    expect(list.json.map((a: { name: string }) => a.name)).toEqual(['fable']);
    expect((await call('GET', `/api/agents/${fable.id}`, peerToken)).status).toBe(200);
    expect((await call('GET', `/api/agents/${other.id}`, peerToken)).status).toBe(403);
    expect((await call('GET', `/api/agents/${fable.id}/output`, peerToken)).status).toBe(200);
    expect((await call('GET', `/api/agents/${other.id}/output`, peerToken)).status).toBe(403);
    const ok = await call('POST', `/api/agents/${fable.id}/send`, peerToken, { text: 'is staging migrated?' });
    expect(ok.status).toBe(200);
    expect(typeof ok.json.prompt_event_id).toBe('number');
    const no = await call('POST', `/api/agents/${other.id}/send`, peerToken, { text: 'deploy prod' });
    expect(no.status).toBe(403);
    expect(no.json.error).toMatch(/limited to: fable/);
  });

  it('everything else is 403, including spawn, tasks, thread, the SSE stream and user management', async () => {
    for (const [m, p] of [
      ['POST', '/api/agents/spawn'], ['POST', '/api/agents/adopt'], ['POST', '/api/tasks'], ['GET', '/api/tasks'],
      ['GET', '/api/thread'], ['GET', '/api/events'], ['GET', '/api/users'], ['POST', `/api/agents/${fable.id}/kill`],
      ['POST', `/api/agents/${fable.id}/reserve`], ['GET', '/api/files/view?path=/etc/passwd'], ['POST', '/api/system/stop-all'],
    ] as const) {
      const res = await call(m, p, peerToken, m === 'POST' ? {} : undefined);
      expect(res.status, `${m} ${p}`).toBe(403);
    }
    expect(restrictedPathAllowed('GET', '/api/events/log')).toBe(true);
    expect(restrictedPathAllowed('GET', '/api/thread')).toBe(false);
    // an unrestricted developer is unaffected
    const dev = createUser({ name: 'ana' });
    if (!dev.ok) throw new Error(dev.error);
    expect((await call('GET', '/api/tasks', dev.data.token)).status).toBe(200);
  });

  it('messages and the event log are filtered to its agents', async () => {
    db.insertAgentMessage({ from_agent_id: fable.id, message: 'fable says: v3 is live', message_type: 'reply' });
    db.insertAgentMessage({ from_agent_id: other.id, message: 'deployer secret notes', message_type: 'info' });
    const msgs = await call('GET', '/api/messages?limit=50', peerToken);
    expect(msgs.json.map((m: { message: string }) => m.message)).toEqual(['fable says: v3 is live']);

    db.insertEvent({ type: 'message.created', entity_type: 'agent_message', entity_id: 'm1', payload: { message_type: 'reply', from_agent_id: fable.id } });
    db.insertEvent({ type: 'message.created', entity_type: 'agent_message', entity_id: 'm2', payload: { message_type: 'reply', from_agent_id: other.id } });
    db.insertEvent({ type: 'agent.status_changed', entity_type: 'agent', entity_id: other.id, payload: { status: 'working' } });
    db.insertEvent({ type: 'run.finished', entity_type: 'run', entity_id: 'r1', payload: { agent_id: other.id } });
    const log = await call('GET', '/api/events/log?since=0', peerToken);
    const seen = log.json.events.map((e: { type: string; entity_id: string }) => `${e.type}:${e.entity_id}`);
    expect(seen).toEqual(['message.created:m1']);
    // the admin sees all of them
    const all = await call('GET', '/api/events/log?since=0', FALLBACK);
    expect(all.json.events.length).toBeGreaterThanOrEqual(4);
  });
});
