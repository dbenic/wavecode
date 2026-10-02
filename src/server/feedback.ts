/**
 * Feedback on replies (spec §5f.1): 👍/👎 and an optional "better: …" note
 * on any captured agent reply. The seat reads its recent feedback at the
 * start of a session (it is folded into the brief) and on demand via the
 * `list_feedback` MCP tool, and keeps what it learns in SEAT.md.
 */

import {
  getAgentMessage,
  getEvent,
  listReplyFeedback,
  upsertReplyFeedback,
  type ReplyFeedback,
  type Result,
  type User,  listUsers,
  type Agent,
} from './db.js';
import { emit } from './event-bus.js';

export const MAX_FEEDBACK_NOTE = 500;
export const BRIEF_FEEDBACK_ROWS = 20;

export type FeedbackErrorCode = 'invalid' | 'forbidden' | 'not_found';
export type FeedbackResult<T> = { ok: true; data: T } | { ok: false; error: string; code: FeedbackErrorCode };

export function recordFeedback(
  user: Pick<User, 'id' | 'role' | 'via_seat'>,
  messageId: string,
  body: { score?: unknown; note?: unknown },
): FeedbackResult<ReplyFeedback> {
  if (user.role === 'observer') return { ok: false, code: 'forbidden', error: 'Observers are read-only' };
  // Feedback comes from people (spec §5f): a seat token carries its owner's
  // id and could otherwise rewrite the owner's 👎 on its own answers.
  if (user.via_seat) return { ok: false, code: 'forbidden', error: 'Seat tokens cannot record feedback' };
  const msg = getAgentMessage(messageId);
  if (!msg.ok) return { ok: false, code: 'not_found', error: msg.error };
  if (msg.data.message_type !== 'reply') return { ok: false, code: 'invalid', error: 'Feedback is for agent replies' };
  if (body.score !== 1 && body.score !== -1) return { ok: false, code: 'invalid', error: 'score must be 1 (👍) or -1 (👎)' };
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') return { ok: false, code: 'invalid', error: 'note must be text' };
    note = body.note.replace(/\s+/g, ' ').trim().slice(0, MAX_FEEDBACK_NOTE) || null;
  }
  const saved = upsertReplyFeedback({
    reply_message_id: messageId,
    prompt_event_id: msg.data.ref_prompt_event_id ?? null,
    agent_id: msg.data.from_agent_id,
    user_id: user.id,
    score: body.score,
    note,
  });
  if (!saved.ok) return { ok: false, code: 'invalid', error: saved.error };
  emit('reply.feedback', 'agent_message', messageId, { score: body.score, note, agent_id: msg.data.from_agent_id });
  return saved;
}

export interface FeedbackView extends ReplyFeedback {
  reply_excerpt: string | null;
  prompt_excerpt: string | null;
}

function excerpt(text: string | null | undefined, n = 160): string | null {
  if (!text) return null;
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/**
 * Feedback a seat should act on: for a personal seat only its owner's (and
 * admins') — anyone can vote on a visible reply, and a note is text that
 * gets typed into the seat's brief, so other people's notes must not reach
 * a seat they do not own. A shared seat (no owner) sees everyone's.
 */
export function recentFeedbackForSeat(agent: Pick<Agent, 'id' | 'owner_id'>, limit = BRIEF_FEEDBACK_ROWS): FeedbackView[] {
  const rows = recentFeedback(agent.id, agent.owner_id ? limit * 5 : limit);
  if (!agent.owner_id) return rows.slice(0, limit);
  const admins = new Set(listUsers().filter((u) => u.role === 'admin').map((u) => u.id));
  return rows.filter((f) => f.user_id === agent.owner_id || admins.has(f.user_id)).slice(0, limit);
}

/** Recent feedback with the reply and the question it answered (for the seat). */
export function recentFeedback(agentId: string | null, limit = BRIEF_FEEDBACK_ROWS): FeedbackView[] {
  return listReplyFeedback({ ...(agentId ? { agent_id: agentId } : {}), limit }).map((f) => {
    const reply = getAgentMessage(f.reply_message_id);
    const prompt = f.prompt_event_id ? getEvent(f.prompt_event_id) : null;
    let promptText: string | null = null;
    if (prompt?.payload_json) {
      try {
        promptText = (JSON.parse(prompt.payload_json) as { text?: string }).text ?? null;
      } catch {
        promptText = null;
      }
    }
    return { ...f, reply_excerpt: excerpt(reply.ok ? reply.data.message : null), prompt_excerpt: excerpt(promptText, 100) };
  });
}

/**
 * For the seat brief: the feedback its answers got (newest first), so the
 * next session starts from it — "👎 too long — on: what is everyone on?".
 */
export function feedbackBriefLine(agent: Pick<Agent, 'id' | 'owner_id'>): string {
  const rows = recentFeedbackForSeat(agent).filter((f) => f.score < 0 || f.note);
  if (rows.length === 0) return '';
  const items = rows.slice(0, 10).map((f) => {
    const mark = f.score > 0 ? '👍' : '👎';
    const what = f.note ? `"${f.note}"` : '(no note)';
    return `${mark} ${what}${f.prompt_excerpt ? ` — on: "${f.prompt_excerpt}"` : ''}`;
  });
  return `Feedback on your recent answers (newest first) — adjust to it and keep the lesson in SEAT.md: ${items.join('; ')}.`;
}

export function feedbackSummary(rows: ReplyFeedback[], viewerId: string): { up: number; down: number; mine: number | null; mine_note: string | null } {
  const mine = rows.find((r) => r.user_id === viewerId) ?? null;
  return {
    up: rows.filter((r) => r.score > 0).length,
    down: rows.filter((r) => r.score < 0).length,
    mine: mine?.score ?? null,
    mine_note: mine?.note ?? null,
  };
}

export type { Result };
