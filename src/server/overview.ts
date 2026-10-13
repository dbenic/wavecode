/**
 * The board: what every agent is doing and what every reviewed lane needs.
 * The heavy build runs in the background reconciler. GET /api/overview reads
 * the stored snapshot and pages attention; it does not ask git or walk freezes.
 */

import { getConfig } from './config.js';
import { getAgent, getDb, getRun, insertTask, listAgents, resolveAgent, type Agent, type Task, type User } from './db.js';
import { usageFor } from './usage-probe.js';
import { listPeerQuestions } from './peers.js';
import { candidateFor, ensureReleaseFreezeTable, getFreezeByRun, listCandidates, reconcileMerged, type ReleaseFreeze } from './release-freezes.js';
import { autoResolveObsoleteFreezes, deployTipsForProjects, isMergedNotDeployed, type DeployTipRead } from './freeze-resolve.js';
import { commitsBehind, isMergeOnlyDelta, laneAutomationDenied, projectRepo, resolveMainRef, withRefMemo } from './lane-main.js';
import { behindMainLine, fullFailFlag, needsGreenFull, needsGreenQuick, QUICK_CHECK_RUNNING } from './lane-status.js';
import { emit } from './event-bus.js';
import { ensureReleaseTables, verificationFor, type ReleaseRequest } from './releases.js';
import { readLaneTests, shaChecks, suiteNames, testsConfigured, type ShaChecks } from './test-runs.js';
import { deskConfig, OPEN_STATUSES, type DeskItem } from './product-desk.js';
import * as productDesk from './product-desk.js';
import * as leases from './leases.js';
import * as taskDispatcher from './task-dispatcher.js';

export interface AgentBoardRow {
  id: string;
  name: string;
  alias: string | null;
  runtime: string;
  model: string | null;
  status: Agent['status'];
  /** when the status last changed (ISO, UTC) */
  status_since: string | null;
  /** minutes in the current status */
  for_min: number | null;
  current: { task_id: string; num: number | null; prompt: string; run_id: string; started_at: string } | null;
  last_reply: { at: string; text: string } | null;
  /** 'awaiting peer answer' | 'review pending' | 'needs reviewer' | 'hung' | 'crashed' | null */
  blocked_on: string | null;
  usage: string | null;
  /** subscription budget from the usage probe: % left of the weekly and the 5-hour window */
  budget: { weekly_left: number | null; five_h_left: number | null; resets: string | null };
  /** release freezes this agent authored that are still open */
  open_freezes: number;
}

/** Something that needs a fix and, ideally, an agent queued to do it. */
export interface FixRow {
  sha: string;
  run_id: string;
  project: string | null;
  desk: number | null;
  lane: string | null;
  author: string | null;
  author_agent_id: string | null;
  reviewer: string | null;
  reason: 'needs fixes' | 'release failed' | 'rejected';
  detail: string | null;
  since: string;
  /** the task queued for the fix (tasks.fix_sha), or null when nobody is on it */
  assigned: { task_id: string; num: number | null; status: Task['status']; agent_id: string | null; agent_name: string | null } | null;
}

export interface LaneBoardRow {
  sha: string;
  run_id: string | null;
  project: string | null;
  desk: number | null;
  lane: string | null;
  author: string | null;
  reviewer: string | null;
  verdict: string | null;
  gate: string | null;
  status: ReleaseFreeze['status'];
  superseded_by: string | null;
  promotable: boolean;
  /** the unreleased release candidate branch this SHA already sits in (projects.<p>.candidate_refs), if any */
  candidate: string | null;
  /** first lines of the freeze note (scope of the change), for grouping decisions */
  summary: string | null;
  staging: {
    status: string; version: string | null; at: string; by: string | null; verified_by: string | null; verified_at: string | null;
    phase?: string | null; progress?: string | null; pin_until?: string | null; url?: string | null; error?: string | null; rollback_status?: string | null;
  } | null;
  production: { status: string; version: string | null; at: string; by: string | null; verified_by: string | null; verified_at: string | null; error?: string | null } | null;
  /** deterministic next step, before any model opinion */
  next: string;
  /** Set when a full run failed after this SHA was staged. */
  full_fail_flag: string | null;
  /** Why Promote stays disabled until a green full gate exists. */
  promote_block: string | null;
  updated_at: string;
}

export interface AttentionRow {
  kind: 'needs_reviewer' | 'hung' | 'crashed' | 'stale' | 'release_failed' | 'awaiting_answer' | 'promotable' | 'idle_with_open_work' | 'fix_unassigned';
  text: string;
  agent_id?: string;
  run_id?: string;
  sha?: string;
}

export interface AttentionGroup {
  kind: string;
  /** How many of this kind exist, across every page. */
  count: number;
  /** This page's rows of this kind. */
  items: AttentionRow[];
}

/** A composed release candidate (projects.<p>.candidate_refs): the unit that goes to production. */
export interface CandidateRow {
  project: string;
  name: string;
  tip: string;
  committed_at: string | null;
  /** lanes (freeze SHAs) the candidate contains, per the board */
  lanes: Array<{ sha: string; desk: number | null; lane: string | null; verdict: string | null; author: string | null }>;
  staging: LaneBoardRow['staging'];
  production: LaneBoardRow['production'];
  verified: { by: string; at: string; note: string | null } | null;
  next: string;
}

