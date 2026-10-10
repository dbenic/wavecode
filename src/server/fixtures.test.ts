import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';

vi.mock('./event-bus.js', () => ({ emit: vi.fn() }));
vi.mock('./session-manager.js', () => ({ sendKeys: vi.fn(() => ({ ok: true, data: undefined })), get: vi.fn() }));
vi.mock('./logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const cfg = {
  artifacts: { storage: '', retention_days: 30, fixture_inbox: [] as string[] },
  projects: { wavepulse: { workspace_match: '**/ws/*' } } as Record<string, { workspace_match: string }>,
  peers: {} as Record<string, { url: string; token: string; agents?: string[] }>,
  paths: {},
  review: { freeze_inbox: [] },
};
vi.mock('./config.js', () => ({ getConfig: vi.fn(() => cfg) }));

// the acting user is swapped per test: owner (admin) or a restricted peer token
const acting = { user: { id: 'owner', name: 'owner', role: 'admin', allowed_agents: null } as Record<string, unknown> };
vi.mock('./auth.js', async () => {
  const actual = await vi.importActual<typeof import('./auth.js')>('./auth.js');
  return { ...actual, getActingUser: vi.fn(() => acting.user) };
});

import { emit } from './event-bus.js';

const INVOICE_XML = '<Invoice><Supplier>ACME d.o.o.</Supplier><Total>1220.00</Total></Invoice>\n';
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

