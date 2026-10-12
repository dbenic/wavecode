/**
 * Releases as records, not chat.
 *
 * A person presses Stage or Promote on a freeze card (or the Release view). The
 * dev box posts a release request to the project's release peer (the deploy
 * box's WaveCode) over the peer API; that daemon stores it and either runs
 * `releases.staging_command` (staging, when configured) or hands it to its
 * deploy agent as one prompt (production, and staging when no command is set).
 * The agent reports back through the `report_release` MCP tool or by printing
 * `RELEASED <id>: …` / `RELEASE FAILED <id>: …`, which the pane watcher detects.
 * A staging command streams NDJSON progress onto the same record. The requester
 * polls the peer for `release.*` and mirrors the outcome, so the Release view
 * always shows what is on staging and in production.
 *
 * Both roles live in this one module: `requestRelease` (requester side),
 * `acceptRelease` + `reportRelease` (deploy side). A box with
 * `releases.deploy_agent` and no `release_peer` serves itself.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import { ulid } from 'ulid';
import { getConfig } from './config.js';
import { getAgent, getDb, resolveAgent, type Agent, type Result } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { notify } from './notifications.js';
import { peerGetJson, peerPostJson } from './peers.js';
import { getFreeze, staleStageBlock } from './release-freezes.js';
import { fillArgv, parseProgressLine } from './staging-progress.js';
import { needsGreenFull, needsGreenQuick, QUICK_CHECK_RUNNING } from './lane-status.js';
import { readLaneTests, shaChecks, suiteNames, testsConfigured } from './test-runs.js';
import { deliverSystemLine } from './wire-lines.js';

/** Returned to non-admins on every production-send path. */
export const PRODUCTION_RELEASE_ADMIN_ONLY = 'Forbidden: only an admin can send a production release';
/**
 * The peer token authenticates the requesting box. That box forwards the originating
 * user (name and role). This box accepts a production request only when the name is
 * on `releases.production_approvers`. An empty or unset list refuses everyone.
 */
