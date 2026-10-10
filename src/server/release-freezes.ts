/**
 * Release freezes reviewed outside WaveCode's own run pipeline.
 *
 * Countix lanes are frozen and reviewed by files: the author drops a freeze
 * note (`<agent>-…-freeze-<sha>-<date>.md`, `desk91-freeze-<sha>.md`) and an
 * independent reviewer drops a verdict file (`<reviewer>-verdict-…-<date>.md`)
 * ending in `VERDICT: PASS` / `VERDICT: NEEDS FIXES` on the exact SHA. Neither
 * is a WaveCode run, so nothing reached the Review queue and the human GO had
 * to be relayed by chat.
 *
 * Every (freeze SHA, verdict) becomes one card in the existing queue: a
 * synthetic task + done run for the author agent and a completed
 * `code_reviews` row for the reviewer, announced through the usual
 * `review.ai_completed` event. Promote / Reject are the normal ones; the
 * extra rules live in `checkPromotable()` and the GO carries the freeze SHA.
 * `release_freezes` only links the SHA to that run — it is not a second
 * review system.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ulid } from 'ulid';
import { getConfig } from './config.js';
import {
  finishRun,
  getAgent,
  getDb,
  insertRun,
  insertTask,
  resolveAgent,
  updateRunSummary,
  updateTaskStatus,
  type Agent,
  type Result,
} from './db.js';
import { countIssues, type ReviewVerdict } from './code-review.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { archiveDocumentFile } from './fixtures.js';

/** merged = the SHA is an ancestor of the project's main: the lane is done, whatever its last verdict said */
export type FreezeStatus = 'open' | 'promoted' | 'rejected' | 'stale' | 'merged';

export interface ReleaseFreeze {
  sha: string;
  run_id: string | null;
  project: string | null;
  desk: number | null;
  lane: string | null;
  author_agent_id: string | null;
  author_name: string | null;
  reviewer_agent_id: string | null;
  reviewer_name: string | null;
  verdict: ReviewVerdict | null;
  freeze_path: string | null;
  verdict_path: string | null;
  gate: string | null;
  status: FreezeStatus;
  superseded_by: string | null;
  decided_by: string | null;
  decision_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** What the card shows (spec: repo, desk, author, reviewer, SHA, verdict, links, gate). */
export type FreezeCard = Pick<ReleaseFreeze,
  'sha' | 'project' | 'desk' | 'lane' | 'author_name' | 'reviewer_name' | 'verdict'
  | 'freeze_path' | 'verdict_path' | 'gate' | 'status' | 'superseded_by'>;

export interface ParsedFreezeFile {
  kind: 'freeze' | 'verdict';
  title: string;
  sha: string | null;
  verdict: ReviewVerdict | null;
  /** Names as written (`Claude1`, `@codex3`, `codex-antonio`), most reliable first; resolved against the agents table at ingest. */
  reviewerCandidates: string[];
  authorCandidates: string[];
  project: string | null;
  desk: number | null;
  lane: string | null;
  gate: string | null;
  /** A verdict file named inside a freeze note (`VERDICT: PASS … : /path/to/review.md`). */
  verdictPath: string | null;
}

const SETTLE_MS = 1200;
const FEEDBACK_MAX = 20_000;
const SUMMARY_MAX = 1_500;
const FILE_NAME_RE = /(freeze|verdict)/i;
const TEXT_EXT_RE = /\.(md|markdown|txt)$/i;

// --- schema ---------------------------------------------------------------------

export function ensureReleaseFreezeTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS release_freezes (
      sha TEXT PRIMARY KEY,
      run_id TEXT,
      project TEXT,
      desk INTEGER,
      lane TEXT,
      author_agent_id TEXT,
      author_name TEXT,
      reviewer_agent_id TEXT,
      reviewer_name TEXT,
      verdict TEXT,
      freeze_path TEXT,
      verdict_path TEXT,
      gate TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      superseded_by TEXT,
      decided_by TEXT,
      decision_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_release_freezes_run ON release_freezes(run_id);
  `);
}

/** The queue consults freezes on every card; a database opened without bootstrap (tests, CLI) gets the table on first use. */
function withTable<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (!/no such table: release_freezes/.test((e as Error).message)) throw e;
    ensureReleaseFreezeTable();
    return fn();
  }
}

export function getFreeze(sha: string): ReleaseFreeze | null {
  return withTable(() => (getDb().prepare('SELECT * FROM release_freezes WHERE sha = ?').get(sha) as ReleaseFreeze | undefined) ?? null);
}

export function getFreezeByRun(runId: string): ReleaseFreeze | null {
  return withTable(() => (getDb().prepare('SELECT * FROM release_freezes WHERE run_id = ?').get(runId) as ReleaseFreeze | undefined) ?? null);
}

export function listFreezes(): ReleaseFreeze[] {
  return withTable(() => getDb().prepare('SELECT * FROM release_freezes ORDER BY created_at DESC').all() as ReleaseFreeze[]);
}

export function toCard(f: ReleaseFreeze): FreezeCard {
  const { sha, project, desk, lane, author_name, reviewer_name, verdict, freeze_path, verdict_path, gate, status, superseded_by } = f;
  return { sha, project, desk, lane, author_name, reviewer_name, verdict, freeze_path, verdict_path, gate, status, superseded_by };
}

function patch(sha: string, fields: Partial<ReleaseFreeze>): void {
  const keys = Object.keys(fields) as (keyof ReleaseFreeze)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE release_freezes SET ${sets}, updated_at = datetime('now') WHERE sha = ?`)
    .run(...keys.map((k) => fields[k] ?? null), sha);
}

