/**
 * Pure heartbeat parsing for the Ops lanes Live board.
 * Callers pass file text. This module does not touch the disk.
 */

import { redactSecrets } from './fable-queue-classify.js';

export const KEY_STATUSES = ['ok', 'expired', 'auth_error', 'unknown'] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];

export type LaneFile = 'ok' | 'missing' | 'invalid' | 'unknown';
export type LaneReason = 'stale' | 'key' | 'missing' | 'invalid';

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface OpsLaneRow {
  /** Role from the filename `<role>.json`. This comes from config, not from the file body. */
  id: string;
  /** `bot` field from the file, or `unknown` when it is missing. */
  bot: string;
  file: LaneFile;
  red: boolean;
  reasons: LaneReason[];
  role: string;
  model: string;
  key_status: KeyStatus;
  key_checked_at: string;
  current_job: string;
  heartbeat_at: string;
  heartbeat_age_s: number | null;
  last_receipt_path: string;
  last_receipt_at: string;
}

function unknownRow(id: string, file: LaneFile): Omit<OpsLaneRow, 'red' | 'reasons' | 'heartbeat_age_s'> {
  return {
    id,
    bot: 'unknown',
    file,
    role: 'unknown',
    model: 'unknown',
    key_status: 'unknown',
    key_checked_at: 'unknown',
    current_job: 'unknown',
    heartbeat_at: 'unknown',
    last_receipt_path: 'unknown',
    last_receipt_at: 'unknown',
  };
}

function withReasons(row: Omit<OpsLaneRow, 'red' | 'reasons' | 'heartbeat_age_s'>, nowMs: number, staleS: number): OpsLaneRow {
  const heartbeat_age_s = row.heartbeat_at === 'unknown' ? null : ageSeconds(row.heartbeat_at, nowMs);
  const reasons: LaneReason[] = [];
  if (row.file === 'missing') reasons.push('missing');
  if (row.file === 'invalid') reasons.push('invalid');
  if (row.key_status === 'auth_error' || row.key_status === 'expired') reasons.push('key');
  if (heartbeat_age_s != null && heartbeat_age_s > staleS) reasons.push('stale');
  return { ...row, heartbeat_age_s, reasons, red: reasons.length > 0 };
}

function ageSeconds(iso: string, nowMs: number): number | null {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.floor((nowMs - parsed) / 1000));
}

/** A lane that was not read. Every schema field stays unknown. */
export function unreadLane(id: string, file: 'missing' | 'invalid' | 'unknown', nowMs: number, staleS: number): OpsLaneRow {
  return withReasons(unknownRow(id, file), nowMs, staleS);
}

function asText(value: unknown, invalid: { current: boolean }): string {
  if (value == null || value === '') return 'unknown';
  if (typeof value !== 'string') {
    invalid.current = true;
    return 'unknown';
  }
  const trimmed = value.trim();
  if (!trimmed) return 'unknown';
  return redactSecrets(trimmed);
}

function asTime(value: unknown, invalid: { current: boolean }): string {
  if (value == null || value === '') return 'unknown';
  if (typeof value !== 'string') {
    invalid.current = true;
    return 'unknown';
  }
  const trimmed = value.trim();
  if (!ISO_RE.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    invalid.current = true;
    return 'unknown';
  }
  return new Date(trimmed).toISOString();
}

function asKeyStatus(value: unknown, invalid: { current: boolean }): KeyStatus {
  if (value == null || value === '') return 'unknown';
  if (typeof value !== 'string' || !(KEY_STATUSES as readonly string[]).includes(value.trim())) {
    invalid.current = true;
    return 'unknown';
  }
  return value.trim() as KeyStatus;
}

/**
 * Parse one heartbeat. Missing fields are `unknown`. A value that is the wrong
 * type, an unknown key status, or a non-ISO timestamp makes the file invalid
 * and is not returned. A `role` that names a different file is invalid.
 * Extra fields are dropped. `bot` is its own field and is not taken from the filename.
 */
export function parseHeartbeat(role: string, raw: string, nowMs: number, staleS: number): OpsLaneRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadLane(role, 'invalid', nowMs, staleS);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return unreadLane(role, 'invalid', nowMs, staleS);
  }
  const obj = parsed as Record<string, unknown>;
  const invalid = { current: false };
  const claimedRole = asText(obj.role, invalid);
  if (claimedRole !== 'unknown' && claimedRole !== role) {
    return unreadLane(role, 'invalid', nowMs, staleS);
  }
  const row: Omit<OpsLaneRow, 'red' | 'reasons' | 'heartbeat_age_s'> = {
    id: role,
    bot: asText(obj.bot, invalid),
    file: 'ok',
    role: claimedRole,
    model: asText(obj.model, invalid),
    key_status: asKeyStatus(obj.key_status, invalid),
    key_checked_at: asTime(obj.key_checked_at, invalid),
    current_job: asText(obj.current_job, invalid),
    heartbeat_at: asTime(obj.heartbeat_at, invalid),
    last_receipt_path: asText(obj.last_receipt_path, invalid),
    last_receipt_at: asTime(obj.last_receipt_at, invalid),
  };
  if (invalid.current) row.file = 'invalid';
  return withReasons(row, nowMs, staleS);
}
