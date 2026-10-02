/**
 * Project rooms (spec §5e): layout, access rules, path safety, room
 * resolution, briefing, reports + ledger, decisions mirror, routes/MCP and
 * the §5e acceptance criteria end to end. Real SQLite/routes/dispatcher;
 * tmux simulated.
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
  killSession: vi.fn(),
  sendTextAndEnter: vi.fn((session: string, text: string) => { tmuxHarness.typed.push({ session, text }); }),
  capturePane: vi.fn(() => ({ ok: true, data: '❯ \n  ⏵⏵ bypass permissions on' })),
  isValidSessionName: vi.fn(() => true),
  isAllowedRawKey: vi.fn(() => true),
}));
vi.mock('./runner.js', () => ({ startRunner: vi.fn(), stopRunner: vi.fn(), executeRun: vi.fn(), clearRunnerRun: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const FALLBACK = 'fallback-admin';
type App = Hono<import('./auth.js').NodeAppEnv>;

describe('project rooms (spec §5e)', () => {
  let tmpDir: string;
  let roomsRoot: string;
  let wsRoot: string;
  let app: App;
  let db: typeof import('./db.js');
  let rooms: typeof import('./rooms.js');
  let ana: { id: string; token: string };
  let bob: { id: string; token: string };
  let watcher: { id: string; token: string };

  async function call(method: string, url: string, token: string, body?: unknown) {
    const res = await app.request(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  function agent(name: string, workspace: string | null) {
    if (workspace) fs.mkdirSync(workspace, { recursive: true });
    const a = db.insertAgent({ name, runtime: 'claude-code', tmux_session: `wc-${name}`, workspace, mode: 'adopted', status: 'idle' });
    if (!a.ok) throw new Error(a.error);
    tmuxHarness.sessions.add(`wc-${name}`);
    return a.data;
  }

  const typedInto = (name: string) => tmuxHarness.typed.filter((t) => t.session === `wc-${name}`).map((t) => t.text);

  beforeEach(async () => {
    tmuxHarness.sessions.clear();
    tmuxHarness.typed.length = 0;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-rooms-'));
    roomsRoot = path.join(tmpDir, 'rooms');
    wsRoot = path.join(tmpDir, 'ws');
    fs.writeFileSync(path.join(tmpDir, 'config.yaml'), [
      'auth:', '  method: token', `  fallback_token: ${FALLBACK}`,
      'autonomy:', '  auto_dispatch: false',
      'paths:', `  rooms_root: ${roomsRoot}`,
      'projects:', '  shop:', `    workspace_match: "${wsRoot}/shop-*"`,
      'artifacts:', `  storage: ${path.join(tmpDir, 'artifacts')}`, '',
    ].join('\n'));
    (await import('./config.js')).loadConfig(path.join(tmpDir, 'config.yaml'));
    db = await import('./db.js');
    db.resetDbForTest();
    db.initDb(path.join(tmpDir, 'test.db'));
    rooms = await import('./rooms.js');

    const { createAuthMiddleware } = await import('./auth.js');
    app = new Hono();
    app.use('/api/*', createAuthMiddleware());
    (await import('./routes/rooms.js')).registerRoomRoutes(app);
    (await import('./routes/tasks.js')).registerTaskRoutes(app);
    (await import('./routes/docs.js')).registerDocsRoutes(app);
    (await import('./routes/decisions.js')).registerDecisionRoutes(app);

    const { createUser } = await import('./users.js');
    const mk = (name: string, role: 'developer' | 'observer' = 'developer') => {
      const r = createUser({ name, role });
      if (!r.ok) throw new Error(r.error);
      return { id: r.data.user.id, token: r.data.token };
    };
    ana = mk('ana');
    bob = mk('bob');
    watcher = mk('watcher', 'observer');
  });

  afterEach(() => {
    db.resetDbForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('layout and resolution', () => {
    it('a room folder has SPEC, ROOM, LEDGER, DECISIONS, REPORTS/ and the four templates; ensureRoom never overwrites', () => {
      const room = rooms.ensureRoom('notes', ana.id);
      if (!room.ok) throw new Error(room.error);
      expect(room.data).toMatchObject({ project: 'notes', root: path.join(roomsRoot, 'notes'), owner_id: ana.id });
      for (const f of ['SPEC.md', 'ROOM.md', 'LEDGER.md', 'DECISIONS.md', 'TEMPLATES/build.md', 'TEMPLATES/review.md', 'TEMPLATES/verify.md', 'TEMPLATES/spec.md']) {
        expect(fs.existsSync(path.join(room.data.root, f)), f).toBe(true);
      }
      expect(fs.statSync(path.join(room.data.root, 'REPORTS')).isDirectory()).toBe(true);
      fs.writeFileSync(path.join(room.data.root, 'SPEC.md'), 'kept');
      rooms.ensureRoom('notes');
      expect(fs.readFileSync(path.join(room.data.root, 'SPEC.md'), 'utf8')).toBe('kept');
      expect(rooms.ensureRoom('Bad Name').ok).toBe(false);
    });

    it('configured projects get rooms; tasks resolve explicit → workspace match → creator default', () => {
      expect(rooms.listRooms().map((r) => r.project)).toEqual(['shop']);
      expect(rooms.roomForWorkspace(`${wsRoot}/shop-frontend`)?.project).toBe('shop');
      expect(rooms.roomForWorkspace(`${wsRoot}/other`)).toBeNull();

      rooms.ensureRoom('notes');
      db.updateUserDefaultRoom(ana.id, 'notes');
      expect(rooms.resolveTaskRoom({ explicit: 'notes', agent: { workspace: `${wsRoot}/shop-x` } })?.project).toBe('notes');
      expect(rooms.resolveTaskRoom({ agent: { workspace: `${wsRoot}/shop-x` }, creatorId: ana.id })?.project).toBe('shop');
      expect(rooms.resolveTaskRoom({ agent: { workspace: '/elsewhere' }, creatorId: ana.id })?.project).toBe('notes');
      expect(rooms.resolveTaskRoom({ agent: null, creatorId: bob.id })).toBeNull();
    });

    it('agent workspaces get .wavecode/room → the room (and it stays out of git status)', () => {
      const room = rooms.ensureRoom('shop');
      if (!room.ok) throw new Error(room.error);
      const ws = path.join(wsRoot, 'shop-fe');
      fs.mkdirSync(path.join(ws, '.git', 'info'), { recursive: true });
      expect(rooms.linkRoomIntoWorkspace(ws, room.data)).toBe(true);
      expect(fs.readlinkSync(path.join(ws, '.wavecode', 'room'))).toBe(room.data.root);
      expect(fs.readFileSync(path.join(ws, '.git', 'info', 'exclude'), 'utf8')).toContain('.wavecode/');
      expect(rooms.linkRoomIntoWorkspace(ws, room.data)).toBe(true); // idempotent
      expect(rooms.linkRoomIntoWorkspace('/does/not/exist', room.data)).toBe(false);
    });
  });

  describe('access rules and path safety', () => {
    it('owner/admin for SPEC.md and TEMPLATES/; any seat for ROOM.md and REPORTS/; LEDGER/DECISIONS WaveCode-only; observers read-only', () => {
      const room = { owner_id: ana.id };
      const as = (id: string, role: 'admin' | 'developer' | 'observer') => (p: string) => rooms.canWriteDoc({ id, role }, room, p).ok;
      const owner = as(ana.id, 'developer');
      const other = as(bob.id, 'developer');
      const admin = as('owner', 'admin');
      const obs = as(watcher.id, 'observer');
      expect([owner('SPEC.md'), other('SPEC.md'), admin('SPEC.md'), obs('SPEC.md')]).toEqual([true, false, true, false]);
      expect([owner('TEMPLATES/build.md'), other('TEMPLATES/build.md')]).toEqual([true, false]);
      expect([other('ROOM.md'), other('REPORTS/x.md'), obs('ROOM.md')]).toEqual([true, true, false]);
      expect([admin('LEDGER.md'), admin('DECISIONS.md')]).toEqual([false, false]);
      expect(other('notes.md')).toBe(false);
    });

    it('paths stay inside the room: no .., absolute, dotfiles, other extensions, or symlinks', () => {
      const room = rooms.ensureRoom('notes');
      if (!room.ok) throw new Error(room.error);
      for (const bad of ['../x.md', '/etc/passwd', 'REPORTS/../../x.md', '.secret.md', 'a.sh', 'REPORTS//x.md', '']) {
        expect(rooms.resolveDocPath(room.data, bad).ok, bad).toBe(false);
      }
      fs.symlinkSync(tmpDir, path.join(room.data.root, 'REPORTS', 'out'));
      expect(rooms.resolveDocPath(room.data, 'REPORTS/out/x.md')).toMatchObject({ ok: false, error: expect.stringMatching(/symlink/) });
      expect(rooms.resolveDocPath(room.data, './REPORTS/ok.md')).toMatchObject({ ok: true, data: { rel: 'REPORTS/ok.md' } });
    });

    it('writes are guarded against lost updates: a stale expected_modified_at is a 409 conflict', () => {
      const room = rooms.ensureRoom('conflict');
      if (!room.ok) throw new Error(room.error);
      const admin = { id: 'owner', role: 'admin' as const };
      expect(rooms.writeDoc(room.data, 'ROOM.md', 'v1', admin).ok).toBe(true);
      const file = path.join(room.data.root, 'ROOM.md');
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(file, past, past);
      const seen = rooms.readDoc(room.data, 'ROOM.md');
      if (!seen.ok) throw new Error(seen.error);
      expect(seen.data.modified_at).toBe(past.toISOString());

      const fresh = rooms.writeDoc(room.data, 'ROOM.md', 'v2', admin, { expectedModifiedAt: seen.data.modified_at });
      expect(fresh.ok).toBe(true);
      const stale = rooms.writeDoc(room.data, 'ROOM.md', 'v3 from an old editor', admin, { expectedModifiedAt: seen.data.modified_at });
      expect(stale).toMatchObject({ ok: false, code: 'conflict' });
      expect(fs.readFileSync(file, 'utf8')).toBe('v2');
      expect(fs.readdirSync(room.data.root).some((f) => f.endsWith('.tmp'))).toBe(false);
    });

    it('the dispatch briefing is byte-capped: one huge ROOM.md line cannot bloat every task prompt', () => {
      const room = rooms.ensureRoom('bloat');
      if (!room.ok) throw new Error(room.error);
      const admin = { id: 'owner', role: 'admin' as const };
      expect(rooms.writeDoc(room.data, 'ROOM.md', 'x'.repeat(200 * 1024), admin).ok).toBe(true);
      const briefing = rooms.roomBriefing(room.data, 'build', 'do the thing');
      expect(Buffer.byteLength(briefing, 'utf8')).toBeLessThan(16 * 1024);
      expect(briefing).toContain('[… truncated]');
      expect(briefing).toContain('do the thing');
    });

    it('template placeholders inside the task text are never expanded', () => {
      expect(rooms.fillTemplate('{task}', { task: 'keep {done_when} and {room} literal', room: '/r', done_when: 'DW' }))
        .toBe('keep {done_when} and {room} literal');
      expect(rooms.fillTemplate('Room {room}\n{task}\nDone: {done_when}', { task: 'T', room: '/r', done_when: 'DW' }))
        .toBe('Room /r\nT\nDone: DW');
    });
  });

  describe('routes', () => {
    it('list rooms, create (caller owns it), list/read/write docs with writable flags', async () => {
      expect((await call('POST', '/api/rooms', ana.token, { project: 'notes' })).json).toMatchObject({ project: 'notes', owner_id: ana.id });
      expect((await call('POST', '/api/rooms', ana.token, { project: 'notes' })).status).toBe(409);
      expect((await call('POST', '/api/rooms', ana.token, { project: 'Bad Name' })).status).toBe(400);
      const listed = (await call('GET', '/api/rooms', bob.token)).json as Array<{ project: string; can_write_spec: boolean; owner: string | null }>;
      expect(listed.map((r) => [r.project, r.can_write_spec, r.owner])).toEqual([['notes', false, 'ana'], ['shop', false, null]]);

      const docs = (await call('GET', '/api/rooms/notes/docs', bob.token)).json.docs as Array<{ path: string; writable: boolean }>;
      expect(docs.slice(0, 4).map((d) => d.path)).toEqual(['SPEC.md', 'ROOM.md', 'LEDGER.md', 'DECISIONS.md']);
      expect(docs.find((d) => d.path === 'ROOM.md')?.writable).toBe(true);
      expect(docs.find((d) => d.path === 'SPEC.md')?.writable).toBe(false);

      expect((await call('PUT', '/api/rooms/notes/docs/ROOM.md', bob.token, { content: '# notes\n\n## Current goal\nship v1\n' })).status).toBe(200);
      expect((await call('GET', '/api/rooms/notes/docs/ROOM.md', ana.token)).json).toMatchObject({ path: 'ROOM.md', content: expect.stringContaining('ship v1'), writable: true });
      expect((await call('GET', '/api/rooms/notes/docs/REPORTS/missing.md', ana.token)).status).toBe(404);
      expect((await call('GET', '/api/rooms/nope/docs', ana.token)).status).toBe(404);
      expect((await call('PUT', '/api/rooms/notes/docs/..%2Fescape.md', ana.token, { content: 'x' })).status).toBe(400);
      expect((await call('PUT', '/api/rooms/notes/docs/ROOM.md', watcher.token, { content: 'x' })).status).toBe(403);
    });

    it('acceptance: a user without room write access gets 403 on SPEC.md but can read it', async () => {
      await call('POST', '/api/rooms', ana.token, { project: 'notes' });
      expect((await call('PUT', '/api/rooms/notes/docs/SPEC.md', ana.token, { content: '# Notes app\n\nOffline-first notes.' })).status).toBe(200);
      const denied = await call('PUT', '/api/rooms/notes/docs/SPEC.md', bob.token, { content: 'hijack' });
      expect(denied.status).toBe(403);
      expect(denied.json.error).toBe('Only the room owner or an admin may write SPEC.md');
      expect((await call('GET', '/api/rooms/notes/docs/SPEC.md', bob.token)).json.content).toContain('Offline-first notes.');
      expect((await call('PUT', '/api/rooms/notes/docs/LEDGER.md', FALLBACK, { content: 'x' })).status).toBe(403);
      // the owner can hand the room over
      expect((await call('PATCH', '/api/rooms/notes', bob.token, { owner_id: bob.id })).status).toBe(403);
      expect((await call('PATCH', '/api/rooms/notes', ana.token, { owner_id: bob.id })).json.owner_id).toBe(bob.id);
      expect((await call('PUT', '/api/rooms/notes/docs/SPEC.md', bob.token, { content: 'v2' })).status).toBe(200);
    });

    it('tasks carry their room (explicit / workspace / default) and template; bad values are 400', async () => {
      await call('POST', '/api/rooms', ana.token, { project: 'notes' });
      const shopAgent = agent('shop-fe', path.join(wsRoot, 'shop-fe'));
      expect((await call('POST', '/api/tasks', ana.token, { prompt: 'x', agent_id: shopAgent.id, hold: true })).json.room).toBe('shop');
      expect((await call('POST', '/api/tasks', ana.token, { prompt: 'x', room: 'notes', template: 'verify', hold: true })).json)
        .toMatchObject({ room: 'notes', template: 'verify' });
      expect((await call('PUT', '/api/users/me/default-room', ana.token, { room: 'notes' })).json).toEqual({ default_room: 'notes' });
      expect((await call('POST', '/api/tasks', ana.token, { prompt: 'x', hold: true })).json.room).toBe('notes');
      expect((await call('POST', '/api/tasks', bob.token, { prompt: 'x', hold: true })).json.room).toBeNull();
      expect((await call('POST', '/api/tasks', ana.token, { prompt: 'x', template: 'deploy' })).status).toBe(400);
      expect((await call('POST', '/api/tasks', ana.token, { prompt: 'x', room: 'nope' })).status).toBe(400);
    });

    it('MCP list_docs / read_doc / write_doc act through the same rules', async () => {
      const { WaveCodeClient } = await import('../mcp/client.js');
      const { WAVECODE_TOOLS } = await import('../mcp/tools.js');
      const fetchImpl = ((input: string, init?: RequestInit) => app.request(input, init)) as unknown as typeof fetch;
      const seat = (token: string) => new WaveCodeClient({ baseUrl: 'http://daemon.test', token, fetchImpl });
      const tool = (name: string) => WAVECODE_TOOLS.find((t) => t.name === name)!;
      await call('POST', '/api/rooms', ana.token, { project: 'notes' });

      await tool('write_doc').handler(seat(ana.token), { room: 'notes', path: 'SPEC.md', content: '# Notes\n\nWe are building offline-first notes.' });
      await expect(tool('write_doc').handler(seat(bob.token), { room: 'notes', path: 'SPEC.md', content: 'x' })).rejects.toThrow(/room owner or an admin/);
      await tool('write_doc').handler(seat(bob.token), { room: 'notes', path: 'REPORTS/bob-notes.md', content: 'findings' });
      expect(await tool('read_doc').handler(seat(bob.token), { room: 'notes', path: 'SPEC.md' })).toMatchObject({ content: expect.stringContaining('offline-first') });
      const list = (await tool('list_docs').handler(seat(bob.token), { room: 'notes' })) as { docs: Array<{ path: string }> };
      expect(list.docs.map((d) => d.path)).toContain('REPORTS/bob-notes.md');
      expect((await tool('list_rooms').handler(seat(bob.token), {})) as unknown[]).toHaveLength(2);
    });
  });

  describe('acceptance: the spec reaches the developer and the tester', () => {
    it('a spec written via write_doc is in the developer\'s (build) and tester\'s (verify) dispatch briefing', async () => {
      const dev = agent('shop-dev', path.join(wsRoot, 'shop-dev'));
      const tester = agent('shop-qa', path.join(wsRoot, 'shop-qa'));
      rooms.ensureRoom('shop');
      expect((await call('PUT', '/api/rooms/shop/docs/SPEC.md', FALLBACK, { content: '# Shop\n\nWe are building a checkout with Apple Pay.\n' })).status).toBe(200);

      await call('POST', '/api/tasks', ana.token, { prompt: 'Implement the Apple Pay button', agent_id: dev.id, hold: true });
      await call('POST', '/api/tasks', ana.token, { prompt: 'Verify the Apple Pay checkout', agent_id: tester.id, template: 'verify', hold: true });
      const dispatcher = await import('./task-dispatcher.js');
      dispatcher.resetDispatcherForTest();
      await dispatcher.dispatchNext({ manual: true });
      // the dispatcher staggers seats by 1.5s
      await vi.waitFor(() => expect(typedInto('shop-dev').length + typedInto('shop-qa').length).toBe(2), { timeout: 5000 });

      const devPrompt = typedInto('shop-dev')[0];
      expect(devPrompt).toContain('## PROJECT ROOM: shop');
      expect(devPrompt).toContain('We are building a checkout with Apple Pay.');
      expect(devPrompt).toContain('# Build');
      expect(devPrompt).toContain('Implement the Apple Pay button');
      expect(devPrompt).toContain('npm run typecheck'); // build done_when
      const qaPrompt = typedInto('shop-qa')[0];
      expect(qaPrompt).toContain('We are building a checkout with Apple Pay.');
      expect(qaPrompt).toContain('# Verify');
      expect(fs.readlinkSync(path.join(wsRoot, 'shop-dev', '.wavecode', 'room'))).toBe(path.join(roomsRoot, 'shop'));
    });
  });

  describe('reports and ledger', () => {
    function shopTaskAndRun(agentName: string) {
      const a = agent(agentName, path.join(wsRoot, agentName));
      const task = db.insertTask({ prompt: 'Implement Apple Pay', agent_id: a.id, created_by: ana.id, room: 'shop' });
      if (!task.ok) throw new Error(task.error);
      const run = db.insertRun({ task_id: task.data.id, agent_id: a.id });
      if (!run.ok) throw new Error(run.error);
      return { a, task: task.data, run: run.data };
    }

    it('acceptance: a review verdict lands as a file under REPORTS/ and a line in LEDGER.md', async () => {
      rooms.ensureRoom('shop');
      const { run } = shopTaskAndRun('shop-dev');
      const cr = await import('./code-review.js');
      cr.ensureReviewTable();
      db.getDb().prepare(`INSERT INTO code_reviews (id, run_id, reviewer_type, reviewer_agent_id, reviewer_runtime, status, diff)
        VALUES ('rv-1', ?, 'cross-model', NULL, 'codex', 'reviewing', 'diff')`).run(run.id);
      cr.finalizeReview('rv-1', '1. HIGH src/pay.ts missing error path\nVERDICT: needs-fixes', { allowFixLoop: false });

      const reports = fs.readdirSync(path.join(roomsRoot, 'shop', 'REPORTS'));
      const review = reports.find((f) => f.includes('review-r0'))!;
      expect(review).toMatch(/^\d{4}-\d{2}-\d{2}-task1-review-r0\.md$/);
      const body = fs.readFileSync(path.join(roomsRoot, 'shop', 'REPORTS', review), 'utf8');
      expect(body).toContain('- Verdict: needs-fixes');
      expect(body).toContain('missing error path');
      const ledger = fs.readFileSync(path.join(roomsRoot, 'shop', 'LEDGER.md'), 'utf8');
      expect(ledger).toMatch(/\| #1 \| shop-dev \| review r0 \| VERDICT: needs-fixes( \(\d+ issues\))? \| REPORTS\/.*review-r0\.md \|/);
    });

    it('a finished run copies its RESULT file and prose into REPORTS/ with a ledger line', async () => {
      rooms.ensureRoom('shop');
      const { a, run } = shopTaskAndRun('shop-dev');
      const { resultPathForRun } = await import('./run-result.js');
      const resultFile = resultPathForRun(run);
      fs.mkdirSync(path.dirname(resultFile), { recursive: true });
      fs.writeFileSync(resultFile, 'Apple Pay button added, 12 tests\nRESULT: PASS\n');
      db.updateRunSummary(run.id, 'Added the Apple Pay button behind a feature flag.');
      db.finishRun(run.id, 0);
      const dispatcher = await import('./task-dispatcher.js');
      await dispatcher.onRunComplete(run.id, a.id);

      const report = fs.readdirSync(path.join(roomsRoot, 'shop', 'REPORTS')).find((f) => f.includes('-result'))!;
      const body = fs.readFileSync(path.join(roomsRoot, 'shop', 'REPORTS', report), 'utf8');
      expect(body).toContain('RESULT: PASS');
      expect(body).toContain('Added the Apple Pay button behind a feature flag.');
      expect(fs.readFileSync(path.join(roomsRoot, 'shop', 'LEDGER.md'), 'utf8')).toMatch(/\| #1 \| shop-dev \| run done \| PASS \|/);
    });

    it('QA findings posted as qa-reports land in REPORTS/; decisions are mirrored into DECISIONS.md', async () => {
      const a = agent('shop-fe', path.join(wsRoot, 'shop-fe'));
      const qa = await call('POST', `/api/agents/${a.id}/docs`, FALLBACK, { filename: 'qa-checkout-buyer.md', content: '# QA\n- bug: total is wrong', subdir: 'qa-reports' });
      expect(qa.status).toBe(201);
      expect(fs.readFileSync(path.join(roomsRoot, 'shop', 'REPORTS', 'qa-checkout-buyer.md'), 'utf8')).toContain('total is wrong');
      expect(fs.readFileSync(path.join(roomsRoot, 'shop', 'LEDGER.md'), 'utf8')).toContain('QA report');

      expect((await call('POST', '/api/decisions', FALLBACK, { workspace: a.workspace, summary: 'Use Stripe for Apple Pay', detail: 'fewer PCI headaches' })).status).toBe(201);
      const decisions = fs.readFileSync(path.join(roomsRoot, 'shop', 'DECISIONS.md'), 'utf8');
      expect(decisions).toContain('Use Stripe for Apple Pay');
      expect(decisions).toContain('fewer PCI headaches');
    });
  });

  it('acceptance: the PM seat is told to read ROOM.md and quote SPEC.md', async () => {
    rooms.ensureRoom('shop');
    const line = rooms.roomsBriefLine();
    expect(line).toContain(`shop at ${path.join(roomsRoot, 'shop')}`);
    expect(line).toContain('quote SPEC.md');
    expect(line).toContain('update ROOM.md');
    const orch = await import('./orchestrator.js');
    const pm = agent('pm', null);
    await orch.briefOrchestratorSeat(pm.id, null);
    expect(typedInto('pm').at(-1)).toContain('quote SPEC.md');
    expect(fs.readFileSync(path.join(process.cwd(), 'docs', 'orchestrator-seat.md'), 'utf8')).toContain('quote SPEC.md');
  });
});
