/**
 * The overlord: a coordinator that reads the board (overview.ts) and says what
 * matters, on a token-based model — never a tmux agent, never a poller.
 *
 * It wakes on events that change the board (a run finished, a verdict landed,
 * a lane went stale, a release came back, an agent hung) and on a slow
 * heartbeat; wakes are debounced and capped per hour. Each wake it writes a
 * report: one line per agent, recommendations with one-click actions, and a
 * digest for the person — posted as a thread item and (when it changed) a
 * notification. It never promotes, stages or types into an agent by itself:
 * every recommendation is a button a person presses.
 */

import { ulid } from 'ulid';
import { getConfig } from './config.js';
import { getDb, listEventsBefore, getLatestEventId, resolveAgent, type Result, type WaveEvent } from './db.js';
import { emit, onEvent } from './event-bus.js';
import { completeText, isLlmConfigured } from './llm-provider.js';
import logger from './logger.js';
import { notify } from './notifications.js';
import { buildBoard, type Board } from './overview.js';
import * as releases from './releases.js';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export type RecommendationKind = 'promote' | 'stage' | 'reject' | 'nudge' | 'reassign' | 'refreeze' | 'fix' | 'info';

export interface Recommendation {
  kind: RecommendationKind;
  run_id?: string | null;
  agent_id?: string | null;
  sha?: string | null;
  text: string;
}

/** A practical release plan: what goes out together, in which order, and why. */
export interface ReleaseGroup {
  title: string;
  /** full SHAs of the lanes in this group, in deploy order */
  shas: string[];
  target: 'staging' | 'production' | 'hold';
  why: string;
}

export interface OverlordReport {
  id: string;
  created_at: string;
  trigger: string;
  model: string;
  agents: Array<{ id: string; note: string }>;
  recommendations: Recommendation[];
  plan: ReleaseGroup[];
  digest: string | null;
  board_at: string;
}

const TRIGGERS = new Set([
  'run.finished', 'run.failed', 'task.failed',
  'review.ai_completed', 'review.superseded', 'review.needs_reviewer', 'review.promoted', 'review.rejected',
  'release.reported',
  'agent.hung', 'agent.crashed', 'agent.runtime_relaunch_exhausted',
  'peer.answer', 'peer.failed',
]);

const KINDS: RecommendationKind[] = ['promote', 'stage', 'reject', 'nudge', 'reassign', 'refreeze', 'fix', 'info'];

export function overlordConfig() {
  const o = getConfig().overlord ?? {};
  return {
    enabled: o.enabled ?? false,
    model: o.model ?? DEFAULT_MODEL,
    heartbeatMin: o.heartbeat_min ?? 30,
    maxWakesPerHour: o.max_wakes_per_hour ?? 12,
    debounceS: o.debounce_s ?? 45,
    notify: o.notify ?? true,
    autoStage: o.auto_stage ?? false,
  };
}

/**
 * Auto-stage: every open lane with an independent PASS, a gate that is not RED, not inside a
 * candidate and without a staging request yet gets a staging request in the overlord's name.
 * Staging is automated and safe; production always stays a person's click.
 */
export async function autoStage(board: Board): Promise<number> {
  let n = 0;
  for (const l of board.lanes) {
    if (l.status !== 'open' || l.verdict !== 'pass' || l.gate === 'RED' || l.candidate || l.staging || !l.project) continue;
    const r = await releases.requestRelease({ project: l.project, sha: l.sha, lane: l.lane, target: 'staging', desk: l.desk != null ? String(l.desk) : null, reviewer: l.reviewer, actorName: 'overlord', runId: l.run_id });
    if (r.ok) n++;
    else logger.warn({ sha: l.sha, error: r.error }, 'Overlord auto-stage failed');
  }
  return n;
}

