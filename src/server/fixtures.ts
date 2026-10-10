/**
 * Development fixtures: the Artifacts page as a library.
 *
 * A fixture is a kept artifact (`kind = 'fixture'`, never pruned) with a desk
 * reference, a project room and a provenance line. Two inbound paths besides
 * the page's own upload:
 *
 *  - drop folders (`artifacts.fixture_inbox`): any file put there becomes a
 *    fixture; sub-folders name the room and the desk
 *    (`<inbox>/wavepulse/desk91/invoice.xml`), or the file name carries them;
 *  - import from a peer (`POST /api/peers/:peer/artifacts/:id/import`): the
 *    deploy box marks a sanitized file as a fixture in its own library, the
 *    dev box pulls it over the peer link, verifies the sha256 and records
 *    where it came from. The peer's restricted token only ever sees fixtures.
 *
 * Customer originals never travel this way: the provenance line says how a
 * file was sanitized, and the agent rules say originals are never requested.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config.js';
import type { Artifact, Result } from './db.js';
import { normalizeDesk, storeArtifactFromBuffer } from './artifact-manager.js';
import { peerDownload, peerGetJson } from './peers.js';
import logger from './logger.js';

const SETTLE_MS = 1200;
const DESK_SEGMENT_RE = /^(?:pd|desk|request|req)?[\s#_-]*#?(\d{1,6})$/i;
const DESK_IN_NAME_RE = /(?:^|[^a-z0-9])(?:pd|desk)[\s#_-]*#?(\d{1,6})(?![0-9])/i;

function expand(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function fixtureInboxDirs(): string[] {
  return (getConfig().artifacts.fixture_inbox ?? []).map(expand);
}

/** Room and desk from where a file sits under the drop folder, then from its name. */
export function parseFixturePath(root: string, file: string): { desk: string | null; room: string | null; filename: string } {
  const projects = Object.keys(getConfig().projects ?? {});
  const rel = path.relative(root, file);
  const segments = rel.split(path.sep);
  const filename = segments.pop() ?? path.basename(file);
  let desk: string | null = null;
  let room: string | null = null;
  for (const seg of segments) {
    const d = seg.match(DESK_SEGMENT_RE);
    if (d && !desk) { desk = d[1]; continue; }
    const p = projects.find((n) => n.toLowerCase() === seg.toLowerCase());
    if (p && !room) room = p;
  }
  if (!desk) {
    const d = filename.match(DESK_IN_NAME_RE);
    if (d) desk = d[1];
  }
  return { desk, room, filename };
}

/** Store one dropped file as a fixture. Same bytes twice = the same artifact (sha256 dedup). */
export function ingestFixtureFile(root: string, file: string, opts: { provenance?: string } = {}): Result<Artifact> {
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (e) {
    return { ok: false, error: `cannot read ${file}: ${(e as Error).message}` };
  }
  if (buffer.length === 0) return { ok: false, error: `${path.basename(file)} is empty` };
  const { desk, room, filename } = parseFixturePath(root, file);
  return storeArtifactFromBuffer({
    buffer,
    filename,
    kind: 'fixture',
    desk,
    room,
    provenance: opts.provenance ?? `dropped into ${root}${desk ? ` for desk ${desk}` : ''}`,
    uploadedBy: null,
  });
}

// --- peer import --------------------------------------------------------------------

export interface PeerFixture {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  desk: string | null;
  room: string | null;
  provenance: string | null;
  note: string | null;
  created_at: string;
}

type RemoteArtifact = Partial<Artifact> & { id: string; filename: string; sha256: string };

function toPeerFixture(a: RemoteArtifact): PeerFixture {
  return {
    id: a.id,
    filename: a.filename,
    mime_type: a.mime_type ?? 'application/octet-stream',
    size_bytes: a.size_bytes ?? 0,
    sha256: a.sha256,
    desk: a.desk ?? null,
    room: a.room ?? null,
    provenance: a.provenance ?? null,
    note: a.note ?? null,
    created_at: a.created_at ?? '',
  };
}

/** The peer's fixture library (its routes return fixtures only to our restricted token). */
export async function listPeerFixtures(peerName: string): Promise<Result<PeerFixture[]>> {
  const r = await peerGetJson<RemoteArtifact[]>(peerName, '/artifacts?kind=fixture');
  if (!r.ok) return r;
  if (!Array.isArray(r.data)) return { ok: false, error: 'peer returned no artifact list' };
  return { ok: true, data: r.data.filter((a) => a && a.kind === 'fixture').map(toPeerFixture) };
}

/**
 * Pull one fixture from a peer into our library. Refuses anything the peer
 * does not mark as a fixture, and verifies the bytes against the peer's sha256.
 */
