/**
 * The retro loop (spec §5f), end to end: reply feedback → seat brief and
 * list_feedback; per-template metrics; retro runs and proposals that apply
 * only on promote; seat tokens never change TEMPLATES/ or SPEC.md directly;
 * the nightly trigger. Real SQLite, auth, routes, seats; tmux simulated.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmuxHarness = vi.hoisted(() => ({
  sessions: new Set<string>(),
  typed: [] as Array<{ session: string; text: string }>,
}));

vi.mock('./tmux.js', () => ({
  hasSession: vi.fn((s: string) => tmuxHarness.sessions.has(s)),
  newSession: vi.fn((s: string) => { tmuxHarness.sessions.add(s); }),
  killSession: vi.fn((s: string) => tmuxHarness.sessions.delete(s)),
  sendTextAndEnter: vi.fn((session: string, text: string) => { tmuxHarness.typed.push({ session, text }); }),
  capturePane: vi.fn(() => ({ ok: true, data: '❯ \n  ⏵⏵ bypass permissions on' })),
  isValidSessionName: vi.fn(() => true),
  isAllowedRawKey: vi.fn(() => true),
}));
vi.mock('./runner.js', () => ({ startRunner: vi.fn(), stopRunner: vi.fn(), executeRun: vi.fn(), clearRunnerRun: vi.fn() }));
vi.mock('./output-watcher.js', () => ({
  startWatching: vi.fn(), stopWatching: vi.fn(), getLastOutputLine: vi.fn(() => null), getOutputVersion: vi.fn(() => 0), isWatching: vi.fn(() => false),
  isClaudeBypassAcceptDialog: vi.fn(() => false),
}));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { emit } from './event-bus.js';

const FALLBACK = 'fallback-admin';
type App = Hono<import('./auth.js').NodeAppEnv>;

describe('the retro loop (spec §5f)', () => {
  let tmpDir: string;
  let roomsRoot: string;
  let app: App;
  let db: typeof import('./db.js');
  let ana: { id: string; token: string };
  let bob: { id: string; token: string };
  let seatId: string;
  let seatToken: string;

  async function call(method: string, url: string, token: string, body?: unknown) {
    const res = await app.request(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  const typedInto = (name: string) => tmuxHarness.typed.filter((t) => t.session === `wc-${name}`).map((t) => t.text);
  const template = () => fs.readFileSync(path.join(roomsRoot, 'shop', 'TEMPLATES', 'build.md'), 'utf8');

  function reply(message: string, promptText: string): string {
    const prompt = emit('agent.prompt_sent', 'agent', seatId, { text: promptText }, ana.id);
    const r = db.insertAgentMessage({ from_agent_id: seatId, message, message_type: 'reply', ref_prompt_actor: ana.id, ref_prompt_event_id: prompt?.id ?? null });
    if (!r.ok) throw new Error(r.error);
    emit('message.created', 'agent_message', r.data.id, { from_agent_id: seatId, message_type: 'reply', ref_prompt_event_id: prompt?.id }, null);
    return r.data.id;
  }

  beforeEach(async () => {
    tmuxHarness.sessions.clear();
    tmuxHarness.typed.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-retro-'));
    roomsRoot = path.join(tmpDir, 'rooms');
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), [
      'auth:', '  method: token', `  fallback_token: ${FALLBACK}`,
      'autonomy:', '  auto_dispatch: false',
      'paths:', `  rooms_root: ${roomsRoot}`,
      'retro:', '  nightly: true', '  hour_utc: 3', '  window_days: 7',
      'artifacts:', `  storage: ${path.join(tmpDir, 'artifacts')}`, '',
    ].join('\n'));
    (await import('./config.js')).loadConfig(path.join(tmpDir, 'config.yaml'));
    db = await import('./db.js');
    db.resetDbForTest();
    db.initDb(path.join(tmpDir, 'test.db'));
    (await import('./reply-capture.js')).resetReplyCaptureForTest();

    const { createAuthMiddleware } = await import('./auth.js');
    app = new Hono();
    app.use('/api/*', createAuthMiddleware());
    (await import('./routes/rooms.js')).registerRoomRoutes(app);
    (await import('./routes/seat.js')).registerSeatRoutes(app);
    (await import('./routes/messages.js')).registerMessageRoutes(app);
    (await import('./routes/thread.js')).registerThreadRoutes(app);

    const { createUser } = await import('./users.js');
    const mk = (name: string, role: 'developer' | 'observer' = 'developer') => {
      const r = createUser({ name, role, profile: null as unknown as undefined });
      if (!r.ok) throw new Error(r.error);
      return { id: r.data.user.id, token: r.data.token };
    };
    ana = mk('ana');
    bob = mk('bob');

    // ana owns the shop room and has a seat (its token is what the seat's MCP uses)
    expect((await call('POST', '/api/rooms', ana.token, { project: 'shop' })).status).toBe(201);
    const seat = await call('POST', '/api/users/me/seat', ana.token, {});
    expect(seat.status).toBe(201);
    seatId = seat.json.agent.id;
    const mcp = JSON.parse(fs.readFileSync(path.join(seat.json.agent.workspace, '.mcp.json'), 'utf8'));
    seatToken = mcp.mcpServers.wavecode.headers.Authorization.replace('Bearer ', '');
    await vi.waitFor(() => expect(typedInto('pm-ana').length).toBeGreaterThan(0));
  });

  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('feedback on replies', () => {
    it('acceptance: a 👎 "too long" on an inventory answer is visible to the seat\'s next session (list_feedback + brief)', async () => {
      const id = reply('pm: idle. builder: T12. codex-rev: idle. grok-fe: idle. stamp-1: idle. stamp-2: idle …', 'who is free?');
      expect((await call('POST', `/api/messages/${id}/feedback`, ana.token, { score: -1, note: 'too long' })).json)
        .toMatchObject({ score: -1, note: 'too long', agent_id: seatId, user_id: ana.id });

      // the seat, with its own token, reads its feedback (list_feedback → GET /api/feedback)
      const { WaveCodeClient } = await import('../mcp/client.js');
      const { WAVECODE_TOOLS } = await import('../mcp/tools.js');
      const client = new WaveCodeClient({ baseUrl: 'http://d', token: seatToken, fetchImpl: ((i: string, init?: RequestInit) => app.request(i, init)) as unknown as typeof fetch });
      const rows = await WAVECODE_TOOLS.find((t) => t.name === 'list_feedback')!.handler(client, {}) as Array<Record<string, unknown>>;
      expect(rows).toEqual([expect.objectContaining({ score: -1, note: 'too long', prompt_excerpt: 'who is free?' })]);

      // its next session (re-brief) starts from it
      expect((await call('POST', '/api/users/me/seat/brief', ana.token)).status).toBe(200);
      const brief = typedInto('pm-ana').at(-1)!;
      expect(brief).toContain('Feedback on your recent answers');
      expect(brief).toContain('👎 "too long" — on: "who is free?"');
      expect(brief).toContain('list_feedback');
    });

    it('one vote per person per reply (re-vote replaces); thread shows counts and my vote; validation', async () => {
      const id = reply('short answer', 'status?');
      await call('POST', `/api/messages/${id}/feedback`, ana.token, { score: -1 });
      await call('POST', `/api/messages/${id}/feedback`, ana.token, { score: 1, note: 'better now' });
      await call('POST', `/api/messages/${id}/feedback`, bob.token, { score: -1 });
      const item = ((await call('GET', '/api/thread', ana.token)).json.items as Array<Record<string, any>>).find((i) => i.kind === 'reply')!;
      expect(item.feedback).toEqual({ up: 1, down: 1, mine: 1, mine_note: 'better now', can_vote: true });

      expect((await call('POST', `/api/messages/${id}/feedback`, ana.token, { score: 5 })).status).toBe(400);
      expect((await call('POST', '/api/messages/nope/feedback', ana.token, { score: 1 })).status).toBe(404);
      const msg = db.insertAgentMessage({ message: 'not a reply', message_type: 'info' });
      expect((await call('POST', `/api/messages/${(msg as { data: { id: string } }).data.id}/feedback`, ana.token, { score: 1 })).status).toBe(400);
    });
  });

  describe('metrics', () => {
    it('acceptance: per-template first-pass rate (and fix rounds, questions, time to RESULT) after two tasks', async () => {
      const { ensureReviewTable } = await import('./code-review.js');
      ensureReviewTable();
      const worker = db.insertAgent({ name: 'builder', runtime: 'claude-code', tmux_session: 'wc-builder', workspace: null, mode: 'spawned', status: 'idle' });
      if (!worker.ok) throw new Error(worker.error);
      const mkTask = (prompt: string, reviews: Array<[number, string]>) => {
        const t = db.insertTask({ prompt, room: 'shop', template: 'build', created_by: ana.id });
        if (!t.ok) throw new Error(t.error);
        const r = db.insertRun({ task_id: t.data.id, agent_id: worker.data.id });
        if (!r.ok) throw new Error(r.error);
        db.finishRun(r.data.id, 0);
        reviews.forEach(([round, verdict], i) => db.getDb().prepare(`INSERT INTO code_reviews (id, run_id, reviewer_type, status, verdict, fix_round, feedback)
          VALUES (?, ?, 'cross-model', 'done', ?, ?, 'x')`).run(`rv-${t.data.id}-${i}`, r.data.id, verdict, round));
        return t.data;
      };
      mkTask('first', [[0, 'pass']]);
      const second = mkTask('second', [[0, 'needs-fixes'], [1, 'pass']]);
      db.insertAgentMessage({ from_agent_id: worker.data.id, message: 'which API version?', message_type: 'request', ref_task_id: second.id });

      const res = await call('GET', '/api/rooms/shop/metrics', bob.token);
      const build = res.json.templates.find((m: { template: string }) => m.template === 'build');
      expect(build).toMatchObject({ tasks: 2, reviewed: 2, first_pass_rate: 0.5, mean_fix_rounds: 0.5, questions_rate: 0.5 });
      expect(build.mean_time_to_result_s).toBeGreaterThanOrEqual(0);
      expect(res.json.templates.find((m: { template: string }) => m.template === 'verify')).toMatchObject({ tasks: 0, first_pass_rate: null });
    });
  });

  describe('proposals: nothing in TEMPLATES/ or SPEC.md changes without a promote', () => {
    it('acceptance: a build-template edit proposed by the retro (seat) appears in the review queue with its evidence and applies on promote', async () => {
      const before = template();
      const { WaveCodeClient } = await import('../mcp/client.js');
      const { WAVECODE_TOOLS } = await import('../mcp/tools.js');
      const seat = new WaveCodeClient({ baseUrl: 'http://d', token: seatToken, fetchImpl: ((i: string, init?: RequestInit) => app.request(i, init)) as unknown as typeof fetch });
      const proposed = await WAVECODE_TOOLS.find((t) => t.name === 'propose_room_change')!.handler(seat, {
        room: 'shop',
        path: 'TEMPLATES/build.md',
        content: `${before}\n- run \`npm run typecheck\` before you write RESULT\n`,
        evidence: '4/6 builds failed typecheck on first review → add npm run typecheck to build done_when',
      }) as { id: string };
      expect(template()).toBe(before); // not applied yet

      const queue = (await call('GET', '/api/proposals?status=pending', ana.token)).json as Array<Record<string, string>>;
      expect(queue).toEqual([expect.objectContaining({
        id: proposed.id, room: 'shop', path: 'TEMPLATES/build.md', status: 'pending', proposed_by: ana.id,
        evidence: expect.stringContaining('4/6 builds failed typecheck'),
        diff: expect.stringContaining('+ - run `npm run typecheck` before you write RESULT'),
      })]);

      expect((await call('POST', `/api/proposals/${proposed.id}/promote`, seatToken)).status).toBe(403); // a person promotes
      expect((await call('POST', `/api/proposals/${proposed.id}/promote`, bob.token)).status).toBe(403); // not the room owner
      expect((await call('POST', `/api/proposals/${proposed.id}/promote`, ana.token)).json).toMatchObject({ status: 'approved', decided_by: ana.id });
      expect(template()).toContain('npm run typecheck` before you write RESULT');
      expect(fs.readFileSync(path.join(roomsRoot, 'shop', 'LEDGER.md'), 'utf8')).toContain('proposal promoted');
    });

    it('a seat writing TEMPLATES/ or SPEC.md directly gets a proposal (202), not a change; ROOM.md stays writable', async () => {
      const spec = fs.readFileSync(path.join(roomsRoot, 'shop', 'SPEC.md'), 'utf8');
      const viaSeat = await call('PUT', '/api/rooms/shop/docs/SPEC.md', seatToken, { content: '# rewritten by the seat' });
      expect(viaSeat.status).toBe(202);
      expect(viaSeat.json).toMatchObject({ proposed: true, proposal: { path: 'SPEC.md', status: 'pending' } });
      expect(fs.readFileSync(path.join(roomsRoot, 'shop', 'SPEC.md'), 'utf8')).toBe(spec);
      expect((await call('PUT', '/api/rooms/shop/docs/TEMPLATES/build.md', seatToken, { content: 'x' })).status).toBe(202);
      expect((await call('PUT', '/api/rooms/shop/docs/ROOM.md', seatToken, { content: '# Room\n\n## Vocabulary\n- "who is free" = can take work now\n' })).status).toBe(200);

      // reject leaves it unchanged; a proposal made stale by a later edit is refused
      const [p1, p2] = (await call('GET', '/api/rooms/shop/proposals?status=pending', ana.token)).json as Array<{ id: string; path: string }>;
      expect((await call('POST', `/api/proposals/${p2.id}/reject`, ana.token)).json.status).toBe('rejected');
      await call('PUT', `/api/rooms/shop/docs/${p1.path}`, ana.token, { content: 'edited by ana meanwhile' });
      const stale = await call('POST', `/api/proposals/${p1.id}/promote`, ana.token);
      expect(stale.status).toBe(409);
      expect(stale.json.error).toMatch(/stale/);
      expect((await call('POST', `/api/proposals/${p1.id}/promote`, ana.token)).status).toBe(409);
    });

    it('proposal validation', async () => {
      const bad = (body: Record<string, unknown>) => call('POST', '/api/rooms/shop/proposals', ana.token, body);
      expect((await bad({ path: 'LEDGER.md', content: 'x', evidence: 'e' })).status).toBe(400);
      expect((await bad({ path: 'REPORTS/x.md', content: 'x', evidence: 'e' })).status).toBe(400);
      expect((await bad({ path: 'TEMPLATES/build.md', content: 'x', evidence: '' })).status).toBe(400);
      expect((await bad({ path: '../x.md', content: 'x', evidence: 'e' })).status).toBe(400);
      expect((await bad({ path: 'TEMPLATES/build.md', content: template(), evidence: 'e' })).status).toBe(400); // no change
      expect((await call('POST', '/api/rooms/nope/proposals', ana.token, { path: 'ROOM.md', content: 'x', evidence: 'e' })).status).toBe(404);
    });
  });

  describe('running the retro', () => {
    it('sends the room owner\'s seat the evidence (tasks, feedback, questions, metrics) with the proposal instructions', async () => {
      const id = reply('long inventory…', 'who is free?');
      await call('POST', `/api/messages/${id}/feedback`, ana.token, { score: -1, note: 'too long' });
      db.insertTask({ prompt: 'Add Apple Pay', room: 'shop', template: 'build', created_by: ana.id });

      const res = await call('POST', '/api/rooms/shop/retro', ana.token);
      expect(res.status).toBe(202);
      expect(res.json).toMatchObject({ seat: 'pm-ana', evidence: expect.stringMatching(/^REPORTS\/\d{4}-\d{2}-\d{2}-retro-evidence\.md$/) });
      const evidence = fs.readFileSync(path.join(roomsRoot, 'shop', res.json.evidence), 'utf8');
      expect(evidence).toContain('## Metrics per template');
      expect(evidence).toContain('[build] pending: Add Apple Pay');
      expect(evidence).toContain('👎 "too long" — question: "who is free?"');
      expect(evidence).toContain('- who is free?'); // what people asked the seat

      const prompt = typedInto('pm-ana').at(-1)!;
      expect(prompt).toContain('propose_room_change');
      expect(prompt).toContain('"## Vocabulary"');
      expect(prompt).toContain('Do not edit TEMPLATES/ or SPEC.md directly');
      expect(prompt).not.toContain('\n');
      expect(db.listEvents().some((e) => e.type === 'retro.started')).toBe(true);
      expect((await call('POST', '/api/rooms/nope/retro', ana.token)).status).toBe(404);
    });

    it('wavecode retro <room> asks the daemon', async () => {
      const { runRetroCommand, formatRetroStarted } = await import('../cli/retro-command.js');
      const { WaveCodeClient } = await import('../mcp/client.js');
      const client = new WaveCodeClient({ baseUrl: 'http://d', token: ana.token, fetchImpl: ((i: string, init?: RequestInit) => app.request(i, init)) as unknown as typeof fetch });
      db.insertTask({ prompt: 'x', room: 'shop', created_by: ana.id });
      const r = await runRetroCommand('shop', client);
      expect(r.ok && r.data.seat).toBe('pm-ana');
      expect(formatRetroStarted('shop', { seat: 'pm-ana', evidence: 'REPORTS/x.md', activity: 1 })).toContain('review queue');
      expect((await runRetroCommand('nope', client)).ok).toBe(false);
    });

    it('nightly: at hour_utc, once per UTC day, only rooms with activity', async () => {
      const { maybeRunNightlyRetros } = await import('./retro.js');
      expect((await call('POST', '/api/rooms', bob.token, { project: 'quiet' })).status).toBe(201);
      db.insertTask({ prompt: 'x', room: 'shop', created_by: ana.id });
      const now = new Date();
      const at = (h: number, dayOffset = 0) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, h, 5));
      expect(await maybeRunNightlyRetros(at(2))).toEqual([]); // not the hour
      expect(await maybeRunNightlyRetros(at(3))).toEqual(['shop']); // quiet room has no activity
      expect(await maybeRunNightlyRetros(at(3))).toEqual([]); // once per day
      expect(await maybeRunNightlyRetros(at(3, 1))).toEqual(['shop']); // next day
    });
  });
});
