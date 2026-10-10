import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

vi.mock('./event-bus.js', () => ({ emit: vi.fn(() => ({ id: 1 })) }));
vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })), get: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('./task-dispatcher.js', () => ({ dispatchNext: vi.fn(), unblockDependentsPublic: vi.fn(), onRunComplete: vi.fn(), finalizeRun: vi.fn() }));

const cfg = {
  projects: {} as Record<string, { workspace_match: string; release_peer?: string }>,
  peers: {} as Record<string, { url: string; token: string; agents?: string[] }>,
  releases: {} as { deploy_agent?: string | null },
  review: { auto_review: false, default_reviewer: 'x', self_review: true, max_fix_loops: 2, require_pass_to_promote: false, gate_dependents_on_approval: false, auto_pick: true, freeze_inbox: [] as string[] },
  artifacts: { storage: '', retention_days: 30 },
  paths: {},
};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => cfg) }));

const acting = { user: { id: 'owner', name: 'owner', role: 'admin', allowed_agents: null } as Record<string, unknown> };
vi.mock('./auth.js', async () => {
  const actual = await vi.importActual<typeof import('./auth.js')>('./auth.js');
  return { ...actual, getActingUser: vi.fn(() => acting.user) };
});

import { emit } from './event-bus.js';
import { notify } from './notifications.js';
import * as sessionManager from './session-manager.js';

const SHA = '2431f684b9e960b84e73a4e98b5068869664ffb4';
const SHA_B = 'e65a2ab5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** The deploy box at the fetch boundary: accepts release requests, serves their state and an event log. */
function fakeDeployBox() {
  const state = { requests: new Map<string, Record<string, unknown>>(), events: [] as Array<{ id: number; type: string; entity_id: string }>, nextEvent: 10, posts: [] as Record<string, unknown>[] };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    if (auth !== 'Bearer peer-token-0123456789') return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    if (url.pathname === '/api/releases' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      state.posts.push(body);
      const id = `R${String(state.requests.size + 1).padStart(25, '0')}`;
      state.requests.set(id, { id, ...body, status: 'sent', version: null, deployed_sha: null, report: null, error: null, deploy_agent_id: 'r-fable', reported_at: null });
      return Response.json({ id, status: 'sent' }, { status: 201 });
    }
    const one = /^\/api\/releases\/([^/]+)$/.exec(url.pathname);
    if (one) {
      const r = state.requests.get(one[1]);
      return r ? Response.json(r) : new Response(JSON.stringify({ error: 'nf' }), { status: 404 });
    }
    if (url.pathname === '/api/events/log') {
      const since = Number(url.searchParams.get('since') ?? 0);
      const events = state.events.filter((e) => e.id > since);
      return Response.json({ events, last_id: events.length ? events[events.length - 1].id : since });
    }
    return new Response(JSON.stringify({ error: `no route ${url.pathname}` }), { status: 404 });
  };
  const deployed = (id: string, version: string) => {
    const r = state.requests.get(id)!;
    Object.assign(r, { status: 'deployed', version, deployed_sha: r.sha, report: `deployed ${String(r.sha).slice(0, 8)} v${version}`, reported_at: '2026-10-10 15:00:00' });
    state.events.push({ id: state.nextEvent++, type: 'release.reported', entity_id: id });
  };
  return { state, fetchImpl, deployed };
}