export function ensureOverlordTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS overlord_reports (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      trigger TEXT NOT NULL,
      model TEXT NOT NULL,
      report_json TEXT NOT NULL,
      digest TEXT,
      board_at TEXT
    );
    CREATE TABLE IF NOT EXISTS overlord_chat (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      role TEXT NOT NULL,
      user_id TEXT,
      user_name TEXT,
      text TEXT NOT NULL
    );
  `);
  try { getDb().exec('ALTER TABLE overlord_chat ADD COLUMN actions_json TEXT'); } catch { /* exists */ }
}

function withTable<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (!/no such table: overlord_reports/.test((e as Error).message)) throw e;
    ensureOverlordTable();
    return fn();
  }
}

function rowToReport(row: { id: string; created_at: string; trigger: string; model: string; report_json: string; digest: string | null; board_at: string | null }): OverlordReport {
  const parsed = JSON.parse(row.report_json) as { agents?: OverlordReport['agents']; recommendations?: Recommendation[]; plan?: ReleaseGroup[] };
  return { id: row.id, created_at: row.created_at, trigger: row.trigger, model: row.model, agents: parsed.agents ?? [], recommendations: parsed.recommendations ?? [], plan: parsed.plan ?? [], digest: row.digest, board_at: row.board_at ?? row.created_at };
}

export function getLatestReport(): OverlordReport | null {
  const row = withTable(() => getDb().prepare('SELECT * FROM overlord_reports ORDER BY created_at DESC, id DESC LIMIT 1').get() as Parameters<typeof rowToReport>[0] | undefined);
  return row ? rowToReport(row) : null;
}

export function listReports(limit = 20): OverlordReport[] {
  return withTable(() => (getDb().prepare('SELECT * FROM overlord_reports ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as Parameters<typeof rowToReport>[0][]).map(rowToReport));
}

// --- the prompt ---------------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the coordinator of a small software team of CLI coding agents (Claude Code, Codex) run by WaveCode. You never do the coding, review or specs yourself: you keep the overview and tell the people what needs a decision.

You receive the board as JSON: every agent (status, how long, current task, last reply, what it is blocked on, plan usage), every reviewed lane (exact SHA, verdict, gate, what is on staging and in production, the deterministic next step), the attention list, and the recent events. Your previous recommendations are included so you do not repeat yourself.

Rules you follow:
- A lane is promotable only with an independent PASS on the exact SHA and a gate that is not RED. Stale SHAs are never promotable. Staging is automatic and safe to recommend for any reviewed lane. Production is a human decision: recommend it, never assume it.
- Prefer reading state over asking agents. Recommend a nudge only when an agent is idle with open work for a long time or blocked on something a person can unblock.
- Be concrete and short. Name agents as @alias, lanes by project, desk and the first 8 characters of the SHA.
- If nothing changed that a person needs to act on, set digest to null.

Fixes and budget:
- Every NEEDS FIXES verdict, failed release or rejection is an open fix until an agent is queued on it (the board lists fixes with "assigned"). For each unassigned fix recommend kind "fix" with the agent_id to do it and the run_id of the lane: prefer the author (it knows the change) when it is idle and has weekly budget; otherwise the idle agent on the same runtime with the most weekly budget left. Never pick an agent below 10% weekly budget or one that is hung/crashed; say if nobody fits.
- Budget: agents report weekly and 5-hour % left. Mention an agent running low; spread new work to agents with budget.

Release planning — the practical advice the person wants most:
- Each lane deploys to staging on its own; that is cheap and always fine to recommend.
- For production, propose groups: lanes that touch the same area (same desk family, same module, one depends on another, a fix on top of a feature) go out together, in dependency order, so one verification covers them and nothing ships half. Independent lanes can ship separately; say so.
- Put a lane on hold when its verdict is not PASS, its gate is RED, it is stale, a newer freeze on the same lane is coming, or its staging run has not been verified yet (staging.verified_by is null). A production group contains only lanes verified on staging; say who verified.
- A lane with "candidate" set already sits in the deployer's release candidate branch: it ships with that release. Do not recommend staging, promoting or fixing it separately; mention it only as part of that release.
- Where the board lists "candidates", those are the unit of production: the deployer composes them, gates the combined code and stages them. Your production advice is per candidate (GO on the candidate once verified on staging), and for reviewed lanes not yet in a candidate: which ones to compose into the next candidate together. Never propose promoting a single lane when candidates exist.
- Order groups: hotfixes and small, verified changes first; large or risky changes last and alone.
- Use the lane summaries (scope of the change) to judge overlap; when you cannot tell, say what to check instead of guessing.

Answer with one JSON object and nothing else:
{
  "agents": [{"id": "<agent id>", "note": "<one line: what it is doing / needs>"}],
  "recommendations": [{"kind": "promote|stage|reject|nudge|reassign|refreeze|fix|info", "run_id": "<run id for promote/stage/reject/fix, else null>", "agent_id": "<agent id for nudge/reassign/fix, else null>", "sha": "<sha or null>", "text": "<one or two sentences: what and why>"}],
  "plan": [{"title": "<short name, e.g. 'Invoices batch: Desk #91 + #105'>", "shas": ["<full sha>", "..."], "target": "staging|production|hold", "why": "<one or two sentences: why together / why this order / what to verify first>"}],
  "digest": "<2-4 lines for the person: what to deploy now, what to wait for, or null>"
}`;

