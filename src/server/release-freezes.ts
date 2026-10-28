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
import { ulid } from 'ulid';
import { getConfig } from './config.js';
import {
  finishRun,
  getAgent,
  getDb,
  getRun,
  insertRun,
  insertTask,
  listAgents,
  resolveAgent,
  updateRunSummary,
  updateTaskStatus,
  type Agent,
  type Result,
} from './db.js';
import { countVerdictIssues, type ReviewVerdict } from './code-review.js';
import { fireFreeze, fireReviewRequest } from './pipeline-hooks.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { archiveDocumentFile } from './fixtures.js';
import { behindMainLine } from './lane-status.js';
import { gitAncestor, gitText } from './git-memo.js';
import { execFileAsync } from './proc.js';
import { commitsBehind, laneAutomationDenied, observeRepo, pingLaneAboutMain, mainTip, projectRepo } from './lane-main.js';
import { pingReviewersForGreenSha } from './gate-ping.js';
import { readLaneTests, shaChecks, suiteNames, testsConfigured, type TestRun } from './test-runs.js';

/** merged = the SHA is an ancestor of the project's main: the lane is done, whatever its last verdict said.
 *  behind-main = the SHA does not contain the project's current main, so it cannot be staged. */
export type FreezeStatus = 'open' | 'promoted' | 'rejected' | 'stale' | 'merged' | 'behind-main';

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
const FILE_NAME_RE = /(freeze|verdict|review-request)/i;
const REVIEW_REQUEST_RE = /review-request/i;

/** `<you>-<lane>-review-request-<sha8>.md`: the agent asks for a review itself (docs/maestro-contract.md). */
export function isReviewRequestFileName(name: string): boolean {
  return REVIEW_REQUEST_RE.test(name) && TEXT_EXT_RE.test(name) && !name.startsWith('.');
}
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
    CREATE TABLE IF NOT EXISTS freeze_verdicts (
      sha TEXT NOT NULL,
      reviewer_agent_id TEXT,
      reviewer_name TEXT NOT NULL,
      profile TEXT,
      verdict TEXT NOT NULL,
      path TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (sha, reviewer_name)
    );
  `);
}

/** One row per (SHA, reviewer): every verdict file that was ingested, not only the latest. The merge queue counts these. */
export interface FreezeVerdict {
  sha: string;
  reviewer_agent_id: string | null;
  reviewer_name: string;
  /** The reviewer's credential profile at ingest time; null = home-dir login. */
  profile: string | null;
  verdict: ReviewVerdict;
  path: string | null;
  created_at: string;
}

export function recordVerdict(row: { sha: string; reviewer: Agent | null; reviewerName: string; verdict: ReviewVerdict; path: string | null }): void {
  withTable(() => {
    getDb().prepare(`INSERT INTO freeze_verdicts (sha, reviewer_agent_id, reviewer_name, profile, verdict, path)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(sha, reviewer_name) DO UPDATE SET reviewer_agent_id = excluded.reviewer_agent_id, profile = excluded.profile,
        verdict = excluded.verdict, path = excluded.path, created_at = datetime('now')`)
      .run(row.sha, row.reviewer?.id ?? null, row.reviewerName.toLowerCase(), row.reviewer?.profile ?? null, row.verdict, row.path);
  });
}

export function listVerdicts(sha: string): FreezeVerdict[] {
  return withTable(() => getDb().prepare('SELECT * FROM freeze_verdicts WHERE sha = ? ORDER BY created_at').all(sha) as FreezeVerdict[]);
}

/** The queue consults freezes on every card; a database opened without bootstrap (tests, CLI) gets the table on first use. */
function withTable<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (!/no such table: (release_freezes|freeze_verdicts)/.test((e as Error).message)) throw e;
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

/** Record the gate command's result word on the freeze. */
export function setFreezeGate(sha: string, gate: string): void {
  const g = gate.toUpperCase();
  if (g !== 'GREEN' && g !== 'RED' && g !== 'QUEUED' && g !== 'RUNNING' && g !== 'CANCELLED') return;
  patch(sha, { gate: g });
}

/** Point an open, undecided freeze at a reviewer. A written verdict stays put. */
export function setFreezeReviewer(sha: string, reviewer: { id: string; name: string } | null): void {
  const freeze = getFreeze(sha);
  if (!freeze || freeze.verdict) return;
  patch(sha, {
    reviewer_agent_id: reviewer?.id ?? null,
    reviewer_name: reviewer?.name ?? null,
  });
}

export function listFreezes(): ReleaseFreeze[] {
  return withTable(() => getDb().prepare('SELECT * FROM release_freezes ORDER BY created_at DESC').all() as ReleaseFreeze[]);
}

/** A denied lane or author is not a Reviews card and is not a developer lane on that page. */
export function freezeOnReviews(freeze: { project: string | null; lane: string | null; author_name?: string | null }): boolean {
  return !laneAutomationDenied(freeze.project, freeze.author_name ? { name: freeze.author_name } : null, freeze.lane);
}

/** Freezes the Reviews page may show. Denied lanes and agents are left out. */
export function listReviewFreezes(): ReleaseFreeze[] {
  return listFreezes().filter(freezeOnReviews);
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

/**
 * Words that used to be captured as a lane name ("the lane is…", "branch from…",
 * "lane remains update"). A real lane is a quoted token, a `wc-…` name, or the
 * first token after `Lane:` / `Branch:`.
 */
const LANE_FILLER = new Set([
  'is', 'from', 'remains', 'remain', 'update', 'updated', 'the', 'a', 'an', 'and', 'or',
  'of', 'to', 'for', 'on', 'in', 'at', 'by', 'with', 'still', 'now', 'currently',
  'was', 'were', 'be', 'been', 'this', 'that', 'it', 'its', 'not', 'no', 'yes', 'as', 'into', 'onto',
  'changes', 'source', 'separately', 'held', 'also', 'commits', 'test-path',
]);

export function isFillerLane(lane: string | null | undefined): boolean {
  if (!lane) return false;
  return LANE_FILLER.has(lane.trim().toLowerCase());
}

/** A raw commit id is not a lane. `6ed9192e` used to be stored as one. */
export function isShaLane(lane: string | null | undefined): boolean {
  if (!lane) return false;
  return /^[0-9a-f]{7,40}$/i.test(lane.trim());
}

/** Filler words and hex SHAs are not lanes, including rows written before that rule. */
export function isInvalidLane(lane: string | null | undefined): boolean {
  return isFillerLane(lane) || isShaLane(lane);
}

function cleanToken(raw: string): string {
  return raw.replace(/^[`*'"]+|[`*'".),:;]+$/g, '').trim();
}