/** Open Product Desk requests as the board sees them (from the cached read; null when the desk is off). */
export interface DeskBoardRow {
  id: number;
  status: string;
  title: string;
  area: string | null;
  priority: string | null;
  target_version: string | null;
  updated_at: string | null;
  /** lanes frozen for this desk and tasks carrying it, per the board */
  lanes: Array<{ sha: string; verdict: string | null; status: string }>;
  tasks: Array<{ num: number | null; status: string; agent: string | null }>;
}

export interface Board {
  at: string;
  host: string;
  agents: AgentBoardRow[];
  lanes: LaneBoardRow[];
  /** Newest stale or superseded freeze per lane. Never a decision. */
  history: LaneBoardRow[];
  candidates: CandidateRow[];
  /** null = Product Desk not configured */
  desk: DeskBoardRow[] | null;
  fixes: FixRow[];
  /** Full list in the snapshot. GET /api/overview replaces this with one page. */
  attention: AttentionRow[];
  attention_groups?: AttentionGroup[];
  attention_total?: number;
  attention_page?: number;
  counts: { working: number; idle: number; error: number; open_lanes: number; promotable: number; releases_open: number; open_fixes: number; unassigned_fixes: number };
}

/** The marker a fix task carries in its prompt so a person can see which SHA it is. */
export function fixMarker(sha: string): string {
  return `[fix ${sha.slice(0, 8)}]`;
}

export const ATTENTION_PAGE_SIZE = 20;
const OVERVIEW_KV = 'overview_board';
const FIX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const IDLE_WITH_WORK_MIN = 20;
const PROMOTED_WINDOW_MIN = 24 * 60;

function iso(sqlite: string | null | undefined): string | null {
  if (!sqlite) return null;
  return sqlite.includes('T') ? sqlite : `${sqlite.replace(' ', 'T')}Z`;
}

function minutesSince(isoTs: string | null, now: number): number | null {
  if (!isoTs) return null;
  const t = Date.parse(isoTs);
  return Number.isFinite(t) ? Math.max(0, Math.round((now - t) / 60_000)) : null;
}

function withinFixWindow(sqlite: string | null, now: number): boolean {
  const t = Date.parse(iso(sqlite) ?? '');
  return Number.isFinite(t) && now - t >= 0 && now - t < FIX_WINDOW_MS;
}

