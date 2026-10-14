import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

vi.mock('./event-bus.js', () => ({ emit: vi.fn(() => ({ id: 1 })) }));
vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })), get: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./task-dispatcher.js', () => ({ dispatchNext: vi.fn(async () => undefined), unblockDependentsPublic: vi.fn(), onRunComplete: vi.fn(), finalizeRun: vi.fn() }));

const cfg = {
  product_desk: { enabled: true, url: 'https://desk.test/api/product-desk', token_file: '', poll_min: 5, project: 'wavepulse' } as Record<string, unknown>,
  projects: { wavepulse: { workspace_match: '**/ws/*' } },
  peers: {},
  releases: {},
  review: { auto_review: false, default_reviewer: 'x', self_review: true, max_fix_loops: 2, require_pass_to_promote: false, gate_dependents_on_approval: false, auto_pick: true, freeze_inbox: [] as string[] },
  artifacts: { storage: '', retention_days: 30 },
  autonomy: { auto_dispatch: false },
  paths: {},
};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => cfg) }));

const acting = { user: { id: 'owner', name: 'owner', role: 'admin', allowed_agents: null } as Record<string, unknown> };
vi.mock('./auth.js', async () => {
  const actual = await vi.importActual<typeof import('./auth.js')>('./auth.js');
  return { ...actual, getActingUser: vi.fn(() => acting.user) };
});

import { emit } from './event-bus.js';

const SHA = '2431f684b9e960b84e73a4e98b5068869664ffb4';

const LIST = [
  { id: '108', status: 'implementing', title: 'PD-108 outgoing line VAT treatment', area: 'invoices', priority: 'high', target_version: null, source: 'email', requester_name: 'Ana', received_at: '2026-10-08 10:00:00+00', updated_at: '2026-10-10 12:00:00+00', file_count: 2, message_count: 3, last_agent: 'codex2', last_summary: 'spec r2 frozen', merged_into_id: null },
  { id: '91', status: 'in_review', title: 'Desk #91 issued credit notes', area: 'invoices', priority: null, target_version: '0.443.3', source: 'email', requester_name: 'Bor', received_at: null, updated_at: '2026-10-10 11:00:00+00', file_count: 0, message_count: 1, last_agent: null, last_summary: null, merged_into_id: null },
  { id: '12', status: 'shipped', title: 'old thing', area: null, priority: null, target_version: '0.440.0', source: 'email', requester_name: null, received_at: null, updated_at: null, file_count: 0, message_count: 0, last_agent: null, last_summary: null, merged_into_id: null },
];

