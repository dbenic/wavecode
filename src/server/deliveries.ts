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
import { getAgent, getDb, resolveAgent, type Result } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { deliverSystemLine } from './wire-lines.js';

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
  id: string; title: string; project: string | null; goal_id: string | null; spec_path: string | null;
  lanes_json: string; shas_json: string; release_lane: number; stage: string | null; stage_started_at: string | null;
  last_progress_at: string | null; attempts: number; status: string; stall_cause: string | null; stall_at: string | null;
  created_by: string | null; since_at: string; created_at: string; updated_at: string;
}

interface Ev {
  id: number;
  type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  created_at: string;
}

const STAGE_ORDER = new Map<Stage, number>(STAGES.map((s, i) => [s, i]));
const SHA_RE = /^[0-9a-f]{40}$/i;

/** Event types the derivation reads. Everything else stays untouched. */
const SIGNAL_TYPES = [
  'pipeline.frozen', 'pipeline.quick', 'pipeline.gate', 'gate.result', 'pipeline.first_pass_requested',
  'pipeline.first_pass', 'pipeline.first_pass_timeout', 'pipeline.review', 'review.ai_completed', 'review.superseded',
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
    id: r.id, title: r.title, project: r.project, goal_id: r.goal_id, spec_path: r.spec_path,
    lanes: parseList(r.lanes_json), shas: parseList(r.shas_json), release_lane: r.release_lane === 1,
    stage: (r.stage as Stage | null) ?? null, stage_started_at: r.stage_started_at, last_progress_at: r.last_progress_at,
    attempts: r.attempts, status: r.status as DeliveryStatus, stall_cause: r.stall_cause, stall_at: r.stall_at,
    created_by: r.created_by, since_at: r.since_at, created_at: r.created_at, updated_at: r.updated_at,
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
  title: string;
  project?: string | null;
  lanes?: string[];
  goal_id?: string | null;
  spec_path?: string | null;
  release_lane?: boolean;
  /** Events before this instant are ignored. Default: 24 h before creation (a lane usually predates its record). */
  since?: string | null;
  created_by?: string | null;
}

export function createDelivery(opts: CreateDeliveryOpts): Result<Delivery> {
  const title = opts.title?.trim();
  if (!title) return { ok: false, error: 'title is required' };
  const lanes = [...new Set((opts.lanes ?? []).map(normalizeLane).filter(Boolean))];
  if (lanes.some((l) => l.length > 120 || /\s/.test(l))) return { ok: false, error: 'lanes must be branch names' };
  const since = opts.since ? new Date(opts.since) : new Date(Date.now() - 24 * 3600_000);
  if (Number.isNaN(since.getTime())) return { ok: false, error: 'since must be an ISO date' };
  const id = ulid();
  const now = nowIso();
  getDb().prepare(`INSERT INTO deliveries (id, title, project, goal_id, spec_path, lanes_json, shas_json, release_lane, stage, stage_started_at, attempts, status, created_by, since_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 'spec', ?, 1, 'open', ?, ?, ?, ?)`)
    .run(id, title, opts.project ?? null, opts.goal_id ?? null, opts.spec_path ?? null, JSON.stringify(lanes), opts.release_lane ? 1 : 0, now, opts.created_by ?? null, since.toISOString(), now, now);
  const d = getDelivery(id)!;
  emit('delivery.created', 'delivery', id, { title, project: d.project, lanes, goal_id: d.goal_id, release_lane: d.release_lane });
  return { ok: true, data: d };
}

export function getDelivery(id: string): Delivery | null {
  const r = getDb().prepare('SELECT * FROM deliveries WHERE id = ?').get(id) as Row | undefined;
  return r ? rowToDelivery(r) : null;
}

