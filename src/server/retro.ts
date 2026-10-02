/**
 * The retro (spec §5f.3): once a night (or `wavecode retro <room>`) the
 * room's seat gets the evidence of the last week — tasks per template,
 * verdicts and fix rounds, questions agents sent back, feedback on replies,
 * the questions people asked — and proposes (a) template / ROOM.md changes
 * with the evidence for each and (b) a vocabulary update for ROOM.md. Its
 * proposals land in the review queue; nothing applies without a promote.
 */

import { getConfig } from './config.js';
import {
  getAgent,
  getDb,
  getRoom,
  getUser,
  listAgents,
  type Agent,
  type Room,
} from './db.js';
import { emit } from './event-bus.js';
import { isAdmin } from './users.js';
import { checkAgentAccess } from './leases.js';
import type { User } from './db.js';
import { recentFeedback } from './feedback.js';
import logger from './logger.js';
import { roomMetrics, type TemplateMetrics } from './metrics.js';
import { resolveOrchestratorAgent } from './orchestrator.js';
import { trackPrompt } from './reply-capture.js';
import { addReport, listRooms } from './rooms.js';
import * as sessionManager from './session-manager.js';
import { getRuntimeState } from './runtime-liveness.js';

export type RetroErrorCode = 'not_found' | 'unavailable' | 'failed' | 'forbidden';
export type RetroResult<T> = { ok: true; data: T } | { ok: false; error: string; code: RetroErrorCode };

const DAY_MS = 86_400_000;

function sqlTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function pct(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 100)}%`;
}

function metricsTable(rows: TemplateMetrics[]): string {
  return [
    '| template | tasks | reviewed | first-pass PASS | mean fix rounds | questions/task | time to first RESULT |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((m) => `| ${m.template} | ${m.tasks} | ${m.reviewed} | ${pct(m.first_pass_rate)} | ${m.mean_fix_rounds ?? '—'} | ${m.questions_rate ?? '—'} | ${m.mean_time_to_result_s === null ? '—' : `${Math.round(m.mean_time_to_result_s / 60)} min`} |`),
  ].join('\n');
}

/** The seat that runs a room's retro: the room owner's seat, else the shared orchestrator. */
export function retroSeatFor(room: Room): Agent | null {
  if (room.owner_id) {
    const owner = getUser(room.owner_id);
    if (owner.ok && owner.data.seat_agent_id) {
      const seat = getAgent(owner.data.seat_agent_id);
      if (seat.ok) return seat.data;
    }
  }
  return resolveOrchestratorAgent(listAgents().filter((a) => a.lease_reason !== 'seat'));
}

/** Evidence for the retro, as markdown (also written to REPORTS/). */
export function buildRetroEvidence(room: Room, now = new Date(), windowDays = getConfig().retro?.window_days ?? 7): { markdown: string; activity: number } {
  const since = sqlTime(new Date(now.getTime() - windowDays * DAY_MS));
  const db = getDb();
  const tasks = db.prepare(`
    SELECT id, num, template, status, prompt, created_at FROM tasks WHERE room = ? AND created_at >= ? ORDER BY created_at
  `).all(room.project, since) as Array<{ id: string; num: number | null; template: string | null; status: string; prompt: string; created_at: string }>;

  const reviews = db.prepare(`
    SELECT cr.fix_round, cr.verdict, cr.issues_found, substr(cr.feedback, 1, 400) AS feedback
    FROM code_reviews cr JOIN runs r ON r.id = cr.run_id WHERE r.task_id = ? AND cr.status = 'done' ORDER BY cr.created_at
  `);
  const questions = db.prepare("SELECT message FROM agent_messages WHERE ref_task_id = ? AND message_type = 'request' ORDER BY created_at");

  const taskLines = tasks.map((t) => {
    let rv: Array<{ fix_round: number; verdict: string | null; issues_found: number; feedback: string | null }> = [];
    try {
      rv = reviews.all(t.id) as typeof rv;
    } catch {
      rv = []; // no reviews table yet
    }
    const qs = (questions.all(t.id) as Array<{ message: string }>).map((q) => q.message.replace(/\s+/g, ' ').slice(0, 160));
    const verdicts = rv.map((r) => `r${r.fix_round}: ${r.verdict ?? '?'}${r.issues_found ? ` (${r.issues_found} issues)` : ''}${r.feedback ? ` — ${r.feedback.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
    return [
      `- #${t.num ?? '?'} [${t.template ?? 'build'}] ${t.status}: ${t.prompt.replace(/\s+/g, ' ').slice(0, 140)}`,
      ...verdicts.map((v) => `  - review ${v}`),
      ...qs.map((q) => `  - asked back: ${q}`),
    ].join('\n');
  });

  // Feedback on replies, and what people asked the seats, in the window
  const seats = listAgents().filter((a) => a.role === 'orchestrator');
  const feedback = seats.flatMap((s) => recentFeedback(s.id, 50))
    .filter((f) => f.created_at >= since)
    .map((f) => `- ${f.score > 0 ? '👍' : '👎'}${f.note ? ` "${f.note}"` : ''}${f.prompt_excerpt ? ` — question: "${f.prompt_excerpt}"` : ''}${f.reply_excerpt ? ` — answer began: "${f.reply_excerpt.slice(0, 120)}"` : ''}`);
  const asked = seats.length === 0 ? [] : (db.prepare(`
    SELECT payload_json FROM events WHERE type = 'agent.prompt_sent' AND created_at >= ? AND actor_id IS NOT NULL
      AND entity_id IN (${seats.map(() => '?').join(',')}) ORDER BY id
  `).all(since, ...seats.map((s) => s.id)) as Array<{ payload_json: string | null }>)
    .map((r) => {
      try {
        const p = JSON.parse(r.payload_json ?? '{}') as { text?: string; via?: string };
        return p.via ? null : p.text?.replace(/\s+/g, ' ').slice(0, 160) ?? null;
      } catch {
        return null;
      }
    })
    .filter((t): t is string => !!t);

  const markdown = [
    `# Retro evidence — ${room.project}, ${windowDays} days to ${now.toISOString().slice(0, 10)}`,
    '',
    '## Metrics per template',
    metricsTable(roomMetrics(room.project, { since })),
    '',
    '## Tasks, verdicts and questions back',
    taskLines.length ? taskLines.join('\n') : '(no tasks in this room in the window)',
    '',
    '## Feedback on answers',
    feedback.length ? feedback.join('\n') : '(none)',
    '',
    '## What people asked the seats',
    asked.length ? asked.map((q) => `- ${q}`).join('\n') : '(none)',
    '',
  ].join('\n');
  return { markdown, activity: tasks.length + feedback.length + asked.length };
}

