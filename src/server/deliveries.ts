/**
 * Delivery tracker: a feature from spec to production as one durable record
 * (docs/ops/delivery-tracker-plan.md). Temporal's model without Temporal's server:
 * every stage is a span with a Start-To-Close budget, the WaveCode events the
 * pipeline already writes are the signals, and a one-minute tick turns an
 * overrun or a pipeline refusal into one `delivery.stalled` event plus one
 * message to the seats that should act. Nothing here runs an agent, merges, or
 * deploys; it only derives and reports.
 *
 * Spans are derived, never hand-written: `deriveDelivery` rebuilds every stage
 * row of a delivery from the events of its lanes and the SHAs seen on them, so
 * a restart or a new lane just re-derives.
 */

import { ulid } from 'ulid';
import { getConfig } from './config.js';
import { getAgent, getDb, listAgents, listTasks, type Result, type Task } from './db.js';
import { listFreezes } from './release-freezes.js';
import { mainSpec } from './lane-main.js';
import { workspaceMatches } from './project-gate.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { tellDriverSeats } from './wire-lines.js';
import { recordJob } from './perf-monitor.js';

export const STAGES = ['spec', 'build', 'first_pass', 'gates', 'review', 'land', 'candidate', 'release'] as const;
export type Stage = (typeof STAGES)[number];
export type StageOutcome = 'ok' | 'fail' | 'skipped' | 'superseded';
export type DeliveryStatus = 'open' | 'done' | 'failed' | 'cancelled';

/** Start-To-Close budgets in minutes (docs/ops/delivery-tracker-plan.md, "Stages"). */
export const DEFAULT_BUDGETS_MIN: Record<Stage, number> = {
  spec: 120, build: 180, first_pass: 20, gates: 25, review: 45, land: 30, candidate: 60, release: 45,
};

export interface Delivery {
  id: string;
  title: string;
  project: string | null;
  goal_id: string | null;
  spec_path: string | null;
  /** Product-desk number (PD-134): every lane whose freeze carries it joins this delivery. */
  desk: number | null;
  lanes: string[];
  shas: string[];
  release_lane: boolean;
  stage: Stage | null;
  stage_started_at: string | null;
  last_progress_at: string | null;
  attempts: number;
  status: DeliveryStatus;
  stall_cause: string | null;
  stall_at: string | null;
  created_by: string | null;
  since_at: string;
  created_at: string;
  updated_at: string;
  /** Tasks this record tracks: build starts when one is dispatched (v31). */
  task_ids: string[];
  /** Agents building it: a hung one blocks the open build span (v31). */
  agent_ids: string[];
}

export interface StageSpan {
  id?: number;
  delivery_id: string;
  stage: Stage;
  attempt: number;
  started_at: string;
  finished_at: string | null;
  outcome: StageOutcome | null;
  cause: string | null;
  actor: string | null;
  sha: string | null;
  lane: string | null;
  event_id: number | null;
}

interface Row {
  id: string; title: string; project: string | null; goal_id: string | null; spec_path: string | null; desk: number | null;
  lanes_json: string; shas_json: string; release_lane: number; stage: string | null; stage_started_at: string | null;
  last_progress_at: string | null; attempts: number; status: string; stall_cause: string | null; stall_at: string | null;
  task_ids_json?: string; agent_ids_json?: string;
  created_by: string | null; since_at: string; created_at: string; updated_at: string;
}

interface Ev {
  id: number;
  type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  created_at: string;
  /** created_at as epoch ms, parsed once at load: the tick compares it per delivery. */
  at_ms: number;
}

const STAGE_ORDER = new Map<Stage, number>(STAGES.map((s, i) => [s, i]));
/**
 * A recorded freeze note emits no event of its own: the pipeline's first reaction to it (gate, quick check,
 * first-pass request, review assignment) or the queue taking the SHA is the freeze signal. A refusal, a note,
 * a verdict or a gate result names a SHA without adopting it.
 */
const ADOPTING = new Set(['pipeline.frozen', 'pipeline.gate', 'pipeline.quick', 'pipeline.first_pass_requested', 'pipeline.review', 'merge_queue.queued', 'merge_queue.merged', 'merge_queue.bounced']);
const SHA_RE = /^[0-9a-f]{40}$/i;

/** Event types the derivation reads. Everything else stays untouched. */
const SIGNAL_TYPES = [
  'run.finished', 'run.failed', 'agent.hung', 'agent.resumed',
  'pipeline.frozen', 'pipeline.quick', 'pipeline.gate', 'gate.result', 'pipeline.first_pass_requested',
  'pipeline.first_pass', 'pipeline.first_pass_timeout', 'pipeline.review', 'review.ai_completed', 'review.superseded', 'pipeline.candidate_review',
  'merge_queue.queued', 'merge_queue.merged', 'merge_queue.bounced', 'pipeline.refused', 'pipeline.action',
  'release.requested', 'release.reported', 'task.dispatched', 'task.created', 'lane.retired',
];

function nowIso(): string {
  return new Date().toISOString();
}

function toIso(sqlite: string): string {
  // events.created_at is `datetime('now')` ("YYYY-MM-DD HH:MM:SS", UTC); normalise to ISO.
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sqlite) ? sqlite.replace(' ', 'T') + 'Z' : sqlite);
  return Number.isNaN(d.getTime()) ? sqlite : d.toISOString();
}

function rowToDelivery(r: Row): Delivery {
  return {
    id: r.id, title: r.title, project: r.project, goal_id: r.goal_id, spec_path: r.spec_path, desk: r.desk ?? null,
    lanes: parseList(r.lanes_json), shas: parseList(r.shas_json), release_lane: r.release_lane === 1,
    stage: (r.stage as Stage | null) ?? null, stage_started_at: r.stage_started_at, last_progress_at: r.last_progress_at,
    attempts: r.attempts, status: r.status as DeliveryStatus, stall_cause: r.stall_cause, stall_at: r.stall_at,
    created_by: r.created_by, since_at: r.since_at, created_at: r.created_at, updated_at: r.updated_at,
    task_ids: parseList(r.task_ids_json ?? '[]'), agent_ids: parseList(r.agent_ids_json ?? '[]'),
  };
}