function acceptLane(token: string): string | null {
  const t = cleanToken(token);
  if (!t || t.length > 80) return null;
  if (LANE_FILLER.has(t.toLowerCase())) return null;
  if (/^(origin\/main|main|head)$/i.test(t)) return null;
  if (/^[0-9a-f]{7,40}$/i.test(t)) return null;
  if (!/^[\w./~+-]+$/.test(t)) return null;
  return t;
}

/** A lane field, not a sentence that happens to contain the word. */
function isLaneField(line: string): boolean {
  return /^\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:the\s+)?(?:lane|branch)\b/i.test(line);
}

/**
 * `wc-*`, or a lane the config or a registered seat already names.
 * Filler words and prose tokens are not lanes.
 */
export function isRealLaneId(lane: string | null | undefined): boolean {
  if (!lane) return false;
  const t = lane.trim();
  if (!t || t.length > 80 || isFillerLane(t)) return false;
  if (/^(origin\/main|main|head)$/i.test(t)) return false;
  if (/^wc-/i.test(t)) return true;
  const want = t.toLowerCase();
  try {
    const cfg = getConfig();
    for (const project of Object.values(cfg.projects ?? {})) {
      const glob = project.lane_glob || 'wc-*';
      try { if (globToRe(glob).test(t)) return true; } catch { /* bad glob */ }
    }
    for (const dev of cfg.developers ?? []) {
      for (const glob of dev.lanes ?? []) {
        try { if (globToRe(glob).test(t)) return true; } catch { /* bad glob */ }
      }
    }
  } catch { /* config not loaded */ }
  try {
    return listAgents().some((agent) =>
      agent.tmux_session.toLowerCase() === want
      || agent.name.toLowerCase() === want
      || agent.alias?.toLowerCase() === want,
    );
  } catch {
    return false;
  }
}

function fieldKind(line: string): 'lane' | 'branch' | null {
  if (!isLaneField(line)) return null;
  const laneAt = line.search(/\blane\b/i);
  const branchAt = line.search(/\bbranch\b/i);
  if (laneAt >= 0 && (branchAt < 0 || laneAt <= branchAt)) return 'lane';
  if (branchAt >= 0) return 'branch';
  return null;
}

function fieldToken(line: string): string | null {
  const kw = line.search(/\b(?:lane|branch)\b/i);
  const head = line.slice(kw);
  const rest = head.replace(/^\**\s*(?:lane|branch)\b\**\s*[:：]?\**\s*/i, '');
  // A colon right after the keyword (`Lane:`, `**Branch**:`) or a `wc-*` / known id. Prose
  // ("the lane remains update…", "Branch tip `sha` was pushed: up to date") is not a name: a
  // colon later in the sentence used to make its first word the lane ("tip", "adds").
  const labelled = /^\**\s*(?:lane|branch)\b\**\s*[:：]/i.test(head);
  const take = (token: string | null): string | null => {
    if (!token) return null;
    if (labelled || isRealLaneId(token)) return token;
    return null;
  };
  const quoted = [...rest.matchAll(/`([^`]+)`/g)].map((m) => take(acceptLane(m[1]))).find((v): v is string => !!v);
  if (quoted) return quoted;
  for (const word of rest.split(/[\s,;]+/)) {
    const lane = take(acceptLane(word));
    if (lane) return lane;
  }
  return null;
}

/**
 * `Lane:` and `Branch:` fields in the head of a freeze note.
 * A branch name does not have to be `wc-*`. Filler and a hex SHA are not lanes.
 */
export function noteLanes(lines: string[]): { lane: string | null; branch: string | null } {
  let lane: string | null = null;
  let branch: string | null = null;
  for (const line of lines) {
    const kind = fieldKind(line);
    if (!kind) continue;
    const token = fieldToken(line);
    if (!token) continue;
    if (kind === 'lane' && !lane) lane = token;
    if (kind === 'branch' && !branch) branch = token;
  }
  return { lane, branch };
}

/** Lane line, else the branch line. The same order as {@link attributedLane}. */
export function laneFromLines(lines: string[]): string | null {
  const notes = noteLanes(lines);
  return notes.lane ?? notes.branch;
}

function seatForLane(lane: string): { id: string } | null {
  const bare = lane.replace(/^wc-/i, '');
  try {
    const agent = listAgents().find((a) =>
      a.tmux_session.toLowerCase() === lane.toLowerCase()
      || a.name.toLowerCase() === lane.toLowerCase()
      || a.name.toLowerCase() === bare.toLowerCase()
      || a.alias?.toLowerCase() === bare.toLowerCase()
      || a.alias?.toLowerCase() === lane.toLowerCase(),
    );
    return agent ? { id: agent.id } : null;
  } catch {
    return null;
  }
}

/** The lane string is some other seat's tmux or name, not this author. */
function namesOtherSeat(lane: string, authorId: string | null): boolean {
  const seat = seatForLane(lane);
  if (!seat) return false;
  return seat.id !== authorId;
}

/** A branch the run actually has checked out, or a lane already stored on a release. Not a note token. */
function isRecordLane(name: string): boolean {
  const t = name.trim();
  if (!t || t.length > 80 || isFillerLane(t)) return false;
  if (/^(origin\/main|main|head)$/i.test(t)) return false;
  if (/^[0-9a-f]{7,40}$/i.test(t)) return false;
  return /^[\w./~+-]+$/.test(t);
}

async function workspaceBranch(agentId: string | null): Promise<string | null> {
  if (!agentId) return null;
  const agent = getAgent(agentId);
  if (!agent.ok || !agent.data.workspace || !fs.existsSync(agent.data.workspace)) return null;
  try {
    const name = (await execFileAsync('git', ['-C', agent.data.workspace, 'branch', '--show-current'], {
      timeout: 5000,
    })).trim();
    return name && isRecordLane(name) ? name : null;
  } catch {
    return null;
  }
}

function releaseRequestLane(sha: string): string | null {
  try {
    const row = getDb().prepare(
      `SELECT lane FROM release_requests WHERE lower(sha) = ? AND lane IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
    ).get(sha.toLowerCase()) as { lane: string } | undefined;
    return row?.lane && isRecordLane(row.lane) ? row.lane : null;
  } catch {
    return null;
  }
}

interface LaneSource {
  sha: string;
  lane: string | null;
  author_agent_id: string | null;
  run_id?: string | null;
  freeze_path?: string | null;
}

/** The run's agent when this freeze has a run, else the freeze author. */
function runAgentId(row: { run_id?: string | null; author_agent_id: string | null } | null | undefined): string | null {
  if (!row) return null;
  if (row.run_id) {
    try {
      const run = getRun(row.run_id);
      if (run.ok) return run.data.agent_id;
    } catch { /* run table missing */ }
  }
  return row.author_agent_id;
}