function recentEvents(limit = 40): Array<{ at: string; type: string; entity: string; summary: string }> {
  const last = getLatestEventId();
  return listEventsBefore(last ? last + 1 : null, limit).map((e: WaveEvent) => {
    let summary = '';
    try {
      const p = e.payload_json ? JSON.parse(e.payload_json) as Record<string, unknown> : {};
      summary = ['sha', 'verdict', 'status', 'target', 'reason', 'error', 'question']
        .map((k) => (typeof p[k] === 'string' || typeof p[k] === 'number' ? `${k}=${String(p[k]).slice(0, 80)}` : null))
        .filter(Boolean).join(' ');
    } catch { /* unparsable payload */ }
    return { at: e.created_at, type: e.type, entity: `${e.entity_type}:${e.entity_id}`, summary };
  });
}

export function buildPrompt(board: Board, trigger: string, previous: OverlordReport | null): string {
  const slim = {
    at: board.at,
    trigger,
    counts: board.counts,
    agents: board.agents.map((a) => ({
      id: a.id, name: a.alias ?? a.name, runtime: a.runtime, status: a.status, for_min: a.for_min,
      current: a.current ? { num: a.current.num, run_id: a.current.run_id, prompt: a.current.prompt.slice(0, 160) } : null,
      last_reply: a.last_reply ? { at: a.last_reply.at, text: a.last_reply.text.slice(0, 160) } : null,
      blocked_on: a.blocked_on, budget: a.budget, open_freezes: a.open_freezes,
    })),
    candidates: board.candidates.map((c) => ({
      project: c.project, name: c.name, tip8: c.tip.slice(0, 8), lanes: c.lanes.map((l) => `${l.desk ? `Desk #${l.desk} ` : ''}${l.sha.slice(0, 8)}`),
      staging: c.staging?.status ?? null, production: c.production?.status ?? null, verified_by: c.verified?.by ?? null, next: c.next,
    })),
    fixes: board.fixes.map((f) => ({
      run_id: f.run_id, sha8: f.sha.slice(0, 8), project: f.project, desk: f.desk, lane: f.lane, author_agent_id: f.author_agent_id, author: f.author, reviewer: f.reviewer,
      reason: f.reason, detail: f.detail, since: f.since, assigned: f.assigned ? { task: f.assigned.num, status: f.assigned.status, agent: f.assigned.agent_name } : null,
    })),
    lanes: board.lanes.map((l) => ({
      run_id: l.run_id, sha8: l.sha.slice(0, 8), sha: l.sha, project: l.project, desk: l.desk, lane: l.lane, author: l.author, reviewer: l.reviewer,
      verdict: l.verdict, gate: l.gate, status: l.status, promotable: l.promotable, candidate: l.candidate,
      staging: l.staging ? { status: l.staging.status, verified_by: l.staging.verified_by } : null, production: l.production?.status ?? null, next: l.next,
      summary: l.summary,
    })),
    attention: board.attention,
    recent_events: recentEvents(),
    previous_recommendations: previous?.recommendations.map((r) => ({ kind: r.kind, run_id: r.run_id ?? null, agent_id: r.agent_id ?? null, text: r.text })) ?? [],
  };
  return JSON.stringify(slim);
}

export function parseReport(text: string): { agents: OverlordReport['agents']; recommendations: Recommendation[]; plan: ReleaseGroup[]; digest: string | null } | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const agents = Array.isArray(o.agents)
    ? (o.agents as unknown[]).filter((a): a is { id: string; note: string } => !!a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string' && typeof (a as { note?: unknown }).note === 'string')
      .map((a) => ({ id: a.id, note: a.note.slice(0, 300) }))
    : [];
  const recommendations = Array.isArray(o.recommendations)
    ? (o.recommendations as unknown[]).flatMap((r) => {
        if (!r || typeof r !== 'object') return [];
        const x = r as Record<string, unknown>;
        const kind = KINDS.includes(x.kind as RecommendationKind) ? (x.kind as RecommendationKind) : 'info';
        if (typeof x.text !== 'string' || !x.text.trim()) return [];
        return [{
          kind,
          run_id: typeof x.run_id === 'string' ? x.run_id : null,
          agent_id: typeof x.agent_id === 'string' ? x.agent_id : null,
          sha: typeof x.sha === 'string' ? x.sha : null,
          text: x.text.trim().slice(0, 500),
        }];
      }).slice(0, 12)
    : [];
  const plan: ReleaseGroup[] = Array.isArray(o.plan)
    ? (o.plan as unknown[]).flatMap((g) => {
        if (!g || typeof g !== 'object') return [];
        const x = g as Record<string, unknown>;
        const shas = Array.isArray(x.shas) ? (x.shas as unknown[]).filter((s): s is string => typeof s === 'string' && /^[0-9a-f]{7,40}$/i.test(s)).map((s) => s.toLowerCase()) : [];
        if (shas.length === 0 || typeof x.title !== 'string') return [];
        const target: ReleaseGroup['target'] = x.target === 'production' || x.target === 'hold' ? x.target : 'staging';
        return [{ title: x.title.trim().slice(0, 120), shas, target, why: typeof x.why === 'string' ? x.why.trim().slice(0, 500) : '' }];
      }).slice(0, 10)
    : [];
  const digest = typeof o.digest === 'string' && o.digest.trim() ? o.digest.trim().slice(0, 1200) : null;
  return { agents, recommendations, plan, digest };
}

// --- chat -----------------------------------------------------------------------------------------

/** An action the overlord proposes in chat; the person presses it, nothing runs on its own. */
export interface ChatAction {
  kind: 'send' | 'assign_fix' | 'stage' | 'promote' | 'reject' | 'verify';
  /** send / assign_fix: the agent (resolved to an id when it exists) */
  agent?: string | null;
  agent_id?: string | null;
  /** send: the exact prompt to type into the agent */
  text?: string | null;
  /** assign_fix / stage / promote / reject: the lane's run */
  run_id?: string | null;
  /** verify / lane reference */
  sha?: string | null;
  label: string;
}

export interface ChatTurn { id: string; created_at: string; role: 'user' | 'assistant'; user_id: string | null; user_name: string | null; text: string; actions: ChatAction[] }

const CHAT_SYSTEM = `You are the coordinator of a small software team of CLI coding agents run by WaveCode, talking with one of the people who run it. You answer from the board you are given (agents, lanes, fixes, releases, budget, recent events) — never invent state. Be practical and short: what to deploy together and in what order, who should take a fix (prefer the author if idle with budget, else the idle agent on the same runtime with the most weekly budget), what is blocked and who can unblock it, where budget is running low. Name agents as @name and lanes by desk and the first 8 characters of the SHA.

When your answer involves doing something, also return it as actions the person can press — you never execute anything yourself:
- "send": a full prompt for an agent (the exact text to type into its pane; complete and self-contained, with paths and the expected deliverable).
- "assign_fix": queue a fix for a lane (run_id from the board's fixes) to an agent.
- "stage" / "promote" / "reject": a lane's run_id (promote only where no candidates exist; otherwise say which candidate to GO).
- "verify": a sha verified on staging.

Answer with one JSON object and nothing else:
{"answer": "<plain text, at most ~12 lines>", "actions": [{"kind": "send", "agent": "@codex1", "text": "<the prompt>"}, {"kind": "assign_fix", "agent": "@claude1", "run_id": "<run id>"}, {"kind": "stage|promote|reject", "run_id": "<run id>"}, {"kind": "verify", "sha": "<sha>"}]}`;

function parseChat(raw: string): { answer: string; actions: ChatAction[] } {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start < 0 || end <= start) return { answer: raw.trim(), actions: [] };
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return { answer: raw.trim(), actions: [] };
  }
  const answer = typeof o.answer === 'string' && o.answer.trim() ? o.answer.trim() : raw.trim();
  const actions: ChatAction[] = Array.isArray(o.actions)
    ? (o.actions as unknown[]).flatMap((a) => {
        if (!a || typeof a !== 'object') return [];
        const x = a as Record<string, unknown>;
        const kind = x.kind as ChatAction['kind'];
        if (kind !== 'send' && kind !== 'assign_fix' && kind !== 'stage' && kind !== 'promote' && kind !== 'reject' && kind !== 'verify') return [];
        const agentRef = typeof x.agent === 'string' ? x.agent.replace(/^@/, '').trim() : null;
        const resolved = agentRef ? resolveAgent(agentRef) : null;
        const agentName = resolved?.ok ? (resolved.data.alias ?? resolved.data.name) : agentRef;
        const agentId = resolved?.ok ? resolved.data.id : null;
        const text = typeof x.text === 'string' && x.text.trim() ? x.text.trim().slice(0, 8000) : null;
        const runId = typeof x.run_id === 'string' && x.run_id.trim() ? x.run_id.trim() : null;
        const sha = typeof x.sha === 'string' && /^[0-9a-f]{7,40}$/i.test(x.sha.trim()) ? x.sha.trim().toLowerCase() : null;
        if (kind === 'send' && (!agentId || !text)) return [];
        if (kind === 'assign_fix' && (!agentId || !runId)) return [];
        if ((kind === 'stage' || kind === 'promote' || kind === 'reject') && !runId) return [];
        if (kind === 'verify' && !sha) return [];
        const label = kind === 'send' ? `Send to @${agentName}` : kind === 'assign_fix' ? `Assign fix → @${agentName}` : kind === 'verify' ? `Verified on staging ${sha!.slice(0, 8)}` : `${kind[0].toUpperCase()}${kind.slice(1)} ${runId!.slice(-6)}`;
        return [{ kind, agent: agentName, agent_id: agentId, text, run_id: runId, sha, label }];
      }).slice(0, 8)
    : [];
  return { answer, actions };
}

