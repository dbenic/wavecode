/**
 * Merge queue for a project's main branch (docs/merge-queue.md). Approved by
 * Denis on 25 Oct 2026 for Wavepulse main only, stabilised by the brief of
 * 26 Oct 2026: WaveCode merges eligible lanes itself, serially, in a checkout
 * it owns. Agents still never push to main.
 *
 * Any lane not on the deny list is eligible when its freeze note names the
 * exact SHA, the freeze-time gate is green on that exact SHA, one reviewer who
 * is not the author and sits on a different credential profile than the
 * builder said PASS on that SHA, the remote lane still points at that SHA, and
 * any new migration is numbered after main's latest. An ask-tier lane also
 * needs Denis's OK label on its pull request; a hold label parks any lane. A
 * lane behind main is not refused: the queue merges main in and gates the
 * result. Every refusal carries one machine-readable code (`NO_PASS_ON_SHA`,
 * `GATE_NOT_GREEN`, ...) and what is missing.
 *
 * The queue then merges the lane onto the current main with `--no-ff`, runs
 * the full suite once on the result, pushes plainly, and tells the author and
 * the coordinating bot. Red or conflicting work bounces to the author. GitHub
 * is reached through `gh` with a server-side credential that is never logged;
 * when `gh auth status` fails the whole queue refuses with `GH_AUTH_MISSING`.
 * An eligible lane that waits longer than `stall_minutes` without progress
 * raises a stall file for the coordinating bot. Nothing here force-pushes,
 * squashes, stages, or touches production. The kill switch is the config flag
 * plus a runtime flag.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfig, type MergeQueueConfig, type MergeTier } from './config.js';
import { getAgent, getDb, listAgents, type Agent } from './db.js';
import { emit } from './event-bus.js';
import { gateOutcome, type ExecOptions } from './lane-pipeline.js';
import { changedFiles, laneAutomationDenied, mainSpec, projectRepo, resolveMainRef } from './lane-main.js';
import logger from './logger.js';
import { fireMainAdvanced } from './pipeline-hooks.js';
import { execFileAsync } from './proc.js';
import { freezeInboxDirs, getFreeze, listFreezes, listVerdicts, viewShaChecks, type FreezeVerdict, type ReleaseFreeze } from './release-freezes.js';
import { gateWordsFor, recordGateResult } from './gate-status.js';
import { samePerson } from './reviewer-assign.js';
import { freezeAgeMs, readLaneTests, readLaneTestsSparingly, testsConfigured } from './test-runs.js';
import { deliverSystemLine, tellDriverSeats } from './wire-lines.js';

export type QueueState = 'waiting' | 'queued' | 'merging' | 'merged' | 'bounced' | 'superseded';

export interface MergeQueueRow {
  sha: string;
  project: string;
  lane: string;
  tier: MergeTier | null;
  state: QueueState;
  reason: string | null;
  priority: number;
  eligible_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  merge_sha: string | null;
  pr: string | null;
  gate_runs: string | null;
  verdict_files: string | null;
  enabled_by: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface QueueSwitch {
  project: string;
  /** `pipeline.merge_queue.enabled` in config. */
  config_enabled: boolean;
  /** Config on and the runtime flag not off. */
  enabled: boolean;
  enabled_by: string | null;
  queued: number;
  /** When the queue last finished a pass over this project (ISO), from the kv heartbeat. */
  last_pass_at: string | null;
  /** Release mode: only these lanes (or `desk:<n>`) land; null = every eligible lane. */
  release_lanes: string[] | null;
}

/** One machine-readable reason per refusal; the row's `reason` starts with it. */
export type EligibilityCode =
  | 'NOT_CONFIGURED' | 'LANE_DENIED' | 'NO_REPO' | 'LANE_GONE' | 'LANE_MOVED' | 'GH_AUTH_MISSING'
  | 'GATE_NOT_GREEN' | 'NEEDS_FIXES' | 'NO_PASS_ON_SHA' | 'NO_PR' | 'MIGRATION_HOLD' | 'ASK_TIER_NO_OK'
  | 'MIGRATION_COLLISION' | 'QUEUE_OFF' | 'CHECK_FAILED' | 'STALLED_MERGE' | 'ALREADY_ON_MAIN' | 'RELEASE_MODE';

export interface Eligibility {
  state: 'waiting' | 'queued' | 'bounced' | 'superseded';
  code: EligibilityCode | null;
  /** `CODE: what is missing`, or null when queued. */
  reason: string | null;
  tier: MergeTier | null;
  pr: string | null;
  verdictFiles: string[];
}

export const MERGE_QUEUE_EVENT = {
  merged: 'merge_queue.merged',
  bounced: 'merge_queue.bounced',
  queued: 'merge_queue.queued',
  switch: 'merge_queue.switch',
  requeued: 'merge_queue.requeued',
  stall: 'merge_queue.stall',
  pass: 'merge_queue.pass',
  resolved: 'merge_queue.resolved',
  reset: 'merge_queue.reset',
  reused: 'merge_queue.review_reused',
} as const;

export interface QueueStall {
  project: string;
  code: EligibilityCode;
  text: string;
  at: string;
  file: string | null;
}

type ExecResult = { code: number; stdout: string };
/** Test hook: return a result to fake the command, or null to run it for real. */
let execForTest: ((argv: string[], opts: ExecOptions) => ExecResult | null) | null = null;
export function setMergeQueueExecForTest(fn: typeof execForTest): void { execForTest = fn; }

const inflight = new Map<string, Promise<void>>();
let recovered = false;

// --- storage ------------------------------------------------------------------

export function ensureMergeQueueTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS merge_queue (
      sha TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      lane TEXT NOT NULL,
      tier TEXT,
      state TEXT NOT NULL,
      reason TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      eligible_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      merge_sha TEXT,
      pr TEXT,
      gate_runs TEXT,
      verdict_files TEXT,
      enabled_by TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function withTable<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (!/no such table: merge_queue/.test((e as Error).message)) throw e;
    ensureMergeQueueTable();
    return fn();
  }
}

export function getQueueRow(sha: string): MergeQueueRow | null {
  return withTable(() => (getDb().prepare('SELECT * FROM merge_queue WHERE sha = ?').get(sha) as MergeQueueRow | undefined) ?? null);
}

export function listQueue(project?: string | null): MergeQueueRow[] {
  return withTable(() => (project
    ? getDb().prepare('SELECT * FROM merge_queue WHERE project = ? ORDER BY priority DESC, eligible_at, created_at').all(project)
    : getDb().prepare('SELECT * FROM merge_queue ORDER BY priority DESC, eligible_at, created_at').all()) as MergeQueueRow[]);
}

