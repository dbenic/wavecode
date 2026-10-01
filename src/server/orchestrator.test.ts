/**
 * Orchestrator seat (spec §5b): default-seat resolution, the one-line
 * operating prompt, and briefing a seat on spawn/adopt/role change.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const harness = vi.hoisted(() => ({
  pane: '❯ \n  ⏵⏵ bypass permissions on',
  typed: [] as Array<{ agentId: string; text: string }>,
  spawned: [] as string[],
}));

vi.mock('./session-manager.js', async () => {
  const db = await vi.importActual<typeof import('./db.js')>('./db.js');
  return {
    get: (idOrName: string) => {
      const byId = db.getAgent(idOrName);
      return byId.ok ? byId : db.getAgentByName(idOrName);
    },
    sendKeys: vi.fn((agentId: string, text: string) => {
      harness.typed.push({ agentId, text });
      return { ok: true, data: undefined };
    }),
    capturePane: vi.fn(() => ({ ok: true, data: harness.pane })),
    adopt: vi.fn((session: string, runtime: string, name?: string) => db.insertAgent({
      name: name ?? session, runtime, tmux_session: session, workspace: null, mode: 'adopted', status: 'idle',
    })),
    spawnAgent: vi.fn((opts: { name: string; runtime: string; runner?: string }) => {
      harness.spawned.push(opts.name);
      return db.insertAgent({ name: opts.name, runtime: opts.runtime, tmux_session: `wc-${opts.name}`, workspace: '/w', mode: 'spawned', status: 'idle' });
    }),
  };
});

vi.mock('./tmux.js', () => ({
  hasSession: vi.fn(() => true),
  capturePane: vi.fn(() => ({ ok: true, data: harness.pane })),
  sendTextAndEnter: vi.fn(),
  isAllowedRawKey: vi.fn(() => true),
  isValidSessionName: vi.fn(() => true),
}));

vi.mock('./output-watcher.js', () => ({
  startWatching: vi.fn(),
  stopWatching: vi.fn(),
  getLastOutputLine: vi.fn(() => null),
  getOutputVersion: vi.fn(() => 0),
  isWatching: vi.fn(() => false),
  isClaudeBypassAcceptDialog: vi.fn((pane: string) => /Yes, I accept/.test(pane)),
}));

vi.mock('./logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const FALLBACK = 'fallback-admin';

describe('orchestrator seat', () => {
  let tmpDir: string;
  let db: typeof import('./db.js');
  let orch: typeof import('./orchestrator.js');

  function agent(name: string, extra: Partial<import('./db.js').Agent> = {}) {
    const a = db.insertAgent({ name, runtime: 'claude-code', tmux_session: `wc-${name}`, workspace: null, mode: 'spawned', status: 'idle', ...extra });
    if (!a.ok) throw new Error(a.error);
    return a.data;
  }

  beforeEach(async () => {
    harness.pane = '❯ \n  ⏵⏵ bypass permissions on';
    harness.typed.length = 0;
    harness.spawned.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-orch-'));
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), [
      'auth:', '  method: token', `  fallback_token: ${FALLBACK}`,
      'artifacts:', `  storage: ${path.join(tmpDir, 'artifacts')}`, '',
    ].join('\n'));
    (await import('./config.js')).loadConfig(path.join(tmpDir, 'config.yaml'));
    db = await import('./db.js');
    db.resetDbForTest();
    db.initDb(path.join(tmpDir, 'test.db'));
    (await import('./reply-capture.js')).resetReplyCaptureForTest();
    orch = await import('./orchestrator.js');
  });

  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves the default seat: config name → role orchestrator → pm/orchestrator by name', () => {
    const builder = agent('builder');
    const pm = agent('pm');
    const lead = agent('lead', { role: 'orchestrator' });
    expect(orch.resolveOrchestratorAgent([builder, pm, lead], 'builder')?.name).toBe('builder');
    expect(orch.resolveOrchestratorAgent([builder, pm, lead], null)?.name).toBe('lead');
    expect(orch.resolveOrchestratorAgent([builder, pm], null)?.name).toBe('pm');
    expect(orch.resolveOrchestratorAgent([builder, pm], 'missing')?.name).toBe('pm');
    expect(orch.resolveOrchestratorAgent([builder], null)).toBeNull();
  });

  it('the operating prompt is one line built from docs/orchestrator-seat.md', () => {
    const brief = orch.buildOrchestratorBrief();
    expect(brief).not.toContain('\n');
    expect(brief).not.toMatch(/(^|\s)#{1,6}\s/);
    expect(brief).toContain('list_agents');
    expect(brief).toContain('ONE question');
    expect(brief).toContain('[ ] Deploy on pass');
    expect(brief).toContain('Never claim');
    // missing file → built-in fallback, still one line
    const fallback = orch.buildOrchestratorBrief(tmpDir);
    expect(fallback).toContain('orchestrator seat');
    expect(fallback).not.toContain('\n');
  });

  it('parseAgentRole', () => {
    expect(orch.parseAgentRole(undefined)).toEqual({ ok: true, role: undefined });
    expect(orch.parseAgentRole(null)).toEqual({ ok: true, role: null });
    expect(orch.parseAgentRole('orchestrator')).toEqual({ ok: true, role: 'orchestrator' });
    expect(orch.parseAgentRole('boss').ok).toBe(false);
  });

  it('briefing types the prompt once the runtime is up and tracks the acknowledgement as a reply', async () => {
    const pm = agent('pm', { role: 'orchestrator' });
    const res = await orch.briefOrchestratorSeat(pm.id, 'owner');
    expect(res.ok).toBe(true);
    expect(harness.typed).toEqual([{ agentId: pm.id, text: orch.buildOrchestratorBrief() }]);
    const rc = await import('./reply-capture.js');
    expect(rc.getPendingReply(pm.id)).toMatchObject({ actorId: 'owner' });
    expect(db.listEvents().map((e) => e.type)).toEqual(expect.arrayContaining(['agent.prompt_sent', 'agent.orchestrator_briefed']));
  });

  it('never types the brief into a bare shell', async () => {
    harness.pane = 'ci@box:~/repo$ ';
    const pm = agent('pm');
    const res = await orch.briefOrchestratorSeat(pm.id, 'owner', { timeoutMs: 50, pollMs: 10 });
    expect(res).toEqual({ ok: false, error: 'runtime not running' });
    expect(harness.typed).toEqual([]);
  });

  describe('routes', () => {
    async function makeApp() {
      const { createAuthMiddleware } = await import('./auth.js');
      const app = new Hono<import('./auth.js').NodeAppEnv>();
      app.use('/api/*', createAuthMiddleware());
      (await import('./routes/agents.js')).registerAgentRoutes(app);
      return app;
    }
    const call = async (app: Hono<import('./auth.js').NodeAppEnv>, method: string, url: string, body?: unknown) => {
      const res = await app.request(url, {
        method,
        headers: { Authorization: `Bearer ${FALLBACK}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json() as any };
    };

    it('spawn with role orchestrator stores the role and briefs the seat', async () => {
      const app = await makeApp();
      const res = await call(app, 'POST', '/api/agents/spawn', { name: 'pm', runtime: 'claude-code', role: 'orchestrator' });
      expect(res.status).toBe(201);
      expect(res.json.role).toBe('orchestrator');
      await vi.waitFor(() => expect(harness.typed.map((t) => t.text)).toEqual([orch.buildOrchestratorBrief()]));
    });

    it('adopt with role orchestrator briefs; a bad role is 400', async () => {
      const app = await makeApp();
      expect((await call(app, 'POST', '/api/agents/adopt', { sessionName: 'grok-pm', runtime: 'grok', role: 'boss' })).status).toBe(400);
      const res = await call(app, 'POST', '/api/agents/adopt', { sessionName: 'grok-pm', runtime: 'grok', name: 'grok-pm', role: 'orchestrator' });
      expect(res.status).toBe(201);
      expect(res.json.role).toBe('orchestrator');
      await vi.waitFor(() => expect(harness.typed).toHaveLength(1));
    });

    it('PATCH role makes an existing agent the seat (briefed once) and it becomes the default target', async () => {
      const app = await makeApp();
      const lead = agent('lead');
      agent('builder');
      const res = await call(app, 'PATCH', `/api/agents/${lead.id}`, { role: 'orchestrator' });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ role: 'orchestrator', orchestrator: true });
      await vi.waitFor(() => expect(harness.typed).toHaveLength(1));

      // already orchestrator → not briefed again
      await call(app, 'PATCH', `/api/agents/${lead.id}`, { role: 'orchestrator' });
      expect(harness.typed).toHaveLength(1);

      const listed = (await call(app, 'GET', '/api/agents')).json as Array<{ name: string; orchestrator: boolean }>;
      expect(listed.filter((a) => a.orchestrator).map((a) => a.name)).toEqual(['lead']);
    });
  });
});
