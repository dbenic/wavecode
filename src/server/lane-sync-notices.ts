/**
 * Per-lane pause for behind-main / lane-sync notices.
 *
 * There is no other mute. `laneAutomationDenied` is a permanent deny list, and
 * the 30-minute damper only drops a repeat send. This flag stores who paused
 * the lane, when, and why. While it is set, `pingLaneAboutMain` skips that
 * lane. Freeze status updates and Stage eligibility are unchanged.
 *
 * A lane is deferred when its newest freeze's desk (or a desk number in the
 * lane name) is a Product Desk request whose status is `deferred`.
 */

import { getAgent, getDb, type Agent, type Result } from './db.js';
import { deskIdsIn } from './desk-tracking.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { cachedBoard } from './product-desk.js';
import { currentActorId } from './request-context.js';

export const SYNC_NOTICE_EVENT = 'lane.sync_notices';
export const STAGE_CLEAR_REASON = 'cleared by Stage request';
const REASON_MAX = 500;
/** Git branch names: slash, dot, dash, underscore. Not `..`, a leading `-`, spaces, or controls. */
const LANE_MAX = 255;
const LANE_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/;

export type SyncNoticeStatus = 'paused' | 'not found' | 'invalid';

export interface SyncNoticeLaneResult {
  lane: string;
  status: SyncNoticeStatus;
}

export type SyncNoticeApply =
  | { ok: true; lanes: string[]; results: SyncNoticeLaneResult[] }
  | { ok: false; error: string; results: SyncNoticeLaneResult[] };

/**
 * A lane id `pingLaneAboutMain` can store. `claude1/foo` is valid.
 * Rejects `..`, a leading `-`, control characters, spaces, and over-long names.
 */
export function canonicalLaneName(raw: string): string | null {
  const lane = raw.trim();
  if (!lane || lane.length > LANE_MAX || !LANE_RE.test(lane)) return null;
  if (lane.includes('..') || lane.includes('//') || lane.endsWith('/') || lane.endsWith('.')) return null;
  if (/[\u0000-\u001f\u007f]/.test(lane) || /\s/.test(lane)) return null;
  const parts = lane.split('/');
  if (parts.some((part) => !part || part.startsWith('.') || part.startsWith('-') || part.endsWith('.lock') || part.endsWith('.'))) return null;
  return lane;
}

export interface SyncNoticeRow {
  lane: string;
  sync_notices_paused: number;
  paused_by: string | null;
  paused_at: string | null;
  reason: string | null;
}

export function requireSyncNoticeReason(reason: unknown): Result<string> {
  if (typeof reason !== 'string' || !reason.trim()) return { ok: false, error: 'reason is required' };
  const text = reason.trim();
  if (text.length > REASON_MAX) return { ok: false, error: `reason must be at most ${REASON_MAX} characters` };
  return { ok: true, data: text };
}

export function syncNoticesPaused(lane: string): boolean {
  return read(lane)?.sync_notices_paused === 1;
}

export function getSyncNotice(lane: string): SyncNoticeRow | null {
  return read(lane);
}

/**
 * Pause or resume an explicit lane list. A valid name with no row yet is
 * inserted on pause — `syncNoticesPaused` reads that row. An invalid name
 * rejects the whole call and writes nothing. Resume of a lane that is not
 * paused is `not found` and does not insert a row.
 */
export function applyLaneSyncNotices(
  action: 'pause' | 'resume',
  lanes: readonly unknown[],
  by: string,
  reason: string,
  actorId?: string | null,
): SyncNoticeApply {
  const parsed = requireSyncNoticeReason(reason);
  if (!parsed.ok) return { ok: false, error: parsed.error, results: [] };
  const classified = classifyLanes(lanes);
  if (classified.invalid) return { ok: false, error: 'invalid lane name', results: classified.results };
  if (classified.valid.length === 0) return { ok: false, error: 'name at least one lane', results: [] };
  const at = new Date().toISOString();
  const actor = actorId === undefined ? currentActorId() : actorId;
  const affected: string[] = [];
  const results: SyncNoticeLaneResult[] = [];
  getDb().transaction(() => {
    for (const lane of classified.valid) {
      if (action === 'pause') {
        getDb().prepare(`
          INSERT INTO lane_sync_notices (lane, sync_notices_paused, paused_by, paused_at, reason)
          VALUES (?, 1, ?, ?, ?)
          ON CONFLICT(lane) DO UPDATE SET
            sync_notices_paused = 1,
            paused_by = excluded.paused_by,
            paused_at = excluded.paused_at,
            reason = excluded.reason
        `).run(lane, by, at, parsed.data);
        audit('pause', lane, parsed.data, by, actor);
        affected.push(lane);
        results.push({ lane, status: 'paused' });
        continue;
      }
      const row = read(lane);
      if (row?.sync_notices_paused !== 1) {
        results.push({ lane, status: 'not found' });
        continue;
      }
      getDb().prepare(`
        UPDATE lane_sync_notices
        SET sync_notices_paused = 0, paused_by = ?, paused_at = ?, reason = ?
        WHERE lane = ?
      `).run(by, at, parsed.data, lane);
      audit('resume', lane, parsed.data, by, actor);
      affected.push(lane);
    }
  })();
  return { ok: true, lanes: affected, results };
}

export function pauseSyncNotices(lanes: readonly unknown[], by: string, reason: string, actorId?: string | null): Result<string[]> {
  const applied = applyLaneSyncNotices('pause', lanes, by, reason, actorId);
  if (!applied.ok) return { ok: false, error: applied.error };
  return { ok: true, data: applied.lanes };
}