function upsert(row: Pick<MergeQueueRow, 'sha' | 'project' | 'lane'> & Partial<MergeQueueRow>): MergeQueueRow {
  return withTable(() => {
    const existing = getQueueRow(row.sha);
    if (!existing) {
      getDb().prepare(`INSERT INTO merge_queue (sha, project, lane, tier, state, reason, priority, eligible_at, pr, verdict_files)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.sha, row.project, row.lane, row.tier ?? null, row.state ?? 'waiting', row.reason ?? null, row.priority ?? 0,
          row.eligible_at ?? null, row.pr ?? null, row.verdict_files ?? null);
    } else {
      const patch: Record<string, unknown> = {};
      for (const key of ['lane', 'tier', 'state', 'reason', 'priority', 'eligible_at', 'started_at', 'finished_at', 'merge_sha', 'pr', 'gate_runs', 'verdict_files', 'enabled_by', 'attempts'] as const) {
        if (row[key] !== undefined) patch[key] = row[key];
      }
      const keys = Object.keys(patch);
      if (keys.length) {
        getDb().prepare(`UPDATE merge_queue SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE sha = ?`)
          .run(...keys.map((k) => patch[k]), row.sha);
      }
    }
    return getQueueRow(row.sha)!;
  });
}

export function setQueuePriority(sha: string, priority: number): MergeQueueRow | null {
  const row = getQueueRow(sha);
  if (!row) return null;
  return upsert({ sha, project: row.project, lane: row.lane, priority: Math.max(0, Math.min(9, Math.trunc(priority))) });
}

// --- switches -----------------------------------------------------------------

function mqConfig(project: string | null): MergeQueueConfig | null {
  if (!project) return null;
  const raw = getConfig().projects?.[project]?.pipeline?.merge_queue;
  return raw && typeof raw === 'object' ? raw : null;
}

function kvGet(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM kv_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch { return null; }
}

function kvSet(key: string, value: string): void {
  getDb().exec('CREATE TABLE IF NOT EXISTS kv_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  getDb().prepare('INSERT INTO kv_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function configuredProjects(): string[] {
  return Object.entries(getConfig().projects ?? {}).filter(([, p]) => p.pipeline?.merge_queue?.enabled === true).map(([name]) => name);
}

/** Config on and the runtime flag not off. The flag defaults to on when the config enables the queue. */
export function queueEnabled(project: string): boolean {
  if (mqConfig(project)?.enabled !== true) return false;
  return kvGet(`merge_queue.${project}`) !== 'off';
}

export function queueSwitch(project: string): QueueSwitch {
  const config_enabled = mqConfig(project)?.enabled === true;
  const queued = withTable(() => (getDb().prepare("SELECT COUNT(*) AS n FROM merge_queue WHERE project = ? AND state IN ('queued', 'merging')").get(project) as { n: number }).n);
  return { project, config_enabled, enabled: config_enabled && queueEnabled(project), enabled_by: kvGet(`merge_queue.${project}.by`), queued, last_pass_at: kvGet(`merge_queue.${project}.last_pass_at`), release_lanes: releaseLanes(project) };
}

/**
 * Release mode (27 Oct 2026 retro, cause 5): during a release only the named lanes land; every
 * other eligible lane waits with RELEASE_MODE instead of the whole queue being switched OFF and
 * the chosen fixes merged by hand. null = no release in progress. Lanes are branch names or
 * `desk:<n>` (every lane whose freeze carries that desk number).
 */
export function releaseLanes(project: string): string[] | null {
  const raw = kvGet(`merge_queue.${project}.release_lanes`);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : null;
  } catch { return null; }
}

export function setReleaseMode(project: string, lanes: string[] | null, who: string | null): QueueSwitch {
  const clean = lanes ? [...new Set(lanes.map((l) => l.trim().replace(/^origin\//, '')).filter(Boolean))] : null;
  if (clean && clean.length) kvSet(`merge_queue.${project}.release_lanes`, JSON.stringify(clean));
  else { try { getDb().prepare('DELETE FROM kv_settings WHERE key = ?').run(`merge_queue.${project}.release_lanes`); } catch { /* table absent: nothing stored */ } }
  emit(MERGE_QUEUE_EVENT.switch, 'project', project, { project, release_lanes: clean && clean.length ? clean : null, by: who }, null);
  return queueSwitch(project);
}

/** Does release mode let this lane land? `desk:<n>` entries match the freeze's desk number. */
export function laneInRelease(lanes: string[], freeze: Pick<ReleaseFreeze, 'lane' | 'desk'>): boolean {
  return lanes.some((l) => {
    const m = /^desk:(\d+)$/i.exec(l);
    if (m) return freeze.desk !== null && freeze.desk !== undefined && Number(m[1]) === freeze.desk;
    return !!freeze.lane && l === freeze.lane;
  });
}

/**
 * An admin puts one bounced lane back in front of the lane walk without a new freeze: for a
 * bounce that was the tool's, not the code's (26 Oct 2026: four lanes bounced "gate RED" on
 * the gateway's exit 5 after a GREEN RESULT). The row returns to waiting with the attempts
 * cleared; the next pass re-evaluates it and merges it like any other. The freeze must still
 * be live (open or behind main); otherwise the lane needs a new freeze.
 */
export function requeueBounced(sha: string, reason: string, by: string): { ok: true; row: MergeQueueRow } | { ok: false; error: string } {
  const row = getQueueRow(sha);
  if (!row) return { ok: false, error: 'Not in the merge queue' };
  if (row.state !== 'bounced') return { ok: false, error: `queue row is ${row.state}, not bounced` };
  const freeze = getFreeze(sha);
  if (!freeze || !['open', 'behind-main'].includes(freeze.status)) return { ok: false, error: `freeze is ${freeze?.status ?? 'gone'}; freeze the lane again instead` };
  const updated = upsert({ sha, project: row.project, lane: row.lane, state: 'waiting', reason: `REQUEUED by ${by}: ${reason}`.slice(0, 200), eligible_at: null, finished_at: null, attempts: 0 });
  emit(MERGE_QUEUE_EVENT.requeued, 'run', sha, { sha, project: row.project, lane: row.lane, reason, by, was: row.reason }, null);
  logger.info({ sha, lane: row.lane, by, reason, was: row.reason }, 'Merge queue: bounced lane requeued by an admin');
  return { ok: true, row: updated };
}

export interface ResolveOutcome { resolved: Array<{ sha: string; lane: string | null; status: 'stale' | 'merged' }>; skipped: Array<{ sha: string; why: string }> }

/**
 * The supported way to take lanes out of the queue in bulk (an admin, after a triage):
 * each freeze is closed (`stale` by default, `merged` when the work is on main some other
 * way) with the reason kept as its `superseded_by`, and its queue row turns superseded.
 * A freeze that is not open, not this project's, or not found is skipped with the reason.
 */
export function resolveQueueShas(project: string, shas: string[], reason: string, status: 'stale' | 'merged', by: string): ResolveOutcome {
  const out: ResolveOutcome = { resolved: [], skipped: [] };
  const seen = new Set<string>();
  for (const raw of shas) {
    const prefix = raw.trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(prefix)) { out.skipped.push({ sha: raw, why: 'not a SHA' }); continue; }
    const matches = getDb().prepare('SELECT sha FROM release_freezes WHERE sha LIKE ? LIMIT 2').all(`${prefix}%`) as Array<{ sha: string }>;
    if (matches.length !== 1) { out.skipped.push({ sha: raw, why: matches.length === 0 ? 'no freeze with this SHA' : 'ambiguous prefix' }); continue; }
    const sha = matches[0].sha;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const freeze = getFreeze(sha);
    if (!freeze) { out.skipped.push({ sha: raw, why: 'no freeze with this SHA' }); continue; }
    if (freeze.project !== project) { out.skipped.push({ sha: raw, why: `freeze belongs to ${freeze.project ?? 'no project'}` }); continue; }
    if (!['open', 'behind-main', 'rejected'].includes(freeze.status)) { out.skipped.push({ sha: raw, why: `freeze is already ${freeze.status}` }); continue; }
    const row = getQueueRow(sha);
    if (row && (row.state === 'merging' || row.state === 'merged')) { out.skipped.push({ sha: raw, why: `queue row is ${row.state}` }); continue; }
    getDb().prepare("UPDATE release_freezes SET status = ?, superseded_by = ?, updated_at = datetime('now') WHERE sha = ?").run(status, `resolved by ${by}: ${reason}`.slice(0, 200), sha);
    upsert({ sha, project, lane: freeze.lane ?? row?.lane ?? '?', state: 'superseded', reason: `freeze ${status}: ${reason}`.slice(0, 200), eligible_at: null, finished_at: new Date().toISOString() });
    emit(MERGE_QUEUE_EVENT.resolved, 'run', sha, { sha, project, lane: freeze.lane, status, reason, by }, null);
    out.resolved.push({ sha, lane: freeze.lane, status });
  }
  if (out.resolved.length) {
    logger.info({ project, by, status, reason, count: out.resolved.length }, 'Merge queue: lanes resolved in bulk');
    maestroLine(project, `resolved ${out.resolved.length} lane${out.resolved.length === 1 ? '' : 's'} as ${status} by ${by}: ${reason}`);
  }
  return out;
}

export interface ResetOutcome {
  project: string;
  reason: string;
  by: string;
  /** Every row that was waiting or bounced, now superseded; `freeze` says what happened to its freeze. */
  reset: Array<{ sha: string; lane: string | null; was: 'waiting' | 'bounced'; freeze: 'closed' | 'left' | 'none' }>;
  /** Rows the reset does not touch, by state (queued, merging, merged, superseded). */
  untouched: Record<string, number>;
}

/**
 * The queue reset, the supported way to start the list over: every row of the project that is
 * waiting or bounced turns superseded with the given reason, and its freeze, when still open
 * (open / behind-main / rejected), is closed as `stale` with the same reason so the lane can
 * refreeze. `states` narrows it to waiting or bounced rows only (default: both). Rows that are
 * queued, merging, merged or already superseded are not touched, no branch is touched, and the
 * history stays. One event for the whole reset, not one per row.
 */
export function resetQueue(project: string, reason: string, by: string, states: Array<'waiting' | 'bounced'>): ResetOutcome {
  const out: ResetOutcome = { project, reason, by, reset: [], untouched: {} };
  const wanted = states.filter((s) => s === 'waiting' || s === 'bounced');
  if (wanted.length === 0) return out;
  const rows = withTable(() => getDb().prepare(`SELECT * FROM merge_queue WHERE project = ? AND state IN (${wanted.map(() => '?').join(', ')}) ORDER BY created_at`).all(project, ...wanted)) as MergeQueueRow[];
  const closeFreeze = getDb().prepare("UPDATE release_freezes SET status = 'stale', superseded_by = ?, updated_at = datetime('now') WHERE sha = ?");
  const now = new Date().toISOString();
  getDb().transaction(() => {
    for (const row of rows) {
      const freeze = getFreeze(row.sha);
      let freezeOutcome: 'closed' | 'left' | 'none' = 'none';
      if (freeze && ['open', 'behind-main', 'rejected'].includes(freeze.status)) {
        closeFreeze.run(`queue reset by ${by}: ${reason}`.slice(0, 200), row.sha);
        freezeOutcome = 'closed';
      } else if (freeze) {
        freezeOutcome = 'left';
      }
      upsert({ sha: row.sha, project, lane: row.lane, state: 'superseded', reason: reason.slice(0, 200), eligible_at: null, finished_at: now });
      out.reset.push({ sha: row.sha, lane: row.lane, was: row.state as 'waiting' | 'bounced', freeze: freezeOutcome });
    }
  })();
  for (const r of withTable(() => getDb().prepare("SELECT state, COUNT(*) AS n FROM merge_queue WHERE project = ? AND state <> 'superseded' GROUP BY state").all(project)) as Array<{ state: string; n: number }>) {
    out.untouched[r.state] = r.n;
  }
  const closed = out.reset.filter((r) => r.freeze === 'closed').length;
  emit(MERGE_QUEUE_EVENT.reset, 'project', project, { project, reason, by, states: wanted, count: out.reset.length, freezes_closed: closed, shas: out.reset.map((r) => r.sha) }, null);
  logger.info({ project, by, reason, count: out.reset.length, freezes_closed: closed, untouched: out.untouched }, 'Merge queue: reset');
  if (out.reset.length) maestroLine(project, `queue reset by ${by}: ${out.reset.length} lane${out.reset.length === 1 ? '' : 's'} superseded, ${closed} freeze${closed === 1 ? '' : 's'} closed — ${reason}`);
  return out;
}

/** The stall the last pass found for the project, or null when it is moving. */
export function queueStall(project: string): QueueStall | null {
  const raw = kvGet(`merge_queue.${project}.stall`);
  if (!raw) return null;
  try { return JSON.parse(raw) as QueueStall; } catch { return null; }
}

/** The kill switch. Who flipped it is kept for the audit row of every later merge. */
export function setQueueSwitch(project: string, enabled: boolean, who: string | null): QueueSwitch {
  kvSet(`merge_queue.${project}`, enabled ? 'on' : 'off');
  kvSet(`merge_queue.${project}.by`, who ?? 'unknown');
  emit(MERGE_QUEUE_EVENT.switch, 'project', project, { project, enabled, by: who }, null);
  return queueSwitch(project);
}

// --- tiers -------------------------------------------------------------------

const TIER_RE = /^\s*(?:[-*>]\s*)?\**\s*TIER\s*\**\s*[:：]\s*\**\s*(ship|show|ask)\b/im;

export function tierFromNote(text: string | null): MergeTier | null {
  if (!text) return null;
  const m = text.match(TIER_RE);
  return m ? (m[1].toLowerCase() as MergeTier) : null;
}

function globRe(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, '').replace(/\/+$/, '');
  const leading = g.startsWith('**/') ? '(?:.*/)?' : '';
  if (leading) g = g.slice(3);
  const wild = /[*?]/.test(g);
  const body = g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  // A plain path names a file or a directory; a glob matches exactly what it says.
  return new RegExp(`^${leading}${body}${wild ? '' : '(?:/.*)?'}$`);
}

/** Files under an `ask_paths` glob or the migrations directory raise the tier to `ask`. */
export function askPathHit(files: string[], asks: string[], migrationsDir: string | null | undefined): string | null {
  const globs = [...asks, ...(migrationsDir ? [migrationsDir] : [])].filter((g) => g && g.trim());
  const res = globs.map((g) => ({ g, re: globRe(g) }));
  for (const file of files) {
    const hit = res.find(({ re }) => re.test(file));
    if (hit) return file;
  }
  return null;
}

export function tierFor(note: string | null, files: string[], cfg: MergeQueueConfig, migrationsDir: string | null | undefined): { tier: MergeTier | null; forced: string | null } {
  const forced = askPathHit(files, cfg.ask_paths ?? [], migrationsDir);
  if (forced) return { tier: 'ask', forced };
  // No TIER line is no reason to wait: the lane is `show` unless config says otherwise.
  return { tier: tierFromNote(note) ?? cfg.default_tier ?? 'show', forced: null };
}

// --- lanes ---------------------------------------------------------------------

export const DEFAULT_DENY_LANES = ['main', 'master', 'release/*', 'prod-*'];

/**
 * There is no allowlist: any branch may queue unless it is on the deny list
 * (the project's main branch, `merge_queue.deny_lanes`, default main, master,
 * release/*, prod-*) or denied for automation in config.
 */
export function laneDeniedWhy(project: string, lane: string, cfg: MergeQueueConfig): string | null {
  if (!laneRefErrorFree(lane)) return `${lane} is not a safe branch name`;
  const mainBranch = getConfig().projects?.[project]?.main_branch?.trim() || 'main';
  const globs = [mainBranch, 'HEAD', ...(cfg.deny_lanes ?? DEFAULT_DENY_LANES)];
  const hit = globs.find((g) => g.trim() && globRe(g).test(lane));
  if (hit) return `${lane} is on the deny list (${hit})`;
  if (laneAutomationDenied(project, null, lane)) return `${lane} is denied for automation in config`;
  return null;
}

// --- reviews -----------------------------------------------------------------

function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * One independent PASS on the exact SHA: a reviewer who is not the author and not
 * the same person or credential profile as the builder, by the picker's own rule
 * (`samePerson`: name stems such as ales-claude1/ales-claude2 count as one person;
 * a `pipeline.service_profiles` profile is a shared pool whose seats are
 * independent of each other). Every tier needs it; the ask tier adds Denis's OK
 * label on the pull request.
 */
export function independentPasses(
  verdicts: FreezeVerdict[],
  author: { id: string | null; name: string | null; alias?: string | null; profile: string | null },
  serviceProfiles: string[] = [],
): { ok: boolean; passes: FreezeVerdict[]; why: string | null } {
  const own = (v: FreezeVerdict) => sameName(v.reviewer_name, author.name) || (!!author.id && v.reviewer_agent_id === author.id);
  const allPasses = verdicts.filter((v) => v.verdict === 'pass' && !own(v));
  const builder = { name: author.name ?? '', alias: author.alias ?? null, profile: author.profile ?? 'home' };
  const passes = allPasses.filter((v) => !samePerson(builder, { name: v.reviewer_name, profile: v.profile ?? 'home' }, serviceProfiles));
  if (passes.length > 0) return { ok: true, passes, why: null };
  const same = allPasses.map((v) => `@${v.reviewer_name}`).join(', ');
  const why = same
    ? `needs one PASS from a reviewer who is not the builder's own person or profile (${same}: same as @${author.name ?? '?'}${author.profile ? ` on ${author.profile}` : ''})`
    : 'needs one PASS verdict on this exact SHA from a reviewer who is not the author';
  return { ok: false, passes, why };
}

/**
 * `git patch-id --stable` of the lane's own change against its merge-base with main: the same
 * for two SHAs when the lane only merged main between them. Empty when the lane changes nothing.
 */
async function patchIdOf(repo: string, mainRef: string, sha: string): Promise<string | null> {
  const cached = kvGet(`patchid:${sha.toLowerCase()}`);
  if (cached !== null) return cached;
  const base = await tryGit(repo, ['merge-base', mainRef, sha]);
  if (!base) return null;
  const diff = await tryGit(repo, ['diff', '--no-color', '--no-ext-diff', base, sha], 60_000);
  if (diff === null) return null;
  let id = '';
  if (diff.trim()) {
    try {
      const out = await execFileAsync('git', ['-C', repo, 'patch-id', '--stable'], { input: diff, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
      id = out.trim().split(/\s+/)[0] ?? '';
    } catch { return null; }
  }
  kvSet(`patchid:${sha.toLowerCase()}`, id);
  return id;
}

/**
 * The NEEDS FIXES / REJECT verdicts still standing on this exact SHA. The ledger keeps one row per
 * (SHA, reviewer), so a reviewer's later verdict on the same SHA replaces their earlier one; a PASS
 * from someone else does not. Any standing NEEDS FIXES blocks the merge (31 Oct 2026: 75f1d4fe was
 * merged on one PASS while codex8's NEEDS FIXES on that frozen SHA was on file).
 */
export function standingNeedsFixes(verdicts: FreezeVerdict[]): FreezeVerdict[] {
  const latest = new Map<string, FreezeVerdict>();
  for (const v of verdicts) {
    const key = v.reviewer_name.toLowerCase();
    const prev = latest.get(key);
    if (!prev || Date.parse(`${v.created_at.replace(' ', 'T')}Z`) >= Date.parse(`${prev.created_at.replace(' ', 'T')}Z`)) latest.set(key, v);
  }
  return [...latest.values()].filter((v) => v.verdict === 'needs-fixes' || v.verdict === 'reject');
}

/** Why this freeze must not merge, or null. The summary and the per-reviewer ledger both count. */
function needsFixesReason(freeze: ReleaseFreeze): string | null {
  if (freeze.verdict === 'needs-fixes' || freeze.verdict === 'reject') {
    return `reviewer @${freeze.reviewer_name ?? '?'} said ${freeze.verdict === 'reject' ? 'REJECT' : 'NEEDS FIXES'}; fix, push and freeze a new SHA`;
  }
  const standing = standingNeedsFixes(listVerdicts(freeze.sha));
  if (standing.length === 0) return null;
  const who = standing.map((v) => `@${v.reviewer_name} ${v.verdict === 'reject' ? 'REJECT' : 'NEEDS FIXES'}`).join(', ');
  return `${who} on ${freeze.sha.slice(0, 8)} still stands; a PASS from another reviewer does not clear it. The same reviewer re-verdicts this SHA, or fix, push and freeze a new SHA`;
}

interface CarriedReview { donor: string; patchId: string; passes: FreezeVerdict[]; full: string }

/**
 * An earlier freeze on the same lane, by the same author, with the same patch-id and an
 * independent PASS: its review (and its api GREEN) carries over to this SHA. Newest first.
 */
async function reviewCarriedOver(repo: string, mainRef: string, freeze: ReleaseFreeze): Promise<CarriedReview | null> {
  if (!freeze.project || !freeze.lane) return null;
  const mine = await patchIdOf(repo, mainRef, freeze.sha);
  if (!mine) return null;
  const author = authorFor(freeze);
  const who = { id: freeze.author_agent_id ?? author?.id ?? null, name: freeze.author_name ?? author?.name ?? null, alias: author?.alias ?? null, profile: author?.profile ?? null };
  const service = getConfig().projects?.[freeze.project]?.pipeline?.service_profiles ?? [];
  const mineAt = Date.parse(`${freeze.created_at.replace(' ', 'T')}Z`);
  for (const other of listFreezes()) {
    if (other.sha.toLowerCase() === freeze.sha.toLowerCase() || other.project !== freeze.project || other.lane !== freeze.lane) continue;
    if (other.author_name && freeze.author_name && other.author_name.toLowerCase() !== freeze.author_name.toLowerCase()) continue;
    const at = Date.parse(`${other.created_at.replace(' ', 'T')}Z`);
    if (Number.isFinite(at) && Number.isFinite(mineAt) && at > mineAt) continue;
    if (other.verdict === 'needs-fixes' || other.verdict === 'reject') continue;
    if (standingNeedsFixes(listVerdicts(other.sha)).length > 0) continue;
    const passed = independentPasses(verdictsFor(other), who, service);
    if (!passed.ok) continue;
    if ((await patchIdOf(repo, mainRef, other.sha)) !== mine) continue;
    const gates = await gateWords(other).catch(() => ({ quick: 'missing', full: 'missing' }));
    return { donor: other.sha, patchId: mine, passes: passed.passes, full: gates.full };
  }
  return null;
}

function reusedNoted(sha: string): boolean {
  try {
    const row = getDb().prepare('SELECT id FROM events WHERE type = ? AND entity_id = ? LIMIT 1').get(MERGE_QUEUE_EVENT.reused, sha) as { id: number } | undefined;
    return !!row;
  } catch { return false; }
}

/** The freeze's own verdict line counts when the ledger has no row for it (notes ingested before the ledger existed). */
function verdictsFor(freeze: ReleaseFreeze): FreezeVerdict[] {
  const rows = listVerdicts(freeze.sha);
  if (rows.length > 0 || freeze.verdict !== 'pass' || !freeze.reviewer_name) return rows;
  const reviewer = (freeze.reviewer_agent_id ? getAgent(freeze.reviewer_agent_id) : null);
  const name = freeze.reviewer_name.toLowerCase();
  const agent = reviewer?.ok ? reviewer.data : listAgents().find((a) => a.name.toLowerCase() === name || (a.alias ?? '').toLowerCase() === name) ?? null;
  return [{
    sha: freeze.sha, reviewer_agent_id: agent?.id ?? null, reviewer_name: freeze.reviewer_name, profile: agent?.profile ?? null,
    verdict: 'pass', path: freeze.verdict_path ?? null, created_at: freeze.created_at,
  }];
}

/**
 * When the lane already contains main, the merge commit's tree is the lane's own tree, and
 * that tree is what the lane's quick and api gates ran on: a tier1 run on the merge result
 * proves nothing new and costs a gate slot. Returns the gate note for the merged row, or
 * null when the merge gate must run (main moved, a version bump changed the tree, or a gate
 * is not GREEN on the lane SHA). Never applies to a lane that needed a real merge.
 */
async function mergeGateSkip(dir: string, laneSha: string, mainBefore: string, mergeSha: string, freeze: ReleaseFreeze, branch: string): Promise<string | null> {
  if ((await tryGit(dir, ['merge-base', '--is-ancestor', mainBefore, laneSha])) === null) return null;
  const [mergeTree, laneTree] = await Promise.all([tryGit(dir, ['rev-parse', `${mergeSha}^{tree}`]), tryGit(dir, ['rev-parse', `${laneSha}^{tree}`])]);
  if (!mergeTree || mergeTree !== laneTree) return null;
  const gates = await gateWords(freeze);
  if (gates.quick !== 'green' || gates.full !== 'green') return null;
  return `merge gate skipped: ${laneSha.slice(0, 8)} already contains ${branch} and its quick and api gates are GREEN on that tree`;
}

// --- git ---------------------------------------------------------------------

async function git(repo: string, args: string[], timeout = 20000): Promise<string> {
  const out = await execFileAsync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', '-c', 'user.name=wavecode', '-c', 'user.email=wavecode@localhost', ...args], {
    timeout, maxBuffer: 8 * 1024 * 1024,
  });
  return out.trim();
}

/**
 * The text of why there is nothing to merge, or null when the lane still carries work:
 * the SHA is an ancestor of main, or `git cherry` finds an equivalent on main for every
 * lane commit (an unknown answer counts as "still work", never as done).
 */
export async function alreadyOnMain(repo: string, sha: string, mainRef: string): Promise<string | null> {
  const ancestor = await runArgv(['git', '-C', repo, 'merge-base', '--is-ancestor', sha, mainRef], { timeoutMs: 20000 });
  if (ancestor.code === 0) return `${sha.slice(0, 8)} is already in ${mainRef.replace(/^refs\/remotes\//, '')}`;
  if (ancestor.code !== 1) return null;
  const cherry = await tryGit(repo, ['cherry', mainRef, sha]);
  if (cherry === null) return null;
  const lines = cherry.split('\n').map((l) => l.trim()).filter(Boolean);
  // `git cherry` skips merge commits: an empty answer means the lane's own commits are all in
  // main and its tip is only a merge of main (the usual shape of a lane merged some other way).
  if (lines.length === 0) return `${sha.slice(0, 8)} has no commits of its own beyond ${mainRef.replace(/^refs\/remotes\//, '')} (only merges)`;
  if (lines.every((l) => l.startsWith('-'))) return `all ${lines.length} commit${lines.length === 1 ? '' : 's'} of the lane already have equivalents in ${mainRef.replace(/^refs\/remotes\//, '')} (the merge would be empty)`;
  // Different commits, same content: a clean merge whose tree equals main's changes nothing.
  const merged = await runArgv(['git', '-C', repo, 'merge-tree', '--write-tree', '--no-messages', mainRef, sha], { timeoutMs: 30000 });
  if (merged.code !== 0) return null;
  const mainTree = await tryGit(repo, ['rev-parse', `${mainRef}^{tree}`]);
  if (mainTree && merged.stdout.trim() === mainTree) return `merging ${sha.slice(0, 8)} into ${mainRef.replace(/^refs\/remotes\//, '')} would change nothing (its changes are already there)`;
  return null;
}

async function tryGit(repo: string, args: string[], timeout = 20000): Promise<string | null> {
  try { return await git(repo, args, timeout); } catch { return null; }
}

async function runArgv(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  if (argv.length === 0) return { code: 1, stdout: '' };
  if (execForTest) {
    const faked = execForTest(argv, opts);
    if (faked) return faked;
  }
  try {
    const stdout = await execFileAsync(argv[0], argv.slice(1), {
      timeout: opts.timeoutMs ?? 20000,
      maxBuffer: 8 * 1024 * 1024,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { status?: number | null; code?: number | string | null; stdout?: string };
    const code = typeof err.status === 'number' ? err.status : typeof err.code === 'number' ? err.code : 1;
    return { code, stdout: String(err.stdout ?? '') };
  }
}

function fill(template: string[], vars: Record<string, string>): string[] {
  return template.map((arg) => arg.replace(/\{(workspace|lane|sha|remote|project|checkout)\}/g, (_, key: string) => vars[key] ?? ''));
}

/** The remote lane tip, after a fetch. Null when the lane is not on the remote. */
/** Inside one refresh pass a single `ls-remote --heads` answers every lane. */
let headsScope: Map<string, Map<string, string> | null> | null = null;

async function remoteHeads(repo: string, remote: string): Promise<Map<string, string> | null> {
  const key = `${repo}\0${remote}`;
  if (headsScope?.has(key)) return headsScope.get(key)!;
  const out = await tryGit(repo, ['ls-remote', '--heads', remote], 60000);
  let heads: Map<string, string> | null = null;
  if (out !== null) {
    heads = new Map();
    for (const line of out.split('\n')) {
      const m = line.match(/^([0-9a-f]{40})\s+refs\/heads\/(.+)$/i);
      if (m) heads.set(m[2], m[1].toLowerCase());
    }
  }
  headsScope?.set(key, heads);
  return heads;
}

/**
 * The lane's tip on the remote. The lane is fetched only when its tip is the frozen
 * SHA and the objects are missing: a pass over hundreds of lanes used to be one
 * `git fetch` per lane.
 */
async function remoteTip(repo: string, remote: string, lane: string, want: string): Promise<string | null> {
  if (laneRefErrorFree(lane) === false) return null;
  const heads = await remoteHeads(repo, remote);
  if (!heads) return null;
  const sha = heads.get(lane) ?? null;
  if (sha && sha === want.toLowerCase() && (await tryGit(repo, ['cat-file', '-e', `${sha}^{commit}`])) === null) {
    await tryGit(repo, ['fetch', '--quiet', remote, lane], 60000);
  }
  return sha;
}

function laneRefErrorFree(lane: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/.test(lane);
}

// --- pull requests and GitHub ------------------------------------------------------

interface PrItem {
  number?: number | string; head?: string; headRefOid?: string; sha?: string; branch?: string; headRefName?: string; state?: string;
  labels?: Array<string | { name?: string }>;
}

export interface PrMatch { number: string; labels: string[] }

function parsePrs(json: string): PrItem[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed as PrItem[] : [];
  } catch { return []; }
}

function matchPr(items: PrItem[], sha: string, lane: string): PrMatch | null {
  const open = items.filter((it) => !it.state || /^open$/i.test(String(it.state)));
  const bySha = open.find((it) => [it.head, it.headRefOid, it.sha].some((s) => typeof s === 'string' && s.toLowerCase() === sha.toLowerCase()));
  const byLane = open.find((it) => [it.branch, it.headRefName].some((b) => typeof b === 'string' && b === lane));
  const hit = bySha ?? byLane;
  if (hit?.number === undefined) return null;
  const labels = (hit.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name ?? '')).filter(Boolean);
  return { number: `#${hit.number}`, labels };
}

export function prFromList(json: string, sha: string, lane: string): PrMatch | null {
  return matchPr(parsePrs(json), sha, lane);
}

interface GithubPass { ok: boolean; error: string | null; prs: PrItem[] | null }

/** Inside one refresh pass GitHub is asked once per project. */
let ghScope: Map<string, Promise<GithubPass>> | null = null;
const ghAuthOkUntil = new Map<string, number>();
const GH_AUTH_TTL_MS = 5 * 60_000;

function readTokenFile(file: string): string | null {
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    return token || null;
  } catch { return null; }
}

/**
 * `gh auth status` with the server-side credential, then the open pull requests
 * with their labels. The token leaves this function only as `GH_TOKEN` in the
 * child's environment: never in a log line, an event or a row.
 */
async function githubPass(project: string, cfg: MergeQueueConfig): Promise<GithubPass> {
  const gh = cfg.github;
  if (!gh) return { ok: true, error: null, prs: null };
  const run = async (): Promise<GithubPass> => {
    let env: Record<string, string> | undefined;
    if (gh.token_file) {
      const token = readTokenFile(gh.token_file);
      if (!token) return { ok: false, error: `GitHub token file ${gh.token_file} is missing or empty; SystemOps stores the credential there (contents and pull_requests on ${gh.repo}; the queue posts no check runs)`, prs: null };
      env = { GH_TOKEN: token };
    }
    const now = Date.now();
    if ((ghAuthOkUntil.get(project) ?? 0) < now) {
      const status = await runArgv(['gh', 'auth', 'status', '--hostname', 'github.com'], { env, timeoutMs: 30000 });
      if (status.code !== 0) {
        ghAuthOkUntil.delete(project);
        return { ok: false, error: `gh auth status failed (exit ${status.code}); ${gh.token_file ? `check the token in ${gh.token_file}` : 'log gh in as the service user'}`, prs: null };
      }
      ghAuthOkUntil.set(project, now + GH_AUTH_TTL_MS);
    }
    const list = await runArgv(['gh', 'pr', 'list', '--repo', gh.repo, '--state', 'open', '--json', 'number,headRefName,headRefOid,labels', '--limit', '200'], { env, timeoutMs: 60000 });
    if (list.code !== 0) {
      ghAuthOkUntil.delete(project);
      return { ok: false, error: `gh pr list for ${gh.repo} failed (exit ${list.code})`, prs: null };
    }
    return { ok: true, error: null, prs: parsePrs(list.stdout) };
  };
  if (!ghScope) return run();
  let pending = ghScope.get(project);
  if (!pending) { pending = run(); ghScope.set(project, pending); }
  return pending;
}

async function findPr(repo: string, remote: string, sha: string, lane: string, cfg: MergeQueueConfig, github: GithubPass): Promise<PrMatch | null> {
  if (github.prs) return matchPr(github.prs, sha, lane);
  if (cfg.pr_list_command?.length) {
    const result = await runArgv(fill(cfg.pr_list_command, { lane, sha, remote }), { cwd: repo, timeoutMs: 30000 });
    if (result.code !== 0) return null;
    return prFromList(result.stdout, sha, lane);
  }
  const refs = await tryGit(repo, ['ls-remote', remote, 'refs/pull/*/head'], 60000);
  if (!refs) return null;
  for (const line of refs.split('\n')) {
    const m = line.match(/^([0-9a-f]{40})\s+refs\/pull\/(\d+)\/head$/i);
    if (m && m[1].toLowerCase() === sha.toLowerCase()) return { number: `#${m[2]}`, labels: [] };
  }
  return null;
}

export const DEFAULT_OK_LABEL = 'ask-tier-approved';
export const DEFAULT_HOLD_LABELS = ['migration-hold', 'do-not-merge'];

// --- migrations ----------------------------------------------------------------

const MIGRATION_NUMBER_RE = /^(\d{3,})[_-]/;

/**
 * New migrations in the lane must be numbered above main's latest and not
 * collide with each other. Returns the problem, or null.
 */
export function migrationCollision(mainFiles: string[], laneAdded: string[]): string | null {
  const num = (file: string) => { const m = path.basename(file).match(MIGRATION_NUMBER_RE); return m ? Number(m[1]) : null; };
  const mainMax = Math.max(-1, ...mainFiles.map(num).filter((n): n is number => n !== null));
  const seen = new Map<number, string>();
  for (const file of laneAdded) {
    const n = num(file);
    if (n === null) continue;
    if (n <= mainMax) {
      const latest = String(mainMax).padStart(4, '0');
      const next = String(mainMax + 1).padStart(4, '0');
      // 28 Oct 2026: seats renumbered one file at a time and refroze after each bounce (7 freezes in
      // 40 min on one lane), so the message says the number to use and that it is done once.
      return `migration ${path.basename(file)} is not numbered after main's latest (${latest}): merge main into the lane first, then renumber the lane's migrations once so they start at ${next}`;
    }
    const dup = seen.get(n);
    if (dup) return `migrations ${path.basename(dup)} and ${path.basename(file)} share a number`;
    seen.set(n, file);
  }
  return null;
}

async function migrationProblem(repo: string, mainRef: string, sha: string, dir: string | null | undefined): Promise<string | null> {
  if (!dir) return null;
  const base = await tryGit(repo, ['merge-base', mainRef, sha]);
  if (!base) return null;
  const added = (await tryGit(repo, ['diff', '--name-only', '--diff-filter=A', base, sha, '--', dir]))?.split('\n').map((l) => l.trim()).filter(Boolean) ?? [];
  if (added.length === 0) return null;
  const onMain = (await tryGit(repo, ['ls-tree', '--name-only', mainRef, `${dir.replace(/\/$/, '')}/`]))?.split('\n').map((l) => l.trim()).filter(Boolean) ?? [];
  return migrationCollision(onMain, added);
}

// --- eligibility ---------------------------------------------------------------

function readNote(file: string | null): string | null {
  if (!file) return null;
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

async function gateWords(freeze: ReleaseFreeze): Promise<{ quick: string; full: string }> {
  // The one checker (gate-status.ts) decides; the freeze note and the stored column are read only
  // where it finds nothing, so notes written before the checker existed still count during rollout.
  const checked = await gateWordsFor(freeze).catch(() => null);
  if (checked && checked.quick !== 'missing' && checked.full !== 'missing') return { quick: checked.quick, full: checked.full };
  const runs = freeze.project && testsConfigured(freeze.project)
    ? (await readLaneTestsSparingly(freeze, { settled: false, pending: false }).catch(() => null)) ?? []
    : undefined;
  const view = await viewShaChecks(freeze, runs);
  return {
    quick: checked && checked.quick !== 'missing' ? checked.quick : view.quick,
    full: checked && checked.full !== 'missing' ? checked.full : view.full,
  };
}

/** Why a freeze is not merged yet, or `queued` when everything is in. Pure of side effects besides git fetches. */
export async function evaluate(freeze: ReleaseFreeze): Promise<Eligibility> {
  const none: Eligibility = { state: 'waiting', code: null, reason: null, tier: null, pr: null, verdictFiles: [] };
  const no = (base: Eligibility, code: EligibilityCode, text: string): Eligibility => ({ ...base, state: 'waiting', code, reason: `${code}: ${text}` });
  const project = freeze.project;
  const cfg = mqConfig(project);
  if (!project || !cfg || !freeze.lane) return no(none, 'NOT_CONFIGURED', 'not a merge-queue project');
  const denied = laneDeniedWhy(project, freeze.lane, cfg);
  if (denied) return no(none, 'LANE_DENIED', denied);
  const repo = projectRepo(project);
  if (!repo) return no(none, 'NO_REPO', 'project has no repo');
  const spec = mainSpec(project);
  const mainRef = await resolveMainRef(repo, project);
  if (!mainRef) return no(none, 'NO_REPO', `${spec.ref} not found`);

  // Nothing left to merge: the SHA is already in main, every commit of the lane has an
  // equivalent there (a cherry-pick, a squash), or the merge would change nothing. Checked
  // before the lane's state: a deleted or moved lane does not matter once the work is in.
  // The freeze itself stays as it is (the overview tracks it until it is deployed).
  const onMain = await alreadyOnMain(repo, freeze.sha, mainRef);
  if (onMain) return { ...none, state: 'superseded', code: 'ALREADY_ON_MAIN', reason: `ALREADY_ON_MAIN: ${onMain}` };

  // Any commit after the review invalidates it: the remote lane must still be this SHA.
  const tip = await remoteTip(repo, spec.remote, freeze.lane, freeze.sha);
  if (!tip) return no(none, 'LANE_GONE', `${freeze.lane} is not on ${spec.remote}`);
  if (tip.toLowerCase() !== freeze.sha.toLowerCase()) return no(none, 'LANE_MOVED', `lane moved to ${tip.slice(0, 8)} after the freeze; freeze that SHA`);

  const migrationsDir = getConfig().projects?.[project]?.migrations_dir ?? null;
  const files = await changedFiles(repo, freeze.sha, mainRef).catch(() => [] as string[]);
  const note = readNote(freeze.freeze_path);
  const { tier, forced } = tierFor(note, files, cfg, migrationsDir);
  const base: Eligibility = { ...none, tier };

  // GitHub first: without the credential nothing merges, and the card says so on every lane.
  const github = await githubPass(project, cfg);
  if (!github.ok) return no(base, 'GH_AUTH_MISSING', github.error ?? 'gh is not logged in');

  // Review reuse by patch-id (rule 3, 26 Oct 2026): a lane that only merged main since a SHA with an
  // independent PASS carries that PASS and its api GREEN over; the new SHA needs quick GREEN, nothing more.
  const carried = await reviewCarriedOver(repo, mainRef, freeze);
  const gates = await gateWords(freeze);
  const full = gates.full === 'green' ? 'green' : carried?.full === 'green' ? 'green' : gates.full;
  // A full gate contains the quick suite: GREEN full is quick enough (27 Oct 2026: "quick missing, api green" held a lane 50 min).
  const quick = gates.quick === 'green' || gates.full === 'green' ? 'green' : gates.quick;
  if (quick !== 'green' || full !== 'green') {
    const apiWord = carried && carried.full !== 'green' && gates.full !== 'green' ? `${gates.full} (and ${carried.full} on ${carried.donor.slice(0, 8)}, the SHA it would carry from)` : full;
    return no(base, 'GATE_NOT_GREEN', `quick ${quick}, api ${apiWord} on ${freeze.sha.slice(0, 8)}`);
  }

  const fixes = needsFixesReason(freeze);
  if (fixes) return no(base, 'NEEDS_FIXES', fixes);
  const author = authorFor(freeze);
  const passed = independentPasses(
    verdictsFor(freeze),
    { id: freeze.author_agent_id ?? author?.id ?? null, name: freeze.author_name ?? author?.name ?? null, alias: author?.alias ?? null, profile: author?.profile ?? null },
    getConfig().projects?.[project]?.pipeline?.service_profiles ?? [],
  );
  if (!passed.ok && carried) {
    if (!reusedNoted(freeze.sha)) {
      emit(MERGE_QUEUE_EVENT.reused, 'run', freeze.sha, { sha: freeze.sha, project, lane: freeze.lane, donor: carried.donor, patch_id: carried.patchId, reviewers: carried.passes.map((p) => p.reviewer_name), api: carried.full === 'green' && gates.full !== 'green' ? 'carried' : 'own' }, null);
      maestroLine(project, `review reused: ${freeze.sha.slice(0, 8)} on ${freeze.lane} has the same patch-id as ${carried.donor.slice(0, 8)} (only main merged since); PASS by ${carried.passes.map((p) => `@${p.reviewer_name}`).join(', ')} carries over`);
    }
  } else if (!passed.ok) {
    return no(base, 'NO_PASS_ON_SHA', passed.why ?? 'no PASS on this SHA');
  }
  const verdictFiles = (passed.ok ? passed.passes : carried!.passes).map((p) => p.path).filter((p): p is string => !!p);

  const pr = await findPr(repo, spec.remote, freeze.sha, freeze.lane, cfg, github);
  if (!pr && cfg.require_pr === true) return no(base, 'NO_PR', `no open pull request for ${freeze.lane} at ${freeze.sha.slice(0, 8)}`);
  const withPr: Eligibility = { ...base, pr: pr?.number ?? null, verdictFiles };
  const holdLabels = (cfg.github?.hold_labels ?? DEFAULT_HOLD_LABELS).map((l) => l.toLowerCase());
  const hold = pr?.labels.find((l) => holdLabels.includes(l.toLowerCase()));
  if (hold) return no(withPr, 'MIGRATION_HOLD', `pull request ${pr!.number} carries the label ${hold}; remove it when the hold is over`);
  if (tier === 'ask' && cfg.ask_tier !== 'auto') {
    const okLabel = cfg.github?.ok_label ?? DEFAULT_OK_LABEL;
    const why = forced ? `ask because of ${forced}` : 'ask by the freeze note';
    if (!cfg.github) return no(withPr, 'ASK_TIER_NO_OK', `${why}; no github block in config to read the ${okLabel} label from`);
    if (!pr) return no(withPr, 'ASK_TIER_NO_OK', `${why}; needs an open pull request with Denis's ${okLabel} label`);
    if (!pr.labels.some((l) => l.toLowerCase() === okLabel.toLowerCase())) return no(withPr, 'ASK_TIER_NO_OK', `${why}; pull request ${pr.number} has no ${okLabel} label from Denis`);
  }

  const migration = await migrationProblem(repo, mainRef, freeze.sha, migrationsDir);
  if (migration) return { ...withPr, state: 'bounced', code: 'MIGRATION_COLLISION', reason: `MIGRATION_COLLISION: ${migration}` };

  return { ...withPr, state: 'queued' };
}

// --- notes and audit -----------------------------------------------------------

function cetStamp(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Ljubljana', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  return `${parts} CET`;
}

function maestroLine(project: string, text: string): void {
  const file = mqConfig(project)?.maestro_log;
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${cetStamp()} ${text}\n`);
  } catch (e) {
    logger.warn({ project, file, error: (e as Error).message }, 'Merge queue: maestro log not written');
  }
}

/** Waits a person must end: a hold, a moved lane, a red gate, a missing PASS. Not a run still pending or missing. */
const ACT_CODES = new Set<EligibilityCode>(['LANE_DENIED', 'LANE_MOVED', 'NEEDS_FIXES', 'NO_PR', 'MIGRATION_HOLD', 'ASK_TIER_NO_OK', 'GH_AUTH_MISSING', 'CHECK_FAILED', 'RELEASE_MODE', 'NO_PASS_ON_SHA']);
export function personMustAct(result: Pick<Eligibility, 'code' | 'reason'>): boolean {
  if (!result.code) return false;
  if (result.code === 'GATE_NOT_GREEN') return /\bred\b/i.test(result.reason ?? '');
  return ACT_CODES.has(result.code);
}

function tell(agentId: string | null, text: string): void {
  if (!agentId) return;
  const agent = getAgent(agentId);
  if (!agent.ok) return;
  void deliverSystemLine(agent.data, text, { kind: 'info', source: 'merge-queue' });
}

function authorFor(freeze: ReleaseFreeze): Agent | null {
  if (freeze.author_agent_id) {
    const a = getAgent(freeze.author_agent_id);
    if (a.ok) return a.data;
  }
  if (freeze.author_name) {
    const name = freeze.author_name.toLowerCase();
    return listAgents().find((a) => a.name.toLowerCase() === name || (a.alias ?? '').toLowerCase() === name) ?? null;
  }
  return null;
}

function bounce(freeze: ReleaseFreeze, row: MergeQueueRow, reason: string): void {
  const sha8 = freeze.sha.slice(0, 8);
  upsert({ sha: freeze.sha, project: row.project, lane: row.lane, state: 'bounced', reason, finished_at: new Date().toISOString() });
  emit(MERGE_QUEUE_EVENT.bounced, 'run', freeze.sha, { sha: freeze.sha, project: row.project, lane: row.lane, tier: row.tier, pr: row.pr, reason, at: cetStamp() }, null);
  tell(authorFor(freeze)?.id ?? null, `[from WaveCode] merge queue bounced ${sha8} on ${row.lane}: ${reason}. Fix it, push, and freeze a new SHA; the queue picks it up again.`);
  maestroLine(row.project, `bounced ${row.lane} ${sha8}: ${reason}`);
  logger.info({ sha: freeze.sha, lane: row.lane, reason }, 'Merge queue: bounced');
}

function requeue(freeze: ReleaseFreeze, row: MergeQueueRow, reason: string): void {
  upsert({ sha: freeze.sha, project: row.project, lane: row.lane, state: 'queued', reason, attempts: row.attempts + 1, started_at: null });
  emit(MERGE_QUEUE_EVENT.requeued, 'run', freeze.sha, { sha: freeze.sha, project: row.project, lane: row.lane, reason, attempts: row.attempts + 1 }, null);
}

// --- the merge job -------------------------------------------------------------

const MAX_ATTEMPTS = 3;

/** The runner's own verdict line (`=== RESULT GREEN … ===`), the last one when there are several. */
export function resultLine(stdout: string): { word: 'GREEN' | 'RED'; line: string } | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^=== RESULT (GREEN|RED)\b.*===$/);
    if (m) return { word: m[1] as 'GREEN' | 'RED', line: lines[i] };
  }
  return null;
}

/** Exit codes of a process ended by a signal (130 INT, 137 KILL, 143 TERM) or no exit code at all. */
export function killedExit(code: number | null): boolean {
  return code === null || code === 130 || code === 137 || code === 143;
}

/**
 * A non-zero exit with no verdict word anywhere in the output means the gate tool never
 * ran the suite (the remote gateway refused the request, the host was unreachable, the
 * SHA was already in flight). Returns the line that says why, or null for a real verdict.
 */
export function gateRefusal(result: { code: number | null; stdout: string }): string | null {
  if (result.code === 0) return null;
  if (resultLine(result.stdout)) return null;
  if (/\b(QUEUED|RUNNING|GREEN|RED)\b/.test(result.stdout)) return null; // a real verdict token; "running suite" or "phase: queued" is not one
  const lines = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const said = lines.filter((l) => !/remote exit \d+ on host=/.test(l)).slice(-1)[0] ?? lines.slice(-1)[0] ?? '';
  return `${said || `gate tool exit ${result.code ?? '?'} with no verdict`}`.slice(0, 160);
}

async function dropWorktree(repo: string, dir: string): Promise<void> {
  await tryGit(repo, ['worktree', 'remove', '--force', dir]);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  await tryGit(repo, ['worktree', 'prune']);
}

async function runMerge(row: MergeQueueRow): Promise<void> {
  const freeze = getFreeze(row.sha);
  const cfg = mqConfig(row.project);
  const repo = projectRepo(row.project);
  if (!freeze || !cfg || !repo) return;
  const spec = mainSpec(row.project);
  const sha8 = row.sha.slice(0, 8);
  const author = authorFor(freeze);
  // Re-read at the door and again before the push. A NEEDS FIXES that lands while this
  // job is the head, or while the merge gate is running, must not reach origin.
  const holdForFixes = (): boolean => {
    const current = getFreeze(row.sha);
    const why = current ? needsFixesReason(current) : null;
    if (!why) return false;
    upsert({ sha: row.sha, project: row.project, lane: row.lane, state: 'waiting', reason: `NEEDS_FIXES: ${why}`, started_at: null });
    return true;
  };
  if (holdForFixes()) return;
  const started = upsert({ sha: row.sha, project: row.project, lane: row.lane, state: 'merging', reason: null, started_at: new Date().toISOString(), enabled_by: kvGet(`merge_queue.${row.project}.by`) });

  const fetched = await tryGit(repo, ['fetch', '--quiet', spec.remote, spec.branch, row.lane], 90000);
  if (fetched === null) { requeue(freeze, started, `fetch from ${spec.remote} failed`); return; }
  const tip = await tryGit(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${spec.remote}/${row.lane}^{commit}`]);
  if (!tip || tip.toLowerCase() !== row.sha.toLowerCase()) {
    upsert({ sha: row.sha, project: row.project, lane: row.lane, state: 'waiting', reason: `LANE_MOVED: lane moved to ${(tip ?? '').slice(0, 8) || 'nothing'} after the freeze; freeze that SHA`, started_at: null });
    return;
  }
  const mainBefore = await tryGit(repo, ['rev-parse', `refs/remotes/${spec.remote}/${spec.branch}^{commit}`]);
  if (!mainBefore) { requeue(freeze, started, `${spec.ref} not found after fetch`); return; }

  const dir = path.join(path.dirname(repo), '.wavecode-merges', `${path.basename(repo)}-${row.sha.slice(0, 9)}`);
  if (fs.existsSync(dir)) await dropWorktree(repo, dir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const added = await tryGit(repo, ['worktree', 'add', '--detach', dir, mainBefore]);
  if (added === null) { requeue(freeze, started, 'could not create the merge checkout'); return; }

  try {
    const message = [
      `Merge ${row.lane} (${sha8}) into ${spec.branch}`,
      '',
      `WaveCode merge queue · tier ${row.tier ?? '?'}${row.pr ? ` · PR ${row.pr}` : ''}`,
      `Lane SHA: ${row.sha}`,
      author ? `Author: @${author.alias ?? author.name}` : null,
    ].filter((l): l is string => l !== null).join('\n');
    const merged = await tryGit(dir, ['merge', '--no-ff', '--no-edit', '-m', message, row.sha], 120000);
    if (merged === null) {
      const files = (await tryGit(dir, ['diff', '--name-only', '--diff-filter=U']))?.split('\n').map((l) => l.trim()).filter(Boolean) ?? [];
      await tryGit(dir, ['merge', '--abort']);
      bounce(freeze, started, `merge conflict with ${spec.branch} in ${files.length ? files.join(', ') : 'unknown files'}; merge ${spec.ref} into your lane, run the quick check, and freeze the new SHA`);
      return;
    }

    if (cfg.version_command?.length) {
      const bumped = await runArgv(fill(cfg.version_command, { checkout: dir, sha: row.sha, lane: row.lane, project: row.project, remote: spec.remote }), { cwd: dir, timeoutMs: 120000 });
      if (bumped.code !== 0) { requeue(freeze, started, `version command failed (exit ${bumped.code})`); return; }
      const dirty = await tryGit(dir, ['status', '--porcelain']);
      if (dirty) {
        await git(dir, ['add', '-A']);
        await git(dir, ['commit', '--quiet', '--amend', '--no-edit']);
      }
    }

    const mergeSha = await git(dir, ['rev-parse', 'HEAD']);
    // The merge gate runs once, here, on the merged code — unless the lane already contained
    // main and the merge result is the lane's own tree, which its quick and api gates covered.
    let gateNote: string;
    const skipped = await mergeGateSkip(dir, row.sha, mainBefore, mergeSha, freeze, spec.branch);
    if (skipped) {
      gateNote = skipped;
    } else {
      const gateCmd = cfg.gate_command ?? getConfig().projects?.[row.project]?.pipeline?.gate_command ?? null;
      if (!gateCmd?.length) { bounce(freeze, started, 'no gate_command configured; the merge result cannot be tested'); return; }
      const minutes = cfg.gate_timeout_min ?? getConfig().projects?.[row.project]?.pipeline?.gate_timeout_min ?? 120;
      const env: Record<string, string> = {
        WAVECODE_SHA: mergeSha, WAVECODE_LANE: row.lane, WAVECODE_CHECKOUT: dir, WAVECODE_MERGE_OF: row.sha,
        WAVECODE_AUTHOR: author?.name ?? '', COUNTIX_REMOTE_TEST_WHO: `${author?.name ?? 'wavecode'}.${mergeSha.slice(0, 9)}`,
      };
      const gateArgv = fill(gateCmd, { checkout: dir, sha: mergeSha, lane: row.lane, project: row.project, remote: spec.remote });
      const gateStarted = new Date();
      const result = await runArgv(gateArgv, { cwd: dir, env, timeoutMs: minutes * 60_000 });
      // The runner's RESULT line is the suite's verdict whatever the tool's exit code: the tool
      // is killed after printing it (the gateway's reuse path ends a placeholder with SIGTERM), or
      // exits non-zero from bookkeeping on the test host after a GREEN (queue-record.sh killed,
      // "remote exit 5", four false bounces on 26 Oct 2026). Only a missing RESULT line is the tool's word.
      const verdict = resultLine(result.stdout);
      let word = gateOutcome(result);
      if (verdict) word = verdict.word;
      // One immutable record per gate WaveCode ran: what the checker and the deploy scripts read.
      await recordGateResult({
        project: row.project, sha: mergeSha, argv: gateArgv, stdout: result.stdout, exit_code: result.code, started_at: gateStarted, finished_at: new Date(),
        dispatch_failure: word === 'RED' && !verdict ? (killedExit(result.code) ? `gate tool killed (exit ${result.code ?? 'none'}) before a RESULT line` : gateRefusal(result)) : null,
      });
      if (word === 'RED') {
        const refusal = killedExit(result.code) && !verdict ? `gate tool killed (exit ${result.code ?? 'none'}) before a RESULT line` : gateRefusal(result);
        if (refusal !== null) {
          // The tool failed before any suite ran (a gateway policy, an unreachable host, a
          // duplicate): that is not a verdict on the code. Try again; bounce only when it keeps failing.
          if (started.attempts + 1 >= MAX_ATTEMPTS) { bounce(freeze, started, `GATE_DISPATCH_FAILED: ${refusal} — after ${MAX_ATTEMPTS} tries`); return; }
          requeue(freeze, started, `GATE_DISPATCH_FAILED: ${refusal}; trying again`);
          return;
        }
        const last = result.stdout.trim().split('\n').filter((l) => l.trim()).slice(-1)[0] ?? '';
        bounce(freeze, started, `gate RED on merge ${mergeSha.slice(0, 8)}${last ? ` — ${last.slice(0, 160)}` : ''}`);
        return;
      }
      if (word !== 'GREEN') {
        if (started.attempts + 1 >= MAX_ATTEMPTS) { bounce(freeze, started, `gate stayed ${word} on merge ${mergeSha.slice(0, 8)} after ${MAX_ATTEMPTS} tries`); return; }
        requeue(freeze, started, `gate ${word} on merge ${mergeSha.slice(0, 8)}; trying again`);
        return;
      }
      gateNote = `gate GREEN on ${mergeSha.slice(0, 8)}`;
    }

    if (!queueEnabled(row.project)) { requeue(freeze, started, 'merge queue switched off before the push'); return; }
    if (holdForFixes()) return;

    // Plain push: never force, never a different ref. A rejected push means main moved; merge again.
    try {
      await git(dir, ['push', '--quiet', spec.remote, `HEAD:refs/heads/${spec.branch}`], 120000);
    } catch (e) {
      const text = (e as Error).message ?? '';
      if (/rejected|non-fast-forward|fetch first|stale info/i.test(text)) { requeue(freeze, started, `${spec.branch} moved during the gate; merging again`); return; }
      if (started.attempts + 1 >= MAX_ATTEMPTS) { bounce(freeze, started, `push to ${spec.branch} failed ${MAX_ATTEMPTS} times`); return; }
      requeue(freeze, started, `push to ${spec.branch} failed; trying again`);
      return;
    }

    let gateRuns: string[] = [];
    if (testsConfigured(row.project)) {
      try { gateRuns = (await readLaneTests(row.project, row.lane, mergeSha)).map((r) => r.id).filter((id) => id && !id.startsWith('queued-')); } catch { gateRuns = []; }
    }
    const verdictFiles = (row.verdict_files ?? '').split('\n').filter(Boolean);
    const payload = {
      project: row.project, lane: row.lane, tier: row.tier, pr: row.pr,
      sha_in: row.sha, sha_out: mergeSha, main_before: mainBefore,
      gate: gateNote, gate_runs: gateRuns, verdict_files: verdictFiles,
      enabled_by: started.enabled_by, author: author?.name ?? freeze.author_name, at: cetStamp(),
    };
    upsert({ sha: row.sha, project: row.project, lane: row.lane, state: 'merged', reason: gateNote, merge_sha: mergeSha, gate_runs: gateRuns.join(','), finished_at: new Date().toISOString() });
    if (kvGet(`merge_queue.${row.project}.stall`)) kvSet(`merge_queue.${row.project}.stall`, ''); // the queue moved; the banner goes at once
    emit(MERGE_QUEUE_EVENT.merged, 'run', row.sha, payload, null);
    tell(author?.id ?? null, `[from WaveCode] merged ${row.lane} ${sha8} into ${spec.branch} as ${mergeSha.slice(0, 8)}${row.pr ? ` (PR ${row.pr})` : ''}. ${gateNote}. Nothing else to do on this lane.`);
    maestroLine(row.project, `merged ${row.lane} ${sha8} -> ${spec.branch} ${mergeSha.slice(0, 8)} (tier ${row.tier ?? '?'}${row.pr ? `, PR ${row.pr}` : ''}${gateRuns.length ? `, gate ${gateRuns.join(' ')}` : ''}${verdictFiles.length ? `, verdicts ${verdictFiles.map((f) => path.basename(f)).join(' ')}` : ''})`);
    logger.info({ sha: row.sha, lane: row.lane, mergeSha }, 'Merge queue: merged');
    await tryGit(repo, ['fetch', '--quiet', spec.remote, spec.branch], 60000);
    await fireMainAdvanced(row.project, mergeSha);
  } finally {
    await dropWorktree(repo, dir);
  }
}

// --- the stall alarm ------------------------------------------------------------

const DEFAULT_STALL_MINUTES = 30;

function stallDir(cfg: MergeQueueConfig): string | null {
  if (cfg.stall_dir) return cfg.stall_dir;
  if (cfg.maestro_log) return path.dirname(cfg.maestro_log);
  return freezeInboxDirs()[0] ?? null;
}

function fileStamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`;
}

function ageMinutes(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? Math.round((now - t) / 60_000) : null;
}

/**
 * The queue is stalled when it cannot run (no GitHub credential, switched off with
 * eligible lanes) or an eligible lane has waited longer than `stall_minutes` with
 * no merge started or finished in that time. One file per `stall_minutes` goes to
 * the coordinating bot's inbox with the reason, the lanes and their SHAs.
 */
export function checkStall(project: string, ghError: string | null, now = Date.now()): QueueStall | null {
  const cfg = mqConfig(project);
  if (!cfg) return null;
  const limitMs = (cfg.stall_minutes ?? DEFAULT_STALL_MINUTES) * 60_000;
  const rows = listQueue(project);
  const queued = rows.filter((r) => r.state === 'queued');
  const merging = rows.find((r) => r.state === 'merging') ?? null;
  const recent = (iso: string | null) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) && now - t < limitMs; };
  const progress = rows.some((r) => (r.state === 'merged' || r.state === 'bounced') && recent(r.finished_at)) || (merging !== null && recent(merging.started_at));

  let code: EligibilityCode | null = null;
  let text: string | null = null;
  const waitingRows = rows.filter((r) => r.state === 'waiting');
  if (ghError && (queued.length > 0 || waitingRows.length > 0)) {
    code = 'GH_AUTH_MISSING'; text = ghError;
  } else if (queued.length > 0 && !queueEnabled(project)) {
    code = 'QUEUE_OFF'; text = `${queued.length} eligible lane${queued.length === 1 ? '' : 's'} and the switch is off (by ${kvGet(`merge_queue.${project}.by`) ?? 'unknown'})`;
  } else if (merging && !recent(merging.started_at)) {
    code = 'STALLED_MERGE'; text = `${merging.lane} ${merging.sha.slice(0, 8)} has been merging for ${ageMinutes(merging.started_at, now) ?? '?'} min`;
  } else if (!progress) {
    const oldest = queued.filter((r) => !recent(r.eligible_at)).sort((a, b) => (a.eligible_at ?? '').localeCompare(b.eligible_at ?? ''))[0];
    if (oldest) { code = 'STALLED_MERGE'; text = `${oldest.lane} ${oldest.sha.slice(0, 8)} has been eligible for ${ageMinutes(oldest.eligible_at, now) ?? '?'} min and nothing merged`; }
  }

  if (!code || !text) {
    if (kvGet(`merge_queue.${project}.stall`)) kvSet(`merge_queue.${project}.stall`, '');
    return null;
  }
  const previous = queueStall(project);
  const lastWritten = kvGet(`merge_queue.${project}.stall_written`);
  const throttled = lastWritten !== null && recent(lastWritten);
  const stall: QueueStall = { project, code, text, at: new Date(now).toISOString(), file: throttled ? previous?.file ?? null : null };
  if (!throttled) {
    const dir = stallDir(cfg);
    if (dir) {
      const file = path.join(dir, `wavecode-queue-stall-${fileStamp(new Date(now))}.md`);
      const lines = [
        `# WaveCode merge queue stall · ${project}`,
        '',
        `At: ${cetStamp(new Date(now))}`,
        `Reason: ${code}: ${text}`,
        `Queue switch: ${queueEnabled(project) ? 'on' : 'off'}${kvGet(`merge_queue.${project}.by`) ? ` (last by ${kvGet(`merge_queue.${project}.by`)})` : ''}`,
        '',
        '| lane | SHA | state | since (min) | why |',
        '|---|---|---|---|---|',
        ...[...(merging ? [merging] : []), ...queued, ...waitingRows].slice(0, 40).map((r) => `| ${r.lane} | ${r.sha} | ${r.state} | ${ageMinutes(r.state === 'merging' ? r.started_at : r.eligible_at ?? r.updated_at, now) ?? '?'} | ${(r.reason ?? '').replace(/\|/g, '/')} |`),
        '',
        'What to do: fix the reason above (store the GitHub credential, flip the switch, or check the gate on the test server); the queue picks up by itself on the next pass.',
        '',
      ];
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, lines.join('\n'));
        stall.file = file;
      } catch (e) {
        logger.warn({ project, file, error: (e as Error).message }, 'Merge queue: stall file not written');
      }
    }
    kvSet(`merge_queue.${project}.stall_written`, stall.at);
    emit(MERGE_QUEUE_EVENT.stall, 'project', project, { project, code, text, file: stall.file, at: cetStamp(new Date(now)) }, null);
    maestroLine(project, `stall ${code}: ${text}${stall.file ? ` (${path.basename(stall.file)})` : ''}`);
    logger.warn({ project, code, text, file: stall.file }, 'Merge queue: stalled');
  }
  kvSet(`merge_queue.${project}.stall`, JSON.stringify(stall));
  return stall;
}