/**
 * The lane recorded for this SHA: the run's checkout, else the author's, else
 * the release request for this SHA. A seat name found in prose is not a record.
 */
export async function laneFromRunRecord(row: { sha: string; author_agent_id: string | null; run_id?: string | null }): Promise<string | null> {
  const agentId = runAgentId(row);
  const branch = await workspaceBranch(agentId);
  if (branch && !namesOtherSeat(branch, agentId)) return branch;
  const requested = releaseRequestLane(row.sha);
  if (requested && !namesOtherSeat(requested, agentId)) return requested;
  return null;
}

async function chooseLane(noteLane: string | null, noteBranch: string | null, row: LaneSource): Promise<string | null> {
  const agentId = runAgentId(row);
  // A stored real lane name outranks a parsed word that is not one (a second note about the
  // same SHA, written in prose, must not rename the lane).
  const stored = row.lane;
  const storedReal = !!stored && isRealLaneId(stored) && !namesOtherSeat(stored, agentId);
  if (noteLane && !namesOtherSeat(noteLane, agentId) && (!storedReal || isRealLaneId(noteLane))) return noteLane;
  if (noteBranch && !namesOtherSeat(noteBranch, agentId) && (!storedReal || isRealLaneId(noteBranch))) return noteBranch;
  const recorded = await laneFromRunRecord(row);
  if (recorded) return recorded;
  // A lane already stored stays, unless it is filler, a hex SHA, or another seat.
  if (stored && !isInvalidLane(stored) && !namesOtherSeat(stored, agentId)) return stored;
  return null;
}

/**
 * One lane for the board, the stale check, and Stage.
 * The freeze `Lane:` line, else `Branch:`, else the run's lane, else a stored
 * lane that is still a real name. A filler word, a hex SHA, and another seat's
 * name are not a lane.
 * Pass `noteText` to avoid a second read; pass null when there is no note.
 */
export async function attributedLane(row: LaneSource, noteText?: string | null): Promise<string | null> {
  let text = noteText;
  if (text === undefined && row.freeze_path) {
    try { text = fs.readFileSync(row.freeze_path, 'utf8'); } catch { text = null; }
  }
  const lines = (text ?? '').replace(/\r/g, '').split('\n').slice(0, 40);
  const notes = noteLanes(lines);
  return chooseLane(notes.lane, notes.branch, row);
}