/** Lanes that were paused. A lane that was not paused is `not found` and is not listed. */
export function resumeSyncNotices(lanes: readonly unknown[], by: string, reason: string, actorId?: string | null): Result<string[]> {
  const applied = applyLaneSyncNotices('resume', lanes, by, reason, actorId);
  if (!applied.ok) return { ok: false, error: applied.error };
  return { ok: true, data: applied.lanes };
}

export function pauseDeferredLanes(agentId: string, by: string, reason: string, actorId?: string | null): Result<string[]> {
  const lanes = deferredLanesForAgent(agentId);
  if (!lanes.ok) return lanes;
  return pauseSyncNotices(lanes.data, by, reason, actorId);
}

export function resumeDeferredLanes(agentId: string, by: string, reason: string, actorId?: string | null): Result<string[]> {
  const lanes = deferredLanesForAgent(agentId);
  if (!lanes.ok) return lanes;
  return resumeSyncNotices(lanes.data, by, reason, actorId);
}

/**
 * A staging request that was accepted drops the pause. A refusal does not.
 * The audit row names the stage actor and keeps the pause reason.
 */
export function clearSyncNoticesForStage(lane: string, by: string | null): boolean {
  if (!lane) return false;
  const row = read(lane);
  if (row?.sync_notices_paused !== 1) return false;
  const who = by?.trim() || 'unknown';
  getDb().prepare('UPDATE lane_sync_notices SET sync_notices_paused = 0 WHERE lane = ?').run(lane);
  emit(SYNC_NOTICE_EVENT, 'lane', lane, {
    action: 'stage_clear',
    lane,
    reason: STAGE_CLEAR_REASON,
    previous_reason: row.reason,
    previous_by: row.paused_by,
    by: who,
  }, currentActorId());
  logger.info({ lane, by: who, previous_reason: row.reason }, 'Sync notices cleared by Stage request');
  return true;
}

/** Newest freeze per lane whose desk is deferred and which this agent owns. */
export function deferredLanesForAgent(agentId: string): Result<string[]> {
  const agent = getAgent(agentId);
  if (!agent.ok) return agent;
  const deferred = deferredDeskIds();
  const lanes: string[] = [];
  for (const [lane, freeze] of newestByLane()) {
    const owned = freeze.author_agent_id === agent.data.id || agentOwnsLane(agent.data, lane);
    if (!owned) continue;
    if (!isDeferredLane(lane, freeze.desk, deferred)) continue;
    lanes.push(lane);
  }
  lanes.sort();
  return { ok: true, data: lanes };
}

function audit(action: 'pause' | 'resume', lane: string, reason: string, by: string, actorId: string | null): void {
  emit(SYNC_NOTICE_EVENT, 'lane', lane, { action, lane, reason, by }, actorId);
  logger.info({ lane, action, by }, 'Sync notices changed');
}

function classifyLanes(lanes: readonly unknown[]): { valid: string[]; results: SyncNoticeLaneResult[]; invalid: boolean } {
  const valid: string[] = [];
  const results: SyncNoticeLaneResult[] = [];
  const seen = new Set<string>();
  let invalid = false;
  for (const raw of lanes) {
    const shown = typeof raw === 'string' ? raw.trim() : '';
    const name = typeof raw === 'string' ? canonicalLaneName(raw) : null;
    if (!name) {
      invalid = true;
      results.push({ lane: shown, status: 'invalid' });
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    valid.push(name);
  }
  return { valid, results, invalid };
}

function read(lane: string): SyncNoticeRow | null {
  try {
    return (getDb().prepare(
      'SELECT lane, sync_notices_paused, paused_by, paused_at, reason FROM lane_sync_notices WHERE lane = ?',
    ).get(lane) as SyncNoticeRow | undefined) ?? null;
  } catch (e) {
    if (/no such table: lane_sync_notices/.test((e as Error).message)) return null;
    throw e;
  }
}

function deferredDeskIds(): Set<number> {
  const ids = new Set<number>();
  for (const item of cachedBoard() ?? []) {
    if (item.status.trim().toLowerCase() === 'deferred') ids.add(item.id);
  }
  return ids;
}

function isDeferredLane(lane: string, desk: number | null, deferred: Set<number>): boolean {
  const ids = new Set<number>();
  if (desk != null && Number.isInteger(desk)) ids.add(desk);
  for (const id of deskIdsIn(lane)) ids.add(id);
  for (const id of ids) if (deferred.has(id)) return true;
  return false;
}

interface LaneFreeze {
  lane: string;
  desk: number | null;
  author_agent_id: string | null;
}

function newestByLane(): Map<string, LaneFreeze> {
  const map = new Map<string, LaneFreeze>();
  let rows: LaneFreeze[] = [];
  try {
    rows = getDb().prepare(
      `SELECT lane, desk, author_agent_id FROM release_freezes
       WHERE lane IS NOT NULL AND lane != ''
       ORDER BY created_at DESC, rowid DESC`,
    ).all() as LaneFreeze[];
  } catch (e) {
    if (/no such table: release_freezes/.test((e as Error).message)) return map;
    throw e;
  }
  for (const row of rows) {
    if (!map.has(row.lane)) map.set(row.lane, row);
  }
  return map;
}

function agentOwnsLane(agent: Agent, lane: string): boolean {
  const bare = lane.replace(/^wc-/i, '');
  const same = (value: string | null | undefined, other: string) => !!value && value.toLowerCase() === other.toLowerCase();
  return same(agent.tmux_session, lane)
    || same(agent.name, bare)
    || same(agent.name, lane)
    || same(agent.alias, bare)
    || same(agent.alias, lane);
}