// --- the tick ------------------------------------------------------------------

function recoverOnce(): void {
  if (recovered) return;
  recovered = true;
  withTable(() => {
    getDb().prepare("UPDATE merge_queue SET state = 'queued', reason = 'daemon restarted during the merge; starting over', started_at = NULL, updated_at = datetime('now') WHERE state = 'merging'").run();
  });
}

const MERGE_QUEUE_WINDOW_MS = 14 * 24 * 3600_000;

/** The freezes a pass evaluates: the newest open one per lane, frozen within two weeks. The rest carry a reason instead. */
function freezesToEvaluate(project: string, now = Date.now()): { open: ReleaseFreeze[]; parked: Map<string, string> } {
  const open: ReleaseFreeze[] = [];
  const parked = new Map<string, string>();
  const lanesSeen = new Set<string>();
  for (const f of listFreezes()) { // newest first
    if (f.project !== project || !f.lane || (f.status !== 'open' && f.status !== 'behind-main')) continue;
    if (lanesSeen.has(f.lane)) { parked.set(f.sha, `newer freeze on ${f.lane}`); continue; }
    lanesSeen.add(f.lane);
    const age = freezeAgeMs(f.created_at, now);
    if (Number.isFinite(age) && age > MERGE_QUEUE_WINDOW_MS) { parked.set(f.sha, 'frozen more than 14 days ago; freeze the lane again to queue it'); continue; }
    open.push(f);
  }
  return { open, parked };
}