/** The instruction typed into the seat (one line — a newline would submit early). */
export function retroPrompt(room: Room, evidencePath: string): string {
  return [
    `Retro for room ${room.project}. Read the evidence with read_doc {room: "${room.project}", path: "${evidencePath}"} (also ${room.root}/${evidencePath}), plus TEMPLATES/*.md and ROOM.md.`,
    '(a) For each change the evidence supports, call propose_room_change {room, path, content (the full new file), evidence} on TEMPLATES/<kind>.md or ROOM.md — the evidence must cite the numbers or cases, e.g. "4/6 builds failed typecheck on first review → add npm run typecheck to build done_when".',
    '(b) Propose a vocabulary update to the "## Vocabulary" section of ROOM.md: questions people re-ask, the words they use, and the answer shape that scored well (👍) or badly (👎).',
    'Do not edit TEMPLATES/ or SPEC.md directly — a person promotes your proposals. You may update SEAT.md freely with what you learned. Reply with a short list of what you proposed.',
  ].join(' ');
}

export async function runRetro(
  project: string,
  opts: { actorId?: string | null; actor?: Pick<User, 'id' | 'role' | 'via_seat'> | null; now?: Date } = {},
): Promise<RetroResult<{ seat: string; evidence: string; activity: number }>> {
  const room = getRoom(project);
  if (!room.ok) return { ok: false, code: 'not_found', error: room.error };
  const seat = retroSeatFor(room.data);
  if (!seat) return { ok: false, code: 'unavailable', error: `No seat to run the retro for ${project} — the room owner needs a seat, or configure orchestrator_agent` };

  // The retro types a prompt into the room owner's private seat: same lease
  // rule as any other prompt (owner or admin), and never from a seat token.
  // The nightly runner has no actor and is exempt.
  if (opts.actor) {
    if (opts.actor.via_seat) return { ok: false, code: 'forbidden', error: 'Seat tokens cannot start a retro' };
    if (!isAdmin(opts.actor)) {
      const access = checkAgentAccess(seat, opts.actor);
      if (!access.ok) return { ok: false, code: 'forbidden', error: access.error };
    }
  }

  if (getRuntimeState(seat) === 'dead') {
    return { ok: false, code: 'unavailable', error: `${seat.name}'s runtime is not running — relaunch it, then run the retro` };
  }

  const now = opts.now ?? new Date();
  const evidence = buildRetroEvidence(room.data, now);
  const evidencePath = addReport(room.data, `${now.toISOString().slice(0, 10)}-retro-evidence`, evidence.markdown);
  const prompt = retroPrompt(room.data, evidencePath);
  const sent = sessionManager.sendKeys(seat.id, prompt);
  if (!sent.ok) return { ok: false, code: 'failed', error: sent.error };

  const ev = emit('agent.prompt_sent', 'agent', seat.id, { text: prompt.slice(0, 2000), via: 'retro' }, opts.actorId ?? null);
  trackPrompt({ agent: seat, actorId: opts.actorId ?? null, prompt, promptEventId: ev?.id ?? null });
  emit('retro.started', 'room', room.data.id, { project, seat: seat.name, evidence: evidencePath, activity: evidence.activity }, opts.actorId ?? null);
  logger.info({ room: project, seat: seat.name }, 'Retro started');
  return { ok: true, data: { seat: seat.name, evidence: evidencePath, activity: evidence.activity } };
}

const LAST_RUN_KEY = 'retro.last:';

/**
 * Health-monitor tick: at `retro.hour_utc`, once per UTC day, run the retro
 * for every room with activity in the window and a seat to run it.
 */
export async function maybeRunNightlyRetros(now = new Date()): Promise<string[]> {
  const cfg = getConfig().retro;
  if (!cfg?.nightly || now.getUTCHours() !== cfg.hour_utc) return [];
  const today = now.toISOString().slice(0, 10);
  const db = getDb();
  const ran: string[] = [];
  for (const room of listRooms()) {
    const key = `${LAST_RUN_KEY}${room.project}`;
    const last = db.prepare('SELECT value FROM kv_settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (last?.value === today) continue;
    db.prepare('INSERT INTO kv_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, today);
    if (buildRetroEvidence(room, now, cfg.window_days).activity === 0) continue;
    const result = await runRetro(room.project, { now });
    if (result.ok) ran.push(room.project);
    else logger.info({ room: room.project, error: result.error }, 'Nightly retro skipped');
  }
  return ran;
}