function deskNumbers(text: string, filename: string): number[] {
  const found = new Set<number>();
  const re = /\b(?:desk|pd)[\s#_-]*(\d{1,6})\b/gi;
  for (const src of [text, filename]) {
    for (const m of src.matchAll(re)) found.add(Number(m[1]));
  }
  return [...found];
}

/** A composition or multi-desk note is a bundle: it must not wear one desk number. */
export function isBundleNote(title: string, lane: string | null, desks: number[]): boolean {
  if (desks.length > 1) return true;
  return /\b(?:composition|bundle|bundles)\b/i.test(`${title}\n${lane ?? ''}`);
}

export interface FreezeLabels {
  title: string;
  /** One line taken from the freeze-note title (the clause after the dash, or the title). */
  summary: string;
  desk: number | null;
  lane: string | null;
  bundle: boolean;
}

export function freezeNoteSummary(title: string): string {
  const parts = title.split(/\s+[—–-]\s+/);
  const clause = (parts.length > 1 ? parts.slice(1).join(' — ') : title).replace(/\s+/g, ' ').trim();
  return clause.length > 180 ? `${clause.slice(0, 177)}…` : clause;
}

/** Title, one-line summary, desk and lane as the freeze note actually says them. */
export function labelsFromFreezeNote(text: string, filename: string): FreezeLabels {
  const lines = text.replace(/\r/g, '').split('\n');
  const head = lines.slice(0, 40);
  const title = titleOf(lines);
  const lane = laneFromLines(head);
  const desks = deskNumbers(text, path.basename(filename));
  const bundle = isBundleNote(title, lane, desks);
  const desk = bundle || desks.length !== 1 ? null : desks[0];
  return { title, summary: freezeNoteSummary(title), desk, lane, bundle };
}

/**
 * Rewrite a stored lane or desk when the freeze note disagrees.
 * A filler lane ("is", "from", "remains", "update") is cleared.
 * A bundle drops a single desk number. A missing desk on a non-bundle note
 * leaves the stored desk alone.
 */
export async function applyNoteLabels(sha: string, text: string, filename: string): Promise<FreezeLabels> {
  const labels = labelsFromFreezeNote(text, filename);
  const row = getFreeze(sha);
  if (!row) return labels;
  const lane = await attributedLane(row, text);
  const desk = labels.bundle ? null : (labels.desk ?? row.desk);
  const fields: Partial<ReleaseFreeze> = {};
  if (lane !== row.lane) fields.lane = lane;
  if (desk !== row.desk) fields.desk = desk;
  if (Object.keys(fields).length) patch(sha, fields);
  return { ...labels, lane, desk };
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

export interface NoteChecks {
  quick: 'green' | 'red' | null;
  full: 'green' | 'red' | null;
}

function prefixMatches(mention: string, sha: string): boolean {
  return sha.startsWith(mention) || mention.startsWith(sha);
}

/** 'other' when any 7+ hex token is not a prefix of this SHA. One matching prefix does not rescue the line. */
function shaMention(line: string, sha: string): 'this' | 'other' | 'none' {
  const mentions = [...line.toLowerCase().matchAll(/\b[0-9a-f]{7,40}\b/g)].map((m) => m[0]);
  if (mentions.length === 0) return 'none';
  if (mentions.some((m) => !prefixMatches(m, sha))) return 'other';
  return 'this';
}

function noteCheckOnLine(line: string): { kind: 'quick' | 'full'; word: 'green' | 'red' } | null {
  const words = new Set([...line.matchAll(/\b(GREEN|RED)\b/gi)].map((m) => m[1].toUpperCase()));
  if (words.size !== 1) return null;
  const patterns: Array<{ kind: 'quick' | 'full'; re: RegExp }> = [
    { kind: 'quick', re: /\bquick\s+check\b\s*:?\s*(GREEN|RED)\b/i },
    { kind: 'quick', re: /\btier\s*1\b\s*:?\s*(GREEN|RED)\b/i },
    { kind: 'full', re: /\bRESULT\b\s*:?\s*(GREEN|RED)\b/i },
    { kind: 'full', re: /\bGATE\b\s*:?\s*(GREEN|RED)\b/i },
    { kind: 'full', re: /\bfull-tuned\b\s*:?\s*(GREEN|RED)\b/i },
  ];
  for (const pattern of patterns) {
    const match = line.match(pattern.re);
    if (match) return { kind: pattern.kind, word: match[1].toLowerCase() === 'green' ? 'green' : 'red' };
  }
  return null;
}

/**
 * Quick and full results written in a freeze note. A line counts when every
 * 7+ hex token on it is a prefix of this SHA, or when it names no SHA and the
 * note's frozen SHA is this SHA. Any token that is not a prefix of this SHA
 * rejects the whole line.
 */
export function parseNoteChecks(text: string, sha: string): NoteChecks {
  const wanted = sha.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(wanted)) return { quick: null, full: null };
  const lines = text.replace(/\r/g, '').split('\n');
  const noteForThis = findSha(text, lines) === wanted;
  const out: NoteChecks = { quick: null, full: null };
  for (const line of lines) {
    const hit = noteCheckOnLine(line);
    if (!hit) continue;
    const named = shaMention(line, wanted);
    if (named === 'other') continue;
    if (named === 'none' && !noteForThis) continue;
    out[hit.kind] = hit.word;
  }
  return out;
}

type CommandGate = 'GREEN' | 'RED' | 'QUEUED' | 'RUNNING';

/** Latest full-gate command word for this exact SHA, if one was recorded. */
function recordedCommandGate(sha: string): CommandGate | null {
  try {
    const row = getDb().prepare(
      // entity_type first: the (entity_type, entity_id, created_at) index serves this; without it every call scans the events table
      `SELECT payload_json FROM events WHERE entity_type = 'run' AND entity_id = ? AND type = 'pipeline.gate' ORDER BY id DESC LIMIT 1`,
    ).get(`${sha.toLowerCase()}:full`) as { payload_json: string | null } | undefined;
    if (!row?.payload_json) return null;
    const payload = JSON.parse(row.payload_json) as { gate?: string; sha?: string };
    if (payload.sha && payload.sha.toLowerCase() !== sha.toLowerCase()) return null;
    const gate = String(payload.gate ?? '').toUpperCase();
    if (gate === 'GREEN' || gate === 'RED' || gate === 'QUEUED' || gate === 'RUNNING') return gate;
  } catch {
    return null;
  }
  return null;
}

/**
 * Column GREEN only when the note confirms GREEN for this SHA or the latest
 * command event for this SHA is GREEN. Any other command word replaces a
 * stale note GREEN; with no command word the column is null.
 */
function storedFreezeGate(sha: string, noteGate: string | null): string | null {
  const command = recordedCommandGate(sha);
  if ((noteGate ?? '').toUpperCase() === 'GREEN' || command === 'GREEN') return 'GREEN';
  if (command) return command;
  return null;
}

export interface ShaView {
  quick: 'green' | 'red' | 'pending' | 'missing' | 'unconfigured';
  full: 'green' | 'red' | 'pending' | 'missing' | 'unconfigured';
  /** Full-gate word for the card badge. */
  gate: 'GREEN' | 'RED' | null;
}

function readFreezeNote(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

/**
 * Status command wins when it reports this SHA. Otherwise the freeze note, then
 * a latest command event of GREEN for this SHA. A stored column GREEN is not
 * enough once the note was read and does not confirm this SHA.
 */
const VIEW_STALE_OK_MS = 10 * 60_000;

export async function viewShaChecks(freeze: {
  project: string | null;
  sha: string;
  lane: string | null;
  gate: string | null;
  freeze_path?: string | null;
}, runs?: TestRun[], opts: { staleOkMs?: number } = {}): Promise<ShaView> {
  const note = readFreezeNote(freeze.freeze_path);
  const parsed = note != null ? parseNoteChecks(note, freeze.sha) : { quick: null, full: null };
  const configured = !!(freeze.project && testsConfigured(freeze.project));
  // Without runs, a view for a card or a block is served from a report up to ten minutes
  // old: every board request and lane walk asks for these, and each read is an ssh.
  const live = configured
    ? shaChecks(runs ?? await readLaneTests(freeze.project!, freeze.lane ?? '', freeze.sha, { staleOkMs: opts.staleOkMs ?? VIEW_STALE_OK_MS }), freeze.sha, suiteNames(freeze.project))
    : null;
  const sawNote = parsed.quick != null || parsed.full != null;
  const pick = (liveState: 'green' | 'red' | 'pending' | 'missing' | undefined, noteWord: 'green' | 'red' | null): ShaView['quick'] => {
    if (liveState && liveState !== 'missing') return liveState;
    if (noteWord) return noteWord;
    if (!configured && !sawNote) return 'unconfigured';
    return 'missing';
  };
  let full = pick(live?.full, parsed.full);
  let gate: 'GREEN' | 'RED' | null = full === 'green' ? 'GREEN' : full === 'red' ? 'RED' : null;
  // A command GREEN for this SHA counts. A stored column GREEN does not, once
  // the note was read and does not itself confirm this SHA.
  if (full !== 'green' && full !== 'red' && recordedCommandGate(freeze.sha) === 'GREEN') {
    full = 'green';
    gate = 'GREEN';
  }
  const stored = (freeze.gate ?? '').toUpperCase();
  const staleGreen = stored === 'GREEN' && note != null && !parsed.full;
  if (!staleGreen && (full === 'missing' || full === 'unconfigured') && !parsed.full && (stored === 'GREEN' || stored === 'RED') && (!live || live.full === 'missing')) {
    full = stored === 'GREEN' ? 'green' : 'red';
    gate = stored === 'GREEN' ? 'GREEN' : 'RED';
  }
  return { quick: pick(live?.quick, parsed.quick), full, gate };
}

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

  const labels = labelsFromFreezeNote(text, base);
  const project = nameAfter(/\bproject\b\**\s*[:：]\**\s*([A-Za-z][\w-]*)/i, head)
    ?? head.join('\n').match(/\bCountix\s*\/\s*([A-Za-z][\w-]*)/)?.[1] ?? null;
  const noted = sha ? parseNoteChecks(text, sha) : null;
  const gate = noted?.full === 'green' ? 'GREEN' : noted?.full === 'red' ? 'RED' : null;
  const verdictPath = v ? (v.line.match(/(\/[\w.@+-]+(?:\/[\w.@+-]+)*\.(?:md|markdown|txt))/)?.[1] ?? null) : null;

  return {
    kind,
    title,
    sha,
    verdict: v?.verdict ?? null,
    reviewerCandidates,
    authorCandidates,
    project: project ? project.toLowerCase() : null,
    desk: labels.desk,
    lane: labels.lane,
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
  /**
   * Backfill: record the freeze but do not start the pipeline for it. A restart
   * re-reads every note of the day; firing a gate for each flooded the test
   * dispatcher on 25 Oct 2026.
   */
  silent?: boolean;
}

/**
 * Ingest one freeze note or verdict file. Idempotent: the same file delivered
 * twice (or a re-write with the same SHA + verdict + reviewer) changes nothing.
 */
export async function ingestFreezeFile(filePath: string, opts: IngestOptions = {}): Promise<Result<IngestOutcome>> {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return { ok: false, error: `cannot read ${filePath}: ${(e as Error).message}` };
  }
  const result = await ingestFreezeText(text, filePath, opts);
  if (result.ok && !opts.silent) await fireFreeze(result.data.sha);
  return result;
}

export async function ingestFreezeText(text: string, filePath: string, opts: IngestOptions = {}): Promise<Result<IngestOutcome>> {
  const parsed = parseFreezeFile(text, filePath);
  if (!parsed) return { ok: false, error: `${path.basename(filePath)}: not a freeze note or verdict file` };
  if (!parsed.sha) return { ok: false, error: `${path.basename(filePath)}: no exact (40-char) SHA found` };
  const sha = parsed.sha;

  const author = firstAgent(parsed.authorCandidates);
  const reviewer = firstAgent(parsed.reviewerCandidates);
  const reviewerName = reviewer?.name ?? parsed.reviewerCandidates[0] ?? null;
  const project = projectFor(parsed, text);
  const authorLabel = author ?? (parsed.authorCandidates[0] ? { name: parsed.authorCandidates[0] } : null);
  const existingEarly = getFreeze(sha);
  const notes = noteLanes(text.replace(/\r/g, '').split('\n').slice(0, 40));
  const lane = await chooseLane(notes.lane, notes.branch, {
    sha,
    lane: existingEarly?.lane ?? null,
    author_agent_id: author?.id ?? existingEarly?.author_agent_id ?? null,
    run_id: existingEarly?.run_id ?? null,
    freeze_path: filePath,
  });
  if (laneAutomationDenied(project, authorLabel, lane)) {
    return { ok: false, error: `${path.basename(filePath)}: denied lane or agent` };
  }

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

  const existing = existingEarly;
  const enrich: Partial<ReleaseFreeze> = {};
  if (parsed.kind === 'freeze') {
    enrich.freeze_path = filePath;
    if (!existing?.verdict_path && parsed.verdictPath) enrich.verdict_path = parsed.verdictPath;
  } else {
    enrich.verdict_path = filePath;
  }
  if (project && !existing?.project) enrich.project = project;
  if (parsed.desk && !existing?.desk) enrich.desk = parsed.desk;
  if ((existing?.lane ?? null) !== lane) enrich.lane = lane;
  const gateToStore = parsed.kind === 'freeze' ? storedFreezeGate(sha, parsed.gate) : parsed.gate;
  if (parsed.kind === 'freeze') enrich.gate = gateToStore;
  else if (parsed.gate && !existing?.gate) enrich.gate = parsed.gate;
  if (author && !existing?.author_agent_id) { enrich.author_agent_id = author.id; enrich.author_name = author.name; }

  const verdict = parsed.verdict;
  const sameVerdict = existing && verdict && existing.verdict === verdict
    && (existing.reviewer_agent_id ? existing.reviewer_agent_id === (reviewer?.id ?? existing.reviewer_agent_id) : existing.reviewer_name === reviewerName);

  // Decided freezes are final: a re-delivered file must not revive them. A lane behind main is
  // not decided: the merge queue merges main in for it, so its review still lands here.
  if (existing && existing.status !== 'open' && existing.status !== 'stale' && existing.status !== 'behind-main') {
    patch(sha, enrich);
    return { ok: true, data: { sha, effect: 'noop', run_id: existing.run_id } };
  }

  if (!verdict || sameVerdict) {
    if (!existing) {
      getDb().prepare(`INSERT INTO release_freezes (sha, project, desk, lane, author_agent_id, author_name, freeze_path, verdict_path, gate, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`)
        .run(sha, project, parsed.desk, lane, author?.id ?? null, author?.name ?? parsed.authorCandidates[0] ?? null,
          parsed.kind === 'freeze' ? filePath : null, parsed.kind === 'verdict' ? filePath : parsed.verdictPath, gateToStore);
      supersedeOlder(sha, project, lane, parsed.desk);
      await settleBehind(sha, project);
      return { ok: true, data: { sha, effect: 'stored', run_id: null } };
    }
    const changed = Object.keys(enrich).some((k) => (existing as unknown as Record<string, unknown>)[k] !== (enrich as Record<string, unknown>)[k]);
    patch(sha, enrich);
    await settleBehind(sha, project ?? existing.project);
    return { ok: true, data: { sha, effect: changed ? 'updated' : 'noop', run_id: existing.run_id } };
  }

  // A verdict on this SHA — the rules.
  const authorId = author?.id ?? existing?.author_agent_id ?? null;
  const authorName = author?.name ?? existing?.author_name ?? parsed.authorCandidates[0] ?? null;
  if (!reviewer && reviewerName && reviewerName.toLowerCase() === authorName?.toLowerCase()) {
    return { ok: false, error: `${path.basename(filePath)}: self-review refused — ${reviewerName} is the author of ${sha.slice(0, 8)}` };
  }
  if (!authorId) {
    // A freeze whose author is not an agent (a lane WaveCode or a person pushed, author
    // "@wavecode"): there is no seat to hang a review card on, but the verdict still counts for
    // the merge queue, which reads the ledger. Record it and keep the freeze; no synthetic run.
    if (parsed.kind === 'verdict' && reviewerName && existing) {
      recordVerdict({ sha, reviewer, reviewerName, verdict, path: filePath });
      patch(sha, { ...enrich, reviewer_agent_id: reviewer?.id ?? null, reviewer_name: reviewerName, verdict, verdict_path: filePath });
      logger.info({ sha, file: filePath, reviewer: reviewerName, verdict, author: authorName }, 'Verdict recorded for a freeze without an author agent');
      return { ok: true, data: { sha, effect: 'updated', run_id: existing.run_id } };
    }
    return { ok: false, error: `${path.basename(filePath)}: author agent not found (${parsed.authorCandidates.join(', ') || 'none named'})` };
  }
  if (reviewer && reviewer.id === authorId) {
    logger.warn({ sha, file: filePath, reviewer: reviewer.name }, 'Self-review refused: reviewer is the author');
    return { ok: false, error: `${path.basename(filePath)}: self-review refused — @${reviewer.name} is the author of ${sha.slice(0, 8)}` };
  }
  if (parsed.kind === 'verdict' && reviewerName) recordVerdict({ sha, reviewer, reviewerName, verdict, path: filePath });
  if (opts.passOnly && verdict !== 'pass' && !existing?.run_id) {
    // Backfill keeps the queue to what can be promoted; the freeze is still recorded so a later PASS completes it.
    if (existing) {
      patch(sha, enrich);
      await settleBehind(sha, project ?? existing.project);
      return { ok: true, data: { sha, effect: 'noop', run_id: null } };
    }
    getDb().prepare(`INSERT INTO release_freezes (sha, project, desk, lane, author_agent_id, author_name, reviewer_agent_id, reviewer_name, freeze_path, verdict_path, gate, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`)
      .run(sha, project, parsed.desk, lane, authorId, authorName, reviewer?.id ?? null, reviewerName,
        parsed.kind === 'freeze' ? filePath : null, parsed.kind === 'verdict' ? filePath : parsed.verdictPath, gateToStore);
    await settleBehind(sha, project);
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
          (lane ?? existing?.lane) ? `(lane ${lane ?? existing?.lane})` : null,
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
          .run(sha, runId, project, parsed.desk, lane, authorId, authorName, reviewer?.id ?? null, reviewerName, verdict,
            parsed.kind === 'freeze' ? filePath : null, parsed.kind === 'verdict' ? filePath : parsed.verdictPath, gateToStore);
      } else {
        patch(sha, { ...enrich, run_id: runId, author_agent_id: authorId, author_name: authorName, reviewer_agent_id: reviewer?.id ?? null, reviewer_name: reviewerName, verdict });
      }
      const reviewId = ulid();
      const feedback = text.slice(0, FEEDBACK_MAX);
      const issuesFound = countVerdictIssues(feedback);
      getDb().prepare(`INSERT INTO code_reviews (id, run_id, reviewer_type, reviewer_agent_id, reviewer_runtime, status, diff, feedback, issues_found, verdict, fix_round)
        VALUES (?, ?, 'cross-model', ?, ?, 'done', NULL, ?, ?, ?, 0)`)
        .run(reviewId, runId, reviewer?.id ?? null, reviewer?.runtime ?? null, feedback, issuesFound, verdict);
      emit('review.ai_completed', 'run', runId, {
        review_id: reviewId,
        issues_found: issuesFound,
        verdict,
        fix_round: 0,
        reviewer_agent: reviewerName,
        reviewer_agent_id: reviewer?.id ?? null,
        freeze: { sha, project, desk: parsed.desk ?? existing?.desk ?? null, lane: lane ?? existing?.lane ?? null, file: filePath, archive: archivedPath },
      }, null);
    })();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  supersedeOlder(sha, project ?? existing?.project ?? null, lane ?? existing?.lane ?? null, parsed.desk ?? existing?.desk ?? null);
  logger.info({ sha, runId, verdict, reviewer: reviewerName, author: authorName, file: filePath }, 'Release freeze ingested');
  await settleBehind(sha, project ?? existing?.project ?? null);
  if (verdict === 'needs-fixes' && (parsed.gate ?? existing?.gate) === 'GREEN') {
    try { pingReviewersForGreenSha(sha); } catch (e) { logger.debug({ sha, error: (e as Error).message }, 'Gate ping skipped'); }
  }
  return { ok: true, data: { sha, effect, run_id: runId } };
}

