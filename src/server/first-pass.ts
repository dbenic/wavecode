/**
 * First pass on a freeze, run on a seat, never a verdict.
 *
 * When a freeze lands, the least-loaded seat in `review.first_pass.seats`
 * with plan capacity left gets one short prompt: read the lane diff once,
 * list the real issues, and write `wave-firstpass-<sha8>-<date>.md` into the
 * first-pass directory (default: the freeze inbox). The file ends with
 * `FIRST PASS: PASS` or `FIRST PASS: NEEDS FIXES`. Its name carries neither
 * `freeze` nor `verdict`, so the freeze ingester never reads it as the
 * reviewer's verdict, and it cannot stage anything. The pipeline announces
 * the result to the assigned reviewer (a checklist) and, on NEEDS FIXES, to
 * the author (fix now, before the reviewer gets to it).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config.js';
import { getDb, listAgents, type Agent } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { belowCapacity, loadFor, minCapacityPct, pickLeastLoaded, samePerson } from './reviewer-assign.js';
import { deliverSystemLine } from './wire-lines.js';

export const FIRST_PASS = 'pipeline.first_pass';
export const FIRST_PASS_REQUESTED = 'pipeline.first_pass_requested';
export const FIRST_PASS_TIMEOUT = 'pipeline.first_pass_timeout';

/** `wave-firstpass-<sha8>-<yyyymmdd>.md`, optionally with a suffix (`-codex2`). */
export const FIRST_PASS_FILE_RE = /^wave-firstpass-([0-9a-f]{7,40})-(\d{8})(?:[-_][\w.-]*)?\.(?:md|markdown|txt)$/i;
const RESULT_RE = /^\s*(?:[>│|*_]+\s*)?FIRST[ _-]?PASS\s*[:：]\s*\**\s*(PASS|NEEDS[ -]FIXES)\b/i;
const ISSUE_RE = /^\s*[-*]\s+\[?\s*(?:severity:\s*)?(HIGH|MED|MEDIUM|LOW|BLOCKER|CRITICAL)\b/i;
const SHA_RE = /\b([0-9a-f]{40})\b/i;

export interface FirstPassSettings {
  enabled: boolean;
  seats: string[];
  dir: string | null;
  timeoutMs: number;
}

export interface FirstPassResult {
  sha: string;
  result: 'pass' | 'needs-fixes';
  issues: number;
  file: string;
  seat: string | null;
}

export interface FirstPassRequest {
  sha: string;
  seatId: string;
  seat: string;
  file: string;
  atMs: number;
}

export const firstPassHooks = {
  /** Called once per first-pass file; the pipeline announces it. */
  onResult: null as ((result: FirstPassResult) => void) | null,
};

function expand(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function firstPassSettings(): FirstPassSettings {
  let review: ReturnType<typeof getConfig>['review'] | undefined;
  try { review = getConfig().review; } catch { review = undefined; }
  const fp = review?.first_pass;
  const dir = fp?.dir ?? review?.freeze_inbox?.[0] ?? null;
  return {
    enabled: fp?.enabled === true && (fp.seats?.length ?? 0) > 0,
    seats: (fp?.seats ?? []).map((s) => s.toLowerCase()),
    dir: dir ? expand(dir) : null,
    timeoutMs: Math.max(1, fp?.timeout_min ?? 20) * 60_000,
  };
}

export function isFirstPassFileName(name: string): boolean {
  return FIRST_PASS_FILE_RE.test(path.basename(name));
}

export function firstPassFileName(sha: string, now = new Date()): string {
  const day = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  return `wave-firstpass-${sha.slice(0, 8).toLowerCase()}-${day}.md`;
}

/** The last FIRST PASS line decides; a line that names both words is instructions, not a result. */
export function parseFirstPass(text: string, filename: string): FirstPassResult | null {
  const base = path.basename(filename);
  const named = base.match(FIRST_PASS_FILE_RE);
  if (!named) return null;
  const lines = text.replace(/\r/g, '').split('\n');
  let result: 'pass' | 'needs-fixes' | null = null;
  for (const line of lines) {
    const m = line.match(RESULT_RE);
    if (!m) continue;
    // "FIRST PASS: PASS or FIRST PASS: NEEDS FIXES" is the instruction, not the result.
    const rest = line.replace(/FIRST[ _-]?PASS\s*[:：]/i, '');
    const both = /\bPASS\b/i.test(rest) && /\bNEEDS[ -]FIXES\b/i.test(rest);
    if (both || /\bor\b/i.test(rest)) continue;
    result = m[1].toUpperCase() === 'PASS' ? 'pass' : 'needs-fixes';
  }
  if (!result) return null;
  const full = lines.map((l) => l.match(SHA_RE)?.[1]).find(Boolean) ?? null;
  const sha = (full ?? named[1]).toLowerCase();
  const seat = lines.map((l) => l.match(/^\s*(?:[-*]\s*)?Seat\s*[:：]\s*@?([A-Za-z][\w.-]*)/i)?.[1]).find(Boolean) ?? null;
  const issues = lines.filter((l) => ISSUE_RE.test(l)).length;
  return { sha, result, issues, file: filename, seat: seat ? seat.toLowerCase() : null };
}

function handles(agent: Agent): string[] {
  return [agent.name, agent.alias].filter((s): s is string => !!s).map((s) => s.toLowerCase());
}

/**
 * The least-loaded listed seat with capacity. Never the author or the
 * author's own seats (service profiles excepted), never a denied name, never
 * the orchestrator.
 */
export function chooseFirstPassSeat(
  author: Agent,
  agents: Agent[],
  settings: Pick<FirstPassSettings, 'seats'>,
  opts: { serviceProfiles?: string[]; deny?: string[]; floor?: number; load?: (agent: Agent) => ReturnType<typeof loadFor> } = {},
): Agent | null {
  const listed = new Set(settings.seats.map((s) => s.toLowerCase()));
  const deny = new Set((opts.deny ?? []).map((s) => s.toLowerCase()));
  const floor = opts.floor ?? minCapacityPct();
  const load = opts.load ?? loadFor;
  const candidates = agents.filter((agent) => {
    if (agent.mode === 'file' || agent.role === 'orchestrator') return false;
    if (!handles(agent).some((h) => listed.has(h))) return false;
    if (agent.id === author.id) return false;
    if (handles(agent).some((h) => deny.has(h))) return false;
    if (samePerson(author, agent, opts.serviceProfiles)) return false;
    if (belowCapacity(load(agent), floor)) return false;
    return true;
  });
  return pickLeastLoaded(candidates, load);
}

function requestedRows(): FirstPassRequest[] {
  try {
    const rows = getDb().prepare(
      `SELECT entity_id, payload_json FROM events WHERE type = ? ORDER BY id ASC`,
    ).all(FIRST_PASS_REQUESTED) as { entity_id: string; payload_json: string | null }[];
    const out: FirstPassRequest[] = [];
    for (const row of rows) {
      let payload: { sha?: string; seat_id?: string; seat?: string; file?: string; at_ms?: number } = {};
      try { payload = row.payload_json ? JSON.parse(row.payload_json) : {}; } catch { payload = {}; }
      const sha = (payload.sha ?? row.entity_id).toLowerCase();
      if (!payload.seat_id || !payload.file) continue;
      out.push({ sha, seatId: payload.seat_id, seat: payload.seat ?? payload.seat_id, file: payload.file, atMs: typeof payload.at_ms === 'number' ? payload.at_ms : 0 });
    }
    return out;
  } catch {
    return [];
  }
}

export function firstPassRequested(sha: string): FirstPassRequest | null {
  const rows = requestedRows().filter((r) => r.sha === sha.toLowerCase());
  return rows.length ? rows[rows.length - 1] : null;
}

/** The latest recorded first pass on this SHA, or null. */
export function firstPassFor(sha: string): FirstPassResult | null {
  try {
    const row = getDb().prepare(
      `SELECT payload_json FROM events WHERE type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(FIRST_PASS, sha.toLowerCase()) as { payload_json: string | null } | undefined;
    if (!row?.payload_json) return null;
    const p = JSON.parse(row.payload_json) as Partial<FirstPassResult>;
    if (!p.result || !p.file) return null;
    return { sha: sha.toLowerCase(), result: p.result, issues: p.issues ?? 0, file: p.file, seat: p.seat ?? null };
  } catch {
    return null;
  }
}

function hasEvent(type: string, entityId: string): boolean {
  try {
    const row = getDb().prepare('SELECT id FROM events WHERE type = ? AND entity_id = ? LIMIT 1').get(type, entityId) as { id: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

export function firstPassPrompt(opts: {
  sha: string; lane: string | null; authorName: string; freezePath: string | null; repo: string | null; remote: string; file: string; seatName: string;
}): string {
  const sha8 = opts.sha.slice(0, 8);
  const where = opts.repo
    ? `In ${opts.repo} (or your own worktree of it) run \`git fetch ${opts.remote} ${opts.lane ?? ''}\` and read \`git diff ${opts.remote}/main...${opts.sha}\`; do not check it out and do not touch your own branch.`
    : `Read the diff of ${opts.sha} against main in your worktree; do not check it out and do not touch your own branch.`;
  return [
    `[from WaveCode] First pass, one pass only, no fixes: freeze ${sha8} on ${opts.lane ?? 'the lane'} by @${opts.authorName}.`,
    opts.freezePath ? `Freeze note: ${opts.freezePath}.` : null,
    where,
    `Write ${opts.file} with these lines: a title, \`SHA: ${opts.sha}\`, \`Lane: ${opts.lane ?? '?'}\`, \`Author: @${opts.authorName}\`, \`Seat: @${opts.seatName}\`, then \`ISSUES:\` with one line per real issue as \`- [HIGH|MED|LOW] path:line — why\` (at most 10, bugs, security, data, tests; no style nits), and end with exactly one line \`FIRST PASS: PASS\` or \`FIRST PASS: NEEDS FIXES\`.`,
    'Never write the word VERDICT in that file: this is a checklist for the reviewer, not the review. Then return to what you were doing.',
  ].filter(Boolean).join(' ');
}

export async function requestFirstPass(
  freeze: { sha: string; project: string | null; lane: string | null; freeze_path: string | null },
  author: Agent,
  opts: { repo: string | null; remote: string; serviceProfiles?: string[]; deny?: string[]; agents?: Agent[] },
): Promise<{ ok: true; data: { seat: Agent; file: string } } | { ok: false; error: string }> {
  const settings = firstPassSettings();
  if (!settings.enabled) return { ok: false, error: 'off' };
  if (!settings.dir) return { ok: false, error: 'no first-pass directory (review.first_pass.dir or review.freeze_inbox)' };
  if (firstPassRequested(freeze.sha) || firstPassFor(freeze.sha)) return { ok: false, error: 'already requested' };
  const seat = chooseFirstPassSeat(author, opts.agents ?? listAgents(), settings, { serviceProfiles: opts.serviceProfiles, deny: opts.deny });
  if (!seat) return { ok: false, error: 'no listed seat with capacity that is not the author' };
  const file = path.join(settings.dir, firstPassFileName(freeze.sha));
  const text = firstPassPrompt({
    sha: freeze.sha, lane: freeze.lane, authorName: author.alias ?? author.name, freezePath: freeze.freeze_path,
    repo: opts.repo, remote: opts.remote, file, seatName: seat.alias ?? seat.name,
  });
  await deliverSystemLine(seat, text, { kind: 'info', source: 'first-pass' });
  emit(FIRST_PASS_REQUESTED, 'run', freeze.sha.toLowerCase(), {
    sha: freeze.sha.toLowerCase(), project: freeze.project, lane: freeze.lane, seat_id: seat.id, seat: seat.name, file, at_ms: Date.now(),
  }, null);
  logger.info({ sha: freeze.sha, seat: seat.name, file }, 'First pass requested');
  return { ok: true, data: { seat, file } };
}

/**
 * A first-pass file landed (the inbox watcher saw it). Recorded once per
 * file; the pipeline hook announces it.
 */
export function recordFirstPassFile(file: string): FirstPassResult | null {
  if (!isFirstPassFileName(file)) return null;
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const parsed = parseFirstPass(text, file);
  if (!parsed) {
    logger.debug({ file }, 'First-pass file has no FIRST PASS line yet');
    return null;
  }
  const previous = firstPassFor(parsed.sha);
  if (previous && previous.file === file && previous.result === parsed.result && previous.issues === parsed.issues) return previous;
  const requested = firstPassRequested(parsed.sha);
  const seat = parsed.seat ?? requested?.seat.toLowerCase() ?? null;
  const result: FirstPassResult = { ...parsed, seat };
  emit(FIRST_PASS, 'run', parsed.sha, { ...result, requested_seat_id: requested?.seatId ?? null }, null);
  logger.info({ sha: parsed.sha, result: parsed.result, issues: parsed.issues, file }, 'First pass recorded');
  try { firstPassHooks.onResult?.(result); } catch (e) { logger.debug({ file, error: (e as Error).message }, 'First-pass hook failed'); }
  return result;
}

/** Requests older than the timeout with no file, not yet noted. Each is noted once. */
export function overdueFirstPasses(now = Date.now(), timeoutMs = firstPassSettings().timeoutMs): FirstPassRequest[] {
  const out: FirstPassRequest[] = [];
  for (const req of requestedRows()) {
    if (now - req.atMs < timeoutMs) continue;
    if (firstPassFor(req.sha)) continue;
    if (hasEvent(FIRST_PASS_TIMEOUT, req.sha)) continue;
    emit(FIRST_PASS_TIMEOUT, 'run', req.sha, { sha: req.sha, seat_id: req.seatId, seat: req.seat, file: req.file, waited_ms: now - req.atMs }, null);
    out.push(req);
  }
  return out;
}