export const PRODUCTION_RELEASE_ORIGIN_MISSING = 'Forbidden: a production release from a peer requires the originating user (name and role)';
export const PRODUCTION_RELEASE_NOT_APPROVER = 'Forbidden: the originating user is not in releases.production_approvers';
/** A developer may stage only after the reviewer's PASS on that exact SHA. */
export const STAGE_NEEDS_PASS = "Stage needs the reviewer's PASS on this exact SHA";
/** Deploy-side re-check when the freeze's gate is known and is not GREEN. */
export function stageNeedsGreen(gate: string): string {
  return `Stage needs a GREEN gate (this SHA is ${gate})`;
}

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
  /** staging only: who confirmed the feature works on staging, when, and a note */
  verified_by: string | null;
  verified_at: string | null;
  verification_note: string | null;
  /** staging command progress (schema v1). Null when the deploy agent handles the request. */
  deploy_id: string | null;
  progress_phase: string | null;
  progress_status: string | null;
  pin_until: string | null;
  staging_url: string | null;
  rollback_status: string | null;
  rollback_to: string | null;
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
  for (const col of [
    'verified_by TEXT', 'verified_at TEXT', 'verification_note TEXT',
    'deploy_id TEXT', 'progress_phase TEXT', 'progress_status TEXT',
    'pin_until TEXT', 'staging_url TEXT', 'rollback_status TEXT', 'rollback_to TEXT',
  ]) {
    try { getDb().exec(`ALTER TABLE release_requests ADD COLUMN ${col}`); } catch { /* exists */ }
  }
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS release_verifications (
      sha TEXT PRIMARY KEY,
      project TEXT,
      verified_by TEXT NOT NULL,
      verified_at TEXT NOT NULL DEFAULT (datetime('now')),
      note TEXT
    );
  `);
}

export interface Verification { sha: string; project: string | null; verified_by: string; verified_at: string; note: string | null }

export function verificationFor(sha: string): Verification | null {
  return withTable(() => (getDb().prepare('SELECT * FROM release_verifications WHERE sha = ?').get(sha) as Verification | undefined) ?? null);
}

/** Lane, desk and version already known for a SHA, so Ready for prod can name them. */
function readyForProdContext(sha: string): { version: string | null; lane: string | null; desk: string | null } {
  const staging = listReleases({ sha, target: 'staging', limit: 10 });
  const staged = staging.find((r) => r.version) ?? staging[0] ?? null;
  let freeze: { lane: string | null; desk: number | null } | null = null;
  try { freeze = getFreeze(sha); } catch { freeze = null; }
  return {
    version: staged?.version ?? null,
    lane: staged?.lane ?? freeze?.lane ?? null,
    desk: staged?.desk ?? (freeze?.desk != null ? String(freeze.desk) : null),
  };
}

/**
 * "Ready for prod" (verified on staging) for a SHA — a lane or a whole candidate — recorded with the person's name.
 * Developers and admins may record it. Independent of who staged it: Fable stages candidates on its own, so there may be no staging record.
 */
export function verifySha(sha: string, project: string | null, by: { name: string }, note: string | null): Result<Verification> {
  const clean = sha.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(clean)) return { ok: false, error: 'sha must be a commit id' };
  withTable(() => getDb().prepare(`INSERT INTO release_verifications (sha, project, verified_by, verified_at, note) VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(sha) DO UPDATE SET project = excluded.project, verified_by = excluded.verified_by, verified_at = excluded.verified_at, note = excluded.note`)
    .run(clean, project, by.name, note?.trim().slice(0, 1000) || null));
  const v = verificationFor(clean)!;
  for (const r of listReleases({ sha: clean, target: 'staging', limit: 5 })) patch(r.id, { verified_by: v.verified_by, verified_at: v.verified_at, verification_note: v.note });
  const where = readyForProdContext(clean);
  emit('release.verified', 'release', clean, {
    sha: clean, project, verified_by: by.name, note: v.note,
    version: where.version, lane: where.lane, desk: where.desk,
    wording: 'Ready for prod',
  });
  const body = [
    project,
    where.lane ? `lane ${where.lane}` : null,
    where.desk ? `Desk #${where.desk}` : null,
    `SHA ${clean}`,
    where.version ? `v${where.version}` : null,
    `by ${by.name}`,
  ].filter(Boolean).join(' · ');
  void notify({
    title: `Ready for prod${project ? `: ${project}` : ''} ${clean.slice(0, 8)}${where.version ? ` v${where.version}` : ''}`,
    body,
    url: '/release',
    tag: `ready-for-prod-${clean.slice(0, 12)}`,
  }).catch(() => {});
  return { ok: true, data: v };
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

function insert(row: Omit<ReleaseRequest, 'created_at' | 'updated_at' | 'reported_at' | 'verified_by' | 'verified_at' | 'verification_note' | 'deploy_id' | 'progress_phase' | 'progress_status' | 'pin_until' | 'staging_url' | 'rollback_status' | 'rollback_to'>): ReleaseRequest {
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
  /**
   * Production is sent only when the caller has already established the actor
   * is an admin. Staging ignores this.
   */
  actorIsAdmin?: boolean;
  /** Role of the person who pressed Promote. Forwarded with the name on a production peer request. */
  actorRole?: string | null;
  runId?: string | null;
  /** free text forwarded to the deployer (e.g. the lanes a candidate contains) */
  note?: string | null;
}

/**
 * Create a release request and forward it to the project's release peer (or
 * serve it locally when this box has the deploy agent itself).
 */