// --- parsing --------------------------------------------------------------------

const SHA40 = /\b[0-9a-f]{40}\b/;

function titleOf(lines: string[]): string {
  const first = lines.find((l) => l.trim().length > 0) ?? '';
  return first.replace(/^#+\s*/, '').trim();
}

function findSha(text: string, lines: string[]): string | null {
  const labelled = text.match(/\b(?:exact\s+sha|freeze\s+sha|frozen\s+sha|candidate(?:\s+sha)?)\b[^\n]*?([0-9a-f]{40})\b/i);
  if (labelled) return labelled[1].toLowerCase();
  const title = titleOf(lines).match(SHA40);
  if (title) return title[0].toLowerCase();
  for (const l of lines) {
    if (/\b(base|previous|parent|source|origin\/main)\b/i.test(l)) continue;
    const m = l.match(SHA40);
    if (m) return m[0].toLowerCase();
  }
  return null;
}

const VERDICT_LINE_RE = /\bVERDICT:?\s*\**\s*(PASS|NEEDS[ -]FIXES|FAIL|REJECT)\b/i;

/** The last line that states exactly one verdict; "issue `VERDICT: PASS` or `VERDICT: NEEDS FIXES`" states two and is a request, not a verdict. */
function findVerdict(lines: string[]): { verdict: ReviewVerdict; line: string } | null {
  let found: { verdict: ReviewVerdict; line: string } | null = null;
  for (const line of lines) {
    const m = line.match(VERDICT_LINE_RE);
    if (!m) continue;
    const says = (re: RegExp) => re.test(line);
    const count = [/\bPASS\b/i, /\bNEEDS[ -]FIXES\b/i, /\b(FAIL|REJECT)\b/i].filter(says).length;
    if (count !== 1) continue;
    if (/\b(requested|request|or\s+`?VERDICT)/i.test(line)) continue;
    const word = m[1].toUpperCase();
    const verdict: ReviewVerdict = word === 'PASS' ? 'pass' : word.startsWith('NEEDS') ? 'needs-fixes' : 'reject';
    found = { verdict, line };
  }
  return found;
}

function nameAfter(re: RegExp, lines: string[]): string | null {
  for (const l of lines) {
    const m = l.match(re);
    if (m) return m[1].replace(/[.,;:)]+$/, '');
  }
  return null;
}

function pushUnique(list: string[], v: string | null | undefined): void {
  if (!v) return;
  const n = v.replace(/^@/, '').toLowerCase();
  if (n && !list.includes(n)) list.push(n);
}

export function parseFreezeFile(text: string, filename: string): ParsedFreezeFile | null {
  const base = path.basename(filename);
  const lines = text.replace(/\r/g, '').split('\n');
  const head = lines.slice(0, 30);
  const title = titleOf(lines);

  let kind: 'freeze' | 'verdict' | null = null;
  if (/verdict/i.test(base) || /^verdict\b/i.test(title)) kind = 'verdict';
  else if (/freeze/i.test(base) || /\bfreeze\b/i.test(title)) kind = 'freeze';
  if (!kind) return null;

  const sha = findSha(text, lines);
  const v = findVerdict(lines);

  const reviewerCandidates: string[] = [];
  const authorCandidates: string[] = [];
  if (kind === 'verdict') {
    pushUnique(reviewerCandidates, base.match(/^(.+?)-verdict-/i)?.[1]);
    pushUnique(reviewerCandidates, nameAfter(/\b(?:independent\s+)?reviewer\b\**\s*[:：]?\**\s*@?([A-Za-z][\w-]*)/i, head));
    pushUnique(authorCandidates, nameAfter(/\bauthor\b\**\s*[:：]?\**\s*@?([A-Za-z][\w-]*)/i, head));
    // "review of /home/wave/inbox/codex2-freeze-…" / "Verdict: Codex2 SI AOP …"
    pushUnique(authorCandidates, text.match(/\/([A-Za-z][\w-]*?)-(?:[\w-]*-)?freeze-[^\s/]*/)?.[1]);
    pushUnique(authorCandidates, title.match(/^verdict\s*[:：]\s*@?([A-Za-z][\w-]*)/i)?.[1]);
  } else {
    pushUnique(authorCandidates, nameAfter(/\bauthor\b\**\s*[:：]?\**\s*@?([A-Za-z][\w-]*)/i, head));
    const prefix = base.match(/^([A-Za-z][\w-]*?)-(?:[\w-]*-)?freeze-/i)?.[1];
    pushUnique(authorCandidates, prefix);
    pushUnique(authorCandidates, prefix?.split('-')[0]);
    pushUnique(reviewerCandidates, v ? v.line.match(/@([A-Za-z][\w-]*)/)?.[1] : null);
    pushUnique(reviewerCandidates, nameAfter(/\b(?:independent\s+)?reviewer\b\**\s*[:：]?\**\s*@?([A-Za-z][\w-]*)/i, head));
  }

  // "Desk #91", "PD-108", "pd108" in the text or the file name
  const desk = (text.match(/\b(?:desk|pd)[\s#_-]*(\d{1,6})\b/i) ?? base.match(/(?:desk|pd)[\s#_-]*(\d{1,6})/i))?.[1];
  const project = nameAfter(/\bproject\b\**\s*[:：]\**\s*([A-Za-z][\w-]*)/i, head)
    ?? head.join('\n').match(/\bCountix\s*\/\s*([A-Za-z][\w-]*)/)?.[1] ?? null;
  const lane = nameAfter(/\b(?:lane|branch)\b\**\s*[:：]?\**\s*`?(wc-[\w./-]+|[\w./-]*\/[\w./-]+|[\w.-]+)`?/i, head);
  const gate = (text.match(/full-tuned\b[^\n]*?\b(GREEN|RED)\b/i) ?? text.match(/\bgate\b[^\n]*?\b(GREEN|RED)\b/i))?.[1]?.toUpperCase() ?? null;
  const verdictPath = v ? (v.line.match(/(\/[\w.@+-]+(?:\/[\w.@+-]+)*\.(?:md|markdown|txt))/)?.[1] ?? null) : null;

  return {
    kind,
    title,
    sha,
    verdict: v?.verdict ?? null,
    reviewerCandidates,
    authorCandidates,
    project: project ? project.toLowerCase() : null,
    desk: desk ? Number(desk) : null,
    lane: lane && !/^(and|or|the)$/i.test(lane) ? lane : null,
    gate,
    verdictPath,
  };
}

// --- ingest ---------------------------------------------------------------------

function firstAgent(candidates: string[]): Agent | null {
  for (const c of candidates) {
    const r = resolveAgent(c);
    if (r.ok) return r.data;
  }
  return null;
}

function projectFor(parsed: ParsedFreezeFile, text: string): string | null {
  const projects = getConfig().projects ?? {};
  const names = Object.keys(projects);
  if (parsed.project) {
    const hit = names.find((n) => n.toLowerCase() === parsed.project);
    if (hit) return hit;
  }
  // "Project: Countix" names the company; the configured project is mentioned elsewhere ("Countix / wavepulse", "WavePulse")
  const mentioned = names.find((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text));
  if (mentioned) return mentioned;
  if (parsed.project) return parsed.project;
  const withPeer = names.filter((n) => projects[n].release_peer);
  return withPeer.length === 1 ? withPeer[0] : null;
}

export interface IngestOutcome {
  sha: string;
  /** 'card' = a queue card was created, 'updated' = an existing freeze was enriched or re-verdicted, 'noop' = already known. */
  effect: 'card' | 'updated' | 'noop' | 'stored';
  run_id: string | null;
}

export interface IngestOptions {
  /** Backfill: only PASS verdicts create cards (spec §6). */
  passOnly?: boolean;
}

/**
 * Ingest one freeze note or verdict file. Idempotent: the same file delivered
 * twice (or a re-write with the same SHA + verdict + reviewer) changes nothing.
 */
export function ingestFreezeFile(filePath: string, opts: IngestOptions = {}): Result<IngestOutcome> {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return { ok: false, error: `cannot read ${filePath}: ${(e as Error).message}` };
  }
  return ingestFreezeText(text, filePath, opts);
}

export function ingestFreezeText(text: string, filePath: string, opts: IngestOptions = {}): Result<IngestOutcome> {
  const parsed = parseFreezeFile(text, filePath);
  if (!parsed) return { ok: false, error: `${path.basename(filePath)}: not a freeze note or verdict file` };
  if (!parsed.sha) return { ok: false, error: `${path.basename(filePath)}: no exact (40-char) SHA found` };
  const sha = parsed.sha;

  const author = firstAgent(parsed.authorCandidates);
  const reviewer = firstAgent(parsed.reviewerCandidates);
  const reviewerName = reviewer?.name ?? parsed.reviewerCandidates[0] ?? null;
  const project = projectFor(parsed, text);

  // Keep the file itself: the inbox is transient, the library is not.
  let archivedPath: string | null = null;
  if (fs.existsSync(filePath)) {
    try {
    const archived = archiveDocumentFile(filePath, {
      desk: parsed.desk ? String(parsed.desk) : null,
      room: project,
      provenance: [
        `${parsed.kind === 'verdict' ? 'verdict' : 'freeze note'} on exact SHA ${sha}`,
        parsed.lane ? `lane ${parsed.lane}` : null,
        reviewerName ? `reviewer @${reviewerName}` : null,
        author ? `author @${author.name}` : null,
        `archived from ${filePath}`,
      ].filter(Boolean).join(', '),
      note: parsed.title,
    });
    if (archived.ok) archivedPath = archived.data.storage_path;
    else logger.info({ file: filePath, reason: archived.error }, 'Freeze file not archived');
    } catch (e) {
      logger.warn({ file: filePath, error: (e as Error).message }, 'Freeze file not archived');
    }
  }

  const existing = getFreeze(sha);
  const enrich: Partial<ReleaseFreeze> = {};
  if (parsed.kind === 'freeze') {
    enrich.freeze_path = filePath;
    if (!existing?.verdict_path && parsed.verdictPath) enrich.verdict_path = parsed.verdictPath;
  } else {
    enrich.verdict_path = filePath;
  }
  if (project && !existing?.project) enrich.project = project;
  if (parsed.desk && !existing?.desk) enrich.desk = parsed.desk;
  if (parsed.lane && !existing?.lane) enrich.lane = parsed.lane;
  if (parsed.gate && (!existing?.gate || parsed.kind === 'freeze')) enrich.gate = parsed.gate;
  if (author && !existing?.author_agent_id) { enrich.author_agent_id = author.id; enrich.author_name = author.name; }

  const verdict = parsed.verdict;
  const sameVerdict = existing && verdict && existing.verdict === verdict
    && (existing.reviewer_agent_id ? existing.reviewer_agent_id === (reviewer?.id ?? existing.reviewer_agent_id) : existing.reviewer_name === reviewerName);

  // Decided freezes are final: a re-delivered file must not revive them.
  if (existing && existing.status !== 'open' && existing.status !== 'stale') {
    patch(sha, enrich);
    return { ok: true, data: { sha, effect: 'noop', run_id: existing.run_id } };
  }

  if (!verdict || sameVerdict) {
    if (!existing) {
      getDb().prepare(`INSERT INTO release_freezes (sha, project, desk, lane, author_agent_id, author_name, freeze_path, verdict_path, gate, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`)
        .run(sha, project, parsed.desk, parsed.lane, author?.id ?? null, author?.name ?? parsed.authorCandidates[0] ?? null,
          parsed.kind === 'freeze' ? filePath : null, parsed.kind === 'verdict' ? filePath : parsed.verdictPath, parsed.gate);
      supersedeOlder(sha, project, parsed.lane, parsed.desk);
      return { ok: true, data: { sha, effect: 'stored', run_id: null } };
    }
    const changed = Object.keys(enrich).some((k) => (existing as unknown as Record<string, unknown>)[k] !== (enrich as Record<string, unknown>)[k]);
    patch(sha, enrich);
    return { ok: true, data: { sha, effect: changed ? 'updated' : 'noop', run_id: existing.run_id } };
  }

  // A verdict on this SHA — the rules.
  const authorId = author?.id ?? existing?.author_agent_id ?? null;
  const authorName = author?.name ?? existing?.author_name ?? parsed.authorCandidates[0] ?? null;
  if (!authorId) return { ok: false, error: `${path.basename(filePath)}: author agent not found (${parsed.authorCandidates.join(', ') || 'none named'})` };
  if (reviewer && reviewer.id === authorId) {
    logger.warn({ sha, file: filePath, reviewer: reviewer.name }, 'Self-review refused: reviewer is the author');
    return { ok: false, error: `${path.basename(filePath)}: self-review refused — @${reviewer.name} is the author of ${sha.slice(0, 8)}` };
  }
  if (!reviewer && reviewerName && reviewerName.toLowerCase() === authorName?.toLowerCase()) {
    return { ok: false, error: `${path.basename(filePath)}: self-review refused — ${reviewerName} is the author of ${sha.slice(0, 8)}` };
  }
  if (opts.passOnly && verdict !== 'pass' && !existing?.run_id) {
    // Backfill keeps the queue to what can be promoted; the freeze is still recorded so a later PASS completes it.
    if (existing) {
      patch(sha, enrich);
      return { ok: true, data: { sha, effect: 'noop', run_id: null } };
    }
    getDb().prepare(`INSERT INTO release_freezes (sha, project, desk, lane, author_agent_id, author_name, reviewer_agent_id, reviewer_name, freeze_path, verdict_path, gate, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`)
      .run(sha, project, parsed.desk, parsed.lane, authorId, authorName, reviewer?.id ?? null, reviewerName,
        parsed.kind === 'freeze' ? filePath : null, parsed.kind === 'verdict' ? filePath : parsed.verdictPath, parsed.gate);
    return { ok: true, data: { sha, effect: 'stored', run_id: null } };
  }

  const authorAgent = getAgent(authorId);
  if (!authorAgent.ok) return { ok: false, error: authorAgent.error };

  let runId = existing?.run_id ?? null;
  let effect: IngestOutcome['effect'] = 'updated';
  try {
    getDb().transaction(() => {
      if (!runId) {
        const label = [
          'Release freeze',
          project ? `${project}` : null,
          (parsed.desk ?? existing?.desk) ? `Desk #${parsed.desk ?? existing?.desk}` : null,
          `@ ${sha.slice(0, 8)}`,
          (parsed.lane ?? existing?.lane) ? `(lane ${parsed.lane ?? existing?.lane})` : null,
          `— author @${authorAgent.data.alias ?? authorAgent.data.name}, reviewed by @${reviewerName ?? '?'}`,
        ].filter(Boolean).join(' ');
        const task = insertTask({ agent_id: authorId, prompt: label, created_by: null, room: project ?? null });
        if (!task.ok) throw new Error(task.error);
        const run = insertRun({ task_id: task.data.id, agent_id: authorId });
        if (!run.ok) throw new Error(run.error);
        const finished = finishRun(run.data.id, 0);
        if (!finished.ok) throw new Error(finished.error);
        const done = updateTaskStatus(task.data.id, 'done');
        if (!done.ok) throw new Error(done.error);
        updateRunSummary(run.data.id, `${parsed.title}\n\n${text.trim().slice(0, SUMMARY_MAX)}`);
        runId = run.data.id;
        effect = 'card';
      }
      if (!existing) {
        getDb().prepare(`INSERT INTO release_freezes (sha, run_id, project, desk, lane, author_agent_id, author_name, reviewer_agent_id, reviewer_name, verdict, freeze_path, verdict_path, gate, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`)
          .run(sha, runId, project, parsed.desk, parsed.lane, authorId, authorName, reviewer?.id ?? null, reviewerName, verdict,
            parsed.kind === 'freeze' ? filePath : null, parsed.kind === 'verdict' ? filePath : parsed.verdictPath, parsed.gate);
      } else {
        patch(sha, { ...enrich, run_id: runId, author_agent_id: authorId, author_name: authorName, reviewer_agent_id: reviewer?.id ?? null, reviewer_name: reviewerName, verdict });
      }
      const reviewId = ulid();
      const feedback = text.slice(0, FEEDBACK_MAX);
      getDb().prepare(`INSERT INTO code_reviews (id, run_id, reviewer_type, reviewer_agent_id, reviewer_runtime, status, diff, feedback, issues_found, verdict, fix_round)
        VALUES (?, ?, 'cross-model', ?, ?, 'done', NULL, ?, ?, ?, 0)`)
        .run(reviewId, runId, reviewer?.id ?? null, reviewer?.runtime ?? null, feedback, countIssues(feedback), verdict);
      emit('review.ai_completed', 'run', runId, {
        review_id: reviewId,
        issues_found: countIssues(feedback),
        verdict,
        fix_round: 0,
        reviewer_agent: reviewerName,
        reviewer_agent_id: reviewer?.id ?? null,
        freeze: { sha, project, desk: parsed.desk ?? existing?.desk ?? null, lane: parsed.lane ?? existing?.lane ?? null, file: filePath, archive: archivedPath },
      }, null);
    })();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  supersedeOlder(sha, project ?? existing?.project ?? null, parsed.lane ?? existing?.lane ?? null, parsed.desk ?? existing?.desk ?? null);
  logger.info({ sha, runId, verdict, reviewer: reviewerName, author: authorName, file: filePath }, 'Release freeze ingested');
  return { ok: true, data: { sha, effect, run_id: runId } };
}

/** A newer commit on the same lane invalidates older open freezes (spec rule 3). */
/**
 * A newer commit on the same lane — or a newer freeze for the same desk in the same project
 * (verdict files often carry no lane line, and a desk is one unit of work) — invalidates older
 * open freezes (spec rule 3).
 */
function supersedeOlder(sha: string, project: string | null, lane: string | null, desk: number | null): void {
  if (!lane && desk == null) return;
  const rows = getDb().prepare(
    `SELECT * FROM release_freezes WHERE sha <> ? AND status = 'open' AND (project IS ? OR project = ?)
       AND ((? IS NOT NULL AND lane = ?) OR (? IS NOT NULL AND desk = ?))
       AND created_at <= (SELECT created_at FROM release_freezes WHERE sha = ?)`,
  ).all(sha, project, project, lane, lane, desk, desk, sha) as ReleaseFreeze[];
  for (const old of rows) {
    const by = old.lane && old.lane === lane ? 'lane' : 'desk';
    patch(old.sha, { status: 'stale', superseded_by: sha });
    if (old.run_id) emit('review.superseded', 'run', old.run_id, { sha: old.sha, superseded_by: sha, lane, desk, by }, null);
    logger.info({ sha: old.sha, superseded_by: sha, lane, desk, by }, 'Release freeze superseded by a newer freeze');
  }
}

// --- merged into main -------------------------------------------------------------------

const mergedCache = new Map<string, { at: number; merged: boolean | null }>();
const MERGED_TTL_MS = 60_000;
const fetchedAt = new Map<string, number>();
const FETCH_TTL_MS = 10 * 60_000;

/** Best-effort `git fetch --prune origin` on the base clone (main and candidate branches), at most every 10 minutes per repo. */
function refreshMain(repo: string, now: number): void {
  const last = fetchedAt.get(repo) ?? 0;
  if (now - last < FETCH_TTL_MS) return;
  fetchedAt.set(repo, now);
  try {
    execFileSync('git', ['-C', repo, 'fetch', '--quiet', '--prune', 'origin'], { stdio: 'ignore', timeout: 30_000 });
  } catch (e) {
    logger.debug({ repo, error: (e as Error).message }, 'Base clone fetch skipped');
  }
}

/** Test hook: a repo may be probed without fetching (no remote). */
export function setFetchDisabledForTest(disabled: boolean): void {
  fetchDisabled = disabled;
}
let fetchDisabled = false;

function globToRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

const candidateCache = new Map<string, { at: number; refs: Array<{ ref: string; name: string }> }>();

/** Unreleased candidate branches (newest first) matching projects.<p>.candidate_refs, as remote-tracking refs. */
function candidateRefs(project: string, repo: string, now: number): Array<{ ref: string; name: string }> {
  const glob = getConfig().projects?.[project]?.candidate_refs;
  if (!glob) return [];
  const hit = candidateCache.get(repo);
  if (hit && now - hit.at < MERGED_TTL_MS) return hit.refs;
  const re = globToRe(glob);
  let refs: Array<{ ref: string; name: string }> = [];
  try {
    const out = execFileSync('git', ['-C', repo, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes/origin'], { encoding: 'utf-8', timeout: 5000 });
    refs = out.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((short) => ({ ref: short, name: short.replace(/^origin\//, '') }))
      .filter((r) => re.test(r.name))
      .filter((r) => {
        // released candidates are already on main: not "in candidate" any more
        try { execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', r.ref, 'origin/main'], { stdio: 'ignore', timeout: 5000 }); return false; } catch { return true; }
      });
  } catch (e) {
    logger.debug({ repo, error: (e as Error).message }, 'Candidate refs unavailable');
  }
  candidateCache.set(repo, { at: now, refs });
  return refs;
}

export interface CandidateRef { ref: string; name: string; tip: string; committed_at: string | null }

/** Unreleased candidate branches of a project with their tip SHA (newest first). */
export function listCandidates(project: string, now = Date.now()): CandidateRef[] {
  const repo = getConfig().projects?.[project]?.repo;
  if (!repo) return [];
  if (!fetchDisabled) refreshMain(repo, now);
  return candidateRefs(project, repo, now).map((c) => {
    let tip = '';
    let committed: string | null = null;
    try {
      const out = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%H %cI', c.ref], { encoding: 'utf-8', timeout: 5000 }).trim();
      [tip, committed] = out.split(' ') as [string, string];
    } catch { /* unreadable ref */ }
    return { ref: c.ref, name: c.name, tip, committed_at: committed };
  }).filter((c) => c.tip);
}

/** The newest unreleased candidate that contains `sha`, or null. */
export function candidateFor(project: string | null, sha: string, now = Date.now()): { ref: string; name: string } | null {
  const repo = project ? getConfig().projects?.[project]?.repo : undefined;
  if (!repo || !project) return null;
  if (!fetchDisabled) refreshMain(repo, now);
  if (isOnMain(project, sha, now) === true) return null; // released: on main, not "in candidate"
  for (const c of candidateRefs(project, repo, now)) {
    try {
      execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', sha, c.ref], { stdio: 'ignore', timeout: 5000 });
      return c;
    } catch { /* not in this one */ }
  }
  return null;
}

/** Is `sha` an ancestor of the project's main (per the local base clone)? null = cannot tell. */
export function isOnMain(project: string | null, sha: string, now = Date.now()): boolean | null {
  const repo = project ? getConfig().projects?.[project]?.repo : undefined;
  if (!repo) return null;
  const key = `${repo}:${sha}`;
  const hit = mergedCache.get(key);
  if (hit && now - hit.at < MERGED_TTL_MS) return hit.merged;
  if (!fetchDisabled) refreshMain(repo, now);
  let merged: boolean | null = null;
  for (const ref of ['origin/main', 'main']) {
    try {
      execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', sha, ref], { stdio: 'ignore', timeout: 5000 });
      merged = true;
      break;
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 1) { merged = false; break; } // known commit, not an ancestor
      // 128: unknown sha or ref — try the next ref, else unknown
    }
  }
  mergedCache.set(key, { at: now, merged });
  return merged;
}

/**
 * Close freezes whose SHA already sits on main (deployed or merged by other means):
 * status 'merged', the queue card approved, a review.superseded event with superseded_by 'main'.
 */
export function reconcileMerged(now = Date.now()): number {
  let n = reconcileSuperseded();
  const open = getDb().prepare("SELECT * FROM release_freezes WHERE status IN ('open', 'stale')").all() as ReleaseFreeze[];
  for (const f of open) {
    if (isOnMain(f.project, f.sha, now) !== true) continue;
    patch(f.sha, { status: 'merged', superseded_by: 'main' });
    if (f.run_id) {
      getDb().prepare("UPDATE runs SET review_status = 'approved' WHERE id = ? AND review_status = 'pending'").run(f.run_id);
      emit('review.superseded', 'run', f.run_id, { sha: f.sha, superseded_by: 'main', by: 'merged' }, null);
    }
    logger.info({ sha: f.sha, project: f.project }, 'Release freeze is on main: closed as merged');
    n++;
  }
  return n;
}

/**
 * Among open freezes, only the newest per (project, lane) and per (project, desk) stays open;
 * older ones are stale. Ingest applies this as files arrive; this pass covers rows created
 * before the rule existed and freezes whose lane or desk was only learned later.
 */
export function reconcileSuperseded(): number {
  const open = (getDb().prepare("SELECT * FROM release_freezes WHERE status = 'open' ORDER BY created_at ASC, rowid ASC").all() as ReleaseFreeze[]);
  const newest = new Map<string, ReleaseFreeze>();
  for (const f of open) {
    if (f.lane) newest.set(`lane:${f.project ?? ''}:${f.lane}`, f);
    if (f.desk != null) newest.set(`desk:${f.project ?? ''}:${f.desk}`, f);
  }
  let n = 0;
  for (const f of open) {
    const byLane = f.lane ? newest.get(`lane:${f.project ?? ''}:${f.lane}`) : undefined;
    const byDesk = f.desk != null ? newest.get(`desk:${f.project ?? ''}:${f.desk}`) : undefined;
    const winner = byLane && byLane.sha !== f.sha ? byLane : byDesk && byDesk.sha !== f.sha ? byDesk : null;
    if (!winner) continue;
    patch(f.sha, { status: 'stale', superseded_by: winner.sha });
    if (f.run_id) emit('review.superseded', 'run', f.run_id, { sha: f.sha, superseded_by: winner.sha, lane: f.lane, desk: f.desk, by: byLane && byLane.sha !== f.sha ? 'lane' : 'desk' }, null);
    logger.info({ sha: f.sha, superseded_by: winner.sha }, 'Release freeze superseded on reconcile');
    n++;
  }
  return n;
}

export function resetMergedCacheForTest(): void {
  mergedCache.clear();
  candidateCache.clear();
  fetchedAt.clear();
}

// --- promote / reject rules --------------------------------------------------------

/** Current tip of the lane as git knows it from the author's workspace; null when unknowable. */
function laneHead(freeze: ReleaseFreeze): string | null {
  if (!freeze.lane || !freeze.author_agent_id) return null;
  const agent = getAgent(freeze.author_agent_id);
  if (!agent.ok || !agent.data.workspace) return null;
  for (const ref of [freeze.lane, `origin/${freeze.lane}`]) {
    try {
      const out = execFileSync('git', ['-C', agent.data.workspace, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { encoding: 'utf-8', timeout: 5000 }).trim();
      if (SHA40.test(out)) return out;
    } catch { /* try the next ref */ }
  }
  return null;
}

/**
 * Server-side rules for promoting a freeze card: PASS on the exact SHA
 * (non-PASS needs an admin override reason — the route checks the role),
 * reviewer ≠ author, and the SHA must still be the lane's tip. A stale SHA is
 * refused outright; no override, because that is the one thing the rule is for.
 */
export function checkPromotable(freeze: ReleaseFreeze, opts: { overrideReason?: string | null } = {}): Result<ReleaseFreeze> {
  const short = freeze.sha.slice(0, 8);
  if (freeze.status === 'promoted') return { ok: false, error: `Freeze ${short} was already promoted` };
  if (freeze.status === 'rejected') return { ok: false, error: `Freeze ${short} was rejected` };
  if (freeze.status === 'stale') {
    return { ok: false, error: `Promotion refused: freeze ${short} is stale — lane ${freeze.lane ?? '?'} moved on to ${freeze.superseded_by?.slice(0, 8) ?? 'a newer commit'}. Freeze and review the new SHA.` };
  }
  const head = laneHead(freeze);
  if (head && head !== freeze.sha) {
    patch(freeze.sha, { status: 'stale', superseded_by: head });
    if (freeze.run_id) emit('review.superseded', 'run', freeze.run_id, { sha: freeze.sha, superseded_by: head, lane: freeze.lane }, null);
    return { ok: false, error: `Promotion refused: lane ${freeze.lane} is now at ${head.slice(0, 8)}, not the reviewed ${short}. Freeze and review the new SHA.` };
  }
  if (freeze.reviewer_agent_id && freeze.reviewer_agent_id === freeze.author_agent_id) {
    return { ok: false, error: `Promotion refused: ${short} was reviewed by its author (@${freeze.author_name}); an independent reviewer's PASS is required.` };
  }
  if (freeze.verdict !== 'pass' && !opts.overrideReason?.trim()) {
    const v = freeze.verdict ? `verdict is '${freeze.verdict}'` : 'no verdict on this SHA';
    return { ok: false, error: `Promotion blocked: ${v} for ${short}. An independent PASS on the exact SHA is required (admins may override with a stored reason).` };
  }
  return { ok: true, data: freeze };
}

export function markPromoted(runId: string, actorName: string | null): void {
  const f = getFreezeByRun(runId);
  if (f) patch(f.sha, { status: 'promoted', decided_by: actorName });
}

export function markRejected(runId: string, actorName: string | null, reason: string | null): void {
  const f = getFreezeByRun(runId);
  if (f) patch(f.sha, { status: 'rejected', decided_by: actorName, decision_reason: reason });
}

// --- folder watcher + backfill -------------------------------------------------------

const watchers = new Map<string, fs.FSWatcher>();
const seen = new Map<string, number>(); // path → mtimeMs ingested
const timers = new Set<NodeJS.Timeout>();

function expand(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** `review.freeze_inbox` dirs (none by default: a deploy box's inbox holds GO files, not freezes). */
export function freezeInboxDirs(): string[] {
  return (getConfig().review.freeze_inbox ?? []).map(expand);
}

export function isFreezeFileName(name: string): boolean {
  return !name.startsWith('.') && FILE_NAME_RE.test(name) && TEXT_EXT_RE.test(name);
}

function ingestIfChanged(file: string, opts: IngestOptions = {}): void {
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return;
  }
  if (seen.get(file) === mtime) return;
  seen.set(file, mtime);
  try {
    const r = ingestFreezeFile(file, opts);
    if (!r.ok) logger.info({ file, reason: r.error }, 'Freeze file skipped');
  } catch (e) {
    logger.warn({ file, error: (e as Error).message }, 'Freeze file could not be ingested');
  }
}

export function startOfLocalDay(now = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** First run: import today's freezes and PASS verdicts so an already-reviewed lane shows up (spec §6). */
export function backfillFreezes(dirs = freezeInboxDirs(), now = new Date()): number {
  const since = startOfLocalDay(now);
  let n = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter(isFreezeFileName);
    } catch {
      continue;
    }
    const files = names
      .map((name) => {
        const file = path.join(dir, name);
        try { return { file, mtime: fs.statSync(file).mtimeMs }; } catch { return null; }
      })
      .filter((x): x is { file: string; mtime: number } => !!x && x.mtime >= since)
      .sort((a, b) => a.mtime - b.mtime);
    for (const { file } of files) {
      ingestIfChanged(file, { passOnly: true });
      n++;
    }
  }
  return n;
}

/** One fs.watch event: let the writer finish (SETTLE_MS), then ingest if the file changed since last time. */
export function onInboxEvent(dir: string, filename: string | Buffer | null, settleMs = SETTLE_MS): void {
  if (!filename || typeof filename !== 'string' || !isFreezeFileName(filename)) return;
  const file = path.join(dir, filename);
  const t = setTimeout(() => { timers.delete(t); ingestIfChanged(file); }, settleMs);
  timers.add(t);
}

export function startFreezeWatchers(): void {
  for (const dir of freezeInboxDirs()) {
    if (watchers.has(dir)) continue;
    if (!fs.existsSync(dir)) {
      logger.warn({ dir }, 'Freeze inbox does not exist; not watching');
      continue;
    }
    try {
      const w = fs.watch(dir, (_event, filename) => onInboxEvent(dir, filename));
      w.on('error', (e) => logger.warn({ dir, error: e.message }, 'Freeze watcher error'));
      watchers.set(dir, w);
      logger.info({ dir }, 'Watching freeze inbox');
    } catch (e) {
      logger.warn({ dir, error: (e as Error).message }, 'Freeze watcher could not start');
    }
  }
  const imported = backfillFreezes();
  if (imported > 0) logger.info({ imported }, 'Freeze inbox backfill done');
}

export function stopFreezeWatchers(): void {
  for (const w of watchers.values()) w.close();
  watchers.clear();
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

/** Test hook. */
export function resetFreezesForTest(): void {
  stopFreezeWatchers();
  seen.clear();
}
