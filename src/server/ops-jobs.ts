/**
 * Ops job store. WaveCode records jobs. Bots pull them.
 * This module never starts a process and never reads a script.
 */

import fs from 'node:fs';
import path from 'node:path';
import { generateId, getDb } from './db.js';
import { redactSecrets } from './fable-queue-classify.js';
import { getConfig } from './config.js';
import {
  boundOpsRole, isOpsJobRole, isOpsOwner, resolveOpsLanes,
  type OpsJobRole, type ResolvedOpsLanes,
} from './ops-lanes-config.js';

export const OPS_JOB_KINDS = ['stage', 'ask_data', 'scribe_write'] as const;
export type OpsJobKind = (typeof OPS_JOB_KINDS)[number];

export const OPS_JOB_STATUSES = ['queued', 'claimed', 'done', 'failed', 'awaiting_owner', 'rejected'] as const;
export type OpsJobStatus = (typeof OPS_JOB_STATUSES)[number];

export const OPEN_JOB_STATUSES = ['queued', 'claimed', 'awaiting_owner'] as const;

/** Script names only. No arguments, flags, or shell text. */
export const STAGE_STEPS = ['stg-quiet-check', 'stg-backup', 'stg-pause', 'deploy', 'stg-resume'] as const;

export const READ_ANSWER_POLICY = {
  payroll: 'totals_only',
  gl: 'totals_only',
  no_personal_names: true,
} as const;

/**
 * One UPDATE, so two pullers cannot both receive the same queued row.
 * The outer `status = 'queued'` is what the loser misses after the winner commits.
 */
export const CLAIM_SQL = `
UPDATE ops_jobs
SET status = 'claimed', claimed_by = ?, claimed_at = ?
WHERE status = 'queued'
  AND id = (
    SELECT id FROM ops_jobs
    WHERE role = ? AND status = 'queued'
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  )
RETURNING *
`;

export interface OpsApproval {
  by: string;
  at: string;
}

export interface OpsJob {
  id: string;
  kind: OpsJobKind;
  role: OpsJobRole;
  status: OpsJobStatus;
  requester: string;
  payload: Record<string, unknown>;
  created_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  finished_at: string | null;
  receipt_paths: string[];
  approval: OpsApproval | null;
}

interface OpsJobRow {
  id: string;
  kind: string;
  role: string;
  status: string;
  requester: string;
  payload_json: string;
  created_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  finished_at: string | null;
  receipt_paths_json: string | null;
  approval_by: string | null;
  approval_at: string | null;
}

let testConfig: ResolvedOpsLanes | null = null;

export function setOpsLanesForTest(value: ResolvedOpsLanes | null): void {
  testConfig = value;
}

export function currentOpsConfig(): ResolvedOpsLanes {
  if (testConfig) return testConfig;
  try {
    return resolveOpsLanes(getConfig());
  } catch {
    return resolveOpsLanes(undefined);
  }
}

function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parsePaths(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function mapOpsJob(row: OpsJobRow): OpsJob | null {
  if (!isOpsJobRole(row.role)) return null;
  if (!(OPS_JOB_KINDS as readonly string[]).includes(row.kind)) return null;
  if (!(OPS_JOB_STATUSES as readonly string[]).includes(row.status)) return null;
  return {
    id: row.id,
    kind: row.kind as OpsJobKind,
    role: row.role,
    status: row.status as OpsJobStatus,
    requester: row.requester,
    payload: parseObject(row.payload_json),
    created_at: row.created_at,
    claimed_by: row.claimed_by,
    claimed_at: row.claimed_at,
    finished_at: row.finished_at,
    receipt_paths: parsePaths(row.receipt_paths_json),
    approval: row.approval_by && row.approval_at ? { by: row.approval_by, at: row.approval_at } : null,
  };
}

function redactPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...payload };
  if (typeof next.question === 'string') next.question = redactSecrets(next.question);
  return next;
}

export function publicOpsJob(job: OpsJob): OpsJob {
  return { ...job, payload: redactPayload(job.payload), receipt_paths: [...job.receipt_paths] };
}

