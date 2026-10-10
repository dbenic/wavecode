import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })), get: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('./llm-provider.js', () => ({ completeText: vi.fn(), isLlmConfigured: vi.fn(() => true) }));

const cfg = {
  projects: { wavepulse: { workspace_match: '**/ws/*', release_peer: 'deploy/fable' } } as Record<string, { workspace_match: string; release_peer?: string }>,
  peers: { deploy: { url: 'http://deploy.test', token: 'peer-token-0123456789' } },
  releases: {} as { deploy_agent?: string | null },
  overlord: { enabled: true, model: 'claude-sonnet-5-5', heartbeat_min: 0, max_wakes_per_hour: 2, debounce_s: 0, notify: true } as Record<string, unknown>,
  review: { auto_review: false, default_reviewer: 'x', self_review: true, max_fix_loops: 2, require_pass_to_promote: false, gate_dependents_on_approval: false, auto_pick: true, freeze_inbox: [] as string[] },
  artifacts: { storage: '', retention_days: 30 },
  server: { host: 'countix-dev' },
  paths: {},
};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => cfg) }));

const acting = { user: { id: 'owner', name: 'owner', role: 'admin', allowed_agents: null } as Record<string, unknown> };
vi.mock('./auth.js', async () => {
  const actual = await vi.importActual<typeof import('./auth.js')>('./auth.js');
  return { ...actual, getActingUser: vi.fn(() => acting.user) };
});

import { completeText } from './llm-provider.js';
import { notify } from './notifications.js';

const SHA = '2431f684b9e960b84e73a4e98b5068869664ffb4';