export async function requestRelease(opts: RequestReleaseOpts): Promise<Result<ReleaseRequest>> {
  if (!SHA_RE.test(opts.sha)) return { ok: false, error: 'sha must be the exact 40-character commit id' };
  if (!isTarget(opts.target)) return { ok: false, error: "target must be 'staging' or 'production'" };
  if (opts.target === 'production' && opts.actorIsAdmin !== true) return { ok: false, error: PRODUCTION_RELEASE_ADMIN_ONLY };
  try {
    const freeze = getFreeze(opts.sha);
    if (freeze && opts.target === 'staging') {
      const stale = staleStageBlock(freeze);
      if (stale) return { ok: false, error: stale };
    }
    if (freeze && opts.target === 'production') {
      const full = promoteFullBlock(freeze);
      if (full) return { ok: false, error: full };
    }
  } catch { /* freeze table unavailable: the deploy command still enforces its own gates */ }
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
      reviewer: opts.reviewer ?? null, requested_by: opts.actorName, requester_is_admin: opts.actorIsAdmin === true,
      // Production forwards the originating user. Staging bodies stay as they were.
      ...(opts.target === 'production' ? { requester_role: opts.actorRole ?? null } : {}),
      origin_id: id, origin_box: os.hostname(), note: opts.note ?? null,
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
  requested_by?: unknown; requester_role?: unknown; requester_is_admin?: unknown; origin_id?: unknown; origin_box?: unknown; note?: unknown;
}

function forwardedUser(body: IncomingRelease): { name: string | null; role: string | null } {
  const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  return { name: text(body.requested_by, 64), role: text(body.requester_role, 32) };
}

/**
 * Deploy-side gate for a production request that arrived from a peer.
 * The originating user is the forwarded name and role. Missing either refuses.
 * The name must be on `releases.production_approvers`; an empty or unset list refuses everyone.
 */
export function peerProductionAllowed(body: IncomingRelease): Result<true> {
  const { name, role } = forwardedUser(body);
  if (!name || !role) return { ok: false, error: PRODUCTION_RELEASE_ORIGIN_MISSING };
  const list = getConfig().releases?.production_approvers ?? [];
  const allowed = list.some((n) => n.trim().toLowerCase() === name.toLowerCase());
  if (!allowed) return { ok: false, error: PRODUCTION_RELEASE_NOT_APPROVER };
  return { ok: true, data: true };
}

/** A request from a peer box (or a local caller): store it and hand it to the deploy agent. */
export function acceptRelease(body: IncomingRelease, via: { userName: string; fromPeer: boolean }): Result<ReleaseRequest> {
  const sha = typeof body.sha === 'string' ? body.sha.trim().toLowerCase() : '';
  if (!SHA_RE.test(sha)) return { ok: false, error: 'sha must be the exact 40-character commit id' };
  if (!isTarget(body.target)) return { ok: false, error: "target must be 'staging' or 'production'" };
  // Before the idempotent open-request lookup, so a retry that drops the originating
  // user cannot fetch or refresh a production GO.
  if (body.target === 'production' && via.fromPeer) {
    const allowed = peerProductionAllowed(body);
    if (!allowed.ok) return allowed;
  }
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
    report: str(body.note, 2000),
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
    r.report && r.status === 'requested' ? `Note from the requester: ${r.report}` : null,
    'Gate the exact SHA per your runbook, assign the version, deploy, verify.',
    `When done, report with the report_release tool (id ${r.id}) or print exactly one line:`,
    `RELEASED ${r.id}: deployed <sha> version <x.y.z> to ${r.target}`,
    `or, if you could not: RELEASE FAILED ${r.id}: <why>`,
  ].filter(Boolean).join('\n');
}

function stagingCommand(): string[] | null {
  const cmd = getConfig().releases?.staging_command;
  return cmd && cmd.length > 0 ? cmd : null;
}

/**
 * Re-check the reviewer PASS and, when the freeze names one, a GREEN gate.
 * An unknown freeze is allowed: the staging command enforces the same gates.
 */
/**
 * Staging needs a green quick check or a green full run on the exact SHA,
 * read from the test-status JSON. With no test command, the freeze file's
 * own gate line is the fallback (a named non-GREEN still blocks).
 */
