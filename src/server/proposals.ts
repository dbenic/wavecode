/**
 * Room proposals (spec §5f.3): changes to TEMPLATES/, SPEC.md or ROOM.md
 * proposed by a seat (the retro, or a seat's write_doc on a protected file)
 * with the evidence for them. They sit in the review queue; a person who may
 * write the file promotes it and WaveCode applies it — only if the file has
 * not changed since the proposal (else the proposal is stale). Nothing in
 * TEMPLATES/ or SPEC.md changes from an automated actor without a promote.
 */

import { createHash } from 'node:crypto';
import {
  decideRoomProposal,
  getRoom,
  getRoomProposal,
  insertRoomProposal,
  listRoomProposals,
  type RoomProposal,
  type User,
} from './db.js';
import { emit } from './event-bus.js';
import { MAX_DOC_BYTES } from './rooms.js';
import { userName } from './leases.js';
import { appendLedger, canWriteDoc, readDoc, resolveDocPath, writeDoc } from './rooms.js';

export const MAX_EVIDENCE_CHARS = 8000;

export type ProposalErrorCode = 'invalid' | 'forbidden' | 'not_found' | 'conflict';
export type ProposalResult<T> = { ok: true; data: T } | { ok: false; error: string; code: ProposalErrorCode };

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Line diff (LCS) in unified style: ` ` same, `-` removed, `+` added. */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  // n*m bounds the LCS table; max(n,m) bounds the per-row allocations (4M tiny arrays would block the loop)
  if (n * m > 4_000_000 || Math.max(n, m) > 20_000) return `--- before (${n} lines)\n+++ after (${m} lines)\n(too large to diff — full content in the proposal)`;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < n) out.push(`- ${a[i++]}`);
  while (j < m) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

/** Paths a proposal may change: anything but the WaveCode-written files and REPORTS/. */
function proposable(rel: string): boolean {
  return rel !== 'LEDGER.md' && rel !== 'DECISIONS.md' && !rel.startsWith('REPORTS/');
}

export function proposeRoomChange(
  user: Pick<User, 'id' | 'role'>,
  project: string,
  input: { path?: unknown; content?: unknown; evidence?: unknown; agentId?: string | null },
): ProposalResult<RoomProposal> {
  if (user.role === 'observer') return { ok: false, code: 'forbidden', error: 'Observers are read-only' };
  const room = getRoom(project);
  if (!room.ok) return { ok: false, code: 'not_found', error: room.error };
  if (typeof input.path !== 'string') return { ok: false, code: 'invalid', error: 'path is required' };
  const resolved = resolveDocPath(room.data, input.path);
  if (!resolved.ok) return { ok: false, code: 'invalid', error: resolved.error };
  if (!proposable(resolved.data.rel)) return { ok: false, code: 'invalid', error: `${resolved.data.rel} is written by WaveCode or directly — not via proposals` };
  if (typeof input.content !== 'string') return { ok: false, code: 'invalid', error: 'content must be the full new file' };
  // Same cap as a direct write — otherwise the proposal is stored, diffed, and can never be promoted
  if (Buffer.byteLength(input.content, 'utf8') > MAX_DOC_BYTES) {
    return { ok: false, code: 'invalid', error: `proposals are limited to ${MAX_DOC_BYTES} bytes` };
  }
  if (typeof input.evidence !== 'string' || !input.evidence.trim()) {
    return { ok: false, code: 'invalid', error: 'evidence is required — say what in the tasks, verdicts or feedback justifies the change' };
  }
  const current = readDoc(room.data, resolved.data.rel);
  const before = current.ok ? current.data.content : '';
  if (before === input.content) return { ok: false, code: 'invalid', error: 'the proposal does not change the file' };
  const created = insertRoomProposal({
    room: project,
    path: resolved.data.rel,
    content: input.content,
    base_sha256: sha(before),
    diff: lineDiff(before, input.content),
    evidence: input.evidence.trim().slice(0, MAX_EVIDENCE_CHARS),
    proposed_by: user.id,
    proposed_by_agent_id: input.agentId ?? null,
  });
  if (!created.ok) return { ok: false, code: 'invalid', error: created.error };
  emit('room.proposal_created', 'room_proposal', created.data.id, { project, path: resolved.data.rel });
  return created;
}

/** A person who may write the file approves → applied, if the file is unchanged since. */
export function promoteProposal(user: Pick<User, 'id' | 'role' | 'via_seat'>, id: string): ProposalResult<RoomProposal> {
  const proposal = getRoomProposal(id);
  if (!proposal.ok) return { ok: false, code: 'not_found', error: proposal.error };
  const p = proposal.data;
  if (p.status !== 'pending') return { ok: false, code: 'conflict', error: `Proposal is already ${p.status}` };
  if (user.via_seat) return { ok: false, code: 'forbidden', error: 'A person promotes proposals — not a seat' };
  const room = getRoom(p.room);
  if (!room.ok) return { ok: false, code: 'not_found', error: room.error };
  const access = canWriteDoc(user, room.data, p.path);
  if (!access.ok) return { ok: false, code: 'forbidden', error: access.error };

  const current = readDoc(room.data, p.path);
  if (sha(current.ok ? current.data.content : '') !== p.base_sha256) {
    decideRoomProposal(id, 'stale', user.id);
    return { ok: false, code: 'conflict', error: `${p.path} changed since this proposal was made — it is stale; ask for a fresh one` };
  }
  const written = writeDoc(room.data, p.path, p.content, user);
  if (!written.ok) return { ok: false, code: written.code === 'forbidden' ? 'forbidden' : 'invalid', error: written.error };
  const decided = decideRoomProposal(id, 'approved', user.id);
  appendLedger(room.data, {
    task: '—',
    agent: p.proposed_by ? userName(p.proposed_by) : 'retro',
    event: 'proposal promoted',
    result: `${p.path} changed by ${userName(user.id)}`,
  });
  emit('room.proposal_promoted', 'room_proposal', id, { project: p.room, path: p.path });
  return decided.ok ? decided : { ok: false, code: 'not_found', error: decided.error };
}

export function rejectProposal(user: Pick<User, 'id' | 'role' | 'via_seat'>, id: string): ProposalResult<RoomProposal> {
  const proposal = getRoomProposal(id);
  if (!proposal.ok) return { ok: false, code: 'not_found', error: proposal.error };
  if (proposal.data.status !== 'pending') return { ok: false, code: 'conflict', error: `Proposal is already ${proposal.data.status}` };
  if (user.via_seat) return { ok: false, code: 'forbidden', error: 'A person decides proposals — not a seat' };
  const room = getRoom(proposal.data.room);
  if (!room.ok) return { ok: false, code: 'not_found', error: room.error };
  if (!canWriteDoc(user, room.data, proposal.data.path).ok) return { ok: false, code: 'forbidden', error: 'Only someone who may write the file can reject it' };
  const decided = decideRoomProposal(id, 'rejected', user.id);
  emit('room.proposal_rejected', 'room_proposal', id, { project: proposal.data.room, path: proposal.data.path });
  return decided.ok ? decided : { ok: false, code: 'not_found', error: decided.error };
}

export { listRoomProposals };
