import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';

vi.mock('./event-bus.js', () => ({ emit: vi.fn(() => ({ id: 1 })) }));
vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })), get: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('./notifications.js', () => ({ notify: vi.fn(async () => undefined) }));
vi.mock('./task-dispatcher.js', () => ({ dispatchNext: vi.fn(), unblockDependentsPublic: vi.fn(), onRunComplete: vi.fn(), finalizeRun: vi.fn() }));

const cfg = {
  projects: {} as Record<string, { workspace_match: string; release_peer?: string; repo?: string; candidate_refs?: string }>,
  peers: {} as Record<string, { url: string; token: string; agents?: string[] }>,
  releases: {} as { deploy_agent?: string | null; production_approvers?: string[]; staging_command?: string[]; staging_watch_command?: string[] },
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
const FIXTURE_SHA = 'abc123abc123abc123abc123abc123abc123abcd';
const SHA_B = 'e65a2ab5aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const flush = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/** The deploy box at the fetch boundary: accepts release requests, serves their state and an event log. */
function fakeDeployBox() {
  const state = {
    requests: new Map<string, Record<string, unknown>>(),
    events: [] as Array<{ id: number; type: string; entity_id: string }>,
    nextEvent: 10,
    posts: [] as Record<string, unknown>[],
    stagingTip: null as { sha: string; version: string | null; lane: string | null } | null,
  };
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
    if (url.pathname === '/api/releases/staging-tip') return Response.json(state.stagingTip);
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
    peers.stopPeerPollers();
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
      expect(box.state.posts[0]).not.toHaveProperty('requester_role');
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

    it('mirrors staging progress from the peer while the request is still open', async () => {
      cfg.projects.wavepulse = { workspace_match: '**/ws/*', release_peer: 'deploy/fable' };
      cfg.peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789', agents: ['fable'] };
      const box = fakeDeployBox();
      peers.setPeerFetchForTest(box.fetchImpl);
      const r = await rel.requestRelease({ project: 'wavepulse', sha: SHA, target: 'staging', actorName: 'denis' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const remote = box.state.requests.get(r.data.peer_request_id!)!;
      Object.assign(remote, {
        progress_phase: 'build', progress_status: 'heartbeat', deploy_id: '20261012T120000Z-abc123abc',
        pin_until: '2026-10-12T18:00:00Z', staging_url: 'https://staging.example/app',
      });
      box.state.events.push({ id: box.state.nextEvent++, type: 'release.progress', entity_id: r.data.peer_request_id! });
      for (let i = 0; i < 40 && rel.getRelease(r.data.id)?.progress_phase !== 'build'; i++) await flush(25);
      expect(rel.getRelease(r.data.id)).toMatchObject({
        status: 'sent', progress_phase: 'build', progress_status: 'heartbeat',
        deploy_id: '20261012T120000Z-abc123abc', pin_until: '2026-10-12T18:00:00Z', staging_url: 'https://staging.example/app',
      });
      expect(vi.mocked(emit)).toHaveBeenCalledWith('release.progress', 'release', r.data.id, expect.objectContaining({ phase: 'build', url: 'https://staging.example/app' }), null);
      box.deployed(r.data.peer_request_id!, '1.2.3');
      for (let i = 0; i < 40 && rel.getRelease(r.data.id)!.status !== 'deployed'; i++) await flush(25);
      expect(rel.getRelease(r.data.id)).toMatchObject({ status: 'deployed', version: '1.2.3', progress_phase: 'build', staging_url: 'https://staging.example/app' });
    });

    it('a person marks a deployed staging as verified; the audit trail lists stage, deployer outcome and verification with names', async () => {
      cfg.projects.wavepulse = { workspace_match: '**/ws/*', release_peer: 'deploy/fable' };
      cfg.peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789', agents: ['fable'] };
      const box = fakeDeployBox();
      peers.setPeerFetchForTest(box.fetchImpl);
      const r = await rel.requestRelease({ project: 'wavepulse', sha: SHA, lane: 'wc-claude2', target: 'staging', desk: '91', actorName: 'denis' });
      if (!r.ok) throw new Error(r.error);
      // not deployed yet: cannot verify
      const early = await app.fetch(new Request(`http://x/api/releases/${r.data.id}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
      expect(early.status).toBe(400);
      box.deployed(r.data.peer_request_id!, '0.442.10');
      for (let i = 0; i < 40 && rel.getRelease(r.data.id)!.status !== 'deployed'; i++) await flush(25);
      acting.user = { id: 'u-antonio', name: 'antonio', role: 'developer', allowed_agents: null };
      const ok = await app.fetch(new Request(`http://x/api/releases/${r.data.id}/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note: 'credit note PDF and e-SLOG checked' }) }));
      expect(ok.status).toBe(200);
      expect(rel.getRelease(r.data.id)).toMatchObject({ verified_by: 'antonio', verification_note: 'credit note PDF and e-SLOG checked' });
      expect(vi.mocked(emit)).toHaveBeenCalledWith('release.verified', 'release', SHA, expect.objectContaining({
        sha: SHA, verified_by: 'antonio', version: '0.442.10', lane: 'wc-claude2', desk: '91', wording: 'Ready for prod',
      }));
      expect(vi.mocked(notify)).toHaveBeenCalledWith(expect.objectContaining({
        title: expect.stringMatching(/Ready for prod: wavepulse 2431f684 v0\.442\.10/),
        body: expect.stringMatching(/lane wc-claude2 · Desk #91 · SHA 2431f684b9e960b84e73a4e98b5068869664ffb4 · v0\.442\.10 · by antonio/),
      }));
      const trail = rel.auditTrail();
      expect(trail.map((e) => [e.action, e.who]).sort()).toEqual([['deployed', expect.stringMatching(/^deployer/)], ['stage', 'denis'], ['verify', 'antonio']]);
      expect(trail.find((e) => e.action === 'verify')?.detail).toMatch(/Ready for prod/);
      const viaRoute = await (await app.fetch(new Request('http://x/api/releases/audit'))).json() as Array<{ action: string }>;
      expect(viaRoute).toHaveLength(3);
    });

    it('a candidate branch is the unit of production: its tip gets the GO with the contained lanes in the note, and verification is keyed by SHA', async () => {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      const repo = path.join(tmp, 'repo');
      fs.mkdirSync(repo);
      const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8', env }).trim();
      git('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); git('add', '.'); git('commit', '-q', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      git('checkout', '-q', '-b', 'lane'); fs.writeFileSync(path.join(repo, 'b.txt'), 'b'); git('add', '.'); git('commit', '-q', '-m', 'desk 91');
      const laneSha = git('rev-parse', 'HEAD');
      git('checkout', '-q', '-b', 'rc'); fs.writeFileSync(path.join(repo, 'c.txt'), 'c'); git('add', '.'); git('commit', '-q', '-m', 'compose');
      const tip = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      git('update-ref', 'refs/remotes/origin/main', base);
      git('update-ref', 'refs/remotes/origin/fable/rc-0443-2', tip);
      (cfg.projects as Record<string, Record<string, unknown>>).wavepulse = { workspace_match: '**/ws/*', release_peer: 'deploy/fable', repo, candidate_refs: 'fable/rc-*' };
      cfg.peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789', agents: ['fable'] };
      const box = fakeDeployBox();
      peers.setPeerFetchForTest(box.fetchImpl);
      const rfz = await import('./release-freezes.js');
      rfz.resetMergedCacheForTest();
      rfz.setFetchDisabledForTest(true);
      // a reviewed lane that sits in the candidate
      agent('claude2'); agent('codex3');
      const inbox = path.join(tmp, 'inbox'); fs.mkdirSync(inbox);
      fs.writeFileSync(path.join(inbox, `desk91-freeze-${laneSha.slice(0, 8)}.md`), `# Desk #91 freeze note\n\nProject: wavepulse · Author: claude2\n- Lane: \`lane\`\n- Freeze SHA: \`${laneSha}\`\n- Review: @codex3 **VERDICT: PASS** on this exact SHA: /r/v.md\n`);
      expect(rf.ingestFreezeFile(path.join(inbox, `desk91-freeze-${laneSha.slice(0, 8)}.md`)).ok).toBe(true);

      const ov = await import('./overview.js');
      const board = ov.buildBoard();
      expect(board.candidates).toHaveLength(1);
      expect(board.candidates[0]).toMatchObject({ name: 'fable/rc-0443-2', tip, verified: null, lanes: [{ sha: laneSha, desk: 91 }] });
      expect(board.lanes[0]).toMatchObject({ candidate: 'fable/rc-0443-2', promotable: false });

      // verification keyed by the candidate tip
      const v = await app.fetch(new Request('http://x/api/releases/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha: tip, project: 'wavepulse', note: 'smoke ok' }) }));
      expect(v.status).toBe(200);
      expect(ov.buildBoard().candidates[0].verified).toMatchObject({ by: 'owner', note: 'smoke ok' });

      // the GO for the candidate: production request for the tip, lanes named in the note
      const go = await app.fetch(new Request('http://x/api/releases/candidates/fable%2Frc-0443-2/promote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'wavepulse' }) }));
      expect(go.status).toBe(202);
      expect(box.state.posts[0]).toMatchObject({ target: 'production', sha: tip, lane: 'fable/rc-0443-2', requested_by: 'owner', requester_role: 'admin', note: `contains: Desk #91 ${laneSha.slice(0, 8)}` });
      expect(rel.auditTrail().map((e) => e.action).sort()).toEqual(['promote', 'verify']);
      expect((await app.fetch(new Request('http://x/api/releases/candidates/nope/stage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'wavepulse' }) }))).status).toBe(404);
      rfz.setFetchDisabledForTest(false);
      rel.stopReleasePollers();
    });

    it('refuses staging and production when the SHA does not contain main, including a candidate and an overlord auto-stage', async () => {
      const repo = path.join(tmp, 'repo');
      fs.mkdirSync(repo);
      const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8', env }).trim();
      git('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
      git('add', '.');
      git('commit', '-q', '-m', 'base');
      git('checkout', '-q', '-b', 'rc');
      fs.writeFileSync(path.join(repo, 'c.txt'), 'c');
      git('add', '.');
      git('commit', '-q', '-m', 'candidate');
      const behind = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
      git('add', '.');
      git('commit', '-q', '-m', 'main moved');
      const mainSha = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/remotes/origin/main', mainSha);
      git('update-ref', 'refs/remotes/origin/fable/rc-0443-2', behind);
      cfg.projects.wavepulse = { workspace_match: '**/ws/*', release_peer: 'deploy/fable', repo, candidate_refs: 'fable/rc-*' };
      cfg.peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789', agents: ['fable'] };
      const box = fakeDeployBox();
      peers.setPeerFetchForTest(box.fetchImpl);
      const rfz = await import('./release-freezes.js');
      rfz.setFetchDisabledForTest(true);

      const staging = await rel.requestRelease({ project: 'wavepulse', sha: behind, lane: 'wc-ales', target: 'staging', actorName: 'denis' });
      expect(staging.ok).toBe(false);
      if (staging.ok) return;
      expect(staging.error).toBe('behind main: merge main');
      const production = await rel.requestRelease({ project: 'wavepulse', sha: behind, target: 'production', actorName: 'denis', actorIsAdmin: true });
      expect(production.ok).toBe(false);
      if (!production.ok) expect(production.error).toBe(staging.error);
      expect(rel.listReleases({ sha: behind })).toEqual([]);

      const current = await rel.requestRelease({ project: 'wavepulse', sha: mainSha, lane: 'wc-ales', target: 'staging', actorName: 'denis' });
      expect(current.ok).toBe(true);

      const stage = await app.fetch(new Request('http://x/api/releases/candidates/fable%2Frc-0443-2/stage', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'wavepulse' }),
      }));
      expect(stage.status).toBe(400);
      expect(await stage.json()).toMatchObject({ error: staging.error });
      const promote = await app.fetch(new Request('http://x/api/releases/candidates/fable%2Frc-0443-2/promote', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'wavepulse' }),
      }));
      expect(promote.status).toBe(400);
      expect(box.state.posts.every((p) => p.sha !== behind)).toBe(true);

      const ol = await import('./overlord.js');
      const staged = await ol.autoStage({
        lanes: [{ status: 'open', verdict: 'pass', candidate: null, staging: null, project: 'wavepulse', sha: behind, lane: 'wc-ales', desk: null, reviewer: 'codex3', gate: null, run_id: null }],
      } as never);
      expect(staged).toBe(0);
      expect(rel.listReleases({ sha: behind })).toEqual([]);
      rfz.setFetchDisabledForTest(false);
      rel.stopReleasePollers();
    });

    it('a peer that refuses the request leaves a failed record, visible as an event', async () => {
      cfg.projects.wavepulse = { workspace_match: '**/ws/*', release_peer: 'deploy/fable' };
      cfg.peers.deploy = { url: 'http://deploy.test', token: 'wrong-token-000000000', agents: ['fable'] };
      peers.setPeerFetchForTest(fakeDeployBox().fetchImpl);
      const r = await rel.requestRelease({ project: 'wavepulse', sha: SHA, target: 'production', actorName: 'denis', actorIsAdmin: true });
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

      const { runWithActor } = await import('./request-context.js');
      const promoted = await runWithActor('owner', async () => rq.promote(card.run.id), { admin: true });
      expect(promoted.ok).toBe(true);
      const prod = () => rel.listReleases({ sha: SHA, target: 'production' })[0];
      for (let i = 0; i < 40 && prod()?.status !== 'sent'; i++) await flush(10);
      expect(box.state.posts[1]).toMatchObject({ target: 'production', sha: SHA, requested_by: 'owner', requester_role: 'admin', requester_is_admin: true, reviewer: 'codex3' });
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

      // An admin override covers a missing PASS only. It does not cover staleness.
      const asAdmin = await runWithActor('owner', async () => rq.stage(cardC.run.id), { admin: true });
      expect(asAdmin.ok).toBe(false);
      if (!asAdmin.ok) expect(asAdmin.error).toMatch(/stale/);
      expect(box.state.posts.filter((p) => p.sha === SHA_C)).toEqual([]);
    });

    it('refuses Stage when the lane tip moved past the freeze, even for an admin', async () => {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      const repo = path.join(tmp, 'moved');
      fs.mkdirSync(repo);
      const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8', env }).trim();
      git('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); git('add', '.'); git('commit', '-q', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      git('update-ref', 'refs/remotes/origin/main', base);
      git('checkout', '-q', '-b', 'lane');
      fs.writeFileSync(path.join(repo, 'b.txt'), 'b'); git('add', '.'); git('commit', '-q', '-m', 'frozen');
      const frozen = git('rev-parse', 'HEAD');
      fs.writeFileSync(path.join(repo, 'c.txt'), 'c'); git('add', '.'); git('commit', '-q', '-m', 'moved on');
      cfg.projects.wavepulse = { workspace_match: '**/ws/*', release_peer: 'deploy/fable', repo };
      cfg.peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789', agents: ['fable'] };
      peers.setPeerFetchForTest(fakeDeployBox().fetchImpl);
      const rfz = await import('./release-freezes.js');
      rfz.setFetchDisabledForTest(true);
      const author = db.insertAgent({ name: 'claude2', runtime: 'claude-code', tmux_session: 'wc-claude2', workspace: repo, mode: 'adopted', status: 'idle' });
      if (!author.ok) throw new Error(author.error);
      db.insertAgent({ name: 'codex3', runtime: 'claude-code', tmux_session: 'wc-codex3', workspace: repo, mode: 'adopted', status: 'idle' });
      const note = path.join(tmp, `lane-freeze-${frozen.slice(0, 8)}.md`);
      fs.writeFileSync(note, `# Desk #7 freeze note\n\nProject: wavepulse · Author: claude2\n- Lane: \`lane\`\n- Freeze SHA: \`${frozen}\`\n- Review: @codex3 **VERDICT: PASS (gate pending)** on this exact SHA: /r/v.md\n`);
      expect(rf.ingestFreezeFile(note).ok).toBe(true);
      const card = rq.listPendingReviews().find((i) => i.freeze?.sha === frozen);
      expect(card?.freeze?.verdict).toBe('pass');
      const { runWithActor } = await import('./request-context.js');
      const refused = await runWithActor('owner', async () => rq.stage(card!.run.id), { admin: true });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toMatch(/stale/);
      expect(rf.getFreeze(frozen)?.status).toBe('stale');
      rfz.setFetchDisabledForTest(false);
    });

    it('stages on a green quick check and refuses Promote until the full gate is green', async () => {
      cfg.projects.wavepulse = { workspace_match: '**/ws/*', release_peer: 'deploy/fable' };
      (cfg.projects.wavepulse as { tests?: { status_command: string[] } }).tests = { status_command: ['test-status', '{sha}'] };
      cfg.peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789', agents: ['fable'] };
      const box = fakeDeployBox();
      peers.setPeerFetchForTest(box.fetchImpl);
      agent('claude2'); agent('codex3');
      const runs = await import('./test-runs.js');
      const inbox = path.join(tmp, 'inbox'); fs.mkdirSync(inbox);
      const note = path.join(inbox, `desk91-freeze-${SHA.slice(0, 8)}.md`);
      fs.writeFileSync(note, `# Desk #91 freeze note\n\nProject: wavepulse · Author: claude2\n- Lane: \`wc-claude2\`\n- Freeze SHA: \`${SHA}\`\n- Review: @codex3 **VERDICT: PASS** on this exact SHA: /r/v.md\n`);
      expect(rf.ingestFreezeFile(note).ok).toBe(true);
      const [card] = rq.listPendingReviews();
      const report = (rows: unknown[]) => JSON.stringify({ v: 1, runs: rows });
      runs.setTestRunExecForTest(() => report([{ id: 'q', sha: SHA, who: 'wave.runner.example.wc-claude2', kind: 'dev', suite: 'tier1', state: 'running', host: 'runner.example' }]));
      const running = await rq.stage(card.run.id);
      expect(running.ok).toBe(false);
      if (!running.ok) expect(running.error).toBe('quick check running');

      runs.setTestRunExecForTest(() => report([{ id: 'q', sha: SHA, who: 'wave.runner.example.wc-claude2', kind: 'dev', suite: 'quick', state: 'pass', ended_at: '2026-10-12T12:00:00.000+02:00' }]));
      const staged = await rq.stage(card.run.id);
      expect(staged.ok).toBe(true);
      const { runWithActor } = await import('./request-context.js');
      const blocked = await runWithActor('owner', async () => rq.promote(card.run.id), { admin: true });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error).toMatch(/needs green full gate on/);

      runs.setTestRunExecForTest(() => report([
        { id: 'q', sha: SHA, who: 'wave.runner.example.wc-claude2', kind: 'dev', suite: 'quick', state: 'pass', ended_at: '2026-10-12T12:00:00.000+02:00' },
        { id: 'g', sha: SHA, who: 'unknown', kind: 'gate', suite: 'full-tuned', state: 'pass', ended_at: '2026-10-12T13:00:00.000+02:00' },
      ]));
      const promoted = await runWithActor('owner', async () => rq.promote(card.run.id), { admin: true });
      expect(promoted.ok).toBe(true);
      runs.setTestRunExecForTest(null);
    });

    it('a developer can stage and approve a freeze, and that does not send a production request or a Release GO', async () => {
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
      const { createUser } = await import('./users.js');
      const { runWithActor } = await import('./request-context.js');
      const dev = createUser({ name: 'antonio', role: 'developer' });
      if (!dev.ok) throw new Error(dev.error);

      const staged = await runWithActor(dev.data.user.id, async () => rq.stage(card.run.id));
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;
      expect(staged.data.target).toBe('staging');
      expect(box.state.posts).toHaveLength(1);
      expect(box.state.posts[0]).toMatchObject({ target: 'staging', requested_by: 'antonio' });

      const promoted = await runWithActor(dev.data.user.id, async () => rq.promote(card.run.id));
      expect(promoted.ok).toBe(true);
      if (promoted.ok) expect(promoted.data.review_status).toBe('approved');
      await flush(40);
      expect(rel.listReleases({ sha: SHA, target: 'production' })).toEqual([]);
      expect(box.state.posts.filter((p) => p.target === 'production')).toEqual([]);
      expect(db.getDb().prepare(`SELECT COUNT(*) AS n FROM peer_questions`).get()).toEqual({ n: 0 });
    });

    it('a developer cannot stage a freeze or candidate without the reviewer PASS; an admin can, and a deployed candidate is exempt', async () => {
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      const repo = path.join(tmp, 'repo');
      fs.mkdirSync(repo);
      const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
      const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8', env }).trim();
      git('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'a'); git('add', '.'); git('commit', '-q', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      git('checkout', '-q', '-b', 'lane'); fs.writeFileSync(path.join(repo, 'b.txt'), 'b'); git('add', '.'); git('commit', '-q', '-m', 'desk 91');
      const laneSha = git('rev-parse', 'HEAD');
      git('checkout', '-q', '-b', 'rc'); fs.writeFileSync(path.join(repo, 'c.txt'), 'c'); git('add', '.'); git('commit', '-q', '-m', 'compose');
      const tip = git('rev-parse', 'HEAD');
      git('checkout', '-q', 'main');
      git('update-ref', 'refs/remotes/origin/main', base);
      git('update-ref', 'refs/remotes/origin/fable/rc-0443-2', tip);
      (cfg.projects as Record<string, Record<string, unknown>>).wavepulse = { workspace_match: '**/ws/*', release_peer: 'deploy/fable', repo, candidate_refs: 'fable/rc-*' };
      cfg.peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789', agents: ['fable'] };
      const box = fakeDeployBox();
      peers.setPeerFetchForTest(box.fetchImpl);
      const rfz = await import('./release-freezes.js');
      rfz.resetMergedCacheForTest();
      rfz.setFetchDisabledForTest(true);
      agent('claude2'); agent('codex3');
      const inbox = path.join(tmp, 'inbox'); fs.mkdirSync(inbox);
      const note = path.join(inbox, `desk91-freeze-${laneSha.slice(0, 8)}.md`);
      fs.writeFileSync(note, `# Desk #91 freeze note\n\nProject: wavepulse · Author: claude2\n- Lane: \`lane\`\n- Freeze SHA: \`${laneSha}\`\n- Review: @codex3 **VERDICT: NEEDS FIXES** on this exact SHA: /r/v.md\n\nR1 — P1 balance\nR2 (P2) rounding\n`);
      expect(rf.ingestFreezeFile(note).ok).toBe(true);
      const [card] = rq.listPendingReviews();
      expect(card.latestReview).toMatchObject({ verdict: 'needs-fixes', issues_found: 2 });
      const { createUser } = await import('./users.js');
      const { runWithActor } = await import('./request-context.js');
      const dev = createUser({ name: 'antonio', role: 'developer' });
      if (!dev.ok) throw new Error(dev.error);

      const refused = await runWithActor(dev.data.user.id, async () => rq.stage(card.run.id));
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toMatch(/reviewer's PASS on this exact SHA/);
      expect(box.state.posts).toEqual([]);

      acting.user = { id: dev.data.user.id, name: 'antonio', role: 'developer', allowed_agents: null };
      const candRefused = await app.fetch(new Request('http://x/api/releases/candidates/fable%2Frc-0443-2/stage', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'wavepulse' }),
      }));
      expect(candRefused.status).toBe(403);
      expect(((await candRefused.json()) as { error: string }).error).toMatch(/reviewer's PASS on this exact SHA/);

      acting.user = { id: 'owner', name: 'owner', role: 'admin', allowed_agents: null };
      const candAdmin = await app.fetch(new Request('http://x/api/releases/candidates/fable%2Frc-0443-2/stage', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'wavepulse' }),
      }));
      expect(candAdmin.status).toBe(202);
      const staged = rel.listReleases({ sha: tip, target: 'staging' })[0];
      expect(rel.reportRelease(staged.id, { status: 'deployed', sha: tip, version: '0.1.0' }).ok).toBe(true);
      box.state.stagingTip = { sha: tip, version: '0.1.0', lane: 'fable/rc-0443-2' };
      rel.resetStagingTipCacheForTest();

      const allowed = await runWithActor(dev.data.user.id, async () => rq.stage(card.run.id));
      expect(allowed.ok).toBe(false);
      if (!allowed.ok) {
        expect(allowed.error).toMatch(/would roll staging back:/);
        expect(allowed.error).not.toMatch(/PASS/);
      }
      rfz.setFetchDisabledForTest(false);
      rel.stopReleasePollers();
    });

    it('a developer Promote of a plain run does not relay a Release GO; production requestRelease without an admin does not post', async () => {
      cfg.projects.wavepulse = { workspace_match: '**/ws/*', release_peer: 'deploy/fable' };
      cfg.peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789', agents: ['fable'] };
      const urls: string[] = [];
      peers.setPeerFetchForTest(async (input, init) => {
        const url = new URL(String(input));
        urls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
        if (url.pathname === '/api/releases' && init?.method === 'POST') return Response.json({ id: 'R000000000000000000000099', status: 'sent' }, { status: 201 });
        if (url.pathname === '/api/agents') return Response.json([{ id: 'r-fable', name: 'fable', alias: 'fable', runtime: 'claude-code', status: 'idle' }]);
        if (/^\/api\/agents\/[^/]+\/send$/.test(url.pathname)) return Response.json({ ok: true, prompt_event_id: 1 });
        return Response.json({ events: [], last_id: 0 });
      });
      const author = agent('claude2');
      const task = db.insertTask({ prompt: 'ship the lane', agent_id: author.id });
      if (!task.ok) throw new Error(task.error);
      const run = db.insertRun({ task_id: task.data.id, agent_id: author.id });
      if (!run.ok) throw new Error(run.error);
      db.finishRun(run.data.id, 0);
      const { createUser } = await import('./users.js');
      const { runWithActor } = await import('./request-context.js');
      const dev = createUser({ name: 'antonio', role: 'developer' });
      if (!dev.ok) throw new Error(dev.error);
      const promoted = await runWithActor(dev.data.user.id, async () => rq.promote(run.data.id));
      expect(promoted.ok).toBe(true);
      await flush(30);
      expect(urls).toEqual([]);
      expect(rel.listReleases({ target: 'production' })).toEqual([]);

      // The same kind of run, promoted by an admin, does reach the deploy peer.
      const task2 = db.insertTask({ prompt: 'ship the other lane', agent_id: author.id });
      if (!task2.ok) throw new Error(task2.error);
      const run2 = db.insertRun({ task_id: task2.data.id, agent_id: author.id });
      if (!run2.ok) throw new Error(run2.error);
      db.finishRun(run2.data.id, 0);
      const asAdmin = await runWithActor('owner', async () => rq.promote(run2.data.id), { admin: true });
      expect(asAdmin.ok).toBe(true);
      await flush(40);
      expect(urls.some((u) => u.includes('/api/agents'))).toBe(true);

      const before = urls.filter((u) => u.startsWith('POST') && u.includes('/api/releases')).length;
      const refused = await rel.requestRelease({ project: 'wavepulse', sha: SHA, target: 'production', actorName: 'antonio' });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error).toMatch(/only an admin/);
      expect(urls.filter((u) => u.startsWith('POST') && u.includes('/api/releases'))).toHaveLength(before);
      const sent = await rel.requestRelease({ project: 'wavepulse', sha: SHA, target: 'production', actorName: 'denis', actorRole: 'admin', actorIsAdmin: true });
      expect(sent.ok).toBe(true);
      expect(urls.filter((u) => u.startsWith('POST') && u.includes('/api/releases')).length).toBe(before + 1);
    });

    it('candidate promote is 403 for a developer and stage is not; Ready for prod stays open to a developer', async () => {
      acting.user = { id: 'u-dev', name: 'antonio', role: 'developer', allowed_agents: null };
      const promote = await app.fetch(new Request('http://x/api/releases/candidates/fable%2Frc/promote', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'wavepulse' }),
      }));
      expect(promote.status).toBe(403);
      expect(((await promote.json()) as { error: string }).error).toMatch(/only an admin can send a production release \(you are antonio, developer\)/);
      const stage = await app.fetch(new Request('http://x/api/releases/candidates/fable%2Frc/stage', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'wavepulse' }),
      }));
      expect(stage.status).not.toBe(403);
      const ready = await app.fetch(new Request('http://x/api/releases/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha: SHA, project: 'wavepulse', note: 'checked on staging' }),
      }));
      expect(ready.status).toBe(200);
      expect(rel.auditTrail().find((e) => e.action === 'verify')).toMatchObject({ who: 'antonio', detail: expect.stringMatching(/Ready for prod/) });
    });
  });

  describe('deploy side (the box with the deploy agent)', () => {
    it('a request from a peer is handed to the deploy agent with the right header; its report closes the record', async () => {
      const fable = agent('fable');
      cfg.releases = { deploy_agent: 'fable', production_approvers: ['denis'] };
      acting.user = { id: 'u-peer', name: 'peer-countix-dev', role: 'developer', allowed_agents: '["fable"]' };
      const res = await app.fetch(new Request('http://x/api/releases', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha: SHA, lane: 'wc-claude2', target: 'production', project: 'wavepulse', desk: '91', reviewer: 'codex3', requested_by: 'denis', requester_role: 'admin', requester_is_admin: true, origin_id: 'L1', origin_box: 'countix-dev' }),
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
      const dup = await app.fetch(new Request('http://x/api/releases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha: SHA, target: 'production', requested_by: 'denis', requester_role: 'admin' }) }));
      expect((await dup.json() as { id: string }).id).toBe(r.id);
      // a retry that drops the originating user must not reuse the open production GO
      const stripped = await app.fetch(new Request('http://x/api/releases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha: SHA, target: 'production' }) }));
      expect(stripped.status).toBe(403);
      expect(typedInto(fable.id)).toHaveLength(1);

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
      const res = await app.fetch(new Request('http://x/api/releases', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha: SHA_B, target: 'production', requester_is_admin: true }) }));
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/only an admin can send a production release \(you are antonio, developer\)/);
      expect(typedInto(fable.id)).toHaveLength(1); // the staging prompt only
    });

    it('a peer production request is refused unless the originating user is on production_approvers; staging is not', async () => {
      const fable = agent('fable');
      cfg.releases = { deploy_agent: 'fable' };
      acting.user = { id: 'u-peer', name: 'peer-countix-dev', role: 'developer', allowed_agents: '["fable"]' };
      const post = (body: Record<string, unknown>) => app.fetch(new Request('http://x/api/releases', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      }));
      const named = { sha: SHA, target: 'production', project: 'wavepulse', requested_by: 'denis', requester_role: 'admin', origin_box: 'countix-dev' };

      // empty allow-list (the default) refuses a complete originating user, including a direct accept
      const empty = await post(named);
      expect(empty.status).toBe(403);
      expect(((await empty.json()) as { error: string }).error).toMatch(/not in releases\.production_approvers/);
      const direct = rel.acceptRelease(named, { userName: 'peer-countix-dev', fromPeer: true });
      expect(direct.ok).toBe(false);
      expect(typedInto(fable.id)).toEqual([]);
      expect(rel.listReleases({ sha: SHA, target: 'production' })).toEqual([]);

      cfg.releases = { deploy_agent: 'fable', production_approvers: ['denis'] };
      const noName = await post({ sha: SHA, target: 'production', requester_role: 'admin' });
      expect(noName.status).toBe(403);
      expect(((await noName.json()) as { error: string }).error).toMatch(/originating user \(name and role\)/);
      const noRole = await post({ sha: SHA, target: 'production', requested_by: 'denis' });
      expect(noRole.status).toBe(403);
      expect(((await noRole.json()) as { error: string }).error).toMatch(/originating user \(name and role\)/);
      const other = await post({ ...named, requested_by: 'antonio', requester_role: 'developer' });
      expect(other.status).toBe(403);
      expect(((await other.json()) as { error: string }).error).toMatch(/not in releases\.production_approvers/);

      const allowed = await post(named);
      expect(allowed.status).toBe(201);
      expect(typedInto(fable.id)).toHaveLength(1);
      expect(typedInto(fable.id)[0]).toMatch(/Release GO/);

      cfg.releases = { deploy_agent: 'fable' };
      const staging = await post({ sha: SHA_B, target: 'staging', project: 'wavepulse', requested_by: 'antonio' });
      expect(staging.status).toBe(201);
      expect(typedInto(fable.id)[1]).toMatch(/Automated: deploy to STAGING only/);
    });

    it('without a deploy agent the request fails loudly instead of vanishing', () => {
      cfg.releases = {};
      const r = rel.acceptRelease({ sha: SHA, target: 'staging', project: 'wavepulse' }, { userName: 'peer', fromPeer: true });
      expect(r.ok).toBe(false);
      expect(rel.listReleases({ sha: SHA })[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/deploy_agent/) });
    });

    it('RELEASED / RELEASE FAILED lines in the deploy agent pane report the outcome; another agent cannot', () => {
      const fable = agent('fable');
      const other = agent('claude1');
      cfg.releases = { deploy_agent: 'fable', production_approvers: ['denis'] };
      const a = rel.acceptRelease({ sha: SHA, target: 'staging', project: 'wavepulse' }, { userName: 'peer', fromPeer: true });
      const b = rel.acceptRelease({ sha: SHA_B, target: 'production', project: 'wavepulse', requested_by: 'denis', requester_role: 'admin' }, { userName: 'peer', fromPeer: true });
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

    it('a staging command streams progress and closes the release; production still prompts the agent', async () => {
      const fable = agent('fable');
      agent('claude2');
      const marker = path.join(tmp, 'ran');
      const replay = path.join(tmp, 'replay.cjs');
      fs.writeFileSync(replay, "const fs=require('fs'); fs.writeSync(1, 'not-json\\n'+fs.readFileSync(process.argv[2],'utf8')); process.exit(Number(process.argv[3]||0));\n");
      const success = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'staging-progress', 'success.ndjson');
      const failed = success.replace('success.ndjson', 'failed.ndjson');
      const note = path.join(tmp, 'freeze-pass.md');
      fs.writeFileSync(note, `# Desk #7 freeze note\n\nProject: wavepulse · Author: claude2\n- Lane: \`lane-a\`\n- Freeze SHA: \`${FIXTURE_SHA}\`\n- Review: @codex3 **VERDICT: PASS** on this exact SHA: /r/v.md\n- gate: GREEN\n`);
      expect(rf.ingestFreezeFile(note).ok).toBe(true);
      cfg.releases = { deploy_agent: 'fable', production_approvers: ['denis'], staging_command: ['node', replay, success, '0', '{sha}', '--lane', '{lane}', '--desk', '{desk}'] };
      const staged = rel.acceptRelease({ sha: FIXTURE_SHA, target: 'staging', lane: 'lane-a', desk: '7', project: 'wavepulse' }, { userName: 'antonio', fromPeer: true });
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;
      for (let i = 0; i < 50 && rel.getRelease(staged.data.id)!.status !== 'deployed'; i++) await flush(20);
      const done = rel.getRelease(staged.data.id)!;
      expect(done).toMatchObject({
        status: 'deployed', version: '1.2.3', staging_url: 'https://staging.example/app',
        pin_until: '2026-10-12T18:00:00Z', deploy_id: '20261012T120000Z-abc123abc', progress_phase: 'done',
      });
      expect(typedInto(fable.id)).toHaveLength(0);
      expect(vi.mocked(emit)).toHaveBeenCalledWith('release.progress', 'release', staged.data.id, expect.objectContaining({ phase: 'build', deploy_id: '20261012T120000Z-abc123abc' }), null);
      expect(vi.mocked(emit)).toHaveBeenCalledWith('release.reported', 'release', staged.data.id, expect.objectContaining({ status: 'deployed', version: '1.2.3' }), null);

      cfg.releases = { ...cfg.releases, staging_command: ['node', replay, failed, '1', '{sha}'] };
      const broke = rel.acceptRelease({ sha: FIXTURE_SHA, target: 'staging', project: 'wavepulse' }, { userName: 'antonio', fromPeer: true });
      expect(broke.ok).toBe(true);
      if (!broke.ok) return;
      for (let i = 0; i < 50 && rel.getRelease(broke.data.id)!.status !== 'failed'; i++) await flush(20);
      expect(rel.getRelease(broke.data.id)).toMatchObject({
        status: 'failed', progress_phase: 'build', rollback_status: 'ok', version: '1.2.3',
        error: expect.stringContaining('build failed in fixture'),
      });

      cfg.releases = { deploy_agent: 'fable', production_approvers: ['denis'], staging_command: ['node', replay, success, '0', '{sha}'] };
      fs.writeFileSync(path.join(tmp, 'touch.cjs'), "require('fs').writeFileSync(process.argv[2], 'ran');\n");
      cfg.releases.staging_command = ['node', path.join(tmp, 'touch.cjs'), marker, '{sha}'];
      const prod = rel.acceptRelease({ sha: SHA_B, target: 'production', project: 'wavepulse', requested_by: 'denis', requester_role: 'admin' }, { userName: 'denis', fromPeer: true });
      expect(prod.ok).toBe(true);
      expect(typedInto(fable.id)[0]).toMatch(/authorization for PRODUCTION/);
      await flush(40);
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('refuses a staging command when the known freeze is not PASS or not GREEN', () => {
      agent('claude2');
      const marker = path.join(tmp, 'ran');
      const touch = path.join(tmp, 'touch.cjs');
      fs.writeFileSync(touch, "require('fs').writeFileSync(process.argv[2], 'ran');\n");
      cfg.releases = { staging_command: ['node', touch, marker, '{sha}'] };
      const needs = path.join(tmp, 'freeze-needs.md');
      fs.writeFileSync(needs, `# Desk #7 freeze note\n\nProject: wavepulse · Author: claude2\n- Lane: \`lane-a\`\n- Freeze SHA: \`${FIXTURE_SHA}\`\n- Review: @codex3 **VERDICT: NEEDS FIXES** on this exact SHA: /r/v.md\n`);
      expect(rf.ingestFreezeFile(needs).ok).toBe(true);
      const blocked = rel.acceptRelease({ sha: FIXTURE_SHA, target: 'staging' }, { userName: 'antonio', fromPeer: true });
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.error).toBe(rel.STAGE_NEEDS_PASS);
      expect(rel.listReleases({ sha: FIXTURE_SHA })[0]).toMatchObject({ status: 'failed', error: rel.STAGE_NEEDS_PASS });
      expect(fs.existsSync(marker)).toBe(false);

      const redSha = SHA;
      fs.writeFileSync(path.join(tmp, 'freeze-red.md'), `# Desk #7 freeze note\n\nProject: wavepulse · Author: claude2\n- Lane: \`lane-a\`\n- Freeze SHA: \`${redSha}\`\n- Review: @codex3 **VERDICT: PASS** on this exact SHA: /r/v.md\n- gate: RED\n`);
      expect(rf.ingestFreezeFile(path.join(tmp, 'freeze-red.md')).ok).toBe(true);
      const red = rel.acceptRelease({ sha: redSha, target: 'staging' }, { userName: 'antonio', fromPeer: true });
      expect(red.ok).toBe(false);
      if (!red.ok) expect(red.error).toBe(rel.stageNeedsGreen('RED'));
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('re-attaches a staging deploy with the watch command after the command is dropped', async () => {
      const hold = path.join(tmp, 'hold.cjs');
      const watch = path.join(tmp, 'watch.cjs');
      const success = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'staging-progress', 'success.ndjson');
      fs.writeFileSync(hold, "const fs=require('fs'); const id='20261012T120000Z-abc123abc'; fs.writeSync(1, JSON.stringify({v:1,ts:'2026-10-12T12:00:00.000Z',deploy_id:id,phase:'queued',status:'start'})+'\\n'); setInterval(()=>{},60000);\n");
      fs.writeFileSync(watch, "const fs=require('fs'); fs.writeSync(1, fs.readFileSync(process.argv[3],'utf8')); process.exit(0);\n");
      cfg.releases = {
        staging_command: ['node', hold, '{sha}'],
        staging_watch_command: ['node', watch, '{deploy_id}', success],
      };
      const staged = rel.acceptRelease({ sha: FIXTURE_SHA, target: 'staging', project: 'wavepulse' }, { userName: 'antonio', fromPeer: true });
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;
      for (let i = 0; i < 50 && rel.getRelease(staged.data.id)?.deploy_id !== '20261012T120000Z-abc123abc'; i++) await flush(20);
      expect(rel.getRelease(staged.data.id)?.status).toBe('sent');
      rel.stopStagingDeploys();
      await flush(30);
      expect(rel.getRelease(staged.data.id)?.status).toBe('sent');
      rel.resumeStagingDeploys();
      for (let i = 0; i < 50 && rel.getRelease(staged.data.id)?.status !== 'deployed'; i++) await flush(20);
      expect(rel.getRelease(staged.data.id)).toMatchObject({ status: 'deployed', version: '1.2.3', staging_url: 'https://staging.example/app' });
    });

    it('GET /api/releases/staging-tip returns the deployed staging tip', async () => {
      cfg.projects.wavepulse = { workspace_match: '**/ws/*' };
      cfg.releases = { deploy_agent: 'fable' };
      agent('fable');
      const sent = await rel.requestRelease({ project: 'wavepulse', sha: SHA, target: 'staging', actorName: 'denis' });
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;
      expect(rel.reportRelease(sent.data.id, { status: 'deployed', sha: SHA, version: '9.9.9' }).ok).toBe(true);
      const res = await app.fetch(new Request('http://x/api/releases/staging-tip?project=wavepulse'));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ sha: SHA, version: '9.9.9' });
      expect((await app.fetch(new Request('http://x/api/releases/staging-tip'))).status).toBe(400);
    });

    it('the peer token may post requests and read outcomes, nothing else', async () => {
      const auth = await import('./auth.js');
      expect(auth.restrictedPathAllowed('POST', '/api/releases')).toBe(true);
      expect(auth.restrictedPathAllowed('GET', '/api/releases/R1')).toBe(true);
      expect(auth.restrictedPathAllowed('GET', '/api/releases/staging-tip')).toBe(true);
      expect(auth.restrictedPathAllowed('POST', '/api/releases/R1/report')).toBe(false);
      expect(auth.restrictedPathAllowed('POST', '/api/reviews/r1/stage')).toBe(false);
    });
  });
});