export function stageGateBlock(freeze: { project: string | null; sha: string; lane: string | null; gate: string | null }): string | null {
  if (testsConfigured(freeze.project) && freeze.project) {
    const checks = shaChecks(readLaneTests(freeze.project, freeze.lane ?? '', freeze.sha), freeze.sha, suiteNames(freeze.project));
    if (checks.quick === 'green' || checks.full === 'green') return null;
    if (checks.quick === 'pending') return QUICK_CHECK_RUNNING;
    return needsGreenQuick(freeze.sha.slice(0, 8));
  }
  if (freeze.gate && freeze.gate.toUpperCase() !== 'GREEN') return stageNeedsGreen(freeze.gate);
  return null;
}

/**
 * Production Promote needs a green full gate (`kind=gate` or a full suite)
 * on the exact SHA. A green quick check is not enough. With no test command,
 * a freeze that names a non-GREEN gate is refused; a missing gate is not.
 */
export function promoteFullBlock(freeze: { project: string | null; sha: string; lane: string | null; gate: string | null }): string | null {
  const sha8 = freeze.sha.slice(0, 8);
  if (testsConfigured(freeze.project) && freeze.project) {
    const checks = shaChecks(readLaneTests(freeze.project, freeze.lane ?? '', freeze.sha), freeze.sha, suiteNames(freeze.project));
    if (checks.full === 'green') return null;
    return needsGreenFull(sha8);
  }
  if (freeze.gate && freeze.gate.toUpperCase() !== 'GREEN') return needsGreenFull(sha8);
  return null;
}

function knownStagingBlock(row: ReleaseRequest): string | null {
  let freeze: ReturnType<typeof getFreeze> = null;
  try { freeze = getFreeze(row.sha); } catch { return null; }
  if (!freeze) return null;
  const stale = staleStageBlock(freeze);
  if (stale) return stale;
  if (freeze.verdict && freeze.verdict !== 'pass') return STAGE_NEEDS_PASS;
  return stageGateBlock(freeze);
}

interface StagingChild {
  child: ChildProcess;
  abandoned: boolean;
}

const stagingChildren = new Map<string, StagingChild>();

function applyProgress(id: string, raw: string): boolean {
  const line = parseProgressLine(raw);
  if (!line) return false;
  const row = getRelease(id);
  if (!row) return false;
  if (row.status === 'deployed' || row.status === 'failed' || row.status === 'rejected') {
    return line.phase === 'done' || line.phase === 'failed';
  }
  // Keep the phase that failed (build, verify, …) so the chip can name it.
  // Later rollback / failed lines still update pin, url, version and rollback.
  const heldFail = row.progress_status === 'fail'
    && !!row.progress_phase
    && row.progress_phase !== 'failed'
    && row.progress_phase !== 'done';
  const fields: Partial<ReleaseRequest> = { deploy_id: line.deploy_id };
  if (!heldFail) {
    fields.progress_phase = line.phase;
    fields.progress_status = line.status;
  }
  if (line.pin_until !== undefined) fields.pin_until = line.pin_until;
  if (line.url !== undefined) fields.staging_url = line.url;
  if (line.rollback_to !== undefined) fields.rollback_to = line.rollback_to;
  if (line.rollback_status !== undefined) fields.rollback_status = line.rollback_status;
  else if (line.phase === 'rollback' && (line.status === 'ok' || line.status === 'fail')) fields.rollback_status = line.status;
  if (line.version) fields.version = line.version;
  if (line.status === 'fail' && line.error) fields.error = `${line.error.code}: ${line.error.msg}`.slice(0, 1000);
  patch(id, fields);
  const updated = getRelease(id)!;
  emit('release.progress', 'release', id, {
    phase: updated.progress_phase, status: line.status, version: updated.version,
    pin_until: updated.pin_until, url: updated.staging_url, error: updated.error,
    rollback_status: updated.rollback_status, rollback_to: updated.rollback_to,
    sha: updated.sha, target: updated.target, deploy_id: updated.deploy_id, origin_id: updated.origin_id,
  }, null);
  if (line.status !== 'heartbeat') {
    logger.info({ releaseId: id, phase: line.phase, status: line.status, deployId: line.deploy_id }, 'Staging progress');
  }
  if (line.phase === 'done') {
    const sha = line.staging_sha && /^[0-9a-f]{40}$/i.test(line.staging_sha) ? line.staging_sha.toLowerCase() : null;
    reportRelease(id, { status: 'deployed', version: line.version ?? updated.version, sha, note: line.url ?? updated.staging_url });
    return getRelease(id)?.status === 'deployed';
  }
  if (line.phase === 'failed') {
    const msg = line.error ? `${line.error.code}: ${line.error.msg}` : (updated.error ?? 'staging deploy failed');
    reportRelease(id, { status: 'failed', version: line.version ?? updated.version, note: msg });
    return getRelease(id)?.status === 'failed';
  }
  return false;
}

