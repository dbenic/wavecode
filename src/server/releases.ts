/**
 * Releases as records, not chat.
 *
 * A person presses Stage or Promote on a freeze card (or the Release view). The
 * dev box posts a release request to the project's release peer (the deploy
 * box's WaveCode) over the peer API; that daemon stores it, hands it to its
 * deploy agent as one prompt with the right header (a human GO for production,
 * an automated request for staging), and the agent reports back through the
 * `report_release` MCP tool or by printing `RELEASED <id>: …` /
 * `RELEASE FAILED <id>: …`, which the pane watcher detects. The requester polls
 * the peer for `release.reported` and mirrors the outcome, so the Release view
 * always shows what is on staging and in production.
 *
 * Both roles live in this one module: `requestRelease` (requester side),
 * `acceptRelease` + `reportRelease` (deploy side). A box with
 * `releases.deploy_agent` and no `release_peer` serves itself.
 */

import os from 'node:os';
import { ulid } from 'ulid';
import { getConfig } from './config.js';
import { getAgent, getDb, resolveAgent, type Agent, type Result } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { notify } from './notifications.js';
import { peerGetJson, peerPostJson } from './peers.js';
import { deliverSystemLine } from './wire-lines.js';

export type ReleaseTarget = 'staging' | 'production';
export type ReleaseStatus = 'requested' | 'sent' | 'deployed' | 'failed' | 'rejected';

export interface ReleaseRequest {
  id: string;
  project: string | null;
  sha: string;
  lane: string | null;
  target: ReleaseTarget;
  desk: string | null;
  reviewer: string | null;
  /** person (or agent) who asked; on the deploy side the name forwarded by the requester */
  requested_by: string | null;
  /** 'local' = requested here (and forwarded to `peer` when set); 'peer' = received from another box */
  origin: 'local' | 'peer';
  /** requester side: the peer the request went to; deploy side: the box it came from */
  peer: string | null;
  /** requester side: the id of the record on the peer */
  peer_request_id: string | null;
  /** deploy side: the requester's own id, echoed back in reports */
  origin_id: string | null;
  run_id: string | null;
  deploy_agent_id: string | null;
  status: ReleaseStatus;
  version: string | null;
  deployed_sha: string | null;
  report: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  reported_at: string | null;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const POLL_WAIT_MS = 30_000;
const POLL_RETRY_MS = 5_000;
let pollIdleMs = POLL_RETRY_MS;
export function setReleasePollIdleMsForTest(ms: number): void { pollIdleMs = ms; }

export function ensureReleaseTables(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS release_requests (
      id TEXT PRIMARY KEY,
      project TEXT,
      sha TEXT NOT NULL,
      lane TEXT,
      target TEXT NOT NULL,
      desk TEXT,
      reviewer TEXT,
      requested_by TEXT,
      origin TEXT NOT NULL,
      peer TEXT,
      peer_request_id TEXT,
      origin_id TEXT,
      run_id TEXT,
      deploy_agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'requested',
      version TEXT,
      deployed_sha TEXT,
      report TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      reported_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_release_requests_sha ON release_requests(sha, target);
    CREATE INDEX IF NOT EXISTS idx_release_requests_status ON release_requests(status);
  `);
}

function withTable<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (!/no such table: release_requests/.test((e as Error).message)) throw e;
    ensureReleaseTables();
    return fn();
  }
}

export function getRelease(id: string): ReleaseRequest | null {
  return withTable(() => (getDb().prepare('SELECT * FROM release_requests WHERE id = ?').get(id) as ReleaseRequest | undefined) ?? null);
}

export function listReleases(filters: { project?: string; sha?: string; target?: ReleaseTarget; status?: ReleaseStatus; limit?: number } = {}): ReleaseRequest[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filters.project) { conds.push('project = ?'); params.push(filters.project); }
  if (filters.sha) { conds.push('sha = ?'); params.push(filters.sha); }
  if (filters.target) { conds.push('target = ?'); params.push(filters.target); }
  if (filters.status) { conds.push('status = ?'); params.push(filters.status); }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  return withTable(() => getDb().prepare(`SELECT * FROM release_requests${where} ORDER BY created_at DESC LIMIT ?`).all(...params, filters.limit ?? 200) as ReleaseRequest[]);
}

/** Latest outcome per target for a SHA — what the Release view shows next to a lane. */
export function releaseStateFor(sha: string): Record<ReleaseTarget, ReleaseRequest | null> {
  const rows = listReleases({ sha, limit: 50 });
  return {
    staging: rows.find((r) => r.target === 'staging') ?? null,
    production: rows.find((r) => r.target === 'production') ?? null,
  };
}

function patch(id: string, fields: Partial<ReleaseRequest>): void {
  const keys = Object.keys(fields) as (keyof ReleaseRequest)[];
  if (keys.length === 0) return;
  getDb().prepare(`UPDATE release_requests SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => fields[k] ?? null), id);
}

