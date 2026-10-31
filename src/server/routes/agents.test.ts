import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WaveConfig } from '../config.js';

// Real SQLite + the real session manager: these cases exist because the
// foreign keys from runs/tasks to agents made DELETE /api/agents/:id fail
// with a 500 (`SqliteError: FOREIGN KEY constraint failed`) for any agent
// with history (deploy box, 27 Oct 2026, agent `claude-countix`).

vi.mock('../event-bus.js', () => ({ emit: vi.fn() }));
vi.mock('../output-watcher.js', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  getLastOutputLine: vi.fn(),
  getOutputVersion: vi.fn(),
  isWatching: vi.fn(() => false),
  getLiveModel: vi.fn(() => null),
}));
vi.mock('../logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const FALLBACK = 'fallback-secret';

function makeConfig(): WaveConfig {
  return {
    auth: { method: 'token', fallback_token: FALLBACK, trusted_proxies: [] },
  } as unknown as WaveConfig;
}

async function makeApp() {
  const { createAuthMiddleware } = await import('../auth.js');
  const { registerAgentRoutes } = await import('./agents.js');
  const app = new Hono<import('../auth.js').NodeAppEnv>();
  app.use('/api/*', createAuthMiddleware(() => makeConfig()));
  registerAgentRoutes(app);
  return app;
}

async function call(app: Hono<import('../auth.js').NodeAppEnv>, method: string, url: string) {
  const res = await app.request(url, { method, headers: { Authorization: `Bearer ${FALLBACK}` } });
  return { status: res.status, json: await res.json() as any };
}

async function adoptedAgent(name: string) {
  const db = await import('../db.js');
  const agent = db.insertAgent({
    name, runtime: 'claude-code', tmux_session: name, workspace: null, mode: 'adopted', status: 'idle',
  });
  if (!agent.ok) throw new Error(agent.error);
  return agent.data;
}

describe('DELETE /api/agents/:id', () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-agent-routes-'));
    const { initDb, resetDbForTest } = await import('../db.js');
    resetDbForTest();
    initDb(path.join(tmpDir, 'test.db'));
  });

  afterEach(async () => {
    const { resetDbForTest } = await import('../db.js');
    resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes the record of an agent nothing references', async () => {
    const db = await import('../db.js');
    const agent = await adoptedAgent('scratch');
    const app = await makeApp();

    const res = await call(app, 'DELETE', `/api/agents/${agent.id}`);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, archived: false });
    expect(db.getAgent(agent.id).ok).toBe(false);
    expect(db.listAgents()).toEqual([]);
  });

  it('archives an adopted agent with a run instead of failing on the foreign key', async () => {
    const db = await import('../db.js');
    const events = await import('../event-bus.js');
    const agent = await adoptedAgent('claude-countix');
    db.getDb().prepare('UPDATE agents SET alias = ?, owner_id = ?, lease_reason = ? WHERE id = ?')
      .run('countix', 'owner', 'reserved', agent.id);
    db.addAgentTag(agent.id, 'backend');
    const task = db.insertTask({ agent_id: agent.id, prompt: 'ship it', created_by: null });
    if (!task.ok) throw new Error(task.error);
    const run = db.insertRun({ task_id: task.data.id, agent_id: agent.id });
    if (!run.ok) throw new Error(run.error);
    const app = await makeApp();

    const res = await call(app, 'DELETE', `/api/agents/${agent.id}`);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, archived: true });
    expect(events.emit).toHaveBeenCalledWith('agent.detached', 'agent', agent.id, { name: 'claude-countix', archived: true });

    // History is intact and still points at the (now archived) row.
    const kept = db.getAgent(agent.id);
    expect(kept.ok).toBe(true);
    if (!kept.ok) throw new Error(kept.error);
    expect(kept.data.detached_at).toEqual(expect.any(String));
    expect(kept.data.name).toBe('claude-countix');
    expect(db.getRun(run.data.id)).toMatchObject({ ok: true, data: { agent_id: agent.id } });
    expect(db.getTask(task.data.id)).toMatchObject({ ok: true, data: { agent_id: agent.id } });

    // Gone from the live surfaces; alias, lease, tags released.
    expect(db.listAgents()).toEqual([]);
    expect(db.resolveAgent(agent.id).ok).toBe(false);
    expect(db.resolveAgent('claude-countix').ok).toBe(false);
    expect(db.resolveAgent('@countix').ok).toBe(false);
    expect(db.listAgentsByTag('backend')).toEqual([]);
    expect(db.listAgentsOwnedBy('owner')).toEqual([]);
    expect(kept.data).toMatchObject({ alias: null, owner_id: null, lease_reason: null, role: null });
    expect((await call(app, 'GET', '/api/agents')).json).toEqual([]);
    expect((await call(app, 'GET', `/api/agents/${agent.id}`)).status).toBe(404);

    // The freed name and alias can be taken by a fresh adoption of the same session.
    const again = await adoptedAgent('claude-countix');
    expect(db.getDb().prepare('UPDATE agents SET alias = ? WHERE id = ?').run('countix', again.id).changes).toBe(1);
    expect(db.resolveAgent('@countix')).toMatchObject({ ok: true, data: { id: again.id } });
    expect(db.listAgents().map((a) => a.id)).toEqual([again.id]);
  });

  it('detaching an already archived agent is a no-op that keeps the original detach time', async () => {
    const db = await import('../db.js');
    const agent = await adoptedAgent('twice');
    const task = db.insertTask({ agent_id: agent.id, prompt: 'x', created_by: null });
    if (!task.ok) throw new Error(task.error);
    db.getDb().prepare("UPDATE agents SET detached_at = '2026-10-27 10:00:00' WHERE id = ?").run(agent.id);
    const app = await makeApp();

    const res = await call(app, 'DELETE', `/api/agents/${agent.id}`);

    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, archived: true });
    expect(db.getAgent(agent.id)).toMatchObject({ ok: true, data: { detached_at: '2026-10-27 10:00:00' } });
  });

  it('404s for an unknown agent', async () => {
    const app = await makeApp();
    expect((await call(app, 'DELETE', '/api/agents/01ARZ3NDEKTSV4RRFFQ69G5FAV')).status).toBe(404);
  });
});