/**
 * A freeze file cannot be refused at write time. If the SHA does not contain
 * the project's current main, the card is `behind-main` and the author is
 * told once to merge (not rebase) and refreeze.
 */
async function settleBehind(sha: string, project: string | null): Promise<void> {
  try {
    const n = await commitsBehind(project, sha);
    if (n == null || n <= 0) return;
    const row = getFreeze(sha);
    if (!row || (row.status !== 'open' && row.status !== 'behind-main')) return;
    if (row.status === 'open') patch(sha, { status: 'behind-main' });
    const repo = project ? getConfig().projects?.[project]?.repo : undefined;
    const tip = repo ? await mainTip(repo, project) : null;
    if (!tip || !row.lane) return;
    await pingLaneAboutMain({
      lane: row.lane, project, mainSha: tip.sha, subject: tip.subject,
      authorAgentId: row.author_agent_id, authorName: row.author_name, kind: 'freeze',
    });
  } catch (e) {
    logger.debug({ sha, error: (e as Error).message }, 'behind-main check skipped');
  }
}

/** A newer commit on the same lane invalidates older open freezes (spec rule 3). */
/**
 * A newer commit on the same lane — or a newer freeze for the same desk in the same project
 * (verdict files often carry no lane line, and a desk is one unit of work) — invalidates older
 * open freezes (spec rule 3).
 */