function laneKey(f: { project: string | null; lane: string | null; sha: string }): string {
  const lane = f.lane?.trim() ? f.lane : f.sha;
  return `${f.project ?? ''}\0${lane}`;
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

function queryAll<T>(sql: string, params: unknown[]): T[] {
  try {
    return getDb().prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

function isCodex1(agent: { name: string; alias?: string | null; tmux_session?: string | null }): boolean {
  const names = [agent.name, agent.alias, agent.tmux_session].filter((s): s is string => !!s).map((s) => s.toLowerCase());
  return names.some((n) => n === 'codex1' || n === 'wc-codex1');
}

function stagedOrShipped(status: string | null | undefined): boolean {
  return status === 'sent' || status === 'requested' || status === 'deployed';
}

type FixAssignment = NonNullable<FixRow['assigned']>;

function loadFixAssignments(shas: string[]): Map<string, FixAssignment> {
  const map = new Map<string, FixAssignment>();
  if (shas.length === 0) return map;
  const rows = queryAll<FixAssignment & { fix_sha: string }>(
    `SELECT t.fix_sha, t.id AS task_id, t.num, t.status, t.agent_id, a.name AS agent_name
     FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id
     WHERE t.fix_sha IN (${placeholders(shas.length)})
     ORDER BY t.created_at DESC`,
    shas,
  );
  for (const row of rows) {
    if (!map.has(row.fix_sha)) {
      map.set(row.fix_sha, { task_id: row.task_id, num: row.num, status: row.status, agent_id: row.agent_id, agent_name: row.agent_name });
    }
  }
  return map;
}

export function assignFixTask(input: {
  runId: string;
  agentId: string;
  note?: string | null;
  actorName?: string | null;
  user?: (Pick<User, 'id' | 'role'> & { name?: string; allowed_agents?: string | null }) | null;
  via: 'overview_fix' | 'auto';
  enforceLease: boolean;
}): { ok: true; task: Task; sha: string; agent: { id: string; name: string } } | { ok: false; status: number; error: string } {
  const run = getRun(input.runId);
  if (!run.ok) return { ok: false, status: 404, error: run.error };
  const freeze = getFreezeByRun(input.runId);
  if (!freeze) return { ok: false, status: 400, error: 'Only a release freeze (a lane with an exact SHA) can be assigned as a fix' };
  const agent = resolveAgent(input.agentId);
  if (!agent.ok) return { ok: false, status: 404, error: agent.error };
  if (isCodex1(agent.data) && input.via === 'auto') return { ok: false, status: 403, error: 'codex1 is not auto-assigned fixes' };
  if (laneAutomationDenied(freeze.project, agent.data, freeze.lane)) return { ok: false, status: 403, error: `refusing ${agent.data.name}: denied` };
  if (input.enforceLease) {
    if (!input.user) return { ok: false, status: 403, error: 'Forbidden' };
    const access = leases.checkAgentAccess(agent.data, input.user);
    if (!access.ok) return { ok: false, status: 403, error: access.error };
  }
  const open = getDb().prepare(
    "SELECT id, num FROM tasks WHERE fix_sha = ? AND status IN ('pending','running','blocked') ORDER BY created_at DESC LIMIT 1",
  ).get(freeze.sha) as { id: string; num: number | null } | undefined;
  if (open) return { ok: false, status: 409, error: `A fix task is already open for ${freeze.sha.slice(0, 8)} (#${open.num ?? open.id})` };
  const what = freeze.verdict === 'needs-fixes' || freeze.verdict === 'reject' ? 'the review findings' : 'the failed release';
  const who = input.actorName ?? input.user?.name ?? null;
  const prompt = [
    `${fixMarker(freeze.sha)} Fix ${what} on lane ${freeze.lane ?? '?'}${freeze.desk ? ` (Desk #${freeze.desk})` : ''}, frozen at exact SHA ${freeze.sha}.`,
    freeze.verdict_path ? `Verdict: ${freeze.verdict_path}` : null,
    freeze.freeze_path ? `Freeze note: ${freeze.freeze_path}` : null,
    typeof input.note === 'string' && input.note.trim() && who ? `From ${who}: ${input.note.trim().slice(0, 1000)}` : null,
    'Address every finding, run the touched tests, then refreeze with a new freeze note and ask the same reviewer for a verdict on the new exact SHA (agent-operating-rules §3a).',
  ].filter(Boolean).join('\n');
  const task = insertTask({
    prompt,
    agent_id: agent.data.id,
    priority: 1,
    fix_sha: freeze.sha,
    created_by: input.via === 'auto' ? null : undefined,
    ...(freeze.project ? { room: freeze.project } : {}),
    ...(freeze.reviewer_agent_id && freeze.reviewer_agent_id !== agent.data.id ? { reviewer: freeze.reviewer_agent_id } : {}),
  });
  if (!task.ok) return { ok: false, status: 400, error: task.error };
  emit('task.created', 'task', task.data.id, { agent_id: agent.data.id, prompt: prompt.slice(0, 300), fix_sha: freeze.sha, run_id: input.runId, via: input.via }, input.via === 'auto' ? null : undefined);
  setTimeout(() => { void taskDispatcher.dispatchNext().catch(() => { /* dispatcher logs */ }); }, 500);
  return { ok: true, task: task.data, sha: freeze.sha, agent: { id: agent.data.id, name: agent.data.name } };
}

function releaseCell(r: ReleaseRequest | null, verified: Map<string, { verified_by: string; verified_at: string; note: string | null }>): LaneBoardRow['staging'] {
  if (!r) return null;
  const v = verified.get(r.sha) ?? null;
  return {
    status: r.status, version: r.version, at: iso(r.updated_at)!, by: r.requested_by,
    verified_by: v?.verified_by ?? r.verified_by ?? null, verified_at: v ? iso(v.verified_at) : r.verified_at ? iso(r.verified_at) : null,
    phase: r.progress_phase, progress: r.progress_status, pin_until: r.pin_until, url: r.staging_url,
    error: r.error, rollback_status: r.rollback_status,
  };
}

function liveChecks(f: ReleaseFreeze): ShaChecks | null {
  if (!f.project || !testsConfigured(f.project)) return null;
  try {
    return shaChecks(readLaneTests(f.project, f.lane ?? '', f.sha), f.sha, suiteNames(f.project));
  } catch {
    return null;
  }
}

function nextStep(f: ReleaseFreeze, staging: ReleaseRequest | null, production: ReleaseRequest | null, candidate: string | null, checks: ShaChecks | null): { next: string; promotable: boolean } {
  if (f.status === 'merged') return { next: 'on main — merged or deployed outside this pipeline', promotable: false };
  if (f.status === 'behind-main') {
    let n: number | null = null;
    try { n = commitsBehind(f.project, f.sha); } catch { n = null; }
    return { next: n && n > 0 ? behindMainLine(n) : 'behind main: merge main', promotable: false };
  }
  if (candidate) return { next: `in candidate ${candidate} — ships with that release`, promotable: false };
  if (f.project && getConfig().projects?.[f.project]?.candidate_refs) {
    if (f.status !== 'open') return { next: f.status, promotable: false };
    if (f.verdict !== 'pass') return { next: f.verdict ? 'needs fixes — author fixes, refreezes, reviewer re-reviews' : 'waiting for an independent verdict', promotable: false };
    return { next: 'reviewed — waiting to be composed into the next candidate', promotable: false };
  }
  if (f.status === 'stale') return { next: `stale — superseded by ${f.superseded_by?.slice(0, 8) ?? 'a newer freeze'}; the new SHA carries the work`, promotable: false };
  if (f.status === 'promoted') return { next: production?.status === 'deployed' ? 'in production' : 'promoted — waiting for the deployer', promotable: false };
  if (f.status === 'rejected') return { next: 'rejected', promotable: false };
  if (production && stagedOrShipped(production.status)) return { next: production.status === 'deployed' ? 'in production' : 'production GO sent — waiting for the deployer', promotable: false };
  if (production?.status === 'failed') return { next: `production failed: ${production.error ?? 'see report'} — fix, refreeze or retry`, promotable: false };
  if (f.verdict !== 'pass') return { next: f.verdict ? 'needs fixes — author fixes, refreezes, reviewer re-reviews' : 'waiting for an independent verdict', promotable: false };
  const sha8 = f.sha.slice(0, 8);
  const fullGreen = checks ? checks.full === 'green' : f.gate === 'GREEN' || !f.gate;
  const stageGreen = checks ? checks.quick === 'green' || checks.full === 'green' : f.gate !== 'RED';
  if (!checks && f.gate === 'RED') return { next: 'PASS but the remote gate is RED — not promotable until green', promotable: false };
  if (checks && !stageGreen) {
    if (checks.quick === 'pending') return { next: QUICK_CHECK_RUNNING, promotable: false };
    return { next: needsGreenQuick(sha8), promotable: false };
  }
  if (staging && (staging.status === 'sent' || staging.status === 'requested')) return { next: 'staging in progress', promotable: false };
  if (staging?.status === 'deployed' && !fullGreen) {
    if (checks?.full === 'red') return { next: fullFailFlag(checks.fullRun?.failing_step), promotable: false };
    return { next: needsGreenFull(sha8), promotable: false };
  }
  if (staging?.status === 'deployed' && staging.verified_by) return { next: `Ready for prod — ${staging.verified_by}`, promotable: false };
  if (staging?.status === 'deployed') return { next: 'on staging — mark Ready for prod', promotable: false };
  if (staging?.status === 'failed') return { next: `staging failed: ${staging.error ?? 'see report'}`, promotable: false };
  return { next: 'reviewed — stage it, then mark Ready for prod', promotable: true };
}

function mergeOnlyAgainst(previous: ReleaseFreeze | undefined, freeze: ReleaseFreeze): boolean {
  if (!previous || !freeze.project) return false;
  const repo = projectRepo(freeze.project);
  if (!repo) return false;
  const mainRef = resolveMainRef(repo, freeze.project);
  if (!mainRef) return false;
  try { return isMergeOnlyDelta(repo, previous.sha, freeze.sha, mainRef); } catch { return false; }
}

interface RankedFreeze extends ReleaseFreeze { rn: number }

function newestFreezes(): RankedFreeze[] {
  try {
    ensureReleaseFreezeTable();
    return getDb().prepare(`
      SELECT * FROM (
        SELECT f.*, ROW_NUMBER() OVER (
          PARTITION BY COALESCE(f.project, ''), COALESCE(NULLIF(f.lane, ''), f.sha)
          ORDER BY f.created_at DESC, f.rowid DESC
        ) AS rn
        FROM release_freezes f
      ) WHERE rn <= 2
    `).all() as RankedFreeze[];
  } catch {
    return [];
  }
}

function loadReleases(shas: string[]): Map<string, ReleaseRequest[]> {
  const map = new Map<string, ReleaseRequest[]>();
  if (shas.length === 0) return map;
  try { ensureReleaseTables(); } catch { return map; }
  const rows = queryAll<ReleaseRequest>(
    `SELECT * FROM release_requests WHERE sha IN (${placeholders(shas.length)}) ORDER BY created_at DESC`,
    shas,
  );
  for (const row of rows) {
    const list = map.get(row.sha) ?? [];
    list.push(row);
    map.set(row.sha, list);
  }
  return map;
}

function loadVerified(shas: string[]): Map<string, { verified_by: string; verified_at: string; note: string | null }> {
  const map = new Map<string, { verified_by: string; verified_at: string; note: string | null }>();
  if (shas.length === 0) return map;
  const rows = queryAll<{ sha: string; verified_by: string; verified_at: string; note: string | null }>(
    `SELECT sha, verified_by, verified_at, note FROM release_verifications WHERE sha IN (${placeholders(shas.length)})`,
    shas,
  );
  for (const row of rows) if (!map.has(row.sha)) map.set(row.sha, row);
  return map;
}

function loadSummaries(ids: string[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;
  const rows = queryAll<{ id: string; summary: string | null }>(
    `SELECT id, summary FROM runs WHERE id IN (${placeholders(ids.length)})`,
    ids,
  );
  for (const row of rows) map.set(row.id, row.summary);
  return map;
}

interface AgentFacts {
  statusSince: string | null;
  running: { id: string; task_id: string; started_at: string } | null;
  task: { num: number | null; prompt: string } | null;
  reply: { created_at: string; message: string } | null;
  alert: 'hung' | 'crashed' | null;
  review: { runId: string; needsReviewer: boolean } | null;
}

function loadAgentFacts(agentIds: string[]): Map<string, AgentFacts> {
  const facts = new Map<string, AgentFacts>();
  for (const id of agentIds) facts.set(id, { statusSince: null, running: null, task: null, reply: null, alert: null, review: null });
  if (agentIds.length === 0) return facts;
  const ph = placeholders(agentIds.length);

  for (const row of queryAll<{ entity_id: string; created_at: string }>(
    `SELECT e.entity_id, e.created_at FROM events e
     INNER JOIN (
       SELECT entity_id, MAX(id) AS id FROM events
       WHERE type = 'agent.status_changed' AND entity_id IN (${ph})
       GROUP BY entity_id
     ) m ON e.id = m.id`,
    agentIds,
  )) {
    const fact = facts.get(row.entity_id);
    if (fact) fact.statusSince = iso(row.created_at);
  }

  const alerts = queryAll<{ type: string; entity_id: string; created_at: string }>(
    `SELECT e.type, e.entity_id, e.created_at FROM events e
     INNER JOIN (
       SELECT type, entity_id, MAX(id) AS id FROM events
       WHERE type IN ('agent.hung', 'agent.crashed') AND entity_id IN (${ph})
       GROUP BY type, entity_id
     ) m ON e.id = m.id`,
    agentIds,
  );
  for (const row of alerts) {
    const fact = facts.get(row.entity_id);
    if (!fact) continue;
    const at = iso(row.created_at);
    const since = fact.statusSince;
    if (at && (!since || at > since)) {
      const kind = row.type === 'agent.hung' ? 'hung' : 'crashed';
      if (!fact.alert || kind === 'hung') fact.alert = kind;
    }
  }

  const runs = queryAll<{ id: string; agent_id: string; task_id: string; started_at: string }>(
    `SELECT id, agent_id, task_id, started_at FROM runs WHERE status = 'running' AND agent_id IN (${ph}) ORDER BY started_at DESC`,
    agentIds,
  );
  const taskIds: string[] = [];
  for (const row of runs) {
    const fact = facts.get(row.agent_id);
    if (!fact || fact.running) continue;
    fact.running = row;
    taskIds.push(row.task_id);
  }
  if (taskIds.length > 0) {
    const tasks = queryAll<{ id: string; num: number | null; prompt: string }>(
      `SELECT id, num, prompt FROM tasks WHERE id IN (${placeholders(taskIds.length)})`,
      taskIds,
    );
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const fact of facts.values()) {
      if (fact.running) fact.task = byId.get(fact.running.task_id) ?? null;
    }
  }

  const replies = queryAll<{ from_agent_id: string; created_at: string; message: string }>(
    `SELECT from_agent_id, created_at, message FROM agent_messages
     WHERE message_type = 'reply' AND from_agent_id IN (${ph})
     ORDER BY created_at DESC`,
    agentIds,
  );
  for (const row of replies) {
    const fact = facts.get(row.from_agent_id);
    if (fact && !fact.reply) fact.reply = { created_at: row.created_at, message: row.message };
  }

  const reviews = queryAll<{ agent_id: string; run_id: string; needs: number }>(
    `SELECT r.agent_id, r.id AS run_id,
       EXISTS(SELECT 1 FROM code_reviews c WHERE c.run_id = r.id AND c.status = 'pending' AND c.reviewer_type = 'cross-model' AND c.reviewer_agent_id IS NULL) AS needs
     FROM runs r WHERE r.agent_id IN (${ph}) AND r.status = 'done' AND r.review_status = 'pending'
       AND NOT EXISTS (SELECT 1 FROM release_freezes f WHERE f.run_id = r.id)
     ORDER BY r.finished_at DESC`,
    agentIds,
  );
  for (const row of reviews) {
    const fact = facts.get(row.agent_id);
    if (fact && !fact.review) fact.review = { runId: row.run_id, needsReviewer: !!row.needs };
  }
  return facts;
}

function emptyBoard(now = Date.now()): Board {
  let host = 'wavecode';
  try { host = getConfig().server?.host ?? host; } catch { /* config not loaded */ }
  return {
    at: new Date(now).toISOString(),
    host,
    agents: [],
    lanes: [],
    history: [],
    candidates: [],
    desk: null,
    fixes: [],
    attention: [],
    counts: { working: 0, idle: 0, error: 0, open_lanes: 0, promotable: 0, releases_open: 0, open_fixes: 0, unassigned_fixes: 0 },
  };
}

/** Slice the snapshot's attention. Counts stay the full totals; items are one page. */
export function pageAttention(board: Board, pageRaw: number): Board {
  const all = board.attention ?? [];
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / ATTENTION_PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Math.floor(pageRaw) || 1));
  const slice = all.slice((page - 1) * ATTENTION_PAGE_SIZE, page * ATTENTION_PAGE_SIZE);
  const counts = new Map<string, number>();
  for (const row of all) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  const groups: AttentionGroup[] = [...counts.entries()].map(([kind, count]) => ({
    kind,
    count,
    items: slice.filter((row) => row.kind === kind),
  }));
  return { ...board, attention: slice, attention_groups: groups, attention_total: total, attention_page: page, history: board.history ?? [] };
}

export function readOverviewSnapshot(): Board {
  try {
    const row = getDb().prepare('SELECT value FROM kv_settings WHERE key = ?').get(OVERVIEW_KV) as { value: string } | undefined;
    if (!row?.value) return emptyBoard();
    const parsed = JSON.parse(row.value) as Board;
    if (!parsed || !Array.isArray(parsed.agents) || !Array.isArray(parsed.attention)) return emptyBoard();
    parsed.history ??= [];
    parsed.lanes ??= [];
    parsed.fixes ??= [];
    parsed.candidates ??= [];
    return parsed;
  } catch {
    return emptyBoard();
  }
}

function writeOverviewSnapshot(board: Board): void {
  getDb().prepare(
    'INSERT INTO kv_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(OVERVIEW_KV, JSON.stringify(board));
}

/**
 * Rebuild the snapshot. Git and per-freeze work happen here, in the
 * background reconciler, not on the overview route.
 */
export async function reconcileOverview(now = Date.now()): Promise<Board> {
  try { reconcileMerged(now); } catch { /* git unavailable: the board still builds */ }
  try { await autoResolveObsoleteFreezes(); } catch { /* same */ }
  const board = await buildBoard(now);
  try { writeOverviewSnapshot(board); } catch { /* table missing in a partial test db */ }
  emit('overview.board', 'overview', 'board', { at: board.at, attention: board.attention.length }, null);
  return board;
}

/** @deprecated The route reads the snapshot. Kept so a test can drop a stale memo. */
export function resetBoardCacheForTest(): void {
  /* snapshot lives in kv_settings; tests get a fresh database */
}

export async function buildBoard(now = Date.now()): Promise<Board> {
  let projects: Array<string | null> = [];
  try {
    projects = (getDb().prepare(
      "SELECT DISTINCT project FROM release_freezes WHERE project IS NOT NULL",
    ).all() as { project: string }[]).map((row) => row.project);
  } catch { /* table missing */ }
  const tips = await deployTipsForProjects(projects);
  return withRefMemo(() => buildBoardPass(now, tips));
}

function buildBoardPass(now: number, tips: Map<string, DeployTipRead>): Board {
  const cfg = getConfig();
  const atIso = new Date(now).toISOString();
  const openQuestions = listPeerQuestions({ limit: 200 }).filter((q) => q.status === 'sent' || q.status === 'queued');
  const ranked = newestFreezes();
  const newest = ranked.filter((f) => f.rn === 1);
  const previous = new Map<string, RankedFreeze>();
  for (const row of ranked) if (row.rn === 2) previous.set(laneKey(row), row);

  const openFreezesByAuthor = new Map<string, number>();
  for (const row of queryAll<{ author_agent_id: string; n: number }>(
    "SELECT author_agent_id, COUNT(*) AS n FROM release_freezes WHERE status = 'open' AND author_agent_id IS NOT NULL GROUP BY author_agent_id",
    [],
  )) openFreezesByAuthor.set(row.author_agent_id, row.n);

  const attention: AttentionRow[] = [];
  const agentsAll = listAgents().filter((a) => !a.tmux_session.startsWith('wc-login-'));
  const facts = loadAgentFacts(agentsAll.map((a) => a.id));
  const agents: AgentBoardRow[] = agentsAll.map((a) => {
    const fact = facts.get(a.id)!;
    const statusSince = fact.statusSince;
    const forMin = minutesSince(statusSince, now);
    let current: AgentBoardRow['current'] = null;
    if (fact.running) {
      current = {
        task_id: fact.running.task_id,
        num: fact.task?.num ?? null,
        prompt: fact.task ? fact.task.prompt.slice(0, 200) : '',
        run_id: fact.running.id,
        started_at: iso(fact.running.started_at)!,
      };
    }
    const question = openQuestions.find((q) => q.from_agent_id === a.id);
    let blocked: string | null = null;
    if (fact.alert) blocked = fact.alert;
    else if (question) blocked = `awaiting peer answer (${question.peer}/${question.agent})`;
    else if (fact.review?.needsReviewer) blocked = 'needs reviewer';
    else if (fact.review) blocked = 'review pending';
    const usage = usageFor(a.runtime, a.profile);
    const weekly = usage?.metrics.find((m) => m.label === 'weekly') ?? null;
    const fiveH = usage?.metrics.find((m) => m.label === '5h') ?? null;
    if (fact.alert) attention.push({ kind: fact.alert, text: `@${a.alias ?? a.name} ${fact.alert}`, agent_id: a.id });
    if (question) attention.push({ kind: 'awaiting_answer', text: `@${a.alias ?? a.name} waits for ${question.peer}/${question.agent} (${minutesSince(iso(question.created_at), now) ?? '?'} min)`, agent_id: a.id });
    if (fact.review?.needsReviewer) attention.push({ kind: 'needs_reviewer', text: `@${a.alias ?? a.name}'s run needs a reviewer`, agent_id: a.id, run_id: fact.review.runId });
    if (a.status === 'idle' && current && forMin !== null && forMin >= IDLE_WITH_WORK_MIN) {
      attention.push({ kind: 'idle_with_open_work', text: `@${a.alias ?? a.name} idle ${forMin} min with task #${current.num ?? '?'} still open`, agent_id: a.id, run_id: current.run_id });
    }
    return {
      id: a.id, name: a.name, alias: a.alias ?? null, runtime: a.runtime, model: (a as { model?: string | null }).model ?? null,
      status: a.status, status_since: statusSince, for_min: forMin, current,
      last_reply: fact.reply ? { at: iso(fact.reply.created_at)!, text: fact.reply.message.slice(0, 240) } : null,
      blocked_on: blocked, usage: usage?.summary ?? null,
      budget: { weekly_left: weekly?.left_pct ?? null, five_h_left: fiveH?.left_pct ?? null, resets: weekly?.resets ?? null },
      open_freezes: openFreezesByAuthor.get(a.id) ?? 0,
    };
  });

  const laneFreezes = newest.filter((f) => f.run_id && (
    f.status === 'open' || f.status === 'behind-main' || (f.status === 'promoted' && (minutesSince(iso(f.updated_at), now) ?? PROMOTED_WINDOW_MIN) < PROMOTED_WINDOW_MIN)
  ));
  const historyFreezes = newest.filter((f) => f.run_id && f.status === 'stale');
  const releaseShas = [...new Set([...laneFreezes, ...historyFreezes].map((f) => f.sha))];
  const releases = loadReleases(releaseShas);
  const verified = loadVerified(releaseShas);
  const summaries = loadSummaries([...new Set([...laneFreezes, ...historyFreezes].map((f) => f.run_id).filter((id): id is string => !!id))]);

  const awaitingDeploy = new Map<string, boolean>();
  const mergedNotDeployed = (project: string | null, sha: string): boolean => {
    const key = `${project ?? ''}\0${sha}`;
    const cached = awaitingDeploy.get(key);
    if (cached !== undefined) return cached;
    const value = isMergedNotDeployed(project, sha, (project ? tips.get(project) : undefined) ?? { state: 'unknown' });
    awaitingDeploy.set(key, value);
    return value;
  };

  const toRow = (f: RankedFreeze, mergeOnly: boolean): LaneBoardRow => {
    const rels = releases.get(f.sha) ?? [];
    const staging = rels.find((r) => r.target === 'staging') ?? null;
    const production = rels.find((r) => r.target === 'production') ?? null;
    let candidate: string | null = null;
    if ((f.status === 'open' || f.status === 'behind-main') && f.project) {
      try { candidate = candidateFor(f.project, f.sha, now)?.name ?? null; } catch { candidate = null; }
    }
    const checks = f.status === 'stale' ? null : liveChecks(f);
    const step = mergedNotDeployed(f.project, f.sha)
      ? { next: 'merged, not yet deployed', promotable: false }
      : nextStep(f, staging, production, candidate, checks);
    const promotable = step.promotable && !mergeOnly && f.status === 'open' && !stagedOrShipped(staging?.status) && !stagedOrShipped(production?.status);
    const sha8 = f.sha.slice(0, 8);
    const fullGreen = checks ? checks.full === 'green' : f.gate === 'GREEN' || !f.gate;
    const full_fail_flag = staging?.status === 'deployed' && checks?.full === 'red' ? fullFailFlag(checks.fullRun?.failing_step) : null;
    const promote_block = fullGreen ? null : (checks || f.gate === 'RED' ? `full run not green on ${sha8}` : null);
    const summary = f.run_id ? summaries.get(f.run_id) : null;
    return {
      sha: f.sha, run_id: f.run_id, project: f.project, desk: f.desk, lane: f.lane, author: f.author_name, reviewer: f.reviewer_name,
      verdict: f.verdict, gate: f.gate, status: f.status, superseded_by: f.superseded_by, promotable, candidate,
      summary: summary ? summary.replace(/\s+/g, ' ').slice(0, 600) : null,
      staging: releaseCell(staging, verified), production: releaseCell(production, verified), next: step.next, full_fail_flag, promote_block, updated_at: iso(f.updated_at)!,
    };
  };

  const lanes: LaneBoardRow[] = [];
  const mergeOnlyShas = new Set<string>();
  for (const f of laneFreezes) {
    const mergeOnly = mergeOnlyAgainst(previous.get(laneKey(f)), f);
    if (mergeOnly) mergeOnlyShas.add(f.sha);
    const row = toRow(f, mergeOnly);
    lanes.push(row);
    if (row.promotable) attention.push({ kind: 'promotable', text: `${f.project ?? ''}${f.desk ? ` Desk #${f.desk}` : ''} ${f.sha.slice(0, 8)}: ${row.next}`, sha: f.sha, run_id: f.run_id! });
    for (const cell of [row.staging, row.production]) {
      if (cell?.status === 'failed') attention.push({ kind: 'release_failed', text: `${cell === row.staging ? 'staging' : 'production'} failed for ${f.sha.slice(0, 8)}: ${cell.error ?? ''}`, sha: f.sha, run_id: f.run_id! });
    }
  }
  const history = historyFreezes.map((f) => toRow(f, true));

  const fixes: FixRow[] = [];
  const inCandidate = new Set(lanes.filter((l) => l.candidate).map((l) => l.sha));
  const fixFreezes = newest.filter((f) => {
    if (!f.run_id || f.status === 'stale' || f.status === 'merged') return false;
    if (mergedNotDeployed(f.project, f.sha)) return false;
    if (mergeOnlyShas.has(f.sha)) return false;
    if (inCandidate.has(f.sha)) return false;
    if (!withinFixWindow(f.updated_at, now)) return false;
    return true;
  });
  const fixReleases = loadReleases([...new Set(fixFreezes.map((f) => f.sha).filter((sha) => !releases.has(sha)))]);
  for (const [sha, rows] of fixReleases) releases.set(sha, rows);
  const assigned = loadFixAssignments(fixFreezes.map((f) => f.sha));
  for (const f of fixFreezes) {
    const rels = releases.get(f.sha) ?? [];
    const failed = rels.find((r) => r.status === 'failed');
    let reason: FixRow['reason'] | null = null;
    let detail: string | null = null;
    if (f.status === 'open' && (f.verdict === 'needs-fixes' || f.verdict === 'reject')) { reason = 'needs fixes'; detail = f.verdict_path; }
    else if (f.status !== 'rejected' && failed) { reason = 'release failed'; detail = `${failed.target}: ${failed.error ?? 'see report'}`; }
    else if (f.status === 'rejected' && f.decision_reason) { reason = 'rejected'; detail = f.decision_reason; }
    if (!reason) continue;
    let task = assigned.get(f.sha) ?? null;
    if (task?.status === 'done') continue;
    if (!task && f.author_agent_id && f.run_id) {
      const author = getAgent(f.author_agent_id);
      const denied = !author.ok || isCodex1(author.data) || laneAutomationDenied(f.project, author.data, f.lane);
      if (!denied) {
        const made = assignFixTask({ runId: f.run_id, agentId: f.author_agent_id, via: 'auto', enforceLease: false, actorName: 'overview' });
        if (made.ok) {
          task = { task_id: made.task.id, num: made.task.num ?? null, status: made.task.status, agent_id: made.agent.id, agent_name: made.agent.name };
        }
      }
    }
    const since = iso(f.updated_at)!;
    fixes.push({
      sha: f.sha, run_id: f.run_id!, project: f.project, desk: f.desk, lane: f.lane, author: f.author_name,
      author_agent_id: f.author_agent_id, reviewer: f.reviewer_name, reason, detail, since, assigned: task,
    });
    if (!task) attention.push({ kind: 'fix_unassigned', text: `${f.project ?? ''}${f.desk ? ` Desk #${f.desk}` : ''} ${f.sha.slice(0, 8)} ${reason} — nobody assigned`, sha: f.sha, run_id: f.run_id!, agent_id: f.author_agent_id ?? undefined });
  }

  const candidates: CandidateRow[] = [];
  for (const project of Object.keys(cfg.projects ?? {})) {
    let refs: ReturnType<typeof listCandidates> = [];
    try { refs = listCandidates(project, now); } catch { refs = []; }
    const tips = refs.map((c) => c.tip);
    const tipReleases = loadReleases(tips.filter((sha) => !releases.has(sha)));
    for (const [sha, rows] of tipReleases) releases.set(sha, rows);
    const tipVerified = loadVerified(tips);
    for (const [sha, row] of tipVerified) if (!verified.has(sha)) verified.set(sha, row);
    for (const c of refs) {
      const rels = releases.get(c.tip) ?? [];
      const staging = rels.find((r) => r.target === 'staging') ?? null;
      const production = rels.find((r) => r.target === 'production') ?? null;
      const v = verified.get(c.tip) ?? verificationFor(c.tip);
      const contained = lanes.filter((l) => l.candidate === c.name).map((l) => ({ sha: l.sha, desk: l.desk, lane: l.lane, verdict: l.verdict, author: l.author }));
      let next: string;
      if (production && (production.status === 'sent' || production.status === 'requested')) next = 'production GO sent — waiting for the deployer';
      else if (production?.status === 'deployed') next = 'deployed to production — main will catch up on merge';
      else if (production?.status === 'failed') next = `production failed: ${production.error ?? 'see report'}`;
      else if (v) next = `Ready for prod — ${v.verified_by}`;
      else if (staging?.status === 'deployed') next = 'on staging — mark Ready for prod, then an admin sends the GO';
      else if (staging && (staging.status === 'sent' || staging.status === 'requested')) next = 'staging in progress';
      else next = 'composed — staged by the deployer on its own; mark Ready for prod, then an admin sends the GO';
      const stagingCell = releaseCell(staging, verified);
      const productionCell = releaseCell(production, verified);
      candidates.push({
        project, name: c.name, tip: c.tip, committed_at: c.committed_at, lanes: contained,
        staging: stagingCell, production: productionCell,
        verified: v ? { by: v.verified_by, at: iso(v.verified_at)!, note: v.note } : null, next,
      });
      const staged = stagedOrShipped(staging?.status);
      const shipped = stagedOrShipped(production?.status);
      if (v && !staged && !shipped) attention.push({ kind: 'promotable', text: `${project} ${c.name} Ready for prod — ${v.verified_by}`, sha: c.tip });
    }
  }

  let desk: DeskBoardRow[] | null = null;
  if (deskConfig().enabled) {
    const cached = productDesk.cachedBoard();
    desk = (cached ?? []).filter((d: DeskItem) => OPEN_STATUSES.has(d.status)).map((d) => {
      const links = productDesk.linksFor(d.id);
      return {
        id: d.id, status: d.status, title: d.title, area: d.area, priority: d.priority, target_version: d.target_version, updated_at: d.updated_at,
        lanes: links.lanes.map((l) => ({ sha: l.sha, verdict: l.verdict, status: l.status })),
        tasks: links.tasks.map((t) => ({ num: t.num, status: t.status, agent: t.agent_name })),
      };
    });
  }

  let releasesOpen = 0;
  try {
    ensureReleaseTables();
    const row = getDb().prepare("SELECT COUNT(*) AS n FROM release_requests WHERE status IN ('sent', 'requested')").get() as { n: number };
    releasesOpen = row.n;
  } catch { /* table missing */ }

  return {
    at: atIso,
    host: cfg.server?.host ?? 'wavecode',
    agents,
    lanes,
    history,
    candidates,
    desk,
    fixes,
    attention,
    counts: {
      working: agents.filter((a) => a.status === 'working').length,
      idle: agents.filter((a) => a.status === 'idle').length,
      error: agents.filter((a) => a.status === 'error').length,
      open_lanes: lanes.filter((l) => l.status === 'open').length,
      promotable: lanes.filter((l) => l.promotable && l.status === 'open').length,
      releases_open: releasesOpen,
      open_fixes: fixes.length,
      unassigned_fixes: fixes.filter((x) => !x.assigned).length,
    },
  };
}