describe('overview board + overlord', () => {
  let tmp: string;
  let db: typeof import('./db.js');
  let bus: typeof import('./event-bus.js');
  let ov: typeof import('./overview.js');
  let ol: typeof import('./overlord.js');
  let rf: typeof import('./release-freezes.js');
  let thread: typeof import('./thread.js');
  let app: Hono;

  const agent = (name: string, status: 'idle' | 'working' = 'idle') => {
    const r = db.insertAgent({ name, runtime: 'claude-code', tmux_session: `wc-${name}`, workspace: path.join(tmp, 'ws', name), mode: 'spawned', status });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(completeText).mockReset();
    vi.mocked(notify).mockClear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-overlord-'));
    cfg.artifacts.storage = path.join(tmp, 'store');
    cfg.overlord = { enabled: true, model: 'claude-sonnet-5-5', heartbeat_min: 0, max_wakes_per_hour: 2, debounce_s: 0, notify: true };
    db = await import('./db.js');
    db.initDb(path.join(tmp, 't.db'));
    bus = await import('./event-bus.js');
    ov = await import('./overview.js');
    ol = await import('./overlord.js');
    rf = await import('./release-freezes.js');
    thread = await import('./thread.js');
    (await import('./code-review.js')).ensureReviewTable();
    (await import('./peers.js')).ensurePeerTables();
    (await import('./releases.js')).ensureReleaseTables();
    rf.ensureReleaseFreezeTable();
    ol.ensureOverlordTable();
    ol.resetOverlordForTest();
    const routes = await import('./routes/overview.js');
    app = new Hono();
    routes.registerOverviewRoutes(app as never);
  });

  afterEach(() => {
    ol.resetOverlordForTest();
    bus.resetEventListenersForTest();
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('the board reads agents, their work, replies and blocks, and the reviewed lanes with a deterministic next step — without asking anyone', () => {
    const claude2 = agent('claude2', 'working');
    const codex3 = agent('codex3');
    const task = db.insertTask({ agent_id: claude2.id, prompt: 'Desk #91: issued credit notes', created_by: null });
    if (!task.ok) throw new Error(task.error);
    const run = db.insertRun({ task_id: task.data.id, agent_id: claude2.id });
    if (!run.ok) throw new Error(run.error);
    bus.emit('agent.status_changed', 'agent', claude2.id, { status: 'working' }, null);
    db.insertAgentMessage({ from_agent_id: codex3.id, to_agent_id: null, message: 'Reviewed Desk #91: VERDICT: PASS', message_type: 'reply' });
    const inbox = path.join(tmp, 'inbox'); fs.mkdirSync(inbox);
    const note = path.join(inbox, `desk91-freeze-${SHA.slice(0, 8)}.md`);
    fs.writeFileSync(note, `# Desk #91 freeze note\n\nProject: wavepulse · Author: claude2\n- Lane: \`wc-claude2\`\n- Freeze SHA: \`${SHA}\`\n- Review: @codex3 **VERDICT: PASS** on this exact SHA: /r/v.md\n- Remote full-tuned: GREEN\n`);
    expect(rf.ingestFreezeFile(note).ok).toBe(true);

    const board = ov.buildBoard();
    const c2 = board.agents.find((a) => a.name === 'claude2')!;
    expect(c2.status).toBe('working');
    expect(c2.for_min).toBe(0);
    expect(c2.current?.prompt).toBe('Desk #91: issued credit notes');
    expect(c2.open_freezes).toBe(1);
    const c3 = board.agents.find((a) => a.name === 'codex3')!;
    expect(c3.last_reply?.text).toContain('VERDICT: PASS');
    expect(board.lanes).toHaveLength(1);
    expect(board.lanes[0]).toMatchObject({ sha: SHA, project: 'wavepulse', desk: 91, verdict: 'pass', gate: 'GREEN', promotable: true, next: 'reviewed — stage it, then promote', staging: null, production: null });
    expect(board.attention.map((a) => a.kind)).toContain('promotable');
    expect(board.counts).toMatchObject({ working: 1, idle: 1, open_lanes: 1, promotable: 1 });
  });

  it('a wake sends the board to the model, stores the parsed report, posts a thread item with actions and notifies on a new digest', async () => {
    const claude2 = agent('claude2');
    const inbox = path.join(tmp, 'inbox'); fs.mkdirSync(inbox);
    const note = path.join(inbox, `desk91-freeze-${SHA.slice(0, 8)}.md`);
    agent('codex3');
    fs.writeFileSync(note, `# Desk #91 freeze note\n\nProject: wavepulse · Author: claude2\n- Lane: \`wc-claude2\`\n- Freeze SHA: \`${SHA}\`\n- Review: @codex3 **VERDICT: PASS** on this exact SHA: /r/v.md\n`);
    expect(rf.ingestFreezeFile(note).ok).toBe(true);
    const runId = ov.buildBoard().lanes[0].run_id!;

    vi.mocked(completeText).mockResolvedValueOnce({ ok: true, data: '```json\n' + JSON.stringify({
      agents: [{ id: claude2.id, note: 'idle; Desk #91 reviewed and waiting for you' }],
      recommendations: [
        { kind: 'stage', run_id: runId, sha: SHA, text: 'Desk #91 2431f684 has an independent PASS; stage it.' },
        { kind: 'nudge', agent_id: claude2.id, text: 'Ask @claude2 what blocks Desk #92.' },
        { kind: 'bogus', text: 'unknown kind becomes info' },
      ],
      plan: [{ title: 'Desk #91 alone', shas: [SHA], target: 'production', why: 'independent change, PASS, gate green' }, { title: 'bad', shas: [], target: 'hold', why: 'dropped: no shas' }],
      digest: 'One lane ready: Desk #91 2431f684 (PASS). Stage it, then promote.\nNothing else needs you.',
    }) + '\n```' });

    const report = await ol.wake('review.ai_completed');
    expect(report).not.toBeNull();
    expect(vi.mocked(completeText)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(completeText).mock.calls[0][0];
    expect(call.model).toBe('claude-sonnet-5-5');
    expect(call.systemPrompt).toMatch(/coordinator/);
    const sent = JSON.parse(call.userMessage) as { lanes: Array<{ sha8: string; promotable: boolean }>; agents: Array<{ name: string }>; trigger: string };
    expect(sent.trigger).toBe('review.ai_completed');
    expect(sent.lanes[0]).toMatchObject({ sha8: SHA.slice(0, 8), promotable: true });
    expect(sent.agents.map((a) => a.name)).toContain('claude2');

    expect(report!.recommendations.map((r) => r.kind)).toEqual(['stage', 'nudge', 'info']);
    expect(report!.plan).toEqual([{ title: 'Desk #91 alone', shas: [SHA], target: 'production', why: 'independent change, PASS, gate green' }]);
    expect((JSON.parse(call.userMessage) as { lanes: Array<{ summary: string | null }> }).lanes[0].summary).toMatch(/Desk #91 freeze note/);
    expect(ol.getLatestReport()?.digest).toMatch(/^One lane ready/);
    expect(vi.mocked(notify)).toHaveBeenCalledWith(expect.objectContaining({ title: 'WaveCode overlord', url: '/overview' }));

    // the thread item carries the recommendations as buttons
    const ev = db.listEvents({ entity_type: 'overlord' }).find((e) => e.type === 'overlord.report')!;
    const item = thread.toThreadItem(ev, new thread.ThreadContext({ id: 'owner', name: 'owner', role: 'admin' } as never))!;
    expect(item.kind).toBe('report');
    expect(item.title).toMatch(/^Overlord: One lane ready/);
    expect(item.body).toContain('→ PRODUCTION: Desk #91 alone [2431f684] — independent change, PASS, gate green');
    expect(item.needs_attention).toBe(true);
    expect(item.actions.map((a) => a.path)).toEqual([`/api/reviews/${runId}/stage`, `/api/agents/${claude2.id}/send`]);
    expect(item.actions[1].body).toMatchObject({ text: expect.stringMatching(/^\[Overlord\] Ask @claude2/) });

    // the same digest again: no second notification
    vi.mocked(completeText).mockResolvedValueOnce({ ok: true, data: JSON.stringify({ agents: [], recommendations: [], digest: 'One lane ready: Desk #91 2431f684 (PASS). Stage it, then promote.\nNothing else needs you.' }) });
    await ol.wake('heartbeat');
    expect(vi.mocked(notify)).toHaveBeenCalledTimes(1);
  });

  it('wakes are capped per hour and debounced from board-changing events; a bad answer is logged, not stored', async () => {
    agent('claude2');
    vi.mocked(completeText).mockResolvedValue({ ok: true, data: 'not json at all' });
    expect(await ol.wake('a')).toBeNull();
    expect(ol.getLatestReport()).toBeNull();
    vi.mocked(completeText).mockResolvedValue({ ok: true, data: JSON.stringify({ agents: [], recommendations: [], digest: null }) });
    expect(await ol.wake('b')).not.toBeNull();
    expect(await ol.wake('c')).toBeNull(); // third in the hour: cap of 2
    expect(await ol.wake('d', { force: true })).not.toBeNull();

    ol.resetOverlordForTest();
    vi.mocked(completeText).mockClear();
    ol.startOverlord();
    bus.emit('run.finished', 'run', 'r1', {}, null);
    bus.emit('review.ai_completed', 'run', 'r1', {}, null);
    bus.emit('agent.output_updated', 'agent', 'a1', {}, null); // not a trigger
    await new Promise((r) => setTimeout(r, 30));
    expect(vi.mocked(completeText)).toHaveBeenCalledTimes(1); // two triggers, one debounced wake
    expect(vi.mocked(completeText).mock.calls[0][0].userMessage).toContain('"trigger":"run.finished,review.ai_completed"');
  });

  it('the routes: GET /api/overview returns board + report + settings; wake is admin only', async () => {
    agent('claude2');
    const res = await app.fetch(new Request('http://x/api/overview'));
    expect(res.status).toBe(200);
    const body = await res.json() as { board: { agents: unknown[] }; report: unknown; overlord: { enabled: boolean; model: string } };
    expect(body.board.agents).toHaveLength(1);
    expect(body.report).toBeNull();
    expect(body.overlord).toMatchObject({ enabled: true, model: 'claude-sonnet-5-5' });
    acting.user = { id: 'u-dev', name: 'antonio', role: 'developer', allowed_agents: null };
    expect((await app.fetch(new Request('http://x/api/overview/wake', { method: 'POST' }))).status).toBe(403);
    acting.user = { id: 'owner', name: 'owner', role: 'admin', allowed_agents: null };
    vi.mocked(completeText).mockResolvedValueOnce({ ok: true, data: JSON.stringify({ agents: [], recommendations: [{ kind: 'info', text: 'all quiet' }], digest: null }) });
    const wake = await app.fetch(new Request('http://x/api/overview/wake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(wake.status).toBe(201);
    expect(((await wake.json()) as { trigger: string }).trigger).toBe('manual:owner');
  });
});