function insert(row: Omit<ReleaseRequest, 'created_at' | 'updated_at' | 'reported_at'>): ReleaseRequest {
  withTable(() => getDb().prepare(`INSERT INTO release_requests (id, project, sha, lane, target, desk, reviewer, requested_by, origin, peer, peer_request_id, origin_id, run_id, deploy_agent_id, status, version, deployed_sha, report, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.project, row.sha, row.lane, row.target, row.desk, row.reviewer, row.requested_by, row.origin, row.peer, row.peer_request_id, row.origin_id, row.run_id, row.deploy_agent_id, row.status, row.version, row.deployed_sha, row.report, row.error));
  return getRelease(row.id)!;
}

function isTarget(t: unknown): t is ReleaseTarget {
  return t === 'staging' || t === 'production';
}

// --- requester side ---------------------------------------------------------------------

export interface RequestReleaseOpts {
  project: string;
  sha: string;
  lane?: string | null;
  target: ReleaseTarget;
  desk?: string | null;
  reviewer?: string | null;
  /** the person who pressed Stage / Promote */
  actorName: string | null;
  runId?: string | null;
}

/**
 * Create a release request and forward it to the project's release peer (or
 * serve it locally when this box has the deploy agent itself).
 */
export async function requestRelease(opts: RequestReleaseOpts): Promise<Result<ReleaseRequest>> {
  if (!SHA_RE.test(opts.sha)) return { ok: false, error: 'sha must be the exact 40-character commit id' };
  if (!isTarget(opts.target)) return { ok: false, error: "target must be 'staging' or 'production'" };
  const cfg = getConfig();
  const project = cfg.projects?.[opts.project];
  if (!project) return { ok: false, error: `Unknown project '${opts.project}'` };
  const open = listReleases({ sha: opts.sha, target: opts.target, limit: 5 }).find((r) => r.status === 'requested' || r.status === 'sent');
  if (open) return { ok: false, error: `A ${opts.target} request for ${opts.sha.slice(0, 8)} is already open (${open.id})` };

  const id = ulid();
  const base = {
    id,
    project: opts.project,
    sha: opts.sha,
    lane: opts.lane ?? null,
    target: opts.target,
    desk: opts.desk ?? null,
    reviewer: opts.reviewer ?? null,
    requested_by: opts.actorName,
    run_id: opts.runId ?? null,
    version: null,
    deployed_sha: null,
    report: null,
  };

  if (project.release_peer) {
    const [peerName] = project.release_peer.split('/');
    const row = insert({ ...base, origin: 'local', peer: peerName, peer_request_id: null, origin_id: null, deploy_agent_id: null, status: 'requested', error: null });
    const remote = await peerPostJson<{ id: string; status: string }>(peerName, '/releases', {
      sha: opts.sha, lane: opts.lane ?? null, target: opts.target, project: opts.project, desk: opts.desk ?? null,
      reviewer: opts.reviewer ?? null, requested_by: opts.actorName, origin_id: id, origin_box: os.hostname(),
    });
    if (!remote.ok || !remote.data?.id) {
      const error = remote.ok ? 'peer returned no release id' : remote.error;
      patch(id, { status: 'failed', error });
      emit('release.reported', 'release', id, { status: 'failed', target: opts.target, sha: opts.sha, project: opts.project, error });
      return { ok: false, error: `Release request not accepted by peer ${peerName}: ${error}` };
    }
    patch(id, { status: 'sent', peer_request_id: remote.data.id });
    const sent = getRelease(id)!;
    emit('release.requested', 'release', id, { target: opts.target, sha: opts.sha, project: opts.project, lane: opts.lane ?? null, desk: opts.desk ?? null, peer: peerName, peer_request_id: remote.data.id, requested_by: opts.actorName, run_id: opts.runId ?? null });
    ensureReleasePoller(peerName);
    return { ok: true, data: sent };
  }

  if (cfg.releases?.deploy_agent) {
    // this box deploys itself
    const row = insert({ ...base, origin: 'local', peer: null, peer_request_id: null, origin_id: null, deploy_agent_id: null, status: 'requested', error: null });
    return handToDeployAgent(row);
  }
  return { ok: false, error: `Project '${opts.project}' has no release_peer and this box has no releases.deploy_agent` };
}

// --- deploy side -----------------------------------------------------------------------------

export interface IncomingRelease {
  sha?: unknown; lane?: unknown; target?: unknown; project?: unknown; desk?: unknown; reviewer?: unknown;
  requested_by?: unknown; origin_id?: unknown; origin_box?: unknown;
}

/** A request from a peer box (or a local caller): store it and hand it to the deploy agent. */
export function acceptRelease(body: IncomingRelease, via: { userName: string; fromPeer: boolean }): Result<ReleaseRequest> {
  const sha = typeof body.sha === 'string' ? body.sha.trim().toLowerCase() : '';
  if (!SHA_RE.test(sha)) return { ok: false, error: 'sha must be the exact 40-character commit id' };
  if (!isTarget(body.target)) return { ok: false, error: "target must be 'staging' or 'production'" };
  const str = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const open = listReleases({ sha, target: body.target, limit: 5 }).find((r) => r.status === 'requested' || r.status === 'sent');
  if (open) return { ok: true, data: open }; // idempotent: a retried request is the same request
  const row = insert({
    id: ulid(),
    project: str(body.project, 64),
    sha,
    lane: str(body.lane, 120),
    target: body.target,
    desk: str(body.desk, 40),
    reviewer: str(body.reviewer, 64),
    requested_by: str(body.requested_by, 64),
    origin: via.fromPeer ? 'peer' : 'local',
    peer: via.fromPeer ? `${str(body.origin_box, 64) ?? 'peer'} (${via.userName})` : null,
    peer_request_id: null,
    origin_id: str(body.origin_id, 64),
    run_id: null,
    deploy_agent_id: null,
    status: 'requested',
    version: null,
    deployed_sha: null,
    report: null,
    error: null,
  });
  return handToDeployAgent(row);
}

function deployAgent(): Result<Agent> {
  const name = getConfig().releases?.deploy_agent;
  if (!name) return { ok: false, error: 'releases.deploy_agent is not configured on this box' };
  const a = resolveAgent(name);
  return a.ok ? a : { ok: false, error: `releases.deploy_agent '${name}' is not an agent here` };
}

export function releasePromptText(r: ReleaseRequest): string {
  const who = r.requested_by ?? 'admin';
  const header = r.target === 'production'
    ? `[Release GO ${r.id} from ${who} via WaveCode Promote${r.peer ? ` on ${r.peer}` : ''}. This is a human's authorization for PRODUCTION; act on it per your deploy rules.]`
    : `[Staging request ${r.id} from ${who} via WaveCode${r.peer ? ` on ${r.peer}` : ''}. Automated: deploy to STAGING only; no production step is authorized by this request.]`;
  return [
    header,
    `Deploy exact SHA ${r.sha}${r.lane ? ` (lane ${r.lane})` : ''}${r.project ? ` of ${r.project}` : ''}${r.desk ? ` for Desk #${r.desk}` : ''} to ${r.target}.`,
    r.reviewer ? `Independent review: @${r.reviewer} VERDICT: PASS on this exact SHA.` : null,
    'Gate the exact SHA per your runbook, assign the version, deploy, verify.',
    `When done, report with the report_release tool (id ${r.id}) or print exactly one line:`,
    `RELEASED ${r.id}: deployed <sha> version <x.y.z> to ${r.target}`,
    `or, if you could not: RELEASE FAILED ${r.id}: <why>`,
  ].filter(Boolean).join('\n');
}

function handToDeployAgent(row: ReleaseRequest): Result<ReleaseRequest> {
  const agent = deployAgent();
  if (!agent.ok) {
    patch(row.id, { status: 'failed', error: agent.error });
    emit('release.reported', 'release', row.id, { status: 'failed', target: row.target, sha: row.sha, project: row.project, error: agent.error, origin_id: row.origin_id }, null);
    return { ok: false, error: agent.error };
  }
  deliverSystemLine(agent.data, releasePromptText(row), { kind: 'handoff', source: `release:${row.target}` });
  patch(row.id, { status: 'sent', deploy_agent_id: agent.data.id });
  const sent = getRelease(row.id)!;
  emit('release.requested', 'release', row.id, { target: row.target, sha: row.sha, project: row.project, lane: row.lane, desk: row.desk, requested_by: row.requested_by, deploy_agent_id: agent.data.id, origin: row.origin, origin_id: row.origin_id }, null);
  logger.info({ releaseId: row.id, target: row.target, sha: row.sha, agent: agent.data.name }, 'Release request handed to the deploy agent');
  return { ok: true, data: sent };
}

export interface ReleaseReport {
  status: 'deployed' | 'failed' | 'rejected';
  version?: string | null;
  sha?: string | null;
  note?: string | null;
  byAgentId?: string | null;
}

/** The deploy agent's outcome (MCP tool, API, or a RELEASED / RELEASE FAILED line). */
export function reportRelease(id: string, report: ReleaseReport): Result<ReleaseRequest> {
  const r = getRelease(id);
  if (!r) return { ok: false, error: `Release ${id} not found` };
  if (r.status === 'deployed' || r.status === 'failed' || r.status === 'rejected') return { ok: true, data: r }; // final: a repeat is a no-op
  if (!['deployed', 'failed', 'rejected'].includes(report.status)) return { ok: false, error: "status must be 'deployed', 'failed' or 'rejected'" };
  const deployedSha = report.sha ? report.sha.trim().toLowerCase() : null;
  if (report.status === 'deployed' && deployedSha && deployedSha !== r.sha && !r.sha.startsWith(deployedSha)) {
    return { ok: false, error: `Reported SHA ${deployedSha.slice(0, 8)} is not the requested ${r.sha.slice(0, 8)}; report a failure instead` };
  }
  patch(id, {
    status: report.status,
    version: report.version?.trim() || null,
    deployed_sha: report.status === 'deployed' ? r.sha : null,
    report: report.note?.trim().slice(0, 4000) || null,
    error: report.status === 'deployed' ? null : (report.note?.trim().slice(0, 1000) || report.status),
    reported_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  });
  const done = getRelease(id)!;
  emit('release.reported', 'release', id, {
    status: done.status, target: done.target, sha: done.sha, project: done.project, lane: done.lane, desk: done.desk,
    version: done.version, note: done.report, error: done.error, origin: done.origin, origin_id: done.origin_id,
    deploy_agent_id: report.byAgentId ?? done.deploy_agent_id, requested_by: done.requested_by,
  }, null);
  if (done.origin === 'local') announce(done);
  return { ok: true, data: done };
}

function announce(r: ReleaseRequest): void {
  const title = r.status === 'deployed'
    ? `${r.target === 'production' ? 'Production' : 'Staging'} deployed: ${r.project ?? ''} ${r.sha.slice(0, 8)}${r.version ? ` v${r.version}` : ''}`
    : `${r.target} release ${r.status}: ${r.project ?? ''} ${r.sha.slice(0, 8)}`;
  void notify({ title, body: (r.report ?? r.error ?? '').slice(0, 300), url: '/release', tag: `release-${r.id}` }).catch(() => {});
}

// --- RELEASED / RELEASE FAILED lines in the deploy agent's pane ---------------------------------

const RELEASED_RE = /^[\s•>›⏺*-]*RELEASED\s+([0-9A-Z]{26}):\s*(.+)$/i;
const FAILED_RE = /^[\s•>›⏺*-]*RELEASE\s+FAILED\s+([0-9A-Z]{26}):\s*(.+)$/i;
const SCAN_LINES = 80;
const seenLines = new Set<string>();

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

export function detectReleaseLines(agentId: string, output: string): number {
  const lines = stripAnsi(output).split('\n').slice(-SCAN_LINES);
  let n = 0;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const ok = line.match(RELEASED_RE);
    const bad = ok ? null : line.match(FAILED_RE);
    if (!ok && !bad) continue;
    const key = `${agentId}:${line}`;
    if (seenLines.has(key)) continue;
    seenLines.add(key);
    const id = (ok ?? bad)![1].toUpperCase();
    const rest = (ok ?? bad)![2].trim();
    const r = getRelease(id);
    if (!r) continue;
    if (r.deploy_agent_id && r.deploy_agent_id !== agentId) continue; // only the agent it was handed to may report
    const sha = rest.match(/\b[0-9a-f]{7,40}\b/)?.[0] ?? null;
    const version = rest.match(/\bv?(\d+\.\d+\.\d+(?:[-.][\w.]+)?)\b/)?.[1] ?? null;
    const res = reportRelease(id, ok
      ? { status: 'deployed', sha, version, note: rest, byAgentId: agentId }
      : { status: 'failed', note: rest, byAgentId: agentId });
    if (res.ok) n++;
    else logger.warn({ releaseId: id, line, error: res.error }, 'Release line rejected');
  }
  return n;
}

export function resetReleaseLinesForTest(): void {
  seenLines.clear();
}

// --- requester side: mirror the peer's outcome ---------------------------------------------------

const pollers = new Map<string, { stop: boolean }>();

function openForwarded(peer: string): ReleaseRequest[] {
  return withTable(() => getDb().prepare("SELECT * FROM release_requests WHERE origin = 'local' AND peer = ? AND status = 'sent' AND peer_request_id IS NOT NULL").all(peer) as ReleaseRequest[]);
}

export function ensureReleasePoller(peer: string): void {
  if (pollers.has(peer)) return;
  const handle = { stop: false };
  pollers.set(peer, handle);
  void pollLoop(peer, handle).finally(() => { if (pollers.get(peer) === handle) pollers.delete(peer); });
}

async function pollLoop(peer: string, handle: { stop: boolean }): Promise<void> {
  let cursor = 0;
  while (!handle.stop) {
    const open = openForwarded(peer);
    if (open.length === 0) return;
    // One round trip settles everything that already finished; the long poll waits for the rest.
    for (const r of open) { await mirrorOne(peer, r); if (handle.stop) return; }
    if (openForwarded(peer).length === 0) return;
    const events = await peerGetJson<{ events: Array<{ id: number; type: string; entity_id: string }>; last_id: number }>(
      peer, `/events/log?since=${cursor}&wait_ms=${POLL_WAIT_MS}&types=release.reported`,
    );
    if (handle.stop) return;
    if (!events.ok) {
      await new Promise((res) => setTimeout(res, pollIdleMs));
      continue;
    }
    cursor = events.data.last_id ?? cursor;
    const ids = new Set(events.data.events.map((e) => e.entity_id));
    for (const r of openForwarded(peer)) {
      if (r.peer_request_id && ids.has(r.peer_request_id)) await mirrorOne(peer, r);
      if (handle.stop) return;
    }
    if (ids.size === 0) await new Promise((res) => setTimeout(res, pollIdleMs)); // a fake/instant peer must not spin
  }
}

async function mirrorOne(peer: string, r: ReleaseRequest): Promise<void> {
  if (!r.peer_request_id) return;
  const remote = await peerGetJson<ReleaseRequest>(peer, `/releases/${r.peer_request_id}`);
  if (!remote.ok || !remote.data) return;
  if (!pollers.has(peer)) return; // stopped while the request was in flight
  const s = remote.data.status;
  if (s !== 'deployed' && s !== 'failed' && s !== 'rejected') return;
  patch(r.id, {
    status: s,
    version: remote.data.version ?? null,
    deployed_sha: remote.data.deployed_sha ?? null,
    report: remote.data.report ?? null,
    error: remote.data.error ?? null,
    deploy_agent_id: remote.data.deploy_agent_id ?? null,
    reported_at: remote.data.reported_at ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
  });
  const done = getRelease(r.id)!;
  emit('release.reported', 'release', done.id, {
    status: done.status, target: done.target, sha: done.sha, project: done.project, lane: done.lane, desk: done.desk,
    version: done.version, note: done.report, error: done.error, origin: 'local', peer, peer_request_id: r.peer_request_id, requested_by: done.requested_by, run_id: done.run_id,
  }, null);
  announce(done);
  logger.info({ releaseId: done.id, peer, status: done.status, version: done.version }, 'Release outcome mirrored from peer');
}

export function startReleasePollers(): void {
  const peers = withTable(() => getDb().prepare("SELECT DISTINCT peer FROM release_requests WHERE origin = 'local' AND status = 'sent' AND peer IS NOT NULL").all() as Array<{ peer: string }>);
  for (const { peer } of peers) ensureReleasePoller(peer);
}

export function stopReleasePollers(): void {
  for (const h of pollers.values()) h.stop = true;
  pollers.clear();
}
