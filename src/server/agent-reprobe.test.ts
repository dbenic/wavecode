/**
 * A reachable tmux session clears status error as soon as the socket is bound.
 */

import { Hono } from 'hono';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmuxState = vi.hoisted(() => ({
  alive: true,
  pane: '❯ \n',
}));

vi.mock('./tmux.js', () => ({
  hasSession: vi.fn(() => tmuxState.alive),
  capturePane: vi.fn(() => ({ ok: true, data: tmuxState.pane })),
  bindSessionSocket: vi.fn(),
  isValidSocketName: vi.fn(() => true),
  isValidSessionName: vi.fn(() => true),
  listSessions: vi.fn(() => ({ ok: true, data: [] })),
  sendRawKey: vi.fn(),
  sendTextAndEnter: vi.fn(),
}));

vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined), notifyAgentCrashed: vi.fn(async () => undefined) }));

import * as db from './db.js';
import * as sessionManager from './session-manager.js';
import { detectStatus } from './output-watcher.js';

const WORKING = 'editing src/app.ts\n⏵⏵ bypass permissions on (esc to interrupt)';

describe('agent reprobe', () => {
  let tmp: string;
  let app: Hono;
  const token = 'reprobe-token-0123456789';

  beforeEach(async () => {
    tmuxState.alive = true;
    tmuxState.pane = WORKING;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-reprobe-'));
    fs.writeFileSync(path.join(tmp, 'config.yaml'), [
      'auth:', '  method: token', `  fallback_token: ${token}`,
      'autonomy:', '  auto_dispatch: false',
      'artifacts:', `  storage: ${path.join(tmp, 'artifacts')}`,
      '',
    ].join('\n'));
    const { loadConfig } = await import('./config.js');
    loadConfig(path.join(tmp, 'config.yaml'));
    db.initDb(path.join(tmp, 't.db'));
    sessionManager.registerPaneClassifier(detectStatus);
    const { createAuthMiddleware } = await import('./auth.js');
    app = new Hono();
    app.use('/api/*', createAuthMiddleware());
    const { registerAgentRoutes } = await import('./routes/agents.js');
    registerAgentRoutes(app);
  });

  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function insertError(name: string) {
    const row = db.insertAgent({
      name, runtime: 'claude-code', tmux_session: `wc-${name}`, workspace: tmp, mode: 'adopted', status: 'error',
    });
    if (!row.ok) throw new Error(row.error);
    return row.data;
  }

  async function patch(id: string, body: Record<string, unknown>) {
    const res = await app.request(`/api/agents/${id}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() as { status?: string; error?: string; tmux_socket?: string | null } };
  }

  it('clears error on PATCH when the session is reachable', async () => {
    const agent = insertError('fable');
    tmuxState.pane = WORKING;
    const working = await patch(agent.id, { tmux_socket: 'fable' });
    expect(working.status).toBe(200);
    expect(working.json.status).toBe('working');
    expect(working.json.tmux_socket).toBe('fable');
    expect(db.getAgent(agent.id).ok && db.getAgent(agent.id).data?.status).toBe('working');

    db.updateAgentStatus(agent.id, 'error');
    tmuxState.pane = '❯ \n';
    const idle = await patch(agent.id, { tmux_socket: 'fable' });
    expect(idle.json.status).toBe('idle');
  });

  it('leaves error when the session is still missing', async () => {
    const agent = insertError('fable');
    tmuxState.alive = false;
    const res = await patch(agent.id, { tmux_socket: 'fable' });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('error');
  });

  it('clears error on adopt of an existing session and on rebind', async () => {
    const agent = insertError('fable');
    tmuxState.pane = WORKING;
    const adopted = (await sessionManager.adopt('wc-fable', 'claude-code', 'fable', 'fable'));
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) return;
    expect(adopted.data.id).toBe(agent.id);
    expect(adopted.data.status).toBe('working');
    expect(adopted.data.tmux_socket).toBe('fable');

    db.updateAgentStatus(agent.id, 'error');
    tmuxState.pane = '❯ \n';
    (await sessionManager.rebindAgentSockets());
    const fresh = db.getAgent(agent.id);
    expect(fresh.ok && fresh.data.status).toBe('idle');
  });
});