function spawnStaging(row: ReleaseRequest, argv: string[]): void {
  if (stagingChildren.has(row.id) || argv.length === 0) return;
  let child: ChildProcess;
  try {
    child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    reportRelease(row.id, { status: 'failed', note: (err as Error).message });
    return;
  }
  const handle: StagingChild = { child, abandoned: false };
  stagingChildren.set(row.id, handle);
  let buf = '';
  let stderr = '';
  let sawTerminal = false;
  const take = (chunk: string) => {
    if (handle.abandoned) return;
    buf += chunk;
    const parts = buf.split(/\r?\n/);
    buf = parts.pop() ?? '';
    for (const part of parts) {
      try { if (applyProgress(row.id, part)) sawTerminal = true; } catch (err) {
        logger.warn({ releaseId: row.id, err: (err as Error).message }, 'Staging progress line failed');
      }
    }
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', take);
  child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000); });
  child.on('error', (err) => {
    if (stagingChildren.get(row.id) === handle) stagingChildren.delete(row.id);
    if (handle.abandoned) return;
    try {
      const current = getRelease(row.id);
      if (current && current.status !== 'deployed' && current.status !== 'failed' && current.status !== 'rejected') {
        reportRelease(row.id, { status: 'failed', note: err.message });
      }
    } catch { /* db already closed */ }
  });
  child.on('close', (code) => {
    if (stagingChildren.get(row.id) === handle) stagingChildren.delete(row.id);
    if (handle.abandoned) return;
    try {
      if (buf.trim()) {
        const rest = buf;
        buf = '';
        if (applyProgress(row.id, rest)) sawTerminal = true;
      }
      const current = getRelease(row.id);
      if (!current || current.status === 'deployed' || current.status === 'failed' || current.status === 'rejected') return;
      if (!sawTerminal) {
        reportRelease(row.id, { status: 'failed', note: stderr.trim().slice(-500) || `staging command exited ${code ?? 'null'}` });
      }
    } catch (err) {
      logger.warn({ releaseId: row.id, err: (err as Error).message }, 'Staging command close handler failed');
    }
  });
  logger.info({ releaseId: row.id, command: argv[0], sha: row.sha }, 'Staging deploy command started');
}

function failStaging(row: ReleaseRequest, error: string): Result<ReleaseRequest> {
  patch(row.id, { status: 'failed', error });
  emit('release.reported', 'release', row.id, { status: 'failed', target: row.target, sha: row.sha, project: row.project, error, origin_id: row.origin_id }, null);
  return { ok: false, error };
}

function startStagingCommand(row: ReleaseRequest): Result<ReleaseRequest> {
  const block = knownStagingBlock(row);
  if (block) return failStaging(row, block);
  const template = stagingCommand();
  if (!template) return failStaging(row, 'releases.staging_command is not configured');
  const argv = fillArgv(template, { sha: row.sha, lane: row.lane, desk: row.desk });
  if (argv.length === 0) return failStaging(row, 'releases.staging_command is empty');
  patch(row.id, { status: 'sent' });
  const sent = getRelease(row.id)!;
  emit('release.requested', 'release', row.id, {
    target: row.target, sha: row.sha, project: row.project, lane: row.lane, desk: row.desk,
    requested_by: row.requested_by, origin: row.origin, origin_id: row.origin_id, staging_command: true,
  }, null);
  spawnStaging(sent, argv);
  return { ok: true, data: sent };
}