async function refreshProject(project: string): Promise<MergeQueueRow | null> {
  headsScope = new Map();
  ghScope = new Map();
  try {
    return await refreshProjectPass(project);
  } finally {
    headsScope = null;
    ghScope = null;
  }
}

async function refreshProjectPass(project: string): Promise<MergeQueueRow | null> {
  const { open, parked } = freezesToEvaluate(project);
  const openShas = new Set(open.map((f) => f.sha));
  for (const row of listQueue(project)) {
    // A bounced row whose freeze closed (lane retired, merged elsewhere, superseded) is over too: requeue needs a live freeze.
    if ((row.state !== 'waiting' && row.state !== 'queued' && row.state !== 'bounced') || openShas.has(row.sha)) continue;
    const why = parked.get(row.sha);
    if (why) {
      if (row.state === 'queued' || row.reason !== why) upsert({ sha: row.sha, project, lane: row.lane, state: 'waiting', reason: why, eligible_at: null });
      continue;
    }
    const freeze = getFreeze(row.sha);
    upsert({ sha: row.sha, project, lane: row.lane, state: 'superseded', reason: `freeze ${freeze?.status ?? 'gone'}`, finished_at: new Date().toISOString() });
  }
  for (const freeze of open) {
    const existing = getQueueRow(freeze.sha);
    if (existing && (existing.state === 'merged' || existing.state === 'bounced' || existing.state === 'merging')) continue;
    if (existing?.state === 'superseded' && existing.reason?.startsWith('ALREADY_ON_MAIN')) continue; // once in main, always in main: not re-checked
    let result: Eligibility;
    try { result = await evaluate(freeze); } catch (e) {
      result = { state: 'waiting', code: 'CHECK_FAILED', reason: `CHECK_FAILED: ${(e as Error).message}`.slice(0, 200), tier: null, pr: null, verdictFiles: [] };
    }
    const lane = freeze.lane!;
    if (result.state === 'superseded') {
      if (existing?.state !== 'superseded' || existing.reason !== result.reason) {
        upsert({ sha: freeze.sha, project, lane, tier: result.tier, state: 'superseded', reason: result.reason, eligible_at: null, finished_at: new Date().toISOString() });
        logger.info({ sha: freeze.sha, lane, reason: result.reason }, 'Merge queue: nothing to merge');
      }
      continue;
    }
    if (result.state === 'bounced') {
      const row = upsert({ sha: freeze.sha, project, lane, tier: result.tier, pr: result.pr, verdict_files: result.verdictFiles.join('\n') });
      bounce(freeze, row, result.reason ?? 'not eligible');
      continue;
    }
    const wasQueued = existing?.state === 'queued';
    const release = releaseLanes(project);
    if (result.state === 'queued' && release && !laneInRelease(release, freeze)) {
      result = { ...result, state: 'waiting', code: 'RELEASE_MODE', reason: `RELEASE_MODE: only ${release.join(', ')} land until the release is out` };
    }
    if (result.state === 'queued' && !queueEnabled(project)) result.reason = 'QUEUE_OFF: merge queue is off';
    // A wait that a person must end is said once, where people read (author + driver seats), the first time it appears.
    if (result.state === 'waiting' && result.code && existing?.reason !== result.reason && personMustAct(result)) {
      void tellDriverSeats(`[from WaveCode] merge queue: ${freeze.sha.slice(0, 8)} on ${lane} is waiting — ${result.reason}`, authorFor(freeze)?.id ?? null, 'merge-queue');
    }
    upsert({
      sha: freeze.sha, project, lane, tier: result.tier, state: result.state, reason: result.reason, pr: result.pr,
      verdict_files: result.verdictFiles.join('\n'),
      eligible_at: result.state === 'queued' ? (existing?.eligible_at ?? new Date().toISOString()) : null,
    });
    if (result.state === 'queued' && !wasQueued) {
      emit(MERGE_QUEUE_EVENT.queued, 'run', freeze.sha, { sha: freeze.sha, project, lane, tier: result.tier, pr: result.pr }, null);
      tell(authorFor(freeze)?.id ?? null, `[from WaveCode] ${freeze.sha.slice(0, 8)} on ${lane} is in the merge queue (tier ${result.tier}); it merges into main when its turn comes. Nothing to do.`);
    }
  }
  const queued = listQueue(project).filter((r) => r.state === 'queued');
  return queued[0] ?? null;
}