export function insertOpsJob(input: {
  kind: OpsJobKind;
  role: OpsJobRole;
  status: OpsJobStatus;
  requester: string;
  payload: Record<string, unknown>;
  createdAt?: string;
}): OpsJob {
  const id = generateId();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const payload = redactPayload(input.payload);
  getDb().prepare(`
    INSERT INTO ops_jobs (id, kind, role, status, requester, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, input.kind, input.role, input.status, input.requester, JSON.stringify(payload), createdAt);
  const job = getOpsJob(id);
  if (!job) throw new Error('ops job insert did not persist');
  return job;
}

export function getOpsJob(id: string): OpsJob | null {
  const row = getDb().prepare('SELECT * FROM ops_jobs WHERE id = ?').get(id) as OpsJobRow | undefined;
  return row ? mapOpsJob(row) : null;
}

export function listOpsJobs(limit = 100): OpsJob[] {
  const rows = getDb().prepare('SELECT * FROM ops_jobs ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as OpsJobRow[];
  return rows.map(mapOpsJob).filter((job): job is OpsJob => !!job);
}

export function openStageJob(sha: string): OpsJob | null {
  const row = getDb().prepare(`
    SELECT * FROM ops_jobs
    WHERE kind = 'stage'
      AND status IN ('queued', 'claimed', 'awaiting_owner')
      AND lower(json_extract(payload_json, '$.sha')) = lower(?)
    ORDER BY created_at ASC
    LIMIT 1
  `).get(sha) as OpsJobRow | undefined;
  return row ? mapOpsJob(row) : null;
}

export function stagePayload(sha: string): { sha: string; steps: string[] } {
  return { sha: sha.toLowerCase(), steps: [...STAGE_STEPS] };
}

/** Claim the oldest queued job for this role. A second caller gets nothing. */
export function claimOpsJob(role: OpsJobRole, claimedBy: string, claimedAt = new Date().toISOString()): OpsJob | null {
  const row = getDb().prepare(CLAIM_SQL).get(claimedBy, claimedAt, role) as OpsJobRow | undefined;
  return row ? mapOpsJob(row) : null;
}

export function completeOpsJob(id: string, status: 'done' | 'failed', receiptPaths: string[], finishedAt = new Date().toISOString()): OpsJob | null {
  const row = getDb().prepare(`
    UPDATE ops_jobs
    SET status = ?, receipt_paths_json = ?, finished_at = ?
    WHERE id = ? AND status = 'claimed'
    RETURNING *
  `).get(status, JSON.stringify(receiptPaths), finishedAt, id) as OpsJobRow | undefined;
  return row ? mapOpsJob(row) : null;
}

/** Record consent. The status stays awaiting_owner. Nothing is executed. */
export function approveOpsJob(id: string, by: string, at = new Date().toISOString()): OpsJob | null {
  const row = getDb().prepare(`
    UPDATE ops_jobs
    SET approval_by = ?, approval_at = ?
    WHERE id = ? AND status = 'awaiting_owner' AND approval_by IS NULL
    RETURNING *
  `).get(by, at, id) as OpsJobRow | undefined;
  return row ? mapOpsJob(row) : null;
}

export interface ReceiptCheck {
  ok: true;
  paths: string[];
}

export interface ReceiptReject {
  ok: false;
  error: string;
}

const RECEIPT_OUTSIDE = 'receipt path is outside the role receipts directory';

/**
 * Each path must realpath to a file inside `<receiptsRoot>/<role>/`.
 * The stored value is that real path. File bytes are never read.
 */
export async function checkReceiptPaths(role: string, paths: unknown, receiptsRoot: string): Promise<ReceiptCheck | ReceiptReject> {
  if (!Array.isArray(paths) || paths.length > 20) {
    return { ok: false, error: 'receipt_paths must be a list of at most 20 paths' };
  }
  if (paths.length === 0) return { ok: true, paths: [] };
  if (!isOpsJobRole(role)) return { ok: false, error: RECEIPT_OUTSIDE };
  const base = path.resolve(receiptsRoot, role);
  let rootReal: string;
  try {
    rootReal = await fs.promises.realpath(base);
    const rootStat = await fs.promises.stat(rootReal);
    if (!rootStat.isDirectory()) return { ok: false, error: RECEIPT_OUTSIDE };
  } catch {
    return { ok: false, error: RECEIPT_OUTSIDE };
  }
  const stored: string[] = [];
  for (const raw of paths) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return { ok: false, error: RECEIPT_OUTSIDE };
    let resolved: string;
    try {
      resolved = await fs.promises.realpath(raw);
    } catch {
      return { ok: false, error: RECEIPT_OUTSIDE };
    }
    const rel = path.relative(rootReal, resolved);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, error: RECEIPT_OUTSIDE };
    try {
      const stat = await fs.promises.stat(resolved);
      if (!stat.isFile()) return { ok: false, error: RECEIPT_OUTSIDE };
    } catch {
      return { ok: false, error: RECEIPT_OUTSIDE };
    }
    stored.push(resolved);
  }
  return { ok: true, paths: stored };
}

export function roleBoundTo(user: { name: string; via_seat?: boolean }, cfg = currentOpsConfig()): OpsJobRole | null {
  return boundOpsRole(user, cfg);
}

export function userIsOpsOwner(user: { name: string; via_seat?: boolean }, cfg = currentOpsConfig()): boolean {
  return isOpsOwner(user, cfg);
}
