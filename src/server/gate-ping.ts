/**
 * When a GREEN gate lands on a SHA whose latest verdict is NEEDS FIXES, ask
 * that reviewer for a final verdict. One ping per SHA. Never the author.
 */

import { getAgent, getDb, resolveAgent } from './db.js';
import { emit } from './event-bus.js';
import { deliverSystemLine } from './wire-lines.js';

export const GATE_PING = 'review.gate_pinged';

interface FreezePingRow {
  sha: string;
  lane: string | null;
  verdict: string | null;
  status: string;
  reviewer_agent_id: string | null;
  reviewer_name: string | null;
  author_agent_id: string | null;
  run_id: string | null;
}

function already(sha: string): boolean {
  try {
    const row = getDb().prepare('SELECT id FROM events WHERE type = ? AND entity_id = ? LIMIT 1').get(GATE_PING, sha) as { id: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

/** Ping the reviewer of every open NEEDS FIXES freeze on this SHA. Returns how many were sent. */
export function pingReviewersForGreenSha(sha: string): number {
  const prefix = sha.toLowerCase().slice(0, 8);
  if (prefix.length < 7) return 0;
  let rows: FreezePingRow[] = [];
  try {
    rows = getDb().prepare(
      `SELECT sha, lane, verdict, status, reviewer_agent_id, reviewer_name, author_agent_id, run_id
       FROM release_freezes WHERE verdict = 'needs-fixes' AND status IN ('open', 'behind-main') AND lower(sha) LIKE ?`,
    ).all(`${prefix}%`) as FreezePingRow[];
  } catch {
    return 0;
  }
  let n = 0;
  for (const f of rows) {
    if (!f.sha.toLowerCase().startsWith(prefix)) continue;
    if (already(f.sha)) continue;
    const reviewer = f.reviewer_agent_id
      ? getAgent(f.reviewer_agent_id)
      : f.reviewer_name ? resolveAgent(f.reviewer_name) : null;
    if (!reviewer?.ok) continue;
    if (reviewer.data.id === f.author_agent_id) continue;
    const sha8 = f.sha.slice(0, 8);
    const text = `[from WaveCode] Gate is GREEN on ${sha8}. Please write a final verdict. If the code is OK, write VERDICT: PASS (gate pending). Do not write NEEDS FIXES just to wait for the gate.`;
    deliverSystemLine(reviewer.data, text, { kind: 'info', source: 'gate' });
    emit(GATE_PING, 'run', f.sha, { sha: f.sha, reviewer_agent_id: reviewer.data.id, lane: f.lane, run_id: f.run_id }, null);
    n++;
  }
  return n;
}