/**
 * One pass: refresh every open freeze's eligibility and start the head of the
 * queue when nothing is merging for that project. The merge itself runs in the
 * background (a gate takes as long as the remote suite); `wait` awaits it.
 */
export async function mergeQueueTick(opts: { wait?: boolean } = {}): Promise<void> {
  recoverOnce();
  for (const project of configuredProjects()) {
    if (inflight.has(project)) {
      // Busy merging: the queue is alive, the lanes are not re-read until the merge is done.
      kvSet(`merge_queue.${project}.last_pass_at`, new Date().toISOString());
      if (opts.wait) await inflight.get(project);
      continue;
    }
    const passT0 = Date.now();
    let head: MergeQueueRow | null = null;
    try { head = await refreshProject(project); } catch (e) {
      logger.warn({ project, error: (e as Error).message }, 'Merge queue: refresh failed');
    }
    const cfg = mqConfig(project);
    let ghError: string | null = null;
    if (cfg?.github) {
      try { ghError = (await githubPass(project, cfg)).error; } catch (e) { ghError = (e as Error).message; }
    }
    try { checkStall(project, ghError); } catch (e) {
      logger.warn({ project, error: (e as Error).message }, 'Merge queue: stall check failed');
    }
    if (!queueEnabled(project)) {
      // The switch is off: the cards still show who is eligible, nothing is merged.
      for (const row of listQueue(project)) {
        if (row.state === 'queued') upsert({ sha: row.sha, project, lane: row.lane, reason: 'QUEUE_OFF: merge queue is off' });
      }
      kvSet(`merge_queue.${project}.last_pass_at`, new Date().toISOString());
      emit(MERGE_QUEUE_EVENT.pass, 'project', project, { project, ms: Date.now() - passT0, head: null, off: true }, null);
      continue;
    }
    kvSet(`merge_queue.${project}.last_pass_at`, new Date().toISOString());
    logger.info({ project, ms: Date.now() - passT0, head: head?.sha ?? null, lane: head?.lane ?? null }, 'Merge queue pass');
    emit(MERGE_QUEUE_EVENT.pass, 'project', project, { project, ms: Date.now() - passT0, head: head?.sha ?? null }, null);
    if (!head) continue;
    const job = runMerge(head)
      .catch((e) => logger.warn({ project, sha: head!.sha, error: (e as Error).message }, 'Merge queue: job failed'))
      .finally(() => inflight.delete(project));
    inflight.set(project, job);
    if (opts.wait) await job;
  }
}