type ChatRow = Omit<ChatTurn, 'actions'> & { actions_json?: string | null };

function rowToTurn(r: ChatRow): ChatTurn {
  let actions: ChatAction[] = [];
  try { actions = r.actions_json ? JSON.parse(r.actions_json) as ChatAction[] : []; } catch { actions = []; }
  const { actions_json: _drop, ...rest } = r;
  void _drop;
  return { ...rest, actions };
}

export function listChat(limit = 40): ChatTurn[] {
  // insertion order: two turns can share a second, and ulids are not monotonic within a millisecond
  return withTable(() => (getDb().prepare('SELECT * FROM overlord_chat ORDER BY rowid DESC LIMIT ?').all(limit) as ChatRow[]).reverse().map(rowToTurn));
}

export async function chat(message: string, user: { id: string | null; name: string }): Promise<Result<ChatTurn>> {
  const text = message.trim().slice(0, 4000);
  if (!text) return { ok: false, error: 'message is empty' };
  if (!isLlmConfigured()) return { ok: false, error: 'No LLM API key configured (llm.anthropic_api_key)' };
  const cfg = overlordConfig();
  const history = listChat(12);
  withTable(() => getDb().prepare('INSERT INTO overlord_chat (id, role, user_id, user_name, text) VALUES (?, ?, ?, ?, ?)').run(ulid(), 'user', user.id, user.name, text));
  const board = buildBoard();
  const previous = getLatestReport();
  const userMessage = JSON.stringify({
    board: JSON.parse(buildPrompt(board, 'chat', previous)) as unknown,
    conversation: history.map((t) => ({ who: t.role === 'user' ? (t.user_name ?? 'person') : 'you', text: t.text.slice(0, 600) })),
    question: { from: user.name, text },
  });
  const res = await completeText({ model: cfg.model, systemPrompt: CHAT_SYSTEM, userMessage, maxTokens: 2048 });
  if (!res.ok) return { ok: false, error: res.error };
  const parsed = parseChat(res.data);
  const answer = parsed.answer.slice(0, 6000);
  const id = ulid();
  withTable(() => getDb().prepare('INSERT INTO overlord_chat (id, role, user_id, user_name, text, actions_json) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'assistant', null, 'overlord', answer, JSON.stringify(parsed.actions)));
  emit('overlord.chat', 'overlord', id, { from: user.name, question: text.slice(0, 300), answer: answer.slice(0, 2000), actions: parsed.actions.length }, null);
  const turn = withTable(() => rowToTurn(getDb().prepare('SELECT * FROM overlord_chat WHERE id = ?').get(id) as ChatRow));
  return { ok: true, data: turn };
}

// --- waking ---------------------------------------------------------------------------------------

const wakeTimes: number[] = [];
let debounceTimer: NodeJS.Timeout | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;
let unsubscribe: (() => void) | null = null;
let pendingTrigger: string | null = null;
let inFlight: Promise<OverlordReport | null> | null = null;

function underCap(now: number, max: number): boolean {
  while (wakeTimes.length && now - wakeTimes[0] > 3_600_000) wakeTimes.shift();
  return wakeTimes.length < max;
}

/** One wake: board → model → report → thread item (+ notification when the digest changed). */
export async function wake(trigger: string, opts: { force?: boolean; now?: number } = {}): Promise<OverlordReport | null> {
  const cfg = overlordConfig();
  const now = opts.now ?? Date.now();
  if (!opts.force && !underCap(now, cfg.maxWakesPerHour)) {
    logger.info({ trigger, max: cfg.maxWakesPerHour }, 'Overlord wake skipped: hourly cap');
    return null;
  }
  if (!isLlmConfigured()) {
    logger.warn({ trigger }, 'Overlord wake skipped: no LLM API key configured (llm.anthropic_api_key)');
    return null;
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    wakeTimes.push(now);
    let board = buildBoard(now);
    if (cfg.autoStage) {
      const staged = await autoStage(board);
      if (staged > 0) board = buildBoard(now);
    }
    const previous = getLatestReport();
    const res = await completeText({ model: cfg.model, systemPrompt: SYSTEM_PROMPT, userMessage: buildPrompt(board, trigger, previous), maxTokens: 4096 });
    if (!res.ok) {
      logger.warn({ trigger, error: res.error }, 'Overlord model call failed');
      return null;
    }
    const parsed = parseReport(res.data);
    if (!parsed) {
      logger.warn({ trigger, head: res.data.slice(0, 200) }, 'Overlord answer was not the expected JSON');
      return null;
    }
    const report: OverlordReport = { id: ulid(), created_at: new Date(now).toISOString().replace('T', ' ').slice(0, 19), trigger, model: cfg.model, board_at: board.at, ...parsed };
    withTable(() => getDb().prepare('INSERT INTO overlord_reports (id, created_at, trigger, model, report_json, digest, board_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(report.id, report.created_at, trigger, cfg.model, JSON.stringify({ agents: report.agents, recommendations: report.recommendations, plan: report.plan }), report.digest, board.at));
    emit('overlord.report', 'overlord', report.id, {
      trigger, model: cfg.model, digest: report.digest, recommendations: report.recommendations, plan: report.plan, agents: report.agents, counts: board.counts,
    }, null);
    if (cfg.notify && report.digest && report.digest !== previous?.digest) {
      void notify({ title: 'WaveCode overlord', body: report.digest.slice(0, 400), url: '/overview', tag: 'overlord' }).catch(() => {});
    }
    logger.info({ trigger, reportId: report.id, recommendations: report.recommendations.length }, 'Overlord report');
    return report;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

function schedule(trigger: string): void {
  const cfg = overlordConfig();
  pendingTrigger = pendingTrigger ? `${pendingTrigger},${trigger}`.slice(0, 200) : trigger;
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    const t = pendingTrigger ?? trigger;
    pendingTrigger = null;
    void wake(t).catch((e) => logger.warn({ error: (e as Error).message }, 'Overlord wake failed'));
  }, cfg.debounceS * 1000);
}

export function startOverlord(): void {
  const cfg = overlordConfig();
  if (!cfg.enabled) {
    logger.info('Overlord disabled (overlord.enabled: false)');
    return;
  }
  if (!isLlmConfigured()) logger.warn('Overlord enabled but no LLM API key is configured; wakes will be skipped');
  unsubscribe = onEvent((e) => { if (TRIGGERS.has(e.type)) schedule(e.type); });
  if (cfg.heartbeatMin > 0) {
    heartbeatTimer = setInterval(() => schedule('heartbeat'), cfg.heartbeatMin * 60_000);
  }
  logger.info({ model: cfg.model, heartbeat_min: cfg.heartbeatMin, max_wakes_per_hour: cfg.maxWakesPerHour }, 'Overlord started');
}

export function stopOverlord(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  pendingTrigger = null;
}

/** Test hook. */
export function resetOverlordForTest(): void {
  stopOverlord();
  wakeTimes.length = 0;
  inFlight = null;
}

export { TRIGGERS as OVERLORD_TRIGGERS };