export async function importPeerFixture(
  peerName: string,
  remoteId: string,
  opts: { room?: string; desk?: string; actorName?: string | null } = {},
): Promise<Result<Artifact>> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(remoteId)) return { ok: false, error: 'invalid artifact id' };
  const meta = await peerGetJson<RemoteArtifact>(peerName, `/artifacts/${remoteId}`);
  if (!meta.ok) return meta;
  if (!meta.data || meta.data.kind !== 'fixture') {
    return { ok: false, error: `peer artifact ${remoteId} is not a fixture — only files the peer marked as sanitized fixtures can be imported` };
  }
  const dl = await peerDownload(peerName, `/artifacts/${remoteId}/download`);
  if (!dl.ok) return dl;
  const sha = crypto.createHash('sha256').update(dl.data.buffer).digest('hex');
  if (sha !== meta.data.sha256) {
    return { ok: false, error: `peer artifact ${remoteId}: downloaded bytes do not match the peer's sha256` };
  }
  const date = new Date().toISOString().slice(0, 10);
  const provenance = [
    `imported from peer ${peerName} (artifact ${remoteId}) by ${opts.actorName ?? 'admin'} on ${date}`,
    meta.data.provenance ? `origin: ${meta.data.provenance}` : 'origin: not stated by the peer',
  ].join('; ');
  const stored = storeArtifactFromBuffer({
    buffer: dl.data.buffer,
    filename: meta.data.filename || dl.data.filename || `peer-${remoteId}`,
    kind: 'fixture',
    desk: opts.desk ? normalizeDesk(opts.desk) : meta.data.desk ? normalizeDesk(meta.data.desk) : null,
    room: opts.room ?? meta.data.room ?? null,
    provenance,
    note: meta.data.note ?? undefined,
  });
  if (stored.ok) logger.info({ peer: peerName, remoteId, artifactId: stored.data.id, sha }, 'Fixture imported from peer');
  return stored;
}

// --- drop-folder watcher + backfill ----------------------------------------------------

const watchers = new Map<string, fs.FSWatcher>();
const seen = new Map<string, number>(); // path → mtimeMs ingested
const timers = new Set<NodeJS.Timeout>();

function ingestIfChanged(root: string, file: string): void {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return;
  }
  if (!st.isFile() || path.basename(file).startsWith('.')) return;
  if (seen.get(file) === st.mtimeMs) return;
  seen.set(file, st.mtimeMs);
  try {
    const r = ingestFixtureFile(root, file);
    if (!r.ok) logger.info({ file, reason: r.error }, 'Fixture file skipped');
  } catch (e) {
    logger.warn({ file, error: (e as Error).message }, 'Fixture file could not be ingested');
  }
}

/** One fs.watch event (possibly several per write): ingest once the file settled. */
export function onFixtureInboxEvent(root: string, filename: string | Buffer | null, settleMs = SETTLE_MS): void {
  if (!filename || typeof filename !== 'string') return;
  if (filename.split(/[\\/]/).some((s) => s.startsWith('.'))) return;
  const file = path.join(root, filename);
  const t = setTimeout(() => { timers.delete(t); ingestIfChanged(root, file); }, settleMs);
  timers.add(t);
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

/** Every file already in the drop folders becomes a fixture (idempotent through sha256 dedup). */
export function backfillFixtures(dirs = fixtureInboxDirs()): number {
  let n = 0;
  for (const root of dirs) {
    const files: string[] = [];
    walk(root, files);
    for (const f of files) { ingestIfChanged(root, f); n++; }
  }
  return n;
}

export function startFixtureWatchers(): void {
  for (const root of fixtureInboxDirs()) {
    if (watchers.has(root)) continue;
    try {
      fs.mkdirSync(root, { recursive: true, mode: 0o770 });
    } catch (e) {
      logger.warn({ dir: root, error: (e as Error).message }, 'Fixture inbox could not be created');
      continue;
    }
    try {
      const w = fs.watch(root, { recursive: true }, (_event, filename) => onFixtureInboxEvent(root, filename));
      w.on('error', (e) => logger.warn({ dir: root, error: e.message }, 'Fixture watcher error'));
      watchers.set(root, w);
      logger.info({ dir: root }, 'Watching fixture inbox');
    } catch (e) {
      logger.warn({ dir: root, error: (e as Error).message }, 'Fixture watcher could not start');
    }
  }
  const imported = backfillFixtures();
  if (imported > 0) logger.info({ files: imported }, 'Fixture inbox scanned');
}

export function stopFixtureWatchers(): void {
  for (const w of watchers.values()) w.close();
  watchers.clear();
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

/** Test hook. */
export function resetFixturesForTest(): void {
  stopFixtureWatchers();
  seen.clear();
}