/** How often the queue looks at its lanes on its own, between the (slow) deploy reconcile passes. */
export const MERGE_QUEUE_INTERVAL_MS = 90_000;
let ticking: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * One pass at a time: a second caller (the reconcile pass, the timer) joins the pass
 * already running instead of starting another over the same per-pass caches.
 */
export function mergeQueueTickGuarded(opts: { wait?: boolean } = {}): Promise<void> {
  if (ticking) return ticking;
  ticking = mergeQueueTick(opts)
    .catch((e) => logger.warn({ error: (e as Error).message }, 'Merge queue: tick failed'))
    .finally(() => { ticking = null; });
  return ticking;
}

/**
 * The queue's own clock. A deploy reconcile pass takes minutes (every lane's merge-base
 * is recomputed when main moves) and used to be the only thing that gave the queue a turn,
 * so lanes merged one per pass. Now the head is tried every MERGE_QUEUE_INTERVAL_MS.
 */
export function startMergeQueueTimer(intervalMs = MERGE_QUEUE_INTERVAL_MS): void {
  if (timer) return;
  timer = setInterval(() => { void mergeQueueTickGuarded(); }, intervalMs);
  timer.unref?.();
}

export function stopMergeQueueTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function resetMergeQueueForTest(): void {
  stopMergeQueueTimer();
  ticking = null;
  inflight.clear();
  recovered = false;
  execForTest = null;
  headsScope = null;
  ghScope = null;
  ghAuthOkUntil.clear();
}