export function listDeliveries(opts: { status?: DeliveryStatus | 'all'; limit?: number } = {}): Delivery[] {
  const status = opts.status ?? 'open';
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = status === 'all'
    ? getDb().prepare('SELECT * FROM deliveries ORDER BY created_at DESC LIMIT ?').all(limit) as Row[]
    : getDb().prepare('SELECT * FROM deliveries WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit) as Row[];
  return rows.map(rowToDelivery);
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

function loadSignals(since: string): Ev[] {
  const placeholders = SIGNAL_TYPES.map(() => '?').join(', ');
  const rows = getDb().prepare(`SELECT id, type, entity_id, payload_json, created_at FROM events WHERE type IN (${placeholders}) AND created_at >= ? ORDER BY id`)
    .all(...SIGNAL_TYPES, since.replace('T', ' ').replace(/\.\d+Z$/, '').replace('Z', '')) as { id: number; type: string; entity_id: string; payload_json: string | null; created_at: string }[];
  const out: Ev[] = [];
  for (const r of rows) {
    let payload: Record<string, unknown> = {};
    try { payload = r.payload_json ? JSON.parse(r.payload_json) as Record<string, unknown> : {}; } catch { /* corrupt payload: no signal */ }
    out.push({ id: r.id, type: r.type, entity_id: r.entity_id, payload, created_at: toIso(r.created_at) });
  }
  return out;
}

/**
 * Walk the signals of a delivery and produce its stage spans. Pure: takes the
 * events and returns the spans plus the SHAs it discovered.
 */
export function deriveSpans(delivery: Delivery, events: Ev[], goalTaskIds: Set<string>): { spans: StageSpan[]; shas: string[] } {
  const lanes = new Set(delivery.lanes);
  const shas = new Set(delivery.shas.map((s) => s.toLowerCase()));
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
    if (lane && lanes.has(lane)) return { lane, sha: known ?? evShas[0] ?? null };
    return { lane: known ? (shaLane.get(known) ?? null) : null, sha: known };
  };
  const supersede = (lane: string, newSha: string, at: string) => {
    for (const [key, span] of [...open]) {
      if (span.lane === lane && span.sha && span.sha !== newSha && span.stage !== 'build') finish(key, 'superseded', at, `superseded by ${newSha.slice(0, 8)}`);
    }
  };
  let sawFreeze = false;
  const reopenBuild = (lane: string | null, at: string, ev: Ev, cause: string) => {
    if (!open.has('build')) start('build', 'build', at, ev, { lane, cause: null }).cause = cause;
  };

  // The spec stage runs from the record's start until the first build signal.
  start('spec', 'spec', delivery.since_at > delivery.created_at ? delivery.created_at : delivery.since_at, null);

  for (const ev of events) {
    const at = ev.created_at;
    const p = ev.payload;
    if (ev.type === 'task.created' || ev.type === 'task.dispatched') {
      if (!goalTaskIds.has(ev.entity_id)) continue;
      finish('spec', 'ok', at);
      start('build', 'build', at, ev, { actor: str(p.agent_name) });
      continue;
    }
    const t = tracked(ev);
    if (!t.lane && !t.sha) continue;
    // A SHA joins the record when the lane freezes it or the queue takes it; a refusal that names an
    // unpushed SHA, or a gate result for someone else's SHA on the lane, does not.
    if (t.lane && t.sha && (ev.type === 'pipeline.frozen' || ev.type.startsWith('merge_queue.'))) { shas.add(t.sha); shaLane.set(t.sha, t.lane); }

    switch (ev.type) {
      case 'pipeline.frozen': {
        if (!t.lane || !t.sha) break;
        finish('spec', 'ok', at);
        // The first freeze closes the build that began at since_at. A later freeze with no open build is a
        // re-freeze of the same work (sync merge, rebase): the earlier spans are superseded, no new build attempt.
        if (!open.has('build') && !sawFreeze) start('build', 'build', delivery.since_at, null, { lane: t.lane });
        sawFreeze = true;
        supersede(t.lane, t.sha, at);
        const b = open.get('build');
        if (b) { b.sha = t.sha; b.lane = t.lane; finish('build', 'ok', at); }
        break;
      }
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

/** Rebuild the stage rows of one delivery from events. Idempotent. */
export function deriveDelivery(id: string): Result<{ delivery: Delivery; spans: StageSpan[] }> {
  const d = getDelivery(id);
  if (!d) return { ok: false, error: 'delivery not found' };
  const events = loadSignals(d.since_at);
  const { spans, shas } = deriveSpans(d, events, goalTasks(d.goal_id));
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
    if (s.cause) {
      out.push({ delivery_id: delivery.id, stage: s.stage, attempt: s.attempt, code: 'BLOCKED', cause: s.cause, since: s.started_at, sha: s.sha, lane: s.lane, actor: s.actor });
    } else if (ageMin > budgetMin(s.stage)) {
      out.push({ delivery_id: delivery.id, stage: s.stage, attempt: s.attempt, code: 'OVERRUN', cause: `${s.stage} open for ${Math.floor(ageMin)} min, budget ${budgetMin(s.stage)} min`, since: s.started_at, sha: s.sha, lane: s.lane, actor: s.actor });
    }
  }
  return out;
}

const reported = new Map<string, string>(); // delivery:stage:attempt -> cause already reported

/** Report new stalls of one delivery: one event and one message per new cause. */
export async function reportStalls(delivery: Delivery, spans: StageSpan[], now = Date.now()): Promise<Stall[]> {
  const stalls = findStalls(delivery, spans, now);
  const fresh: Stall[] = [];
  for (const st of stalls) {
    const key = `${st.delivery_id}:${st.stage}:${st.attempt}`;
    const sig = st.code === 'OVERRUN' ? st.code : `${st.code}|${st.cause}`;
    if (reported.get(key) === sig) continue;
    reported.set(key, sig);
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
  const targets = new Set<string>(getConfig().deliveries?.notify ?? []);
  if (actor) targets.add(actor);
  for (const ref of targets) {
    const a = resolveAgent(ref);
    if (!a.ok) continue;
    try { await deliverSystemLine(a.data, text, { kind: 'info', source: 'delivery' }); } catch (e) {
      logger.warn({ agent: ref, error: (e as Error).message }, 'Delivery stall message failed');
    }
  }
}

export function resetDeliveryStallMemoryForTest(): void {
  reported.clear();
}

// --- tick ----------------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export async function deliveryTick(now = Date.now()): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const d of listDeliveries({ status: 'open', limit: 200 })) {
      const derived = deriveDelivery(d.id);
      if (!derived.ok) continue;
      if (derived.data.delivery.status !== 'open') continue;
      await reportStalls(derived.data.delivery, derived.data.spans, now);
    }
  } catch (e) {
    logger.warn({ error: (e as Error).message }, 'Delivery tick failed');
  } finally {
    ticking = false;
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
export function summarize(d: Delivery, spans: StageSpan[], now = Date.now()): Delivery & { stage_minutes: number | null; open_stages: Stage[]; stalls: Stall[] } {
  const cur = currentStage(spans);
  return {
    ...d,
    stage: cur?.stage ?? d.stage,
    stage_started_at: cur?.started_at ?? d.stage_started_at,
    stage_minutes: cur ? Math.floor((now - new Date(cur.started_at).getTime()) / 60_000) : null,
    open_stages: [...new Set(spans.filter((s) => !s.finished_at).map((s) => s.stage))],
    stalls: findStalls(d, spans, now),
  };
}