/**
 * A newer freeze supersedes older open ones on the same lane, and desk-only rows
 * (verdicts with no lane line) for the same desk. A freeze on another lane of the
 * same desk is not superseded: several lanes serve one desk, and the merge queue
 * merges each lane on its own evidence (26 Oct 2026: cross-lane desk staleness
 * hid reviewed, green lanes from the queue).
 */
function supersedeOlder(sha: string, project: string | null, lane: string | null, desk: number | null): void {
  if (!lane && desk == null) return;
  const rows = getDb().prepare(
    `SELECT * FROM release_freezes WHERE sha <> ? AND status = 'open' AND (project IS ? OR project = ?)
       AND ((? IS NOT NULL AND lane = ?) OR (? IS NOT NULL AND desk = ? AND (lane IS NULL OR lane = ?)))
       AND created_at <= (SELECT created_at FROM release_freezes WHERE sha = ?)`,
  ).all(sha, project, project, lane, lane, desk, desk, lane, sha) as ReleaseFreeze[];
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
async function refreshMain(repo: string, now: number): Promise<void> {
  const last = fetchedAt.get(repo) ?? 0;
  if (now - last < FETCH_TTL_MS) return;
  fetchedAt.set(repo, now);
  if (!fetchDisabled) {
    try {
      await execFileAsync('git', ['-C', repo, 'fetch', '--quiet', '--prune', 'origin'], { timeout: 30_000 });
    } catch (e) {
      logger.debug({ repo, error: (e as Error).message }, 'Base clone fetch skipped');
    }
  }
  try { await observeRepo(repo); } catch (e) { logger.debug({ repo, error: (e as Error).message }, 'Main tip not observed'); }
}

/** Fetch (unless tests disabled it) and notice a moved main. Used before lane listing. */
export async function refreshProject(project: string, now = Date.now()): Promise<void> {
  await refreshProjectAsync(project, now);
}

/** One fetch per repo per TTL, without blocking the event loop. The review board uses this. */
export async function refreshProjectAsync(project: string, now = Date.now()): Promise<void> {
  const repo = getConfig().projects?.[project]?.repo;
  if (!repo) return;
  const last = fetchedAt.get(repo) ?? 0;
  if (now - last < FETCH_TTL_MS) return;
  fetchedAt.set(repo, now);
  if (!fetchDisabled) {
    try {
      await gitText(repo, ['fetch', '--quiet', '--prune', 'origin'], 30_000);
    } catch (e) {
      logger.debug({ repo, error: (e as Error).message }, 'Base clone fetch skipped');
    }
  }
  try { await observeRepo(repo); } catch (e) { logger.debug({ repo, error: (e as Error).message }, 'Main tip not observed'); }
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
async function candidateRefs(project: string, repo: string, now: number): Promise<Array<{ ref: string; name: string }>> {
  const glob = getConfig().projects?.[project]?.candidate_refs;
  if (!glob) return [];
  const hit = candidateCache.get(repo);
  if (hit && now - hit.at < MERGED_TTL_MS) return hit.refs;
  const re = globToRe(glob);
  const refs: Array<{ ref: string; name: string }> = [];
  try {
    const out = await gitText(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes/origin'], 5000);
    const listed = (out ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
      .map((short) => ({ ref: short, name: short.replace(/^origin\//, '') }))
      .filter((r) => re.test(r.name));
    for (const r of listed) {
      // released candidates are already on main: not "in candidate" any more
      if (await gitAncestor(repo, r.ref, 'origin/main') === true) continue;
      refs.push(r);
    }
  } catch (e) {
    logger.debug({ repo, error: (e as Error).message }, 'Candidate refs unavailable');
  }
  candidateCache.set(repo, { at: now, refs });
  return refs;
}

export interface CandidateRef { ref: string; name: string; tip: string; committed_at: string | null }

/** Unreleased candidate branches of a project with their tip SHA (newest first). */
export async function listCandidates(project: string, now = Date.now()): Promise<CandidateRef[]> {
  const repo = getConfig().projects?.[project]?.repo;
  if (!repo) return [];
  if (!fetchDisabled) await refreshMain(repo, now);
  const out: CandidateRef[] = [];
  for (const c of await candidateRefs(project, repo, now)) {
    let tip = '';
    let committed: string | null = null;
    const log = await gitText(repo, ['log', '-1', '--format=%H %cI', c.ref], 5000);
    if (log) {
      const parts = log.split(' ');
      tip = parts[0] ?? '';
      committed = parts[1] ?? null;
    }
    if (tip) out.push({ ref: c.ref, name: c.name, tip, committed_at: committed });
  }
  return out;
}

/** The newest unreleased candidate that contains `sha`, or null. */
export async function candidateFor(project: string | null, sha: string, now = Date.now()): Promise<{ ref: string; name: string } | null> {
  const repo = project ? getConfig().projects?.[project]?.repo : undefined;
  if (!repo || !project) return null;
  if (!fetchDisabled) await refreshMain(repo, now);
  if (await isOnMain(project, sha, now) === true) return null; // released: on main, not "in candidate"
  for (const c of await candidateRefs(project, repo, now)) {
    if (await gitAncestor(repo, sha, c.ref) === true) return c;
  }
  return null;
}

/** Is `sha` an ancestor of the project's main (per the local base clone)? null = cannot tell. */
export async function isOnMain(project: string | null, sha: string, now = Date.now()): Promise<boolean | null> {
  const repo = project ? getConfig().projects?.[project]?.repo : undefined;
  if (!repo) return null;
  const key = `${repo}:${sha}`;
  const hit = mergedCache.get(key);
  if (hit && now - hit.at < MERGED_TTL_MS) return hit.merged;
  if (!fetchDisabled) await refreshMain(repo, now);
  let merged: boolean | null = null;
  for (const ref of ['origin/main', 'main']) {
    const ancestor = await gitAncestor(repo, sha, ref);
    if (ancestor === true) { merged = true; break; }
    if (ancestor === false) { merged = false; break; } // known commit, not an ancestor
    // null: unknown sha or ref — try the next ref, else unknown
  }
  mergedCache.set(key, { at: now, merged });
  return merged;
}

/**
 * Close freezes whose SHA already sits on main (deployed or merged by other means):
 * status 'merged', the queue card approved, a review.superseded event with superseded_by 'main'.
 */
export async function reconcileMerged(now = Date.now()): Promise<number> {
  let n = await reconcileSuperseded();
  const open = getDb().prepare("SELECT * FROM release_freezes WHERE status IN ('open', 'stale')").all() as ReleaseFreeze[];
  for (const f of open) {
    if (await isOnMain(f.project, f.sha, now) !== true) continue;
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
export async function reconcileSuperseded(): Promise<number> {
  // behind-main freezes are live candidates too (the queue merges them forward); an older one is retired by a newer freeze on its lane like an open one.
  const open = (getDb().prepare("SELECT * FROM release_freezes WHERE status IN ('open', 'behind-main') ORDER BY created_at ASC, rowid ASC").all() as ReleaseFreeze[]);
  const newest = new Map<string, ReleaseFreeze>();
  for (const f of open) {
    if (f.lane) newest.set(`lane:${f.project ?? ''}:${f.lane}`, f);
    if (f.desk != null) newest.set(`desk:${f.project ?? ''}:${f.desk}`, f);
  }
  let n = 0;
  for (const f of open) {
    const byLane = f.lane ? newest.get(`lane:${f.project ?? ''}:${f.lane}`) : undefined;
    // Desk supersession only for rows without a lane: another lane's freeze does not retire this lane's.
    const byDesk = f.desk != null && !f.lane ? newest.get(`desk:${f.project ?? ''}:${f.desk}`) : undefined;
    const winner = byLane && byLane.sha !== f.sha ? byLane : byDesk && byDesk.sha !== f.sha ? byDesk : null;
    if (!winner) continue;
    // The freeze that is the lane's current tip is the live one whatever its created_at (a
    // note written later for an older SHA does not retire it). Retiring it here only to have
    // the lane walk reopen it (syncAttributedLane) was the 26 Oct 2026 storm: ~2000 flips in ten minutes.
    if (f.lane && (await laneHead(f)) === f.sha) continue;
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
async function laneHead(freeze: ReleaseFreeze): Promise<string | null> {
  if (!freeze.lane || !freeze.author_agent_id) return null;
  const agent = getAgent(freeze.author_agent_id);
  if (!agent.ok || !agent.data.workspace || !fs.existsSync(agent.data.workspace)) return null;
  for (const ref of [freeze.lane, `origin/${freeze.lane}`]) {
    const out = await gitText(agent.data.workspace, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], 5000);
    if (out && SHA40.test(out)) return out;
  }
  return null;
}

/**
 * Server-side rules for promoting a freeze card: PASS on the exact SHA
 * (non-PASS needs an admin override reason — the route checks the role),
 * reviewer ≠ author, and the SHA must still be the lane's tip. A stale SHA is
 * refused outright; no override, because that is the one thing the rule is for.
 */
/**
 * The freeze SHA must contain the project's current main. Returns the
 * what's-missing line when it does not, and records `behind-main`.
 */
/** Shown when Stage is refused because the lane moved past this freeze. No admin override. */
export function staleStageMessage(freeze: { sha: string; lane: string | null }, movedTo?: string | null): string {
  const onto = movedTo ? ` to ${movedTo.slice(0, 8)}` : '';
  return `Freeze ${freeze.sha.slice(0, 8)} is stale — lane ${freeze.lane ?? '?'} moved on${onto}; freeze the new SHA`;
}

/**
 * Stage and Promote both refuse a stale SHA, including one whose lane tip has
 * moved since the freeze was written. Marks the row stale. Admins are not exempt.
 */
/**
 * Write the attributed lane onto the row. A stale mark that blamed a different
 * lane is cleared when this lane's tip is still the freeze SHA.
 */
/** `superseded_by` written by resolveQueueShas / resetQueue (merge-queue.ts): a person decided, not a lane walk. */
export function decidedByAdmin(supersededBy: string | null | undefined): boolean {
  return /^(resolved by|queue reset by) /.test(supersededBy ?? '');
}

export async function syncAttributedLane(freeze: ReleaseFreeze, noteText?: string | null): Promise<ReleaseFreeze> {
  const lane = await attributedLane(freeze, noteText);
  let next = freeze;
  if (lane !== freeze.lane) {
    patch(freeze.sha, { lane });
    next = { ...next, lane };
  }
  // A stale mark decided by an admin (bulk resolve, queue reset) is final: the lane walk clears only
  // a mark that blamed a different lane or a newer freeze, when this lane's tip is still the freeze SHA.
  if (next.status === 'stale' && !decidedByAdmin(next.superseded_by)) {
    const head = await laneHead(next);
    if (head && head === next.sha) {
      patch(next.sha, { status: 'open', superseded_by: null });
      next = { ...next, status: 'open', superseded_by: null };
    }
  }
  return next;
}

export async function staleStageBlock(freeze: ReleaseFreeze): Promise<string | null> {
  const judged = await syncAttributedLane(freeze);
  if (judged.status === 'stale') return staleStageMessage(judged, judged.superseded_by);
  const head = await laneHead(judged);
  if (head && head !== judged.sha) {
    patch(judged.sha, { status: 'stale', superseded_by: head });
    if (judged.run_id) emit('review.superseded', 'run', judged.run_id, { sha: judged.sha, superseded_by: head, lane: judged.lane }, null);
    return staleStageMessage(judged, head);
  }
  return null;
}

export async function behindMainBlock(freeze: ReleaseFreeze): Promise<string | null> {
  const counted = await commitsBehind(freeze.project, freeze.sha);
  const n = freeze.status === 'behind-main' ? (counted ?? 0) : counted;
  if (freeze.status !== 'behind-main' && (n == null || n <= 0)) return null;
  if (n != null && n > 0 && freeze.status === 'open') patch(freeze.sha, { status: 'behind-main' });
  if (n != null && n > 0) {
    const repo = projectRepo(freeze.project);
    const tip = repo ? await mainTip(repo, freeze.project) : null;
    if (tip && freeze.lane) {
      await pingLaneAboutMain({
        lane: freeze.lane, project: freeze.project, mainSha: tip.sha, subject: tip.subject,
        authorAgentId: freeze.author_agent_id, authorName: freeze.author_name, kind: 'freeze',
      });
    }
    return behindMainLine(n);
  }
  if (freeze.status === 'behind-main') return 'behind main: merge main';
  return null;
}

/**
 * The SHA must contain the project's current main before a staging or
 * production request is created. A missing freeze row (a composed candidate,
 * or a freeze table that cannot be read) still uses git. Null ancestry does
 * not block: a box with no repo keeps today's behavior.
 */
export async function releaseBehindMain(project: string, sha: string): Promise<string | null> {
  try {
    const freeze = getFreeze(sha);
    if (freeze) {
      const blocked = await behindMainBlock(freeze);
      if (blocked) return blocked;
    }
  } catch { /* freeze table unavailable: the sha check below still runs */ }
  const n = await commitsBehind(project, sha);
  if (n != null && n > 0) return behindMainLine(n);
  return null;
}

export async function checkPromotable(freeze: ReleaseFreeze, opts: { overrideReason?: string | null } = {}): Promise<Result<ReleaseFreeze>> {
  const short = freeze.sha.slice(0, 8);
  if (freeze.status === 'promoted') return { ok: false, error: `Freeze ${short} was already promoted` };
  if (freeze.status === 'rejected') return { ok: false, error: `Freeze ${short} was rejected` };
  const behind = await behindMainBlock(freeze);
  if (behind) return { ok: false, error: `Promotion refused: ${behind}` };
  if (freeze.status === 'stale') {
    return { ok: false, error: `Promotion refused: freeze ${short} is stale — lane ${freeze.lane ?? '?'} moved on to ${freeze.superseded_by?.slice(0, 8) ?? 'a newer commit'}. Freeze and review the new SHA.` };
  }
  const head = await laneHead(freeze);
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
/** In-flight inbox ingests started by onInboxEvent. Tests drain these after the settle timer. */
const inboxInflight = new Set<Promise<void>>();

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

async function ingestIfChanged(file: string, opts: IngestOptions = {}): Promise<void> {
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return;
  }
  if (seen.get(file) === mtime) return;
  seen.set(file, mtime);
  if (isReviewRequestFileName(path.basename(file))) {
    // A request is an action, not a record: the backfill after a restart does not replay it.
    if (!opts.silent) await fireReviewRequest(file);
    return;
  }
  try {
    const r = await ingestFreezeFile(file, opts);
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
export async function backfillFreezes(dirs = freezeInboxDirs(), now = new Date()): Promise<number> {
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
      await ingestIfChanged(file, { passOnly: true, silent: true });
      n++;
    }
  }
  return n;
}

/** One fs.watch event: let the writer finish (SETTLE_MS), then ingest if the file changed since last time. */
export function onInboxEvent(dir: string, filename: string | Buffer | null, settleMs = SETTLE_MS): void {
  if (!filename || typeof filename !== 'string' || !isFreezeFileName(filename)) return;
  const file = path.join(dir, filename);
  const t = setTimeout(() => {
    timers.delete(t);
    const job = ingestIfChanged(file).finally(() => { inboxInflight.delete(job); });
    inboxInflight.add(job);
  }, settleMs);
  timers.add(t);
}

/** Wait for inbox ingests that onInboxEvent has already started. Tests only. */
export async function pendingInboxForTest(): Promise<void> {
  while (inboxInflight.size > 0) await Promise.allSettled([...inboxInflight]);
}

export async function startFreezeWatchers(): Promise<void> {
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
  const imported = await backfillFreezes();
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
