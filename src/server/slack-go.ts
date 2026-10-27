/**
 * A production GO typed by its approver in Slack (27 Oct 2026).
 *
 * The orchestrator seat (pm-denis) acts as its person through a seat token, which
 * never carries admin powers (spec §5d). Production stays admin-only. The one way a
 * seat may request a production release is when its person has just said so
 * themselves: a Slack message from that person's own Slack user, bridged to the seat,
 * that names the SHA and says GO (or push / promote / deploy / ship) with the word
 * production. The bridge records such a prompt as `agent.prompt_sent` with the
 * person as actor and the text prefixed "[from Slack …]", so the check is a query,
 * not a judgment: no model can invent a GO, relay someone else's, or reuse an old one.
 */

import { getConfig } from './config.js';
import { getDb, getUser, type Result, type User } from './db.js';
import { isAdmin } from './users.js';

export const DEFAULT_GO_WINDOW_MIN = 15;
const SLACK_PREFIX = /^\[from Slack\b/i;
const GO_WORD = /\b(go|push|promote|deploy|ship|release)\b/i;
const PROD_WORD = /\b(prod|production)\b/i;

export interface SlackGo {
  event_id: number;
  at: string;
  user_name: string;
  excerpt: string;
}

function windowMin(): number {
  const v = getConfig().releases?.slack_go_window_min;
  return typeof v === 'number' && v > 0 ? v : DEFAULT_GO_WINDOW_MIN;
}

function toIso(sqlite: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sqlite) ? sqlite.replace(' ', 'T') + 'Z' : sqlite;
}

/** The newest Slack message from `userId` within the window that names `sha` and says GO for production. */
export function findSlackGo(userId: string, sha: string, now = Date.now()): SlackGo | null {
  const since = new Date(now - windowMin() * 60_000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const rows = getDb().prepare(
    `SELECT id, payload_json, created_at FROM events WHERE type = 'agent.prompt_sent' AND actor_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 50`,
  ).all(userId, since) as { id: number; payload_json: string | null; created_at: string }[];
  const short = sha.slice(0, 8).toLowerCase();
  for (const r of rows) {
    let text = '';
    try { text = String((JSON.parse(r.payload_json ?? '{}') as { text?: unknown }).text ?? ''); } catch { continue; }
    if (!SLACK_PREFIX.test(text)) continue;
    const body = text.replace(/^\[[^\]]*\]\s*/, '');
    const names = new RegExp(`\\b${short}[0-9a-f]{0,32}\\b`, 'i').test(body);
    if (!names || !GO_WORD.test(body) || !PROD_WORD.test(body)) continue;
    const u = getUser(userId);
    return { event_id: r.id, at: toIso(r.created_at), user_name: u.ok ? u.data.name : userId, excerpt: body.replace(/\s+/g, ' ').slice(0, 160) };
  }
  return null;
}

export const SEAT_GO_MISSING = 'a seat may request a production release only right after its person typed the GO in Slack';

/**
 * May this seat-token user request a production release of `sha` now?
 * The person must be an admin on `releases.production_approvers`, and their own
 * Slack GO for this SHA must be within the window.
 */
export function seatProductionAllowed(user: Pick<User, 'id' | 'name' | 'via_seat'>, sha: string, now = Date.now()): Result<SlackGo> {
  if (!user.via_seat) return { ok: false, error: 'not a seat token' };
  const person = getUser(user.id);
  if (!person.ok || !isAdmin(person.data)) return { ok: false, error: `${user.name} is not an admin` };
  const list = getConfig().releases?.production_approvers ?? [];
  if (!list.some((n) => n.trim().toLowerCase() === person.data.name.toLowerCase())) {
    return { ok: false, error: `${person.data.name} is not in releases.production_approvers` };
  }
  const go = findSlackGo(user.id, sha, now);
  if (!go) return { ok: false, error: `${SEAT_GO_MISSING} (window ${windowMin()} min; the message must name ${sha.slice(0, 8)} and say GO / push / deploy with "production")` };
  return { ok: true, data: go };
}

/** One line for the release note and the audit trail. */
export function goNote(go: SlackGo): string {
  return `GO by @${go.user_name} in Slack at ${go.at.slice(11, 16)} UTC (event ${go.event_id}): "${go.excerpt}"`;
}