function parseList(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

export function normalizeLane(lane: string): string {
  return lane.trim().replace(/^refs\/heads\//, '').replace(/^origin\//, '');
}

// --- CRUD -----------------------------------------------------------------------------------

export interface CreateDeliveryOpts {
  /** Defaults to `PD-<desk>` when a desk number is given. */
  title?: string;
  desk?: number | null;
  project?: string | null;
  lanes?: string[];
  goal_id?: string | null;
  spec_path?: string | null;
  release_lane?: boolean;
  /** Events before this instant are ignored. Default: 24 h before creation (a lane usually predates its record). */
  since?: string | null;
  created_by?: string | null;
  /** Tasks the record tracks; with them (or agents) the build stage starts at `since`, not spec. */
  task_ids?: string[];
  agent_ids?: string[];
}

export function createDelivery(opts: CreateDeliveryOpts): Result<Delivery> {
  const desk = opts.desk === undefined || opts.desk === null ? null : Number(opts.desk);
  if (desk !== null && (!Number.isInteger(desk) || desk <= 0)) return { ok: false, error: 'desk must be a positive product-desk number' };
  const title = opts.title?.trim() || (desk !== null ? `PD-${desk}` : '');
  if (!title) return { ok: false, error: 'title is required' };
  if (desk !== null) {
    const dup = findOpenByDesk(desk);
    if (dup) return { ok: false, error: `PD-${desk} is already tracked as ${dup.id} (${dup.title})` };
  }
  const lanes = [...new Set((opts.lanes ?? []).map(normalizeLane).filter(Boolean))];
  if (lanes.some((l) => l.length > 120 || /\s/.test(l))) return { ok: false, error: 'lanes must be branch names' };
  const since = opts.since ? new Date(opts.since) : new Date(Date.now() - 24 * 3600_000);
  if (Number.isNaN(since.getTime())) return { ok: false, error: 'since must be an ISO date' };
  const taskIds = [...new Set((opts.task_ids ?? []).filter((t) => typeof t === 'string' && t))];
  const agentIds = [...new Set((opts.agent_ids ?? []).filter((a) => typeof a === 'string' && a))];
  const id = ulid();
  const now = nowIso();
  const firstStage = taskIds.length || agentIds.length ? 'build' : 'spec';
  getDb().prepare(`INSERT INTO deliveries (id, title, project, goal_id, spec_path, desk, lanes_json, shas_json, release_lane, stage, stage_started_at, attempts, status, created_by, since_at, created_at, updated_at, task_ids_json, agent_ids_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 1, 'open', ?, ?, ?, ?, ?, ?)`)
    .run(id, title, opts.project ?? null, opts.goal_id ?? null, opts.spec_path ?? null, desk, JSON.stringify(lanes), opts.release_lane ? 1 : 0, firstStage, now, opts.created_by ?? null, since.toISOString(), now, now, JSON.stringify(taskIds), JSON.stringify(agentIds));
  const d = getDelivery(id)!;
  emit('delivery.created', 'delivery', id, { title, project: d.project, desk, lanes, goal_id: d.goal_id, release_lane: d.release_lane, task_ids: taskIds, agent_ids: agentIds });
  return { ok: true, data: d };
}

export function addTasks(id: string, taskIds: string[]): Result<Delivery> {
  const d = getDelivery(id);
  if (!d) return { ok: false, error: 'delivery not found' };
  const merged = [...new Set([...d.task_ids, ...taskIds.filter(Boolean)])];
  getDb().prepare('UPDATE deliveries SET task_ids_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), nowIso(), id);
  return { ok: true, data: getDelivery(id)! };
}

export function addAgents(id: string, agentIds: string[]): Result<Delivery> {
  const d = getDelivery(id);
  if (!d) return { ok: false, error: 'delivery not found' };
  const merged = [...new Set([...d.agent_ids, ...agentIds.filter(Boolean)])];
  getDb().prepare('UPDATE deliveries SET agent_ids_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), nowIso(), id);
  return { ok: true, data: getDelivery(id)! };
}

export function getDelivery(id: string): Delivery | null {
  const r = getDb().prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as Row | undefined;
  return r ? rowToDelivery(r) : null;
}

export function listDeliveries(opts: { status?: DeliveryStatus | 'all'; limit?: number; desk?: number | null } = {}): Delivery[] {
  const status = opts.status ?? 'open';
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const where: string[] = [];
  const args: unknown[] = [];
  if (status !== 'all') { where.push('status = ?'); args.push(status); }
  if (opts.desk !== undefined && opts.desk !== null) { where.push('desk = ?'); args.push(opts.desk); }
  const sql = `SELECT * FROM deliveries${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`;
  const rows = getDb().prepare(sql).all(...args, limit) as Row[];
  return rows.map(rowToDelivery);
}

const BRANCH_RE = /^[\w.-]+(?:\/[\w.-]+)*$/;
const ADOPT_MAX_AGE_MS = 14 * 24 * 3600_000;
const DESK_MARK_RE = /(?:^|[-_/.])(?:pd|desk)[-_]?(\d{1,6})(?=$|[-_/.])/i;

/**
 * The desk a lane is MARKED with: in the branch name (`wc-codex7-pd162-reland`, `codex2/pd108-s1-fixes`)
 * or in the freeze note's file name (`desk91-freeze-<sha>.md`). A desk only mentioned in the note's prose
 * ("after PD-162 lands") is a reference, not a mark: the first adoption (27 Oct 23:57) swept
 * four main-sync lanes into PD-162 that way. The freeze's own `desk` must agree when it is set.
 */
export function markedDesk(f: { desk: number | null; lane: string | null; freeze_path?: string | null }): number | null {
  const fromLane = f.lane ? DESK_MARK_RE.exec(normalizeLane(f.lane)) : null;
  const base = f.freeze_path ? f.freeze_path.split('/').pop() ?? '' : '';
  const fromFile = base ? DESK_MARK_RE.exec(base) : null;
  const n = fromLane ? Number(fromLane[1]) : fromFile ? Number(fromFile[1]) : null;
  if (!n) return null;
  if (f.desk && f.desk !== n) return null;
  return n;
}

/** sqlite `datetime('now')` stamps are UTC without a zone; ISO stamps carry one. */
function parseStamp(text: string): number | null {
  const t = text.trim();
  const ms = /(?:Z|[+-]\d\d:?\d\d)$/.test(t) ? Date.parse(t) : Date.parse(`${t.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function findOpenByDesk(desk: number): Delivery | null {
  const r = getDb().prepare("SELECT * FROM deliveries WHERE desk = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1").get(desk) as Row | undefined;
  return r ? rowToDelivery(r) : null;
}

/**
 * Desk numbers are the handle people use (27 Oct 2026: "mark each feature and fix with a
 * product-desk number"). A freeze note that carries one (`desk91-freeze-<sha>.md`, `Desk #134`)
 * joins its lane to the open delivery of that desk, or opens one named PD-<n>. Off with
 * `deliveries.auto_desk: false`.
 */
export function adoptDeskLanes(freezes: Array<{ desk: number | null; lane: string | null; project: string | null; created_at: string; freeze_path?: string | null }>, now = Date.now()): { created: string[]; joined: string[] } {
  const out = { created: [] as string[], joined: [] as string[] };
  if (getConfig().deliveries?.auto_desk === false) return out;
  const byDesk = new Map<number, Array<{ lane: string; project: string | null; created_at: string }>>();
  for (const f of freezes) {
    const desk = markedDesk(f);
    if (!desk || !f.lane) continue;
    const lane = normalizeLane(f.lane);
    if (!BRANCH_RE.test(lane) || lane.length < 6) continue; // a word parsed out of prose is not a lane
    const born = parseStamp(f.created_at);
    if (born === null || now - born > ADOPT_MAX_AGE_MS) continue;
    const list = byDesk.get(desk) ?? [];
    list.push({ lane, project: f.project, created_at: f.created_at });
    byDesk.set(desk, list);
  }
  for (const [desk, list] of byDesk) {
    const lanes = [...new Set(list.map((l) => l.lane))];
    const existing = findOpenByDesk(desk);
    if (existing) {
      const missing = lanes.filter((l) => !existing.lanes.includes(l));
      if (missing.length) { addLanes(existing.id, missing); out.joined.push(`${existing.id}:${missing.join(',')}`); }
      continue;
    }
    const first = list.map((l) => l.created_at).sort()[0];
    const firstMs = parseStamp(first);
    const since = firstMs !== null ? new Date(firstMs - 24 * 3600_000).toISOString() : null;
    const created = createDelivery({ desk, project: list.find((l) => l.project)?.project ?? null, lanes, since, created_by: 'tracker' });
    if (created.ok) out.created.push(created.data.id);
  }
  return out;
}

// --- every task and lane gets a record (28 Oct 2026) ------------------------------------------

export interface WorkLane {
  project: string | null;
  lane: string;
  /** The lane's author (the agent whose workspace is on it), when known. */
  author_agent_id: string | null;
  /** ISO time of the lane's first own commit; the build stage starts there. */
  started_at: string | null;
}

export interface WorkSnapshot {
  /** Running tasks (status `running`) with their agent's current lane, when it has one. */
  tasks: Array<{ task: Task; lane: string | null; project: string | null }>;
  /** Developer lanes ahead of main. */
  lanes: WorkLane[];
}

/** A review/verify task the pipeline made for a freeze is not a piece of work of its own. */
function isPipelineTask(t: Task): boolean {
  return t.template === 'review' || t.template === 'verify' || /^Release freeze /.test(t.prompt);
}

function titleOf(prompt: string): string {
  const line = prompt.split('\n').map((l) => l.trim()).find((l) => l && !/^\[/.test(l)) ?? prompt.trim();
  return (line.length > 90 ? `${line.slice(0, 87)}…` : line) || 'Task';
}

/**
 * Open a record for every running task and every developer lane that no open record covers
 * ("I want tracking for each task", Denis, 28 Oct 2026). A task joins the record of its agent's
 * lane when one exists; a lane marked with a desk number joins PD-<n>; the rest get a record of
 * their own, opened in build. Off with `deliveries.auto_track: false`.
 */
export function adoptWork(work: WorkSnapshot, now = Date.now()): { created: string[]; joined: string[] } {
  const out = { created: [] as string[], joined: [] as string[] };
  if (getConfig().deliveries?.auto_track === false) return out;
  const open = listDeliveries({ status: 'open', limit: 500 });
  const byLane = new Map<string, Delivery>();
  const byTask = new Map<string, Delivery>();
  for (const d of open) { for (const l of d.lanes) byLane.set(l, d); for (const t of d.task_ids) byTask.set(t, d); }
  const laneRecord = (lane: string) => byLane.get(normalizeLane(lane)) ?? null;

  for (const { task, lane, project } of work.tasks) {
    if (task.status !== 'running' || isPipelineTask(task) || byTask.has(task.id)) continue;
    const born = parseStamp(task.created_at);
    if (born === null || now - born > ADOPT_MAX_AGE_MS) continue;
    const agentIds = task.agent_id ? [task.agent_id] : [];
    const existing = lane ? laneRecord(lane) : null;
    if (existing) {
      addTasks(existing.id, [task.id]); if (agentIds.length) addAgents(existing.id, agentIds);
      byTask.set(task.id, existing); out.joined.push(`${existing.id}:task:${task.id}`); continue;
    }
    const goalMate = task.goal_id ? open.find((d) => d.goal_id === task.goal_id) : null;
    if (goalMate) { addTasks(goalMate.id, [task.id]); if (agentIds.length) addAgents(goalMate.id, agentIds); byTask.set(task.id, goalMate); out.joined.push(`${goalMate.id}:task:${task.id}`); continue; }
    const created = createDelivery({ title: titleOf(task.prompt), project, lanes: lane ? [lane] : [], goal_id: task.goal_id, task_ids: [task.id], agent_ids: agentIds, since: new Date(born).toISOString(), created_by: 'tracker' });
    if (created.ok) { out.created.push(created.data.id); byTask.set(task.id, created.data); if (lane) byLane.set(normalizeLane(lane), created.data); }
  }

  for (const l of work.lanes) {
    const lane = normalizeLane(l.lane);
    if (!BRANCH_RE.test(lane) || lane.length < 6) continue;
    const covered = laneRecord(lane);
    if (covered) {
      // a record opened by hand knows no agent yet: the lane's author joins it, so a hung agent blocks it
      if (l.author_agent_id && covered.agent_ids.length === 0) { addAgents(covered.id, [l.author_agent_id]); out.joined.push(`${covered.id}:agent:${l.author_agent_id}`); }
      continue;
    }
    const born = l.started_at ? parseStamp(l.started_at) : null;
    if (born !== null && now - born > ADOPT_MAX_AGE_MS) continue;
    const desk = markedDesk({ desk: null, lane });
    const agentIds = l.author_agent_id ? [l.author_agent_id] : [];
    if (desk) {
      const pd = findOpenByDesk(desk);
      if (pd) { addLanes(pd.id, [lane]); if (agentIds.length) addAgents(pd.id, agentIds); byLane.set(lane, pd); out.joined.push(`${pd.id}:${lane}`); continue; }
      const created = createDelivery({ desk, project: l.project, lanes: [lane], agent_ids: agentIds, since: born !== null ? new Date(born).toISOString() : null, created_by: 'tracker' });
      if (created.ok) { out.created.push(created.data.id); byLane.set(lane, created.data); }
      continue;
    }
    const created = createDelivery({ title: lane, project: l.project, lanes: [lane], agent_ids: agentIds, since: born !== null ? new Date(born).toISOString() : null, created_by: 'tracker' });
    if (created.ok) { out.created.push(created.data.id); byLane.set(lane, created.data); }
  }
  return out;
}

/** Lanes already examined, by tip: a lane is re-read from git only when its tip moves. */
const laneSeen = new Map<string, { sha: string; lane: WorkLane | null }>();
/** A remote lane counts as work in progress when its last own (non-merge) commit or its freeze is under two days old, or an agent's workspace is on it (109 open freezes on the box go back three weeks, and main syncs move every clean lane's tip: neither means anyone is working). */
const ACTIVE_LANE_MS = 48 * 3600_000;

/**
 * What the tick hands to adoptWork: running tasks with their agent's lane, and every developer lane
 * (`lane_glob`) on the remote that is ahead of main and active (tip moved in the last two days, or an
 * open freeze), read from git directly (the lane board is cold after a restart and slow with hundreds
 * of stale refs; the first sweep over 14 days opened 106 records, mostly abandoned lanes). Two git
 * calls per lane, once per tip.
 */
async function gatherWork(): Promise<WorkSnapshot> {
  if (getConfig().deliveries?.auto_track === false) return { tasks: [], lanes: [] };
  const { execFileAsync } = await import('./proc.js');
  const { globToRe } = await import('./developers.js');
  const git = async (repo: string, args: string[]) => (await execFileAsync('git', ['-C', repo, ...args], { timeout: 15_000 })).trim();
  const freezes = (() => { try { return listFreezes(); } catch { return []; } })();
  const lanes: WorkLane[] = [];
  for (const [project, pc] of Object.entries(getConfig().projects ?? {})) {
    if (!pc.repo) continue;
    const spec = mainSpec(project);
    const re = globToRe(pc.lane_glob || 'wc-*');
    let refs: string[] = [];
    try { refs = (await git(pc.repo, ['for-each-ref', '--format=%(refname:short) %(objectname)', `refs/remotes/${spec.remote}`])).split('\n'); } catch { continue; }
    for (const line of refs) {
      const [short, sha] = line.trim().split(/\s+/);
      if (!short || !sha) continue;
      const lane = short.startsWith(`${spec.remote}/`) ? short.slice(spec.remote.length + 1) : short;
      if (lane === 'HEAD' || lane === spec.branch || !re.test(lane)) continue;
      const key = `${project}:${lane}`;
      const seen = laneSeen.get(key);
      if (seen && seen.sha === sha) { if (seen.lane) lanes.push(seen.lane); continue; }
      let entry: WorkLane | null = null;
      try {
        const own = await git(pc.repo, ['log', '--reverse', '--format=%cI', `${spec.ref}..${sha}`]);
        const firstOwn = own.split('\n').map((l) => l.trim()).find(Boolean) ?? null;
        // the lane's last own commit, merges excluded: WaveCode's main syncs move every clean lane's tip without anyone working on it
        const tipAt = Date.parse(await git(pc.repo, ['log', '-1', '--no-merges', '--format=%cI', `${spec.ref}..${sha}`]));
        // ahead of main, and active: touched in the last two days or frozen and still open. An abandoned lane is not work in progress.
        const freeze = freezes.find((f) => f.lane === lane && f.project === project && (f.status === 'open' || f.status === 'behind-main') && (parseStamp(f.created_at) ?? 0) >= Date.now() - ACTIVE_LANE_MS);
        const recent = Number.isFinite(tipAt) && Date.now() - tipAt <= ACTIVE_LANE_MS;
        if (firstOwn && (recent || freeze)) {
          const author = freeze?.author_agent_id ?? freezes.find((f) => f.lane === lane && f.project === project && f.author_agent_id)?.author_agent_id ?? null;
          entry = { project, lane, author_agent_id: author, started_at: firstOwn };
        }
      } catch { /* a ref git cannot read is not a lane */ }
      laneSeen.set(key, { sha, lane: entry });
      if (entry) lanes.push(entry);
    }
  }
  // Work that exists only in a workspace so far (a prompt, no push yet): a working agent's lane branch counts
  // from the moment it exists, with the agent as author and the build starting now.
  const have = new Set(lanes.map((l) => `${l.project}:${l.lane}`));
  for (const agent of listAgents()) {
    if (agent.status !== 'working' || !agent.workspace) continue;
    const project = projectOfWorkspace(agent.workspace);
    if (!project) continue;
    const re = globToRe(getConfig().projects?.[project]?.lane_glob || 'wc-*');
    let lane: string | null = null;
    try { lane = (await git(agent.workspace, ['branch', '--show-current'])) || null; } catch { continue; }
    if (!lane || !re.test(lane)) continue;
    const key = `${project}:${lane}`;
    const found = lanes.find((l) => `${l.project}:${l.lane}` === key);
    if (found) { if (!found.author_agent_id) found.author_agent_id = agent.id; continue; }
    if (have.has(key)) continue;
    have.add(key);
    let firstOwn: string | null = null;
    try { firstOwn = (await git(agent.workspace, ['log', '--reverse', '--format=%cI', `${mainSpec(project).ref}..HEAD`])).split('\n').map((l) => l.trim()).find(Boolean) ?? null; } catch { /* no main ref in the worktree */ }
    lanes.push({ project, lane, author_agent_id: agent.id, started_at: firstOwn ?? new Date().toISOString() });
  }
  const tasks: WorkSnapshot['tasks'] = [];
  for (const task of listTasks({ status: 'running' })) {
    let lane: string | null = null; let project: string | null = null;
    if (task.agent_id) {
      const a = getAgent(task.agent_id);
      if (a.ok && a.data.workspace) {
        try { lane = (await git(a.data.workspace, ['branch', '--show-current'])) || null; } catch { /* no branch */ }
        project = lanes.find((b) => b.lane === lane)?.project ?? projectOfWorkspace(a.data.workspace);
      }
    }
    tasks.push({ task, lane, project });
  }
  return { tasks, lanes };
}

export function resetWorkSweepForTest(): void { laneSeen.clear(); }

function projectOfWorkspace(workspace: string): string | null {
  for (const [name, p] of Object.entries(getConfig().projects ?? {})) {
    if (p.repo && workspace.startsWith(p.repo)) return name;
    if (p.workspace_match && workspaceMatches(workspace, p.workspace_match)) return name;
  }
  return null;
}

export function listStages(deliveryId: string): StageSpan[] {
  return getDb().prepare('SELECT * FROM delivery_stages WHERE delivery_id = ? ORDER BY started_at, id').all(deliveryId) as StageSpan[];
}

export function addLanes(id: string, lanes: string[]): Result<Delivery> {
  const d = getDelivery(id);
  if (!d) return { ok: false, error: 'delivery not found' };
  const merged = [...new Set([...d.lanes, ...lanes.map(normalizeLane).filter(Boolean)])];
  getDb().prepare('UPDATE deliveries SET lanes_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), nowIso(), id);
  return { ok: true, data: getDelivery(id)! };
}

export function setDeliveryStatus(id: string, status: DeliveryStatus, actor: string | null): Result<Delivery> {
  const d = getDelivery(id);
  if (!d) return { ok: false, error: 'delivery not found' };
  if (!['open', 'done', 'failed', 'cancelled'].includes(status)) return { ok: false, error: 'bad status' };
  getDb().prepare('UPDATE deliveries SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
  emit('delivery.status', 'delivery', id, { status, by: actor });
  return { ok: true, data: getDelivery(id)! };
}

// --- derivation -----------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

function laneOf(p: Record<string, unknown>): string | null {
  const direct = str(p.lane);
  if (direct) return normalizeLane(direct);
  const freeze = p.freeze as Record<string, unknown> | undefined;
  return freeze && str(freeze.lane) ? normalizeLane(str(freeze.lane)!) : null;
}

function shasOf(p: Record<string, unknown>, entityId: string): string[] {
  const out = new Set<string>();
  for (const key of ['sha', 'sha_in', 'sha_out', 'superseded_by', 'tip']) {
    const v = str(p[key]);
    if (v && SHA_RE.test(v)) out.add(v.toLowerCase());
  }
  const freeze = p.freeze as Record<string, unknown> | undefined;
  if (freeze && str(freeze.sha) && SHA_RE.test(str(freeze.sha)!)) out.add(str(freeze.sha)!.toLowerCase());
  const head = entityId.split(':')[0];
  if (SHA_RE.test(head)) out.add(head.toLowerCase());
  return [...out];
}

function sqlTime(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, '').replace('Z', '');
}

function toEv(r: { id: number; type: string; entity_id: string; payload_json: string | null; created_at: string }): Ev {
  let payload: Record<string, unknown> = {};
  try { payload = r.payload_json ? JSON.parse(r.payload_json) as Record<string, unknown> : {}; } catch { /* corrupt payload: no signal */ }
  const created_at = toIso(r.created_at);
  return { id: r.id, type: r.type, entity_id: r.entity_id, payload, created_at, at_ms: Date.parse(created_at) };
}

export function loadSignals(since: string): Ev[] {
  const placeholders = SIGNAL_TYPES.map(() => '?').join(', ');
  const rows = getDb().prepare(`SELECT id, type, entity_id, payload_json, created_at FROM events WHERE type IN (${placeholders}) AND created_at >= ? ORDER BY id`)
    .all(...SIGNAL_TYPES, sqlTime(since)) as { id: number; type: string; entity_id: string; payload_json: string | null; created_at: string }[];
  return rows.map(toEv);
}

// The tick's signals, kept between passes. Events are append-only, so a pass reads only the
// rows written since the last one (by id) instead of the whole window: on 28 Oct 2026 the
// window was 107k rows (25 MB of JSON) parsed every minute, about 0.5 s of the daemon's
// 1.5 s stall. A fresh database handle (tests) or an older `since` reloads in full.
let signalCache: { db: unknown; since: string; lastId: number; events: Ev[] } | null = null;

export function cachedSignals(since: string): Ev[] {
  const db = getDb();
  const sinceSql = sqlTime(since);
  if (!signalCache || signalCache.db !== db || sinceSql < signalCache.since) {
    const events = loadSignals(since);
    const maxId = (db.prepare('SELECT max(id) AS id FROM events').get() as { id: number | null }).id ?? 0;
    signalCache = { db, since: sinceSql, lastId: Math.max(maxId, events[events.length - 1]?.id ?? 0), events };
    return signalCache.events;
  }
  const placeholders = SIGNAL_TYPES.map(() => '?').join(', ');
  const fresh = (db.prepare(`SELECT id, type, entity_id, payload_json, created_at FROM events WHERE id > ? AND type IN (${placeholders}) ORDER BY id`)
    .all(signalCache.lastId, ...SIGNAL_TYPES) as { id: number; type: string; entity_id: string; payload_json: string | null; created_at: string }[]).map(toEv);
  const maxId = (db.prepare('SELECT max(id) AS id FROM events').get() as { id: number | null }).id ?? 0;
  signalCache.lastId = Math.max(signalCache.lastId, maxId);
  const sinceMs = Date.parse(since);
  if (sinceSql > signalCache.since) {
    // the oldest open delivery moved: drop what no delivery can see any more
    signalCache.since = sinceSql;
    signalCache.events = signalCache.events.filter((e) => e.at_ms >= sinceMs);
  }
  for (const e of fresh) if (e.at_ms >= sinceMs) signalCache.events.push(e);
  return signalCache.events;
}

export function resetSignalCacheForTest(): void { signalCache = null; }

/**
 * Walk the signals of a delivery and produce its stage spans. Pure: takes the
 * events and returns the spans plus the SHAs it discovered.
 */
export interface DeriveContext {
  /** run id → task id, for the runs of the tracked tasks. */
  taskRuns?: Map<string, string>;
  /** agent id → name, for the agents named on the record. */
  agentNames?: Map<string, string>;
}

export function deriveSpans(delivery: Delivery, events: Ev[], goalTaskIds: Set<string>, ctx: DeriveContext = {}): { spans: StageSpan[]; shas: string[] } {
  const lanes = new Set(delivery.lanes);
  const taskIds = new Set([...goalTaskIds, ...delivery.task_ids]);
  const agentIds = new Set(delivery.agent_ids); // grows with every dispatch seen
  const taskRuns = ctx.taskRuns ?? new Map<string, string>();
  const agentNames = ctx.agentNames ?? new Map<string, string>();
  const shas = new Set<string>(); // derived below; the stored list is this derivation's output, not its input
  const shaLane = new Map<string, string>();
  const spans: StageSpan[] = [];
  const open = new Map<string, StageSpan>(); // key: stage or stage:sha or stage:id
  const attempts: Partial<Record<Stage, number>> = {};
  const required = ['quick', 'api'];
  const gateState = new Map<string, Map<string, string>>(); // sha -> suite -> state

  const start = (key: string, stage: Stage, at: string, ev: Ev | null, extra: Partial<StageSpan> = {}): StageSpan => {
    const existing = open.get(key);
    if (existing) return existing;
    const attempt = (attempts[stage] ?? 0) + 1;
    attempts[stage] = attempt;
    const span: StageSpan = {
      delivery_id: delivery.id, stage, attempt, started_at: at, finished_at: null, outcome: null, cause: null,
      actor: null, sha: null, lane: null, event_id: ev?.id ?? null, ...extra,
    };
    spans.push(span);
    open.set(key, span);
    return span;
  };
  const finish = (key: string, outcome: StageOutcome, at: string, cause: string | null = null, actor: string | null = null) => {
    const span = open.get(key);
    if (!span) return;
    span.finished_at = at;
    span.outcome = outcome;
    if (cause) span.cause = cause;
    if (actor) span.actor = actor;
    open.delete(key);
  };
  const tracked = (ev: Ev): { lane: string | null; sha: string | null } => {
    const lane = laneOf(ev.payload);
    const evShas = shasOf(ev.payload, ev.entity_id);
    const known = evShas.find((s) => shas.has(s)) ?? null;
    if (lane && lanes.has(lane)) {
      return { lane, sha: known ?? (ADOPTING.has(ev.type) ? evShas[0] ?? null : null) };
    }
    return { lane: known ? (shaLane.get(known) ?? null) : null, sha: known };
  };
  const supersede = (lane: string, newSha: string, at: string) => {
    for (const [key, span] of [...open]) {
      if (!span.sha || span.sha === newSha || span.stage === 'build') continue;
      const spanLane = span.lane ?? shaLane.get(span.sha) ?? null;
      if (spanLane !== lane) continue;
      const old = span.sha;
      finish(key, 'superseded', at, `superseded by ${newSha.slice(0, 8)}`);
      if (span.stage === 'candidate') for (const [k2, s2] of [...open]) if (s2.sha === old) finish(k2, 'superseded', at, 'candidate superseded');
    }
  };
  let sawFreeze = false;
  const reopenBuild = (lane: string | null, at: string, ev: Ev, cause: string) => {
    if (!open.has('build')) start('build', 'build', at, ev, { lane, cause: null }).cause = cause;
  };

  const since = delivery.since_at > delivery.created_at ? delivery.created_at : delivery.since_at;
  if (delivery.task_ids.length || delivery.agent_ids.length) {
    // Work already handed to an agent: the record opens in build, with the agent as the actor.
    const first = delivery.agent_ids.map((id) => agentNames.get(id)).find(Boolean) ?? null;
    start('build', 'build', since, null, { actor: first, lane: delivery.lanes[0] ?? null });
  } else {
    // The spec stage runs from the record's start until the first build signal.
    start('spec', 'spec', since, null);
  }

  for (const ev of events) {
    const at = ev.created_at;
    const p = ev.payload;
    if (ev.type === 'task.created' || ev.type === 'task.dispatched') {
      if (!taskIds.has(ev.entity_id)) continue;
      finish('spec', 'ok', at);
      const b = start('build', 'build', at, ev, { actor: str(p.agent_name) });
      if (str(p.agent_name)) b.actor = str(p.agent_name);
      if (str(p.agent_id)) agentIds.add(str(p.agent_id)!);
      continue;
    }
    if (ev.type === 'run.finished' || ev.type === 'run.failed') {
      // A run of a tracked task: a failure blocks the build (the agent or a person must act); a finish clears it.
      const taskId = taskRuns.get(ev.entity_id);
      if (!taskId || !taskIds.has(taskId)) continue;
      const b = open.get('build');
      if (!b) continue;
      if (ev.type === 'run.failed') b.cause = `run failed: ${str(p.error) ?? `exit ${p.exit_code ?? '?'}`}`.slice(0, 300);
      else b.cause = null;
      continue;
    }
    if (ev.type === 'agent.hung' || ev.type === 'agent.resumed') {
      // The agent building it went quiet (health monitor) or spoke again.
      if (!agentIds.has(ev.entity_id)) continue;
      const b = open.get('build');
      if (!b) continue;
      if (ev.type === 'agent.hung') b.cause = `@${str(p.name) ?? 'agent'} quiet for ${Number(p.stale_minutes ?? 0)} min (no output while working)`;
      else if (/quiet for \d+ min/.test(b.cause ?? '')) b.cause = null;
      continue;
    }
    const t = tracked(ev);
    if (!t.lane && !t.sha) continue;
    // A SHA joins the record when the lane freezes it or the queue takes it; a refusal that names an
    // unpushed SHA, or a gate result for someone else's SHA on the lane, does not.
    if (t.lane && t.sha && ADOPTING.has(ev.type) && !shas.has(t.sha)) {
      shas.add(t.sha); shaLane.set(t.sha, t.lane);
      // The lane froze this SHA: spec is over, the build that produced it is done, the lane's earlier SHAs are history.
      finish('spec', 'ok', at);
      if (!open.has('build') && !sawFreeze) start('build', 'build', delivery.since_at, null, { lane: t.lane });
      sawFreeze = true;
      supersede(t.lane, t.sha, at);
      const b = open.get('build');
      if (b) { b.sha = t.sha; b.lane = t.lane; finish('build', 'ok', at); }
    }

    switch (ev.type) {
      case 'pipeline.frozen':
        break; // handled above with every other adopting signal
      case 'pipeline.first_pass_requested':
        if (t.sha) start(`first_pass:${t.sha}`, 'first_pass', at, ev, { sha: t.sha, lane: t.lane, actor: str(p.seat) });
        break;
      case 'pipeline.first_pass':
        if (t.sha) finish(`first_pass:${t.sha}`, 'ok', at, null, str(p.seat));
        break;
      case 'pipeline.first_pass_timeout':
        if (t.sha) finish(`first_pass:${t.sha}`, 'skipped', at, 'no first pass in time', str(p.seat));
        break;
      case 'pipeline.quick':
      case 'pipeline.gate': {
        if (!t.sha) break;
        const state = str(p.quick) ?? str(p.gate);
        if (state === 'CANCELLED') { finish(`gates:${t.sha}`, 'superseded', at, str(p.reason) ?? 'run stopped'); break; }
        if (state === 'QUEUED' || state === 'RUNNING') start(`gates:${t.sha}`, 'gates', at, ev, { sha: t.sha, lane: t.lane });
        if (state === 'GREEN' || state === 'RUNNING') { const g = open.get(`gates:${t.sha}`); if (g) g.cause = null; }
        if (state === 'GREEN' && ev.type === 'pipeline.gate') finish(`gates:${t.sha}`, 'ok', at, 'full GREEN');
        if (state === 'RED') { finish(`gates:${t.sha}`, 'fail', at, `${ev.type === 'pipeline.quick' ? 'quick' : 'full'} RED`); reopenBuild(t.lane, at, ev, `${ev.type === 'pipeline.quick' ? 'quick' : 'full'} RED on ${t.sha.slice(0, 8)}`); }
        break;
      }
      case 'gate.result': {
        if (!t.sha) break;
        const suite = str(p.suite) ?? 'quick';
        const state = str(p.state) ?? '';
        const span = start(`gates:${t.sha}`, 'gates', at, ev, { sha: t.sha, lane: t.lane });
        span.cause = null; // a result is progress: whatever blocked the gate is over
        const m = gateState.get(t.sha) ?? new Map<string, string>();
        m.set(suite, state);
        gateState.set(t.sha, m);
        if (state === 'RED') { finish(`gates:${t.sha}`, 'fail', at, `${suite} RED`); reopenBuild(t.lane, at, ev, `${suite} RED on ${t.sha.slice(0, 8)}`); break; }
        const green = (s: string) => m.get(s) === 'GREEN';
        if (green('full') || green('gate') || required.every(green)) { span.cause = null; finish(`gates:${t.sha}`, 'ok', at); }
        break;
      }
      case 'pipeline.review': {
        if (!t.sha) break;
        const kind = str(p.kind) ?? ev.entity_id.split(':')[1] ?? 'assign';
        if (kind === 'assign' || kind === 'request' || kind === 'reassign') {
          const span = start(`review:${t.sha}`, 'review', at, ev, { sha: t.sha, lane: t.lane });
          const reviewer = str(p.reviewer_id);
          if (reviewer) span.actor = reviewerName(reviewer);
        }
        break;
      }
      case 'review.ai_completed': {
        if (!t.sha) break;
        const verdict = str(p.verdict) ?? '';
        const who = str(p.reviewer_agent);
        if (verdict === 'pass') finish(`review:${t.sha}`, 'ok', at, null, who);
        else { finish(`review:${t.sha}`, 'fail', at, `NEEDS FIXES by @${who ?? '?'}`, who); reopenBuild(t.lane, at, ev, `NEEDS FIXES on ${t.sha.slice(0, 8)}`); }
        break;
      }
      case 'review.superseded':
        if (t.sha) finish(`review:${t.sha}`, 'superseded', at, 'newer SHA on the lane');
        break;
      case 'pipeline.candidate_review': {
        // The rolling review of main: it rides on the candidate span of the main SHA the merge produced.
        if (!t.sha) break;
        const span = open.get(`candidate:${t.sha}`);
        if (!span) break;
        const kind = str(p.kind) ?? '';
        const seat = str(p.reviewer) ?? str(p.seat) ?? null;
        if (kind === 'assign') { if (seat) span.actor = seat; }
        else if (kind === 'result') {
          if (seat) span.actor = seat;
          // A PASS answers the candidate review: the span closes ok. Left open, it ran past its budget and
          // raised a false over-budget alarm until the next merge or the release (8c564ada, cb5ce667, 2f3d118d, 77d64b60).
          if (str(p.result) === 'pass') { span.cause = null; finish(`candidate:${t.sha}`, 'ok', at, 'candidate review PASS', seat); break; }
          span.cause = `candidate review NEEDS FIXES by @${seat ?? '?'} (${Number(p.issues ?? 0)} issue${Number(p.issues ?? 0) === 1 ? '' : 's'}), see ${str(p.file) ?? 'the file'}`;
        }
        break;
      }
      case 'merge_queue.queued':
        if (t.sha) start(`land:${t.sha}`, 'land', at, ev, { sha: t.sha, lane: t.lane });
        break;
      case 'merge_queue.merged': {
        const shaIn = str(p.sha_in)?.toLowerCase() ?? t.sha;
        const shaOut = str(p.sha_out)?.toLowerCase() ?? null;
        if (!shaIn) break;
        finish(`gates:${shaIn}`, 'ok', at, 'merged');
        finish(`review:${shaIn}`, 'ok', at, 'merged');
        finish(`first_pass:${shaIn}`, 'skipped', at, 'merged');
        start(`land:${shaIn}`, 'land', at, ev, { sha: shaIn, lane: t.lane });
        finish(`land:${shaIn}`, 'ok', at, shaOut ? `main ${shaOut.slice(0, 8)}` : null);
        for (const [key, span] of [...open]) if (span.stage === 'candidate') { const old = span.sha; finish(key, 'superseded', at, 'newer merge'); if (old) for (const [k2, s2] of [...open]) if (s2.sha === old) finish(k2, 'superseded', at, 'candidate superseded'); }
        if (shaOut) { shas.add(shaOut); start(`candidate:${shaOut}`, 'candidate', at, ev, { sha: shaOut, lane: t.lane }); }
        break;
      }
      case 'lane.retired': {
        // The pipeline retires a lane whose every commit is on main: landed, by the queue or by hand on GitHub.
        // Only a SHA the queue had taken: an empty lane cut from main is retired the same way and landed nothing.
        if (!t.sha || !/on main/i.test(str(p.why) ?? '') || !open.has(`land:${t.sha}`)) break;
        finish(`gates:${t.sha}`, 'ok', at, 'on main');
        finish(`review:${t.sha}`, 'ok', at, 'on main');
        finish(`first_pass:${t.sha}`, 'skipped', at, 'on main');
        start(`land:${t.sha}`, 'land', at, ev, { sha: t.sha, lane: t.lane });
        finish(`land:${t.sha}`, 'ok', at, 'on main (merged outside the queue)');
        break;
      }
      case 'merge_queue.bounced':
        if (t.sha) { finish(`land:${t.sha}`, 'fail', at, str(p.reason)); reopenBuild(t.lane, at, ev, `bounced: ${str(p.reason) ?? ''}`.slice(0, 200)); }
        break;
      case 'release.requested': {
        if (str(p.target) !== 'production') break;
        for (const [key] of [...open]) if (key.startsWith('candidate:')) finish(key, 'ok', at, 'promoted');
        start(`release:${ev.entity_id}`, 'release', at, ev, { sha: t.sha, lane: t.lane, actor: str(p.requested_by) });
        break;
      }
      case 'release.reported': {
        if (str(p.target) !== 'production') break;
        const status = str(p.status);
        if (status === 'deployed') finish(`release:${ev.entity_id}`, 'ok', at, str(p.version) ? `v${str(p.version)}` : null);
        else if (status === 'failed') finish(`release:${ev.entity_id}`, 'fail', at, str(p.error) ?? 'release failed');
        else finish(`release:${ev.entity_id}`, 'skipped', at, status);
        break;
      }
      case 'pipeline.refused':
      case 'pipeline.action': {
        // Not a transition: a block the tick reports as the cause of the open span.
        const note = str(p.reason) ?? str(p.note) ?? '';
        if (!note) break;
        const blocked = /denied|refused|waits for|on hold|not on origin|switched off|conflict/i.test(note);
        if (!blocked) break;
        const bySha = t.sha ? [...open.values()].filter((span) => span.sha === t.sha) : [];
        if (bySha.length > 0) { for (const span of bySha) span.cause = note.slice(0, 300); break; }
        // No open span for that SHA: the note goes to the stage the action is about, on the same lane only.
        const action = str(p.action) ?? (ev.type === 'pipeline.refused' ? 'freeze' : '');
        const stage: Stage | null = /quick|gate|api|full/.test(action) ? 'gates' : /review/.test(action) ? 'review' : /first_pass/.test(action) ? 'first_pass' : /freeze|push/.test(action) ? 'build' : null;
        if (!stage) break;
        for (const span of open.values()) {
          if (span.stage !== stage) continue;
          if (stage === 'build' ? (!span.lane || !t.lane || span.lane === t.lane) : (t.lane !== null && span.lane === t.lane)) span.cause = note.slice(0, 300);
        }
        break;
      }
      default:
        break;
    }
  }
  return { spans, shas: [...shas] };
}

function reviewerName(agentId: string): string | null {
  const a = getAgent(agentId);
  return a.ok ? (a.data.alias ?? a.data.name) : null;
}

function goalTasks(goalId: string | null): Set<string> {
  if (!goalId) return new Set();
  const rows = getDb().prepare('SELECT id FROM tasks WHERE goal_id = ?').all(goalId) as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

function deriveContext(d: Delivery): DeriveContext {
  const taskRuns = new Map<string, string>();
  const ids = [...new Set([...d.task_ids, ...goalTasks(d.goal_id)])];
  if (ids.length) {
    try {
      const rows = getDb().prepare(`SELECT id, task_id FROM runs WHERE task_id IN (${ids.map(() => '?').join(', ')})`).all(...ids) as Array<{ id: string; task_id: string }>;
      for (const r of rows) taskRuns.set(r.id, r.task_id);
    } catch { /* no runs table in a bare test db */ }
  }
  const agentNames = new Map<string, string>();
  for (const id of d.agent_ids) { const a = getAgent(id); if (a.ok) agentNames.set(id, a.data.alias ?? a.data.name); }
  return { taskRuns, agentNames };
}

/**
 * Rebuild the stage rows of one delivery from events. Idempotent. The tick passes the signals it
 * loaded once for every open delivery; a single call loads its own.
 */
export function deriveDelivery(id: string, signals?: Ev[]): Result<{ delivery: Delivery; spans: StageSpan[] }> {
  const d = getDelivery(id);
  if (!d) return { ok: false, error: 'delivery not found' };
  const sinceMs = Date.parse(d.since_at);
  const events = signals ? signals.filter((e) => e.at_ms >= sinceMs) : loadSignals(d.since_at);
  const { spans, shas } = deriveSpans(d, events, goalTasks(d.goal_id), deriveContext(d));
  const db = getDb();
  const current = currentStage(spans);
  const lastProgress = spans.reduce<string | null>((acc, s) => {
    const t = s.finished_at ?? s.started_at;
    return !acc || t > acc ? t : acc;
  }, null);
  const done = spans.some((s) => s.stage === 'release' && s.outcome === 'ok');
  const attemptsTotal = Math.max(1, ...spans.filter((s) => s.stage === 'build').map((s) => s.attempt));
  db.transaction(() => {
    db.prepare('DELETE FROM delivery_stages WHERE delivery_id = ?').run(id);
    const ins = db.prepare(`INSERT INTO delivery_stages (delivery_id, stage, attempt, started_at, finished_at, outcome, cause, actor, sha, lane, event_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const s of spans) ins.run(id, s.stage, s.attempt, s.started_at, s.finished_at, s.outcome, s.cause, s.actor, s.sha, s.lane, s.event_id);
    db.prepare(`UPDATE deliveries SET shas_json = ?, stage = ?, stage_started_at = ?, last_progress_at = ?, attempts = ?, status = CASE WHEN status = 'open' AND ? = 1 THEN 'done' ELSE status END, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(shas), current?.stage ?? (done ? 'release' : 'build'), current?.started_at ?? null, lastProgress, attemptsTotal, done ? 1 : 0, nowIso(), id);
  })();
  return { ok: true, data: { delivery: getDelivery(id)!, spans: listStages(id) } };
}

/** The open span that comes first in stage order; null when nothing is open. */
export function currentStage(spans: StageSpan[]): StageSpan | null {
  const open = spans.filter((s) => !s.finished_at);
  if (open.length === 0) return null;
  return open.sort((a, b) => (STAGE_ORDER.get(a.stage)! - STAGE_ORDER.get(b.stage)!) || a.started_at.localeCompare(b.started_at))[0];
}

// --- stalls --------------------------------------------------------------------------------

export interface Stall {
  delivery_id: string;
  stage: Stage;
  attempt: number;
  code: 'OVERRUN' | 'BLOCKED';
  cause: string;
  since: string;
  sha: string | null;
  lane: string | null;
  actor: string | null;
}

function budgetMin(stage: Stage): number {
  const cfg = getConfig().deliveries?.budgets_min;
  const v = cfg?.[stage];
  return typeof v === 'number' && v > 0 ? v : DEFAULT_BUDGETS_MIN[stage];
}

/** Pure: which open spans are stalled at `now`. */
export function findStalls(delivery: Delivery, spans: StageSpan[], now = Date.now()): Stall[] {
  if (delivery.status !== 'open') return [];
  const out: Stall[] = [];
  for (const s of spans) {
    if (s.finished_at) continue;
    const ageMin = (now - new Date(s.started_at).getTime()) / 60_000;
    if (s.cause && !isQueueing(s.cause)) {
      out.push({ delivery_id: delivery.id, stage: s.stage, attempt: s.attempt, code: 'BLOCKED', cause: s.cause, since: s.started_at, sha: s.sha, lane: s.lane, actor: s.actor });
    } else if (ageMin > budgetMin(s.stage)) {
      const waiting = s.cause ? `; ${s.cause}` : '';
      out.push({ delivery_id: delivery.id, stage: s.stage, attempt: s.attempt, code: 'OVERRUN', cause: `${s.stage} open for ${Math.floor(ageMin)} min, budget ${budgetMin(s.stage)} min${waiting}`, since: s.started_at, sha: s.sha, lane: s.lane, actor: s.actor });
    }
  }
  return out;
}

/**
 * A pipeline note that says the work is queued, not stopped: the gateway runs one job per
 * agent and a few at a time, so "waits for a slot" or "waits for @x's other run" is the
 * normal state of a gate for a while. It stays on the span as its cause (the card shows why
 * it waits) but is not a stall; past the budget it is an overrun that quotes the wait.
 * Until 28 Oct 2026 every change in the queue counts read as a new block and messaged the seats.
 */
export function isQueueing(cause: string): boolean {
  return /waits for (a slot|@\S+'?s other run)|waits in the queue|queued behind/i.test(cause);
}

// delivery:stage:attempt -> cause signature already reported, in the DB so a restart does not
// re-send every open stall (28 Oct 2026: 42 and 58 lines to the driver seat after two restarts).
function reportedSig(key: string): string | null {
  const row = getDb().prepare('SELECT sig FROM delivery_stall_reports WHERE key = ?').get(key) as { sig: string } | undefined;
  return row?.sig ?? null;
}

function markReported(key: string, sig: string): void {
  getDb().prepare('INSERT INTO delivery_stall_reports (key, sig) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET sig = excluded.sig, created_at = datetime(\'now\')').run(key, sig);
}

/** Forget the stalls of deliveries that are no longer open (a closed record does not come back). */
function pruneReported(): void {
  getDb().prepare("DELETE FROM delivery_stall_reports WHERE substr(key, 1, instr(key, ':') - 1) NOT IN (SELECT id FROM deliveries WHERE status = 'open')").run();
}

/** Report new stalls of one delivery: one event and one message per new cause. */
export async function reportStalls(delivery: Delivery, spans: StageSpan[], now = Date.now()): Promise<Stall[]> {
  const stalls = findStalls(delivery, spans, now);
  const fresh: Stall[] = [];
  for (const st of stalls) {
    const key = `${st.delivery_id}:${st.stage}:${st.attempt}`;
    const sig = st.code === 'OVERRUN' ? st.code : `${st.code}|${st.cause}`;
    if (reportedSig(key) === sig) continue;
    markReported(key, sig);
    // A span that was already stalled when the record was created is history the creator saw; the record
    // shows it, nobody is messaged.
    if (new Date(st.since).getTime() < new Date(toIso(delivery.created_at)).getTime()) continue;
    fresh.push(st);
  }
  const db = getDb();
  if (stalls.length === 0) {
    if (delivery.stall_cause) db.prepare('UPDATE deliveries SET stall_cause = NULL, stall_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), delivery.id);
    return [];
  }
  const head = stalls[0];
  db.prepare('UPDATE deliveries SET stall_cause = ?, stall_at = COALESCE(stall_at, ?), updated_at = ? WHERE id = ?')
    .run(`${head.stage}: ${head.code} — ${head.cause}`.slice(0, 400), nowIso(), nowIso(), delivery.id);
  for (const st of fresh) {
    emit('delivery.stalled', 'delivery', delivery.id, { title: delivery.title, stage: st.stage, attempt: st.attempt, code: st.code, cause: st.cause, since: st.since, sha: st.sha, lane: st.lane, actor: st.actor }, null);
    const text = `[delivery "${delivery.title}"] ${st.stage} is ${st.code === 'BLOCKED' ? 'blocked' : 'over budget'}${st.sha ? ` on ${st.sha.slice(0, 8)}` : ''}${st.lane ? ` (${st.lane})` : ''}: ${st.cause}. Since ${st.since.slice(11, 16)} UTC.`;
    await notifySeats(text, st.actor);
  }
  return fresh;
}

async function notifySeats(text: string, actor: string | null): Promise<void> {
  await tellDriverSeats(text, actor, 'delivery');
}

export function resetDeliveryStallMemoryForTest(): void {
  try { getDb().prepare('DELETE FROM delivery_stall_reports').run(); } catch { /* no db open */ }
}

// --- tick ----------------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function deliveryTick(now = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  const started = Date.now();
  try {
    try { adoptDeskLanes(listFreezes().filter((f) => f.status === 'open' || f.status === 'behind-main'), now); } catch (e) {
      logger.debug({ error: (e as Error).message }, 'Delivery desk adoption skipped'); // no freeze table yet
    }
    try { adoptWork(await gatherWork(), now); } catch (e) {
      logger.debug({ error: (e as Error).message }, 'Delivery auto-track skipped');
    }
    // One read of the signal events for the whole pass: per delivery it was 41 x 130 ms of
    // synchronous SQLite on 28 Oct 2026, an 8 s stall of the daemon every minute.
    const open = listDeliveries({ status: 'open', limit: 200 });
    const oldest = open.reduce<string | null>((acc, d) => (!acc || Date.parse(d.since_at) < Date.parse(acc) ? d.since_at : acc), null);
    const signals = oldest ? cachedSignals(oldest) : [];
    for (const d of open) {
      await yieldTurn(); // each delivery's derivation is synchronous; let the loop breathe between them
      const derived = deriveDelivery(d.id, signals);
      if (!derived.ok) continue;
      if (derived.data.delivery.status !== 'open') continue;
      await reportStalls(derived.data.delivery, derived.data.spans, now);
    }
    pruneReported();
  } catch (e) {
    logger.warn({ error: (e as Error).message }, 'Delivery tick failed');
  } finally {
    ticking = false;
    recordJob('delivery_tick', Date.now() - started);
  }
}

export function startDeliveryTimer(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => { void deliveryTick(); }, intervalMs);
  timer.unref?.();
}

export function stopDeliveryTimer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Time in the current stage and the stall, for lists and cards. */
function minutesSince(stamp: string | null | undefined, now: number): number | null {
  if (!stamp) return null;
  const ms = parseStamp(stamp);
  return ms === null ? null : Math.max(0, Math.floor((now - ms) / 60_000));
}

export function summarize(d: Delivery, spans: StageSpan[], now = Date.now()): Delivery & { stage_minutes: number | null; open_stages: Stage[]; stalls: Array<Stall & { minutes: number }> } {
  const cur = currentStage(spans);
  return {
    ...d,
    stage: cur?.stage ?? d.stage,
    stage_started_at: cur?.started_at ?? d.stage_started_at,
    stage_minutes: minutesSince(cur?.started_at ?? d.stage_started_at ?? d.last_progress_at, now),
    open_stages: [...new Set(spans.filter((s) => !s.finished_at).map((s) => s.stage))],
    stalls: findStalls(d, spans, now).map((st) => ({ ...st, minutes: minutesSince(st.since, now) ?? 0 })),
  };
}
