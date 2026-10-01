/**
 * Spec §5b acceptance, end to end: composer/MCP/reply-injection prompt →
 * pane → output-watcher idle edge → reply in /api/thread under its prompt,
 * with chips. Real SQLite, auth, routes, output watcher and MCP tool layer;
 * only the tmux panes are simulated.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const panes = vi.hoisted(() => ({ bySession: new Map<string, string>(), typed: [] as Array<{ agentId: string; text: string }> }));

vi.mock('./session-manager.js', async () => {
  const db = await vi.importActual<typeof import('./db.js')>('./db.js');
  return {
    get: (idOrName: string) => {
      const byId = db.getAgent(idOrName);
      return byId.ok ? byId : db.getAgentByName(idOrName);
    },
    sendKeys: vi.fn((agentId: string, text: string) => {
      panes.typed.push({ agentId, text });
      return { ok: true, data: undefined };
    }),
    sendRawKeys: vi.fn(() => ({ ok: true, data: undefined })),
    capturePane: vi.fn((session: string) => ({ ok: true, data: panes.bySession.get(session) ?? '' })),
    capturePaneAnsi: vi.fn(() => ({ ok: true, data: '' })),
    ensureSpawnedAgentSession: vi.fn(),
    kill: vi.fn(() => ({ ok: true, data: undefined })),
    detach: vi.fn(() => ({ ok: true, data: undefined })),
  };
});

vi.mock('./tmux.js', () => ({
  hasSession: vi.fn(() => true),
  capturePane: vi.fn((session: string) => ({ ok: true, data: panes.bySession.get(session) ?? '' })),
  sendTextAndEnter: vi.fn(),
  isAllowedRawKey: vi.fn(() => true),
}));

vi.mock('./logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const FALLBACK = 'fallback-admin';
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, '__fixtures__', 'panes', name), 'utf8');

const WORKING: Record<string, string> = {
  'claude-code': '● Bash(npm test)\n  ⎿  Running…\n\n✻ Brewing… (12s · esc to interrupt)\n  ⏵⏵ bypass permissions on · esc to interrupt',
  codex: '• Ran npm test\n\n◦ Working (5s • esc to interrupt)\n  gpt-5.2 high · 82% left · ~/repos/wavecode',
  grok: '⏺ Reading files\nResponding… (2s · esc to interrupt)',
};

type App = Hono<import('./auth.js').NodeAppEnv>;

describe('reply capture acceptance (spec §5b)', () => {
  let tmpDir: string;
  let app: App;
  let db: typeof import('./db.js');
  let watcher: typeof import('./output-watcher.js');
  let anaToken: string;
  let anaId: string;
  const agents: Record<string, import('./db.js').Agent> = {};

  async function call(method: string, url: string, body?: unknown, token = anaToken) {
    const res = await app.request(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  /** Agent works (one tick), then the final pane appears and the watcher sees idle long enough to flip. */
  function finishTurn(name: string, finalPane: string) {
    const agent = agents[name];
    panes.bySession.set(agent.tmux_session, WORKING[agent.runtime]);
    watcher.tickForTest(agent.id);
    expect(db.getAgent(agent.id).ok && (db.getAgent(agent.id) as { data: { status: string } }).data.status).toBe('working');
    panes.bySession.set(agent.tmux_session, finalPane);
    for (let i = 0; i < watcher.IDLE_OVERRIDE_THRESHOLD + 1; i++) watcher.tickForTest(agent.id);
  }

  async function thread() {
    return (await call('GET', '/api/thread?limit=50')).json.items as Array<Record<string, any>>;
  }

  beforeEach(async () => {
    panes.bySession.clear();
    panes.typed.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-5b-'));
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), [
      'auth:', '  method: token', `  fallback_token: ${FALLBACK}`,
      'autonomy:', '  auto_dispatch: false',
      'orchestrator_agent: pm',
      'artifacts:', `  storage: ${path.join(tmpDir, 'artifacts')}`, '',
    ].join('\n'));
    (await import('./config.js')).loadConfig(path.join(tmpDir, 'config.yaml'));
    db = await import('./db.js');
    db.resetDbForTest();
    db.initDb(path.join(tmpDir, 'test.db'));
    (await import('./reply-capture.js')).resetReplyCaptureForTest();
    watcher = await import('./output-watcher.js');

    const { createAuthMiddleware } = await import('./auth.js');
    app = new Hono();
    app.use('/api/*', createAuthMiddleware());
    (await import('./routes/agents.js')).registerAgentRoutes(app);
    (await import('./routes/messages.js')).registerMessageRoutes(app);
    (await import('./routes/thread.js')).registerThreadRoutes(app);

    const { createUser } = await import('./users.js');
    const ana = createUser({ name: 'ana' });
    if (!ana.ok) throw new Error(ana.error);
    anaToken = ana.data.token;
    anaId = ana.data.user.id;

    for (const [name, runtime] of [['pm', 'claude-code'], ['builder', 'claude-code'], ['codex2', 'codex'], ['grok-fe', 'grok']] as const) {
      const a = db.insertAgent({ name, runtime, tmux_session: `wc-${name}`, workspace: `/w/${name}`, mode: 'spawned', status: 'idle' });
      if (!a.ok) throw new Error(a.error);
      agents[name] = a.data;
      panes.bySession.set(a.data.tmux_session, '❯ \n  ⏵⏵ bypass permissions on');
      watcher.startWatching(a.data.id); // driven with tickForTest below
    }
  });

  afterEach(() => {
    for (const a of Object.values(agents)) watcher.stopWatching(a.id);
    db.resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('the orchestrator seat is the default target the UI is told about', async () => {
    const listed = (await call('GET', '/api/agents')).json as Array<{ name: string; orchestrator: boolean }>;
    expect(listed.filter((a) => a.orchestrator).map((a) => a.name)).toEqual(['pm']);
  });

  it('"what is chatgpt-countix doing?" to pm → a reply bubble from pm right under the prompt, without opening the pane', async () => {
    const sent = await call('POST', `/api/agents/${agents.pm.id}/send`, { text: 'what is chatgpt-countix doing?' });
    expect(sent.status).toBe(200);
    finishTurn('pm', fixture('claude-pm-question.txt'));

    const items = await thread();
    const prompt = items.find((i) => i.kind === 'prompt')!;
    const reply = items.find((i) => i.kind === 'reply')!;
    expect(prompt).toMatchObject({ agent_id: agents.pm.id, actor_id: anaId, body: 'what is chatgpt-countix doing?' });
    expect(reply).toMatchObject({ agent_id: agents.pm.id, title: 'Reply', refs: { prompt_event_id: prompt.event_id } });
    expect(reply.body.startsWith("chatgpt-countix (Denis's lane) is running the invoices test suite")).toBe(true);
    expect(reply.event_id).toBeGreaterThan(prompt.event_id);

    const stored = db.listAgentMessages({}).find((m) => m.message_type === 'reply')!;
    expect(stored).toMatchObject({ from_agent_id: agents.pm.id, ref_prompt_actor: anaId });
  });

  it('a reply ending with a question and [ ] options has chips; tapping one sends it to the seat as the user\'s prompt', async () => {
    await call('POST', `/api/agents/${agents.pm.id}/send`, { text: 'what is chatgpt-countix doing?' });
    finishTurn('pm', fixture('claude-pm-question.txt'));

    const reply = (await thread()).find((i) => i.kind === 'reply')!;
    expect(reply.needs_attention).toBe(true);
    const chips = reply.actions.filter((a: { id: string }) => a.id === 'quick_reply');
    expect(chips.map((a: { label: string }) => a.label)).toEqual(['Review now', 'After invoices passes', 'Hold']);

    const chip = chips[0];
    const tapped = await call(chip.method, chip.path.replace(/^\/api/, '/api'), chip.body);
    expect(tapped.status).toBe(200);
    expect(panes.typed.at(-1)).toEqual({ agentId: agents.pm.id, text: 'Review now' });
    const prompts = (await thread()).filter((i) => i.kind === 'prompt');
    expect(prompts.at(-1)).toMatchObject({ actor_id: anaId, body: 'Review now', agent_id: agents.pm.id });
  });

  it('a prompt to builder that triggers tool calls (sent via MCP send_prompt) yields the final prose only', async () => {
    const { WaveCodeClient } = await import('../mcp/client.js');
    const { WAVECODE_TOOLS } = await import('../mcp/tools.js');
    const client = new WaveCodeClient({
      baseUrl: 'http://daemon.test',
      token: anaToken,
      fetchImpl: ((input: string, init?: RequestInit) => app.request(input, init)) as unknown as typeof fetch,
    });
    const prompt = 'what changed in auth.ts? summarize it and run the auth tests please, then tell me if anything is red';
    await WAVECODE_TOOLS.find((t) => t.name === 'send_prompt')!.handler(client, { agent_id: 'builder', text: prompt });
    finishTurn('builder', fixture('claude-tools.txt'));

    const reply = (await thread()).find((i) => i.kind === 'reply' && i.agent_id === agents.builder.id)!;
    expect(reply.body.startsWith('Two changes landed in auth.ts:')).toBe(true);
    expect(reply.body).not.toMatch(/● |Running…|⎿|Bash\(/);
    expect(reply.body).not.toContain('what changed in auth.ts');
    expect(reply.needs_attention).toBe(false);
    expect(reply.actions).toEqual([]);
  });

  it('Codex (via reply injection from /api/messages) and Grok seats reply with their chrome stripped', async () => {
    const msg = await call('POST', '/api/messages', { to: 'codex2', message: 'what is the status of the leases lane?' });
    expect(msg.json.injected).toBe(true);
    // Codex echoes the injected line `[from ana] …` in its composer history
    finishTurn('codex2', fixture('codex.txt').replace('› what is the status', '› [from ana] what is the status'));

    await call('POST', `/api/agents/${agents['grok-fe'].id}/send`, { text: 'how many agents are idle?' });
    finishTurn('grok-fe', fixture('grok-blocks.txt'));

    const items = await thread();
    const codexReply = items.find((i) => i.kind === 'reply' && i.agent_id === agents.codex2.id)!;
    expect(codexReply.body).toBe('The leases lane is complete: reserve/release, ownership guards and\nexpiry are in, and all 24 lease tests pass.\n\nNext step is the MCP tools (T3).');
    expect(codexReply.refs.prompt_event_id).toBe(items.find((i) => i.kind === 'report' && i.agent_id === agents.codex2.id)!.event_id);

    const grokReply = items.find((i) => i.kind === 'reply' && i.agent_id === agents['grok-fe'].id)!;
    expect(grokReply.body).toBe('Three agents are idle: pm, codex-rev and grok-fe. builder is working on\nT7 (reply capture).');
    for (const r of [codexReply, grokReply]) {
      expect(r.body).not.toMatch(/›|gpt-5|⎿|⏺|grok-4\.6|esc to interrupt|Worked for|\[from ana\]/);
    }
  });

  it('raw keys are not prompts — nothing is tracked or captured', async () => {
    await call('POST', `/api/agents/${agents.pm.id}/send`, { text: 'C-c', raw: true });
    finishTurn('pm', fixture('claude-pm-question.txt'));
    expect((await thread()).filter((i) => i.kind === 'reply')).toEqual([]);
  });

  it('clients cannot forge a reply', async () => {
    const res = await call('POST', '/api/messages', { from_agent_id: agents.pm.id, message: 'all done!', message_type: 'reply' });
    expect(res.status).toBe(400);
  });
});