describe('releases.ts', () => {
  let tmp: string;
  let db: typeof import('./db.js');
  let rel: typeof import('./releases.js');
  let peers: typeof import('./peers.js');
  let rq: typeof import('./review-queue.js');
  let rf: typeof import('./release-freezes.js');
  let app: Hono;

  const agent = (name: string) => {
    const r = db.insertAgent({ name, runtime: 'claude-code', tmux_session: `wc-${name}`, workspace: path.join(tmp, 'ws', name), mode: 'adopted', status: 'idle' });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };
  const typedInto = (agentId: string) => vi.mocked(sessionManager.sendKeys).mock.calls.filter((c) => c[0] === agentId).map((c) => String(c[1]));

  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(emit).mockClear();
    vi.mocked(notify).mockClear();
    vi.mocked(sessionManager.sendKeys).mockClear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-releases-'));
    cfg.artifacts.storage = path.join(tmp, 'store');
    for (const k of Object.keys(cfg.projects)) delete cfg.projects[k];
    for (const k of Object.keys(cfg.peers)) delete cfg.peers[k];
    cfg.releases = {};
    acting.user = { id: 'owner', name: 'owner', role: 'admin', allowed_agents: null };
    db = await import('./db.js');
    db.initDb(path.join(tmp, 't.db'));
    rel = await import('./releases.js');
    peers = await import('./peers.js');
    rq = await import('./review-queue.js');
    rf = await import('./release-freezes.js');
    (await import('./code-review.js')).ensureReviewTable();
    peers.ensurePeerTables();
    rel.ensureReleaseTables();
    rf.ensureReleaseFreezeTable();
    rel.setReleasePollIdleMsForTest(5);
    rel.resetReleaseLinesForTest();
    const routes = await import('./routes/releases.js');
    app = new Hono();
    routes.registerReleaseRoutes(app as never);
  });

  afterEach(() => {
    rel.stopReleasePollers();
    peers.setPeerFetchForTest(null);
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('requester side (dev box)', () => {
    it('Stage / Promote become release records forwarded to the release peer, and the peer outcome is mirrored back', async () => {
      cfg.projects.wavepulse = { workspace_match: '**/ws/*', release_peer: 'deploy/fable' };
      cfg.peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789', agents: ['fable'] };
      const box = fakeDeployBox();
      peers.setPeerFetchForTest(box.fetchImpl);

      const r = await rel.requestRelease({ project: 'wavepulse', sha: SHA, lane: 'wc-claude2', target: 'staging', desk: '91', reviewer: 'codex3', actorName: 'denis' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data).toMatchObject({ status: 'sent', origin: 'local', peer: 'deploy', target: 'staging', requested_by: 'denis' });
      expect(r.data.peer_request_id).toMatch(/^R/);
      expect(box.state.posts[0]).toMatchObject({ sha: SHA, target: 'staging', project: 'wavepulse', desk: '91', reviewer: 'codex3', requested_by: 'denis', origin_id: r.data.id });
      expect(vi.mocked(emit)).toHaveBeenCalledWith('release.requested', 'release', r.data.id, expect.objectContaining({ target: 'staging', sha: SHA, peer: 'deploy' }));

      // a second request for the same SHA + target while one is open is refused
      const again = await rel.requestRelease({ project: 'wavepulse', sha: SHA, target: 'staging', actorName: 'denis' });
      expect(again.ok).toBe(false);

      box.deployed(r.data.peer_request_id!, '0.442.10');
      for (let i = 0; i < 40 && rel.getRelease(r.data.id)!.status !== 'deployed'; i++) await flush(25);
      const done = rel.getRelease(r.data.id)!;
      expect(done).toMatchObject({ status: 'deployed', version: '0.442.10', deployed_sha: SHA });
      expect(vi.mocked(emit)).toHaveBeenCalledWith('release.reported', 'release', r.data.id, expect.objectContaining({ status: 'deployed', version: '0.442.10', target: 'staging' }), null);
      expect(vi.mocked(notify)).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/^Staging deployed: wavepulse 2431f684 v0\.442\.10/) }));
      expect(rel.releaseStateFor(SHA).staging?.status).toBe('deployed');
      expect(rel.releaseStateFor(SHA).production).toBeNull();
    });

    it('a peer that refuses the request leaves a failed record, visible as an event', async () => {
      cfg.projects.wavepulse = { workspace_match: '**/ws/*', release_peer: 'deploy/fable' };
      cfg.peers.deploy = { url: 'http://deploy.test', token: 'wrong-token-000000000', agents: ['fable'] };
      peers.setPeerFetchForTest(fakeDeployBox().fetchImpl);
      const r = await rel.requestRelease({ project: 'wavepulse', sha: SHA, target: 'production', actorName: 'denis' });
      expect(r.ok).toBe(false);
      expect(rel.listReleases({ sha: SHA })[0]).toMatchObject({ status: 'failed', target: 'production' });
      expect(vi.mocked(emit)).toHaveBeenCalledWith('release.reported', 'release', expect.any(String), expect.objectContaining({ status: 'failed' }));
    });

    it('Promote on a freeze card sends the production GO as a record; Stage sends a staging request; a stale freeze cannot be staged', async () => {
      cfg.projects.wavepulse = { workspace_match: '**/ws/*', release_peer: 'deploy/fable' };
      cfg.peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789', agents: ['fable'] };
      const box = fakeDeployBox();
      peers.setPeerFetchForTest(box.fetchImpl);
      agent('claude2'); agent('codex3');
      const inbox = path.join(tmp, 'inbox'); fs.mkdirSync(inbox);
      const note = path.join(inbox, `desk91-freeze-${SHA.slice(0, 8)}.md`);
      fs.writeFileSync(note, `# Desk #91 freeze note\n\nProject: wavepulse · Author: claude2\n- Lane: \`wc-claude2\`\n- Freeze SHA: \`${SHA}\`\n- Review: @codex3 **VERDICT: PASS** on this exact SHA: /r/v.md\n`);
      expect(rf.ingestFreezeFile(note).ok).toBe(true);
      const [card] = rq.listPendingReviews();

      const staged = await rq.stage(card.run.id);
      expect(staged.ok && staged.data.target).toBe('staging');
      // outside an HTTP request there is no acting user, so requested_by is null here; the route fills it in
      expect(box.state.posts[0]).toMatchObject({ target: 'staging', sha: SHA, lane: 'wc-claude2', desk: '91', reviewer: 'codex3', requested_by: null });

      const promoted = rq.promote(card.run.id);
      expect(promoted.ok).toBe(true);
      const prod = () => rel.listReleases({ sha: SHA, target: 'production' })[0];
      for (let i = 0; i < 40 && prod()?.status !== 'sent'; i++) await flush(10);
      expect(box.state.posts[1]).toMatchObject({ target: 'production', sha: SHA, requested_by: null, reviewer: 'codex3' });
      expect(prod()).toMatchObject({ status: 'sent', run_id: card.run.id });

      // on another lane: a newer freeze makes the older one stale, and a stale SHA cannot be staged
      const SHA_C = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
      const SHA_D = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';
      const other = fs.readFileSync(note, 'utf-8').replaceAll(SHA, SHA_C).replace('wc-claude2', 'wc-other');
      fs.writeFileSync(path.join(inbox, `desk92-freeze-${SHA_C.slice(0, 8)}.md`), other);
      expect(rf.ingestFreezeFile(path.join(inbox, `desk92-freeze-${SHA_C.slice(0, 8)}.md`)).ok).toBe(true);
      const cardC = rq.listPendingReviews().find((i) => i.freeze?.sha === SHA_C)!;
      fs.writeFileSync(path.join(inbox, `desk92-freeze-${SHA_D.slice(0, 8)}.md`), other.replaceAll(SHA_C, SHA_D));
      expect(rf.ingestFreezeFile(path.join(inbox, `desk92-freeze-${SHA_D.slice(0, 8)}.md`)).ok).toBe(true);
      const stale = await rq.stage(cardC.run.id);
      expect(stale.ok).toBe(false);
      expect(!stale.ok && stale.error).toMatch(/stale/);
    });
  });

  describe('deploy side (the box with the deploy agent)', () => {
    it('a request from a peer is handed to the deploy agent with the right header; its report closes the record', async () => {
      const fable = agent('fable');
      cfg.releases = { deploy_agent: 'fable' };
      acting.user = { id: 'u-peer', name: 'peer-countix-dev', role: 'developer', allowed_agents: '["fable"]' };
      const res = await app.fetch(new Request('http://x/api/releases', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha: SHA, lane: 'wc-claude2', target: 'production', project: 'wavepulse', desk: '91', reviewer: 'codex3', requested_by: 'denis', origin_id: 'L1', origin_box: 'countix-dev' }),
      }));
      expect(res.status).toBe(201);
      const r = await res.json() as import('./releases.js').ReleaseRequest;
      expect(r).toMatchObject({ status: 'sent', origin: 'peer', target: 'production', requested_by: 'denis', deploy_agent_id: fable.id, origin_id: 'L1' });
      const [prompt] = typedInto(fable.id);
      expect(prompt).toMatch(new RegExp(`^\\[Release GO ${r.id} from denis via WaveCode Promote on countix-dev \\(peer-countix-dev\\)\\. This is a human's authorization for PRODUCTION`));
      expect(prompt).toContain(`Deploy exact SHA ${SHA} (lane wc-claude2) of wavepulse for Desk #91 to production.`);
      expect(prompt).toContain('@codex3 VERDICT: PASS');
      expect(prompt).toContain(`RELEASED ${r.id}: deployed <sha> version <x.y.z> to production`);

      // the same request again (a retry) is the same record
      const dup = await app.fetch(new Request('http://x/api/releases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha: SHA, target: 'production' }) }));
      expect((await dup.json() as { id: string }).id).toBe(r.id);

      // the report: a different SHA is refused, the right one closes it
      const bad = rel.reportRelease(r.id, { status: 'deployed', sha: SHA_B, version: '1.0.0' });
      expect(bad.ok).toBe(false);
      const ok = await app.fetch(new Request(`http://x/api/releases/${r.id}/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'deployed', sha: SHA, version: '0.442.10', note: 'deployed and verified' }) }));
      expect(ok.status).toBe(200);
      expect(rel.getRelease(r.id)).toMatchObject({ status: 'deployed', version: '0.442.10', deployed_sha: SHA, report: 'deployed and verified' });
      expect(vi.mocked(emit)).toHaveBeenCalledWith('release.reported', 'release', r.id, expect.objectContaining({ status: 'deployed', origin: 'peer', origin_id: 'L1' }), null);
      // final: a second report is a no-op
      expect(rel.reportRelease(r.id, { status: 'failed', note: 'late' }).ok).toBe(true);
      expect(rel.getRelease(r.id)!.status).toBe('deployed');
    });

    it('a staging request carries the automated header, and a production request from a local non-admin is refused', async () => {
      const fable = agent('fable');
      cfg.releases = { deploy_agent: 'fable' };
      const r = rel.acceptRelease({ sha: SHA, target: 'staging', project: 'wavepulse', requested_by: 'antonio' }, { userName: 'antonio', fromPeer: false });
      expect(r.ok).toBe(true);
      expect(typedInto(fable.id)[0]).toMatch(/^\[Staging request \w+ from antonio via WaveCode\. Automated: deploy to STAGING only; no production step is authorized/);
      acting.user = { id: 'u-dev', name: 'antonio', role: 'developer', allowed_agents: null };
      const res = await app.fetch(new Request('http://x/api/releases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha: SHA_B, target: 'production' }) }));
      expect(res.status).toBe(403);
    });

    it('without a deploy agent the request fails loudly instead of vanishing', () => {
      cfg.releases = {};
      const r = rel.acceptRelease({ sha: SHA, target: 'staging' }, { userName: 'peer', fromPeer: true });
      expect(r.ok).toBe(false);
      expect(rel.listReleases({ sha: SHA })[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/deploy_agent/) });
    });

    it('RELEASED / RELEASE FAILED lines in the deploy agent pane report the outcome; another agent cannot', () => {
      const fable = agent('fable');
      const other = agent('claude1');
      cfg.releases = { deploy_agent: 'fable' };
      const a = rel.acceptRelease({ sha: SHA, target: 'staging', project: 'wavepulse' }, { userName: 'peer', fromPeer: true });
      const b = rel.acceptRelease({ sha: SHA_B, target: 'production', project: 'wavepulse' }, { userName: 'peer', fromPeer: true });
      if (!a.ok || !b.ok) throw new Error('accept failed');
      expect(rel.detectReleaseLines(other.id, `• RELEASED ${a.data.id}: deployed ${SHA.slice(0, 8)} version 0.442.10 to staging\n`)).toBe(0);
      expect(rel.getRelease(a.data.id)!.status).toBe('sent');
      const pane = [
        '• Gated the SHA; full-tuned GREEN.',
        `• RELEASED ${a.data.id}: deployed ${SHA.slice(0, 8)} version 0.442.10 to staging`,
        `  RELEASE FAILED ${b.data.id}: migration 0442 refused on prod replica`,
        '❯ ',
      ].join('\n');
      expect(rel.detectReleaseLines(fable.id, pane)).toBe(2);
      expect(rel.getRelease(a.data.id)).toMatchObject({ status: 'deployed', version: '0.442.10', deployed_sha: SHA });
      expect(rel.getRelease(b.data.id)).toMatchObject({ status: 'failed', error: 'migration 0442 refused on prod replica' });
      expect(rel.detectReleaseLines(fable.id, pane)).toBe(0); // same lines again: nothing new
    });

    it('the peer token may post requests and read outcomes, nothing else', async () => {
      const auth = await import('./auth.js');
      expect(auth.restrictedPathAllowed('POST', '/api/releases')).toBe(true);
      expect(auth.restrictedPathAllowed('GET', '/api/releases/R1')).toBe(true);
      expect(auth.restrictedPathAllowed('POST', '/api/releases/R1/report')).toBe(false);
      expect(auth.restrictedPathAllowed('POST', '/api/reviews/r1/stage')).toBe(false);
    });
  });
});
