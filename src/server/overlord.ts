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
import { getDb, listEventsBefore, getLatestEventId, type WaveEvent } from './db.js';
import { emit, onEvent } from './event-bus.js';
import { completeText, isLlmConfigured } from './llm-provider.js';
import logger from './logger.js';
import { notify } from './notifications.js';
import { buildBoard, type Board } from './overview.js';

export const DEFAULT_MODEL = 'claude-sonnet-5-5';

export type RecommendationKind = 'promote' | 'stage' | 'reject' | 'nudge' | 'reassign' | 'refreeze' | 'info';

export interface Recommendation {
  kind: RecommendationKind;
  run_id?: string | null;
  agent_id?: string | null;
  sha?: string | null;
  text: string;
}

export interface OverlordReport {
  id: string;
  created_at: string;
  trigger: string;
  model: string;
  agents: Array<{ id: string; note: string }>;
  recommendations: Recommendation[];
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

const KINDS: RecommendationKind[] = ['promote', 'stage', 'reject', 'nudge', 'reassign', 'refreeze', 'info'];

export function overlordConfig() {
  const o = getConfig().overlord ?? {};
  return {
    enabled: o.enabled ?? false,
    model: o.model ?? DEFAULT_MODEL,
    heartbeatMin: o.heartbeat_min ?? 30,
    maxWakesPerHour: o.max_wakes_per_hour ?? 12,
    debounceS: o.debounce_s ?? 45,
    notify: o.notify ?? true,
  };
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
  `);
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
  const parsed = JSON.parse(row.report_json) as { agents?: OverlordReport['agents']; recommendations?: Recommendation[] };
  return { id: row.id, created_at: row.created_at, trigger: row.trigger, model: row.model, agents: parsed.agents ?? [], recommendations: parsed.recommendations ?? [], digest: row.digest, board_at: row.board_at ?? row.created_at };
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

Answer with one JSON object and nothing else:
{
  "agents": [{"id": "<agent id>", "note": "<one line: what it is doing / needs>"}],
  "recommendations": [{"kind": "promote|stage|reject|nudge|reassign|refreeze|info", "run_id": "<run id for promote/stage/reject, else null>", "agent_id": "<agent id for nudge/reassign, else null>", "sha": "<sha or null>", "text": "<one or two sentences: what and why>"}],
  "digest": "<2-4 lines for the person, or null>"
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
      blocked_on: a.blocked_on, usage: a.usage, open_freezes: a.open_freezes,
    })),
    lanes: board.lanes.map((l) => ({
      run_id: l.run_id, sha8: l.sha.slice(0, 8), sha: l.sha, project: l.project, desk: l.desk, lane: l.lane, author: l.author, reviewer: l.reviewer,
      verdict: l.verdict, gate: l.gate, status: l.status, promotable: l.promotable, staging: l.staging?.status ?? null, production: l.production?.status ?? null, next: l.next,
    })),
    attention: board.attention,
    recent_events: recentEvents(),
    previous_recommendations: previous?.recommendations.map((r) => ({ kind: r.kind, run_id: r.run_id ?? null, agent_id: r.agent_id ?? null, text: r.text })) ?? [],
  };
  return JSON.stringify(slim);
}

export function parseReport(text: string): { agents: OverlordReport['agents']; recommendations: Recommendation[]; digest: string | null } | null {
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
  const digest = typeof o.digest === 'string' && o.digest.trim() ? o.digest.trim().slice(0, 1200) : null;
  return { agents, recommendations, digest };
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
    const board = buildBoard(now);
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
      .run(report.id, report.created_at, trigger, cfg.model, JSON.stringify({ agents: report.agents, recommendations: report.recommendations }), report.digest, board.at));
    emit('overlord.report', 'overlord', report.id, {
      trigger, model: cfg.model, digest: report.digest, recommendations: report.recommendations, agents: report.agents, counts: board.counts,
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