function fakeDesk(opts: { fail?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if ((init?.headers as Record<string, string>)?.Authorization !== 'Bearer desk-token-abcdef0123456789') return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    if (opts.fail) return new Response('nope', { status: opts.fail });
    if (url.pathname === '/api/product-desk/requests') return Response.json({ requests: LIST });
    if (url.pathname === '/api/product-desk/requests/108') {
      return Response.json({
        request: { ...LIST[0], candidate_sha: SHA, note: 'customer wants it before month end', requester_email: 'ana@x.si', created_at: '2026-10-08 10:00:00+00' },
        messages: [
          { id: 1, direction: 'inbound', from_name: 'Ana', from_email: 'ana@x.si', received_at: '2026-10-08 10:00:00+00', subject: 'VAT on outgoing lines', body_text: 'Please make the VAT treatment per line editable.' },
          { id: 2, direction: 'outbound', from_name: 'desk', from_email: 'product@desk', received_at: '2026-10-09 10:00:00+00', subject: 'Re: VAT', body_text: 'We are on it.' },
        ],
        events: [{ id: 5, created_at: '2026-10-09 09:00:00+00', kind: 'status', from_status: 'accepted', to_status: 'implementing', body: 'claimed', version: null, release_sha: null, user_name: 'codex2' }],
        files: [{ id: 77, name: 'invoice-sample.pdf', size: 12345, mime: 'application/pdf' }, { id: 78, filename: 'lines.csv', bytes: 400, content_type: 'text/csv' }],
        notes: [],
      });
    }
    if (url.pathname === '/api/product-desk/files/77') return new Response('%PDF-1.4 fake', { headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="invoice-sample.pdf"' } });
    return new Response(JSON.stringify({ error: 'not allowed' }), { status: 403 });
  };
  return { calls, fetchImpl };
}

describe('product-desk.ts', () => {
  let tmp: string;
  let db: typeof import('./db.js');
  let pd: typeof import('./product-desk.js');
  let rf: typeof import('./release-freezes.js');
  let app: Hono;

  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(emit).mockClear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-desk-'));
    cfg.artifacts.storage = path.join(tmp, 'store');
    cfg.product_desk = { enabled: true, url: 'https://desk.test/api/product-desk', token_file: path.join(tmp, 'curl.conf'), poll_min: 5, project: 'wavepulse' };
    fs.writeFileSync(path.join(tmp, 'curl.conf'), 'header = "Authorization: Bearer desk-token-abcdef0123456789"\n', { mode: 0o600 });
    acting.user = { id: 'owner', name: 'owner', role: 'admin', allowed_agents: null };
    db = await import('./db.js');
    db.initDb(path.join(tmp, 't.db'));
    (await import('./code-review.js')).ensureReviewTable();
    (await import('./peers.js')).ensurePeerTables();
    (await import('./releases.js')).ensureReleaseTables();
    rf = await import('./release-freezes.js');
    rf.ensureReleaseFreezeTable();
    pd = await import('./product-desk.js');
    pd.resetDeskForTest();
    const routes = await import('./routes/desk.js');
    app = new Hono();
    routes.registerDeskRoutes(app as never);
  });

  afterEach(() => {
    pd.setDeskFetchForTest(null);
    pd.stopDeskRefresh();
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('reads the board with the curl-config token, shows open requests by default, links lanes and tasks, and caches', async () => {
    const fake = fakeDesk();
    pd.setDeskFetchForTest(fake.fetchImpl);
    const a = db.insertAgent({ name: 'codex2', runtime: 'codex', tmux_session: 'wc-codex2', workspace: path.join(tmp, 'ws', 'codex2'), mode: 'spawned', status: 'idle' });
    if (!a.ok) throw new Error(a.error);
    db.insertTask({ prompt: '[desk 108] PD-108 outgoing line VAT treatment\n…', agent_id: a.data.id, created_by: null });
    const inbox = path.join(tmp, 'inbox'); fs.mkdirSync(inbox);
    const v = path.join(inbox, `claude2-verdict-pd108-${SHA.slice(0, 8)}.md`);
    fs.writeFileSync(v, `# Verdict: Codex2 PD-108 (exact SHA ${SHA})\nProject: wavepulse · reviewer Claude2 · Author: codex2\n\nVERDICT: NEEDS FIXES\n`);
    db.insertAgent({ name: 'claude2', runtime: 'claude-code', tmux_session: 'wc-claude2', workspace: path.join(tmp, 'ws', 'claude2'), mode: 'spawned', status: 'idle' });
    expect((await rf.ingestFreezeFile(v)).ok).toBe(true);

    const res = await app.fetch(new Request('http://x/api/desk'));
    expect(res.status).toBe(200);
    const body = await res.json() as { enabled: boolean; items: Array<{ id: number; status: string; links: { lanes: unknown[]; tasks: Array<{ agent_name: string }> } }>; state: { cached_at: string | null } };
    expect(body.enabled).toBe(true);
    expect(body.items.map((i) => i.id)).toEqual([108, 91]); // shipped #12 hidden
    expect(body.items[0].links.tasks[0].agent_name).toBe('codex2');
    expect(body.items[0].links.lanes).toEqual([{ sha: SHA, verdict: 'needs-fixes', status: 'open', lane: null, author: 'codex2' }]);
    expect(body.state.cached_at).toBeTruthy();
    const all = await (await app.fetch(new Request('http://x/api/desk?all=1'))).json() as { items: Array<{ id: number }> };
    expect(all.items.map((i) => i.id)).toEqual([108, 91, 12]);
    expect(fake.calls.filter((c) => c.endsWith('/requests'))).toHaveLength(1); // cached
    await app.fetch(new Request('http://x/api/desk?refresh=1'));
    expect(fake.calls.filter((c) => c.endsWith('/requests'))).toHaveLength(2);
  });

  it('a 401 from the desk is reported as a token problem; the last good read stays available', async () => {
    const good = fakeDesk();
    pd.setDeskFetchForTest(good.fetchImpl);
    expect((await app.fetch(new Request('http://x/api/desk'))).status).toBe(200);
    pd.setDeskFetchForTest(fakeDesk({ fail: 401 }).fetchImpl);
    const res = await app.fetch(new Request('http://x/api/desk?refresh=1'));
    expect(res.status).toBe(200);
    const body = await res.json() as { items: unknown[]; state: { error: string | null } };
    expect(body.items).toHaveLength(2);
    expect(body.state.error).toMatch(/401: token invalid, expired or revoked/);
  });

  it('the detail carries messages, events and file metadata; the task prompt names the card, the request text and the files without copying them', async () => {
    pd.setDeskFetchForTest(fakeDesk().fetchImpl);
    const d = await pd.getDeskDetail(108);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.data.request).toMatchObject({ id: 108, candidate_sha: SHA, note: 'customer wants it before month end' });
    expect(d.data.files).toEqual([
      { id: 77, name: 'invoice-sample.pdf', size: 12345, mime: 'application/pdf' },
      { id: 78, name: 'lines.csv', size: 400, mime: 'text/csv' },
    ]);
    const prompt = pd.taskPromptFor(d.data, 'month end matters');
    expect(prompt).toMatch(/^\[desk 108\] PD-108 outgoing line VAT treatment/);
    expect(prompt).toContain('Please make the VAT treatment per line editable.');
    expect(prompt).toContain('invoice-sample.pdf (file 77)');
    expect(prompt).toContain('curl -K ~/.config/countix-desk/curl.conf');
    expect(prompt).toContain('From the person: month end matters');
    expect(prompt).not.toContain('%PDF');
  });

  it('a person hands a request to an agent: a task with the marker, room and reviewer; a second one while open is refused', async () => {
    pd.setDeskFetchForTest(fakeDesk().fetchImpl);
    const codex1 = db.insertAgent({ name: 'codex1', runtime: 'codex', tmux_session: 'wc-codex1', workspace: path.join(tmp, 'ws', 'codex1'), mode: 'spawned', status: 'idle' });
    const claude2 = db.insertAgent({ name: 'claude2', runtime: 'claude-code', tmux_session: 'wc-claude2', workspace: path.join(tmp, 'ws', 'claude2'), mode: 'spawned', status: 'idle' });
    if (!codex1.ok || !claude2.ok) throw new Error('agents');
    const res = await app.fetch(new Request('http://x/api/desk/108/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: 'codex1', reviewer: 'claude2', note: 'start today' }) }));
    expect(res.status).toBe(201);
    const made = await res.json() as { task: { id: string; prompt: string; agent_id: string; room: string | null; reviewer: string | null } };
    expect(made.task.agent_id).toBe(codex1.data.id);
    expect(made.task.room).toBe('wavepulse');
    expect(made.task.reviewer).toBe(claude2.data.id);
    expect(made.task.prompt).toMatch(/^\[desk 108\]/);
    expect(vi.mocked(emit)).toHaveBeenCalledWith('task.created', 'task', made.task.id, expect.objectContaining({ desk_id: 108, via: 'product_desk' }));
    const dup = await app.fetch(new Request('http://x/api/desk/108/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: 'claude2' }) }));
    expect(dup.status).toBe(409);
    const list = await (await app.fetch(new Request('http://x/api/desk'))).json() as { items: Array<{ id: number; links: { tasks: Array<{ status: string }> } }> };
    expect(list.items.find((i) => i.id === 108)!.links.tasks[0].status).toBe('pending');
  });

  it('an original is streamed to a person, never stored, and the view is recorded with their name; a restricted token gets nothing', async () => {
    pd.setDeskFetchForTest(fakeDesk().fetchImpl);
    const res = await app.fetch(new Request('http://x/api/desk/files/77'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('%PDF-1.4 fake');
    expect(vi.mocked(emit)).toHaveBeenCalledWith('desk.file_viewed', 'desk', '77', { by: 'owner' }, 'owner');
    expect(db.listArtifacts()).toHaveLength(0);
    expect((await app.fetch(new Request('http://x/api/desk/files/..%2Fconfig'))).status).toBe(400);
    acting.user = { id: 'u-peer', name: 'peer', role: 'developer', allowed_agents: '["fable"]' };
    expect((await app.fetch(new Request('http://x/api/desk/files/77'))).status).toBe(403);
    expect((await app.fetch(new Request('http://x/api/desk'))).status).toBe(403);
  });

  it('off unless enabled; the board gets the cached open requests with their links', async () => {
    cfg.product_desk = { enabled: false };
    const off = await (await app.fetch(new Request('http://x/api/desk'))).json() as { enabled: boolean; items: unknown[] };
    expect(off).toMatchObject({ enabled: false, items: [] });
    cfg.product_desk = { enabled: true, url: 'https://desk.test/api/product-desk', token_file: path.join(tmp, 'curl.conf'), poll_min: 5, project: 'wavepulse' };
    pd.setDeskFetchForTest(fakeDesk().fetchImpl);
    const ov = await import('./overview.js');
    expect((await ov.buildBoard()).desk).toEqual([]); // nothing cached yet: the board never waits on the network
    await pd.fetchBoard(true);
    const desk = (await ov.buildBoard()).desk!;
    expect(desk.map((d) => d.id)).toEqual([108, 91]);
    expect(desk[0]).toMatchObject({ status: 'implementing', title: 'PD-108 outgoing line VAT treatment', lanes: [], tasks: [] });
    expect((await ov.buildBoard()).desk_tracking?.map((row) => row.id)).toEqual([108, 91]);
  });

  it('the overview snapshot flags two builders on one request and tells the overlord, without writing to the desk', async () => {
    pd.setDeskFetchForTest(fakeDesk().fetchImpl);
    await pd.fetchBoard(true);
    const claude = db.insertAgent({ name: 'claude2', runtime: 'claude-code', tmux_session: 'wc-claude2', workspace: path.join(tmp, 'ws', 'claude2'), mode: 'spawned', status: 'idle' });
    const codex = db.insertAgent({ name: 'codex2', runtime: 'codex', tmux_session: 'wc-codex2', workspace: path.join(tmp, 'ws', 'codex2'), mode: 'spawned', status: 'idle' });
    if (!claude.ok || !codex.ok) throw new Error('agents');
    db.insertTask({ prompt: '[desk 108] first pass', agent_id: claude.data.id, created_by: null });
    db.insertTask({ prompt: 'Desk #108 second pass', agent_id: codex.data.id, created_by: null });
    const ov = await import('./overview.js');
    const board = await ov.buildBoard();
    const row = board.desk_tracking?.find((item) => item.id === 108);
    expect(row?.flags).toContain('two_builders');
    expect(board.attention.some((item) => item.kind === 'desk_two_builders' && item.text.includes('Desk #108'))).toBe(true);
    const overlord = await import('./overlord.js');
    const prompt = JSON.parse(overlord.buildPrompt(board, 'heartbeat', null)) as { desk_tracking: Array<{ id: number; flags: string[] }> };
    expect(prompt.desk_tracking.find((item) => item.id === 108)?.flags).toContain('two_builders');
    expect(pd.deskState().error).toBeNull();
  });
});