/** Drop in-flight staging commands without marking their releases failed. */
export function stopStagingDeploys(): void {
  for (const [id, handle] of [...stagingChildren]) {
    handle.abandoned = true;
    stagingChildren.delete(id);
    try { handle.child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

/** After a restart, follow any staging deploy that already printed a deploy id. */
export function resumeStagingDeploys(): void {
  const watch = getConfig().releases?.staging_watch_command;
  if (!watch || watch.length === 0) return;
  let open: ReleaseRequest[] = [];
  try { open = listReleases({ target: 'staging', status: 'sent', limit: 50 }); } catch { return; }
  for (const row of open) {
    if (!row.deploy_id || stagingChildren.has(row.id)) continue;
    const argv = fillArgv(watch, { deploy_id: row.deploy_id, sha: row.sha, lane: row.lane, desk: row.desk });
    if (argv.length === 0) continue;
    spawnStaging(row, argv);
  }
}

function handToDeployAgent(row: ReleaseRequest): Result<ReleaseRequest> {
  if (row.target === 'staging' && stagingCommand()) return startStagingCommand(row);
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

/**
 * "Ready for prod": a developer or admin confirms the feature works on staging.
 * Recorded on the staging release record; the production decision reads it.
 */
export function verifyStaging(id: string, by: { name: string }, note: string | null): Result<ReleaseRequest> {
  const r = getRelease(id);
  if (!r) return { ok: false, error: `Release ${id} not found` };
  if (r.target !== 'staging') return { ok: false, error: 'Only a staging release can be marked verified' };
  if (r.status !== 'deployed') return { ok: false, error: `Staging ${r.sha.slice(0, 8)} is ${r.status}, not deployed — nothing to verify yet` };
  const v = verifySha(r.sha, r.project, by, note);
  if (!v.ok) return v;
  return { ok: true, data: getRelease(id)! };
}

export interface AuditEntry {
  at: string;
  who: string;
  action: 'stage' | 'promote' | 'verify' | 'reject' | 'deployed' | 'failed' | 'auto-stage';
  target: ReleaseTarget | null;
  sha: string | null;
  project: string | null;
  desk: string | null;
  detail: string | null;
  release_id: string | null;
  run_id: string | null;
}

/** Who did what to which lane, newest first: requests, verifications, rejects, and the deployer's outcomes. */
export function auditTrail(limit = 200): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const r of listReleases({ limit })) {
    const who = r.requested_by ?? 'unknown';
    out.push({ at: r.created_at, who, action: who === 'overlord' ? 'auto-stage' : r.target === 'production' ? 'promote' : 'stage', target: r.target, sha: r.sha, project: r.project, desk: r.desk, detail: r.lane ? `lane ${r.lane}` : null, release_id: r.id, run_id: r.run_id });
    if (r.reported_at && (r.status === 'deployed' || r.status === 'failed' || r.status === 'rejected')) {
      out.push({ at: r.reported_at, who: r.deploy_agent_id ? `deployer (${r.deploy_agent_id.slice(-6)})` : (r.peer ? `deployer via ${r.peer}` : 'deployer'), action: r.status === 'deployed' ? 'deployed' : 'failed', target: r.target, sha: r.sha, project: r.project, desk: r.desk, detail: r.status === 'deployed' ? (r.version ? `v${r.version}` : r.report) : (r.error ?? r.report), release_id: r.id, run_id: r.run_id });
    }
  }
  const verifications = withTable(() => getDb().prepare('SELECT * FROM release_verifications ORDER BY verified_at DESC LIMIT ?').all(limit) as Verification[]);
  for (const v of verifications) {
    const ctx = readyForProdContext(v.sha);
    const ready = 'Ready for prod';
    out.push({
      at: v.verified_at, who: v.verified_by, action: 'verify', target: 'staging', sha: v.sha, project: v.project,
      desk: ctx.desk, detail: [ready, ctx.lane ? `lane ${ctx.lane}` : null, ctx.version ? `v${ctx.version}` : null, v.note].filter(Boolean).join(' — '),
      release_id: null, run_id: null,
    });
  }
  const rejects = getDb().prepare(
    `SELECT e.created_at, e.entity_id AS run_id, e.payload_json, u.name AS user_name FROM events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.type = 'review.rejected' ORDER BY e.id DESC LIMIT ?`,
  ).all(limit) as Array<{ created_at: string; run_id: string; payload_json: string | null; user_name: string | null }>;
  for (const e of rejects) {
    let p: Record<string, unknown> = {};
    try { p = e.payload_json ? JSON.parse(e.payload_json) as Record<string, unknown> : {}; } catch { /* ignore */ }
    const fz = p.freeze && typeof p.freeze === 'object' ? p.freeze as Record<string, unknown> : null;
    if (!fz) continue; // only release freezes belong to this trail
    out.push({ at: e.created_at, who: e.user_name ?? 'owner', action: 'reject', target: null, sha: typeof fz.sha === 'string' ? fz.sha : null, project: typeof fz.project === 'string' ? fz.project : null, desk: fz.desk != null ? String(fz.desk) : null, detail: typeof p.reason === 'string' ? p.reason : null, release_id: null, run_id: e.run_id });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
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
      peer, `/events/log?since=${cursor}&wait_ms=${POLL_WAIT_MS}&types=release.*`,
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

function mirrorProgress(local: ReleaseRequest, remote: ReleaseRequest): void {
  const phase = remote.progress_phase;
  if (!phase) return;
  const same = phase === local.progress_phase
    && (remote.progress_status ?? null) === (local.progress_status ?? null)
    && (remote.deploy_id ?? null) === (local.deploy_id ?? null)
    && (remote.rollback_status ?? null) === (local.rollback_status ?? null);
  if (same) return;
  const fields: Partial<ReleaseRequest> = {
    deploy_id: remote.deploy_id ?? local.deploy_id,
    progress_phase: phase,
    progress_status: remote.progress_status ?? null,
  };
  if (Object.prototype.hasOwnProperty.call(remote, 'pin_until')) fields.pin_until = remote.pin_until ?? null;
  if (remote.staging_url) fields.staging_url = remote.staging_url;
  if (remote.rollback_status) fields.rollback_status = remote.rollback_status;
  if (remote.rollback_to) fields.rollback_to = remote.rollback_to;
  if (remote.version) fields.version = remote.version;
  if (remote.error) fields.error = remote.error;
  patch(local.id, fields);
  const updated = getRelease(local.id)!;
  emit('release.progress', 'release', local.id, {
    phase: updated.progress_phase, status: updated.progress_status, version: updated.version,
    pin_until: updated.pin_until, url: updated.staging_url, error: updated.error,
    rollback_status: updated.rollback_status, rollback_to: updated.rollback_to,
    sha: updated.sha, target: updated.target, deploy_id: updated.deploy_id, origin_id: updated.origin_id,
  }, null);
}

async function mirrorOne(peer: string, r: ReleaseRequest): Promise<void> {
  if (!r.peer_request_id) return;
  const remote = await peerGetJson<ReleaseRequest>(peer, `/releases/${r.peer_request_id}`);
  if (!remote.ok || !remote.data) return;
  if (!pollers.has(peer)) return; // stopped while the request was in flight
  const local = getRelease(r.id) ?? r;
  mirrorProgress(local, remote.data);
  const s = remote.data.status;
  if (s !== 'deployed' && s !== 'failed' && s !== 'rejected') return;
  const fresh = getRelease(r.id) ?? local;
  patch(r.id, {
    status: s,
    version: remote.data.version ?? fresh.version ?? null,
    deployed_sha: remote.data.deployed_sha ?? null,
    report: remote.data.report ?? null,
    error: remote.data.error ?? fresh.error ?? null,
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
  resumeStagingDeploys();
}

export function stopReleasePollers(): void {
  for (const h of pollers.values()) h.stop = true;
  pollers.clear();
  stopStagingDeploys();
}