describe('fixtures: the Artifacts page as a development library', () => {
  let tmp: string;
  let inbox: string;
  let db: typeof import('./db.js');
  let am: typeof import('./artifact-manager.js');
  let fx: typeof import('./fixtures.js');
  let peers: typeof import('./peers.js');
  let app: Hono;

  const upload = async (body: Record<string, unknown>) => {
    const res = await app.fetch(new Request('http://x/api/artifacts/upload', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    return { status: res.status, json: await res.json() as Record<string, unknown> };
  };
  const list = async (query = '') => (await (await app.fetch(new Request(`http://x/api/artifacts${query}`))).json()) as import('./db.js').Artifact[];

  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(emit).mockClear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wavecode-fixtures-'));
    inbox = path.join(tmp, 'fixtures-inbox');
    fs.mkdirSync(inbox);
    cfg.artifacts.storage = path.join(tmp, 'store');
    cfg.artifacts.fixture_inbox = [inbox];
    for (const k of Object.keys(cfg.peers)) delete cfg.peers[k];
    acting.user = { id: 'owner', name: 'owner', role: 'admin', allowed_agents: null };
    db = await import('./db.js');
    db.initDb(path.join(tmp, 't.db'));
    am = await import('./artifact-manager.js');
    fx = await import('./fixtures.js');
    peers = await import('./peers.js');
    fx.resetFixturesForTest();
    const routes = await import('./routes/artifacts.js');
    app = new Hono();
    routes.registerArtifactRoutes(app as never);
  });

  afterEach(() => {
    fx.resetFixturesForTest();
    peers.setPeerFetchForTest(null);
    db.resetDbForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('drop folder', () => {
    it('room and desk come from the folders, else from the file name', () => {
      expect(fx.parseFixturePath(inbox, path.join(inbox, 'wavepulse', 'desk91', 'credit-note.xml'))).toEqual({ room: 'wavepulse', desk: '91', filename: 'credit-note.xml' });
      expect(fx.parseFixturePath(inbox, path.join(inbox, 'PD-108', 'invoice.pdf'))).toEqual({ room: null, desk: '108', filename: 'invoice.pdf' });
      expect(fx.parseFixturePath(inbox, path.join(inbox, 'pd108-outgoing-line.json'))).toEqual({ room: null, desk: '108', filename: 'pd108-outgoing-line.json' });
      expect(fx.parseFixturePath(inbox, path.join(inbox, 'readme.txt'))).toEqual({ room: null, desk: null, filename: 'readme.txt' });
    });

    it('a dropped file becomes a kept fixture with desk, room and provenance; the same bytes again are the same artifact', () => {
      const dir = path.join(inbox, 'wavepulse', 'desk91');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'credit-note.xml');
      fs.writeFileSync(file, INVOICE_XML);
      const r = fx.ingestFixtureFile(inbox, file);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data).toMatchObject({ kind: 'fixture', desk: '91', room: 'wavepulse', filename: 'credit-note.xml', sha256: sha(INVOICE_XML) });
      expect(r.data.provenance).toMatch(/dropped into .*fixtures-inbox for desk 91/);
      fs.writeFileSync(path.join(inbox, 'copy.xml'), INVOICE_XML);
      const again = fx.ingestFixtureFile(inbox, path.join(inbox, 'copy.xml'));
      expect(again.ok && again.data.id).toBe(r.data.id);
      expect(db.listArtifacts()).toHaveLength(1);
    });

    it('a folder event ingests the file once it settled; backfill picks up what was already there', async () => {
      fs.mkdirSync(path.join(inbox, 'desk43'));
      fs.writeFileSync(path.join(inbox, 'desk43', 'bank.csv'), 'date;amount\n2026-10-01;12.00\n');
      expect(fx.backfillFixtures()).toBe(1);
      expect(db.listArtifacts({ kind: 'fixture' }).map((a) => a.desk)).toEqual(['43']);
      fs.writeFileSync(path.join(inbox, 'pd108-lines.json'), '{"lines":[]}');
      fx.onFixtureInboxEvent(inbox, 'pd108-lines.json', 10);
      fx.onFixtureInboxEvent(inbox, '.pd108-lines.json.swp', 10); // editor temp file: ignored
      await new Promise((res) => setTimeout(res, 60));
      expect(db.listArtifacts({ kind: 'fixture' }).map((a) => a.desk).sort()).toEqual(['108', '43']);
    });
  });

  describe('library fields', () => {
    it('upload with kind=fixture stores desk (normalized), room and provenance; the same bytes uploaded as a fixture promote a transient artifact', async () => {
      const first = await upload({ filename: 'a.xml', content_base64: Buffer.from(INVOICE_XML).toString('base64'), note: 'scratch' });
      expect(first.status).toBe(201);
      expect(first.json.kind).toBe('transient');
      const second = await upload({ filename: 'a.xml', content_base64: Buffer.from(INVOICE_XML).toString('base64'), kind: 'fixture', desk: 'PD-108', room: 'wavepulse', provenance: 'redacted export by fable' });
      expect(second.status).toBe(201);
      expect(second.json.id).toBe(first.json.id);
      expect(second.json).toMatchObject({ kind: 'fixture', desk: '108', room: 'wavepulse', provenance: 'redacted export by fable', note: 'scratch' });
      expect(db.listArtifacts()).toHaveLength(1);
      expect(vi.mocked(emit)).toHaveBeenCalledWith('artifact.updated', 'artifact', first.json.id, expect.objectContaining({ kind: 'fixture', desk: '108' }));
    });

    it('PATCH keeps a transient artifact and edits the fields; list filters by kind, room and q', async () => {
      const a = await upload({ filename: 'notes.md', content_base64: Buffer.from('# notes').toString('base64') });
      const b = await upload({ filename: 'desk91-fixture.xml', content_base64: Buffer.from(INVOICE_XML).toString('base64'), kind: 'fixture', desk: '91', room: 'wavepulse' });
      const res = await app.fetch(new Request(`http://x/api/artifacts/${a.json.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'fixture', desk: 'Desk #43', provenance: 'synthetic' }),
      }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ kind: 'fixture', desk: '43', provenance: 'synthetic' });
      expect((await list('?kind=fixture')).map((x) => x.id).sort()).toEqual([a.json.id, b.json.id].sort());
      expect((await list('?room=wavepulse')).map((x) => x.id)).toEqual([b.json.id]);
      expect((await list('?q=synthetic')).map((x) => x.id)).toEqual([a.json.id]);
      expect((await list('?desk=PD-91')).map((x) => x.id)).toEqual([b.json.id]);
      const bad = await app.fetch(new Request(`http://x/api/artifacts/${a.json.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'forever' }) }));
      expect(bad.status).toBe(400);
    });

    it('pruning never touches fixtures', async () => {
      const keep = await upload({ filename: 'keep.xml', content_base64: Buffer.from(INVOICE_XML).toString('base64'), kind: 'fixture' });
      const scratch = await upload({ filename: 'scratch.txt', content_base64: Buffer.from('tmp').toString('base64') });
      db.getDb().prepare("UPDATE artifacts SET created_at = '2020-01-01 00:00:00'").run();
      expect(am.pruneOldArtifacts()).toBe(1);
      expect(db.getArtifact(keep.json.id as string).ok).toBe(true);
      expect(db.getArtifact(scratch.json.id as string).ok).toBe(false);
    });

    it('a restricted (peer) token sees fixtures only, on list, get and download', async () => {
      const keep = await upload({ filename: 'keep.xml', content_base64: Buffer.from(INVOICE_XML).toString('base64'), kind: 'fixture' });
      const scratch = await upload({ filename: 'scratch.txt', content_base64: Buffer.from('tmp').toString('base64') });
      acting.user = { id: 'u-peer', name: 'peer-countix-dev', role: 'developer', allowed_agents: '["fable"]' };
      expect((await list()).map((x) => x.id)).toEqual([keep.json.id]);
      expect((await list('?kind=transient')).map((x) => x.id)).toEqual([keep.json.id]); // cannot widen
      expect((await app.fetch(new Request(`http://x/api/artifacts/${scratch.json.id}`))).status).toBe(404);
      expect((await app.fetch(new Request(`http://x/api/artifacts/${scratch.json.id}/download`))).status).toBe(404);
      expect((await app.fetch(new Request(`http://x/api/artifacts/${keep.json.id}/download`))).status).toBe(200);
      const auth = await import('./auth.js');
      expect(auth.restrictedPathAllowed('GET', '/api/artifacts')).toBe(true);
      expect(auth.restrictedPathAllowed('GET', `/api/artifacts/${keep.json.id}/download`)).toBe(true);
      expect(auth.restrictedPathAllowed('POST', '/api/artifacts/upload')).toBe(false);
      expect(auth.restrictedPathAllowed('PATCH', `/api/artifacts/${keep.json.id}`)).toBe(false);
    });
  });

  describe('documents', () => {
    it('archiveDocumentFile keeps a hand-off as a document with desk, SHA and title; pruning leaves documents alone', () => {
      const file = path.join(tmp, 'fable-to-claude2-desk105-ad4d8143-ack.md');
      const SHA = 'ad4d8143d202664f629754e72189c28d58e2e9ce';
      fs.writeFileSync(file, `# Fable ack for Desk #105\n\nExact SHA ${SHA} gated GREEN.\n`);
      const r = fx.archiveDocumentFile(file, { provenance: 'hand-off from deploy/fable; archived from ' + file });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data).toMatchObject({ kind: 'document', desk: '105', note: 'Fable ack for Desk #105', filename: 'fable-to-claude2-desk105-ad4d8143-ack.md' });
      expect(r.data.provenance).toBe(`hand-off from deploy/fable; archived from ${file}; exact SHA ${SHA}`);
      db.getDb().prepare("UPDATE artifacts SET created_at = '2020-01-01 00:00:00'").run();
      expect(am.pruneOldArtifacts()).toBe(0);
      expect(db.getArtifact(r.data.id).ok).toBe(true);
    });

    it('a document never downgrades a fixture with the same bytes, and PATCH accepts kind=document', async () => {
      const bytes = Buffer.from('same bytes');
      const fixture = await upload({ filename: 'x.txt', content_base64: bytes.toString('base64'), kind: 'fixture' });
      fs.writeFileSync(path.join(tmp, 'x.txt'), bytes);
      const doc = fx.archiveDocumentFile(path.join(tmp, 'x.txt'), { provenance: 'later' });
      expect(doc.ok && doc.data.id).toBe(fixture.json.id);
      expect(doc.ok && doc.data.kind).toBe('fixture');
      const other = await upload({ filename: 'y.txt', content_base64: Buffer.from('other').toString('base64') });
      const res = await app.fetch(new Request(`http://x/api/artifacts/${other.json.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'document' }) }));
      expect(res.status).toBe(200);
      expect((await list('?kind=document')).map((a) => a.id)).toEqual([other.json.id]);
    });
  });

  describe('import from a peer', () => {
    const remote = {
      fixture: { id: 'r-fix', filename: 'desk91-credit-note.xml', mime_type: 'text/xml', sha256: sha(INVOICE_XML), size_bytes: INVOICE_XML.length, kind: 'fixture', desk: '91', room: 'wavepulse', provenance: 'redacted export of Desk #91 attachment by fable, 2026-10-10', note: null, created_at: '2026-10-10 08:00:00' },
      original: { id: 'r-orig', filename: 'original.pdf', mime_type: 'application/pdf', sha256: sha('pdf'), size_bytes: 3, kind: 'transient', desk: null, room: null, provenance: null, note: null, created_at: '' },
    };
    const fakePeerFetch = (opts: { corrupt?: boolean } = {}): typeof fetch => async (input, init) => {
      const url = new URL(String(input));
      const auth = (init?.headers as Record<string, string>)?.Authorization;
      if (auth !== 'Bearer peer-token-0123456789') return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      if (url.pathname === '/api/artifacts') return Response.json([remote.fixture]); // the peer's routes filter to fixtures for our token
      if (url.pathname === '/api/artifacts/r-fix') return Response.json(remote.fixture);
      if (url.pathname === '/api/artifacts/r-orig') return Response.json(remote.original);
      if (url.pathname === '/api/artifacts/r-fix/download') {
        return new Response(opts.corrupt ? INVOICE_XML.replace('1220', '9999') : INVOICE_XML, { headers: { 'content-type': 'text/xml', 'content-disposition': 'inline; filename="desk91-credit-note.xml"' } });
      }
      return new Response(JSON.stringify({ error: `no route ${url.pathname}` }), { status: 404 });
    };

    beforeEach(() => {
      cfg.peers.deploy = { url: 'http://deploy.test', token: 'peer-token-0123456789', agents: ['fable'] };
    });

    it('lists what the peer offers and imports one with a verified sha256 and a provenance chain', async () => {
      peers.setPeerFetchForTest(fakePeerFetch());
      const offered = await fx.listPeerFixtures('deploy');
      expect(offered.ok && offered.data.map((f) => f.id)).toEqual(['r-fix']);
      const r = await fx.importPeerFixture('deploy', 'r-fix', { actorName: 'denis' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.data).toMatchObject({ kind: 'fixture', desk: '91', room: 'wavepulse', filename: 'desk91-credit-note.xml', sha256: sha(INVOICE_XML) });
      expect(r.data.provenance).toMatch(/^imported from peer deploy \(artifact r-fix\) by denis on \d{4}-\d{2}-\d{2}; origin: redacted export of Desk #91/);
      expect(fs.readFileSync(r.data.storage_path, 'utf-8')).toBe(INVOICE_XML);
      // importing again is the same artifact
      const again = await fx.importPeerFixture('deploy', 'r-fix', { actorName: 'denis' });
      expect(again.ok && again.data.id).toBe(r.data.id);
      expect(db.listArtifacts()).toHaveLength(1);
    });

    it('refuses anything the peer did not mark as a fixture, and bytes that do not match the peer\'s sha256', async () => {
      peers.setPeerFetchForTest(fakePeerFetch());
      const orig = await fx.importPeerFixture('deploy', 'r-orig');
      expect(orig.ok).toBe(false);
      expect(!orig.ok && orig.error).toMatch(/not a fixture/);
      peers.setPeerFetchForTest(fakePeerFetch({ corrupt: true }));
      const bad = await fx.importPeerFixture('deploy', 'r-fix');
      expect(bad.ok).toBe(false);
      expect(!bad.ok && bad.error).toMatch(/do not match/);
      expect(db.listArtifacts()).toHaveLength(0);
      expect((await fx.importPeerFixture('nowhere', 'r-fix')).ok).toBe(false);
    });
  });
});
