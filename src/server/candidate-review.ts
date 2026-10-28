/**
 * Rolling candidate review (docs/ops/engine-fixes-27oct-plan.md, cause 2).
 *
 * After every main advance one seat reviews the diff since the last reviewed
 * candidate: the first time since the merge's own base, so nobody is handed
 * a week of history. By freeze time only the last merge is unreviewed.
 *
 * WaveCode writes the request file `wave-candidate-<sha8>-<yyyymmdd>.md` in the
 * freeze directory with the merge list and the diffstat; the seat appends its
 * `ISSUES:` lines and ends the file with one line `CANDIDATE REVIEW: PASS` or
 * `CANDIDATE REVIEW: NEEDS FIXES`. The inbox watcher records the answer; the
 * pipeline announces it (NEEDS FIXES goes to the merged lane's author and the
 * driver seats). Everything is kept as `pipeline.candidate_review` events on
 * the main SHA: kind `assign`, `result`, `superseded`, `overdue`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig } from './config.js';
import { getDb, type Agent } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { execFileAsync } from './proc.js';

export const CANDIDATE_REVIEW = 'pipeline.candidate_review';
export const CANDIDATE_FILE_RE = /^wave-candidate-([0-9a-f]{7,40})-(\d{8})(?:[-_][\w.-]*)?\.(?:md|markdown|txt)$/i;
const RESULT_RE = /^\s*(?:[>│|*_]+\s*)?CANDIDATE[ _-]?REVIEW\s*[:：]\s*\**\s*(PASS|NEEDS[ -]FIXES)\b/i;
const ISSUE_RE = /^\s*[-*]\s+\[?\s*(?:severity:\s*)?(HIGH|MED|MEDIUM|LOW|BLOCKER|CRITICAL)\b/i;
const SHA_RE = /\b([0-9a-f]{40})\b/i;
const MAX_MERGE_LINES = 40;

export type CandidateKind = 'assign' | 'result' | 'superseded' | 'overdue';

export interface CandidateAssign {
  sha: string;
  project: string;
  base: string;
  lane: string | null;
  author: string | null;
  authorId: string | null;
  reviewerId: string;
  reviewer: string;
  file: string;
  merges: number;
  files: number;
  atMs: number;
}

export interface CandidateResult {
  sha: string;
  result: 'pass' | 'needs-fixes';
  issues: number;
  file: string;
  seat: string | null;
}

export interface CandidateSettings {
  enabled: boolean;
  dir: string | null;
  timeoutMs: number;
}

export const candidateHooks = {
  /** Called once per answered request file; the pipeline announces it. */
  onResult: null as ((result: CandidateResult) => void) | null,
};

function expand(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function candidateSettings(project: string): CandidateSettings {
  let cfg: ReturnType<typeof getConfig> | undefined;
  try { cfg = getConfig(); } catch { cfg = undefined; }
  const pipe = cfg?.projects?.[project]?.pipeline;
  const review = cfg?.review;
  const enabled = typeof pipe?.candidate_review === 'boolean' ? pipe.candidate_review : pipe?.auto_review === true;
  const dir = pipe?.freeze_dir ?? review?.first_pass?.dir ?? review?.freeze_inbox?.[0] ?? null;
  const minutes = typeof pipe?.candidate_review_timeout_min === 'number' && pipe.candidate_review_timeout_min > 0 ? pipe.candidate_review_timeout_min : 45;
  return { enabled, dir: dir ? expand(dir) : null, timeoutMs: minutes * 60_000 };
}

export function isCandidateFileName(name: string): boolean {
  return CANDIDATE_FILE_RE.test(path.basename(name));
}

export function candidateFileName(sha: string, now = new Date()): string {
  const day = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
  return `wave-candidate-${sha.slice(0, 8).toLowerCase()}-${day}.md`;
}

/** The last CANDIDATE REVIEW line decides; a line naming both words (or "or") is the instruction. */
export function parseCandidateReview(text: string, filename: string): CandidateResult | null {
  const base = path.basename(filename);
  const named = base.match(CANDIDATE_FILE_RE);
  if (!named) return null;
  const lines = text.replace(/\r/g, '').split('\n');
  let result: 'pass' | 'needs-fixes' | null = null;
  for (const line of lines) {
    const m = line.match(RESULT_RE);
    if (!m) continue;
    const rest = line.replace(/CANDIDATE[ _-]?REVIEW\s*[:：]/i, '');
    const both = /\bPASS\b/i.test(rest) && /\bNEEDS[ -]FIXES\b/i.test(rest);
    if (both || /\bor\b/i.test(rest)) continue;
    result = m[1].toUpperCase() === 'PASS' ? 'pass' : 'needs-fixes';
  }
  if (!result) return null;
  const full = lines.map((l) => l.match(/^\s*(?:[-*]\s*)?(?:Main\s+)?SHA\s*[:：]\s*`?([0-9a-f]{40})/i)?.[1]).find(Boolean)
    ?? lines.map((l) => l.match(SHA_RE)?.[1]).find(Boolean) ?? null;
  const sha = (full ?? named[1]).toLowerCase();
  const seat = lines.map((l) => l.match(/^\s*(?:[-*]\s*)?Seat\s*[:：]\s*@?([A-Za-z][\w.-]*)/i)?.[1]).find(Boolean) ?? null;
  const issues = lines.filter((l) => ISSUE_RE.test(l)).length;
  return { sha, result, issues, file: filename, seat: seat ? seat.toLowerCase() : null };
}

// --- records ------------------------------------------------------------------------------

interface EventRow { id: number; entity_id: string; payload_json: string | null; created_at: string }

function rows(project: string | null, limit = 200): Array<{ id: number; sha: string; kind: CandidateKind; p: Record<string, unknown> }> {
  try {
    const all = getDb().prepare(
      `SELECT id, entity_id, payload_json, created_at FROM events WHERE type = ? ORDER BY id DESC LIMIT ?`,
    ).all(CANDIDATE_REVIEW, limit) as EventRow[];
    const out: Array<{ id: number; sha: string; kind: CandidateKind; p: Record<string, unknown> }> = [];
    for (const r of all) {
      if (!r.payload_json) continue;
      let p: Record<string, unknown>;
      try { p = JSON.parse(r.payload_json) as Record<string, unknown>; } catch { continue; }
      if (project && p.project !== project) continue;
      const kind = String(p.kind ?? '') as CandidateKind;
      if (!['assign', 'result', 'superseded', 'overdue'].includes(kind)) continue;
      out.push({ id: r.id, sha: r.entity_id.toLowerCase(), kind, p });
    }
    return out;
  } catch {
    return [];
  }
}

function toAssign(sha: string, p: Record<string, unknown>): CandidateAssign {
  return {
    sha, project: String(p.project ?? ''), base: String(p.base ?? ''), lane: (p.lane as string | null) ?? null,
    author: (p.author as string | null) ?? null, authorId: (p.author_id as string | null) ?? null,
    reviewerId: String(p.reviewer_id ?? ''), reviewer: String(p.reviewer ?? ''), file: String(p.file ?? ''),
    merges: Number(p.merges ?? 0), files: Number(p.files ?? 0), atMs: Number(p.at_ms ?? 0),
  };
}

export function candidateRequested(sha: string): CandidateAssign | null {
  const hit = rows(null).find((r) => r.sha === sha.toLowerCase() && r.kind === 'assign');
  return hit ? toAssign(hit.sha, hit.p) : null;
}

export function candidateResultFor(sha: string): CandidateResult | null {
  const hit = rows(null).find((r) => r.sha === sha.toLowerCase() && r.kind === 'result');
  if (!hit) return null;
  const p = hit.p;
  if (!p.result || !p.file) return null;
  return { sha: hit.sha, result: p.result as 'pass' | 'needs-fixes', issues: Number(p.issues ?? 0), file: String(p.file), seat: (p.seat as string | null) ?? null };
}

export interface CandidateReviewView extends CandidateAssign {
  result: CandidateResult | null;
  superseded_by: string | null;
  overdue: boolean;
}

/** Newest first: every request on the project with whatever answer it has. */
export function listCandidateReviews(project: string, limit = 20): CandidateReviewView[] {
  const all = rows(project, 600);
  const out: CandidateReviewView[] = [];
  for (const r of all) {
    if (r.kind !== 'assign' || out.length >= limit) continue;
    const result = all.find((x) => x.sha === r.sha && x.kind === 'result' && x.id > r.id);
    const sup = all.find((x) => x.sha === r.sha && x.kind === 'superseded' && x.id > r.id);
    const overdue = all.some((x) => x.sha === r.sha && x.kind === 'overdue' && x.id > r.id);
    out.push({
      ...toAssign(r.sha, r.p),
      result: result ? { sha: r.sha, result: result.p.result as 'pass' | 'needs-fixes', issues: Number(result.p.issues ?? 0), file: String(result.p.file ?? ''), seat: (result.p.seat as string | null) ?? null } : null,
      superseded_by: sup ? String(sup.p.by ?? '') || null : null,
      overdue,
    });
  }
  return out;
}

// --- the request ---------------------------------------------------------------------------

async function git(repo: string, args: string[]): Promise<string | null> {
  try {
    const out = await execFileAsync('git', ['-C', repo, '-c', 'core.fsmonitor=false', ...args], { timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    return out.trim();
  } catch {
    return null;
  }
}

async function isAncestor(repo: string, older: string, newer: string): Promise<boolean> {
  return (await git(repo, ['merge-base', '--is-ancestor', older, newer])) !== null;
}

/**
 * The newest answered candidate review on this project whose SHA is an ancestor of the new main;
 * else `mainBefore` (the merge's own base), else the production SHA. Null: nothing to compare with.
 */
export async function candidateBase(project: string, repo: string, mainSha: string, mainBefore: string | null, productionSha: string | null): Promise<string | null> {
  const reviews = listCandidateReviews(project, 50);
  for (const r of reviews) {
    if (!r.result || r.sha === mainSha) continue;
    if (await isAncestor(repo, r.sha, mainSha)) return r.sha;
  }
  for (const cand of [mainBefore, productionSha]) {
    if (!cand || cand === mainSha) continue;
    if (await isAncestor(repo, cand, mainSha)) return cand;
  }
  return null;
}

export function candidatePrompt(opts: {
  sha: string; base: string; lane: string | null; authorName: string | null; file: string; seatName: string; repo: string | null; remote: string; merges: number; files: number; folded: string | null;
}): string {
  const sha8 = opts.sha.slice(0, 8);
  const base8 = opts.base.slice(0, 8);
  const where = opts.repo
    ? `In your worktree of the project run \`git fetch ${opts.remote} main\` and read \`git diff ${opts.base}..${opts.sha}\`; do not check it out and do not touch your own branch.`
    : `Read \`git diff ${opts.base}..${opts.sha}\` in your worktree; do not check it out and do not touch your own branch.`;
  return [
    `[from WaveCode] Candidate review: main is at ${sha8}${opts.lane ? ` after ${opts.lane}${opts.authorName ? ` by @${opts.authorName}` : ''} merged` : ''}.`,
    `Only the delta since ${base8} is new (${opts.merges} merge${opts.merges === 1 ? '' : 's'}, ${opts.files} file${opts.files === 1 ? '' : 's'}); earlier merges were reviewed already.${opts.folded ? ` It includes ${opts.folded.slice(0, 8)}, which you can skip now.` : ''}`,
    where,
    `The merge list and the diffstat are in ${opts.file}. Append \`ISSUES:\` with one line per real issue as \`- [HIGH|MED|LOW] path:line — why\` (bugs, security, data, tests; no style nits), \`Seat: @${opts.seatName}\`, and end the file with exactly one line \`CANDIDATE REVIEW: PASS\` or \`CANDIDATE REVIEW: NEEDS FIXES\`.`,
    'This is the release review done early, one merge at a time. Then return to what you were doing.',
  ].join(' ');
}

export interface CandidateRequestInput {
  project: string;
  sha: string;
  repo: string | null;
  remote: string;
  lane: string | null;
  author: Agent | null;
  mainBefore: string | null;
  productionSha: string | null;
  /** The pipeline's reviewer picker; the author (when known) is never chosen. */
  pick: (author: Agent | null) => Agent | null;
  deliver: (agent: Agent, text: string) => Promise<void> | void;
  now?: Date;
}

export type CandidateRequestOutcome =
  | { ok: true; data: CandidateAssign & { folded: string | null } }
  | { ok: false; error: 'off' | 'already requested' | 'no directory' | 'no repo' | 'no base' | 'empty' | 'no reviewer' | string };

/** Ask one seat to review the delta that this main advance added. One request per main SHA. */
export async function requestCandidateReview(input: CandidateRequestInput): Promise<CandidateRequestOutcome> {
  const sha = input.sha.toLowerCase();
  const settings = candidateSettings(input.project);
  if (!settings.enabled) return { ok: false, error: 'off' };
  if (candidateRequested(sha)) return { ok: false, error: 'already requested' };
  if (!settings.dir) return { ok: false, error: 'no directory' };
  if (!input.repo) return { ok: false, error: 'no repo' };
  const base = await candidateBase(input.project, input.repo, sha, input.mainBefore, input.productionSha);
  if (!base) return { ok: false, error: 'no base' };
  const names = (await git(input.repo, ['diff', '--name-only', `${base}..${sha}`])) ?? '';
  const files = names.split('\n').map((l) => l.trim()).filter(Boolean).length;
  if (files === 0) return { ok: false, error: 'empty' };
  const log = (await git(input.repo, ['log', '--first-parent', '--format=%h %s', `${base}..${sha}`])) ?? '';
  const mergeLines = log.split('\n').map((l) => l.trim()).filter(Boolean);
  const stat = (await git(input.repo, ['diff', '--stat=120', `${base}..${sha}`])) ?? '';
  const reviewer = input.pick(input.author);
  if (!reviewer) return { ok: false, error: 'no reviewer' };
  // An earlier request with no answer is folded into this one: its delta is inside the new diff.
  let folded: string | null = null;
  for (const prev of listCandidateReviews(input.project, 10)) {
    if (prev.result || prev.superseded_by || prev.sha === sha) continue;
    emit(CANDIDATE_REVIEW, 'run', prev.sha, { kind: 'superseded', project: input.project, sha: prev.sha, by: sha, reviewer_id: prev.reviewerId, at_ms: Date.now() }, null);
    if (!folded) folded = prev.sha;
  }
  const now = input.now ?? new Date();
  const file = path.join(settings.dir, candidateFileName(sha, now));
  const authorName = input.author ? (input.author.alias ?? input.author.name) : null;
  const seatName = reviewer.alias ?? reviewer.name;
  const body = [
    `# Candidate review ${sha.slice(0, 8)} on main`,
    '',
    `- Project: ${input.project}`,
    `- Main SHA: ${sha}`,
    `- Since: ${base}`,
    input.lane ? `- Merged lane: ${input.lane}${authorName ? ` by @${authorName}` : ''}` : null,
    `- Reviewer: @${seatName}`,
    `- Asked: ${now.toISOString()}`,
    '',
    `## Merges in this delta (${mergeLines.length})`,
    '',
    ...mergeLines.slice(0, MAX_MERGE_LINES).map((l) => `- ${l}`),
    mergeLines.length > MAX_MERGE_LINES ? `- … and ${mergeLines.length - MAX_MERGE_LINES} more` : null,
    '',
    `## Diffstat (${files} files)`,
    '',
    '```',
    stat.split('\n').slice(-60).join('\n'),
    '```',
    '',
    '## For the reviewer',
    '',
    `Read \`git diff ${base}..${sha}\`. Append ISSUES: lines as \`- [HIGH|MED|LOW] path:line — why\`, then \`Seat: @${seatName}\`,`,
    'and end this file with exactly one line: CANDIDATE REVIEW: PASS, or CANDIDATE REVIEW: NEEDS FIXES.',
    '',
  ].filter((l): l is string => l !== null).join('\n');
  try {
    fs.mkdirSync(settings.dir, { recursive: true });
    fs.writeFileSync(file, body);
  } catch (e) {
    return { ok: false, error: `request file not written: ${(e as Error).message}` };
  }
  const text = candidatePrompt({
    sha, base, lane: input.lane, authorName, file, seatName, repo: input.repo, remote: input.remote, merges: mergeLines.length, files, folded,
  });
  await input.deliver(reviewer, text);
  const assign: CandidateAssign = {
    sha, project: input.project, base, lane: input.lane, author: authorName, authorId: input.author?.id ?? null,
    reviewerId: reviewer.id, reviewer: seatName, file, merges: mergeLines.length, files, atMs: now.getTime(),
  };
  emit(CANDIDATE_REVIEW, 'run', sha, {
    kind: 'assign', project: input.project, sha, base, lane: input.lane, author: authorName, author_id: input.author?.id ?? null,
    reviewer_id: reviewer.id, reviewer: seatName, file, merges: mergeLines.length, files, at_ms: now.getTime(), folded,
  }, null);
  logger.info({ project: input.project, sha, base, reviewer: seatName, files, merges: mergeLines.length }, 'Candidate review requested');
  return { ok: true, data: { ...assign, folded } };
}

/** A candidate file changed (the inbox watcher saw it). Recorded once per answer; the pipeline hook announces it. */
export function recordCandidateReviewFile(file: string): CandidateResult | null {
  if (!isCandidateFileName(file)) return null;
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const parsed = parseCandidateReview(text, file);
  if (!parsed) {
    logger.debug({ file }, 'Candidate file has no CANDIDATE REVIEW line yet');
    return null;
  }
  const previous = candidateResultFor(parsed.sha);
  if (previous && previous.file === file && previous.result === parsed.result && previous.issues === parsed.issues) return previous;
  const requested = candidateRequested(parsed.sha);
  const seat = parsed.seat ?? requested?.reviewer.toLowerCase() ?? null;
  const result: CandidateResult = { ...parsed, seat };
  emit(CANDIDATE_REVIEW, 'run', parsed.sha, {
    kind: 'result', project: requested?.project ?? null, sha: parsed.sha, base: requested?.base ?? null, lane: requested?.lane ?? null,
    result: parsed.result, issues: parsed.issues, file, seat, reviewer_id: requested?.reviewerId ?? null, author_id: requested?.authorId ?? null, at_ms: Date.now(),
  }, null);
  logger.info({ sha: parsed.sha, result: parsed.result, issues: parsed.issues, file }, 'Candidate review recorded');
  try { candidateHooks.onResult?.(result); } catch (e) { logger.debug({ file, error: (e as Error).message }, 'Candidate hook failed'); }
  return result;
}

/** Requests past the timeout with no answer and not folded into a newer one; each is noted once. */
export function overdueCandidateReviews(now = Date.now()): CandidateAssign[] {
  const out: CandidateAssign[] = [];
  const seen = new Set<string>();
  for (const r of rows(null, 600)) {
    if (r.kind !== 'assign' || seen.has(r.sha)) continue;
    seen.add(r.sha);
    const view = listCandidateReviews(String(r.p.project ?? ''), 50).find((v) => v.sha === r.sha);
    if (!view || view.result || view.superseded_by || view.overdue) continue;
    const timeout = candidateSettings(view.project).timeoutMs;
    if (now - view.atMs < timeout) continue;
    emit(CANDIDATE_REVIEW, 'run', r.sha, { kind: 'overdue', project: view.project, sha: r.sha, reviewer_id: view.reviewerId, reviewer: view.reviewer, file: view.file, waited_ms: now - view.atMs, at_ms: now }, null);
    out.push(view);
  }
  return out;
}
