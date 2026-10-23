/**
 * Pure classifiers for the Fable Queue monitor.
 * Filenames and mtimes only — callers must not pass file bodies.
 */

export type PaneState = 'working' | 'idle' | 'waiting_input' | 'queued' | 'unknown';

export const PIPELINE_STAGES = ['freeze', 'review', 'staged', 'GO-ready', 'live'] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

const FOOTER_LINES = 12;
const WORKING_RE = /esc to interrupt/i;
const QUEUED_RE = /\b\d+\s+messages?\s+queued\b|\bmessages?\s+queued\b|\bqueued\s+messages?\b|\(\s*(?:\d+\s+)?queued\s*\)/i;
const WAITING_RE = /\by\s*\/\s*n\b|\bdo you want to\b/i;
const EMPTY_PROMPT_RE = /^[❯›>]$/;

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Claude Code footer, last lines only (older scrollback is not the current state).
 * A permission or y/n prompt is waiting_input. `esc to interrupt` is working,
 * even when a queued hint shares the footer. A queued-message hint without that
 * is queued. A bare prompt is idle. Anything else is unknown.
 */
export function classifyPane(text: string): PaneState {
  const lines = stripAnsi(text).split(/\r?\n/).slice(-FOOTER_LINES);
  const footer = lines.join('\n');
  if (WAITING_RE.test(footer)) return 'waiting_input';
  if (WORKING_RE.test(footer)) return 'working';
  if (QUEUED_RE.test(footer)) return 'queued';
  const last = [...lines].reverse().find((line) => line.trim().length > 0)?.trim() ?? '';
  if (EMPTY_PROMPT_RE.test(last)) return 'idle';
  return 'unknown';
}

export interface NamedFile {
  name: string;
  mtimeMs: number;
}

export interface AgedName {
  name: string;
  age_s: number;
  /** Set on a brief that no receipt paired with. Never set on the newest receipt. */
  status?: 'unmatched';
}

export function fileStem(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  return base.replace(/\.[^.]+$/, '');
}

/** Strip token, key, and password values. The placeholder is not itself a secret. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
}

const SLUG_STOP = new Set([
  'fable', 'fable2', 'fable3', 'fable4', 'fable5',
  'brief', 'receipt', 'inbox', 'outbox', 'note', 'notes', 'done', 'from',
  'freeze', 'verdict', 'staged', 'review', 'ready', 'live', 'production', 'staging',
]);

function isDateToken(token: string): boolean {
  return /^20\d{2}$/.test(token) || /^20\d{6}$/.test(token) || /^20\d{12}$/.test(token);
}

/** Ids embedded in a filename: `#145`/`145`, `ENG-5`, `B1`. Dates are not ids. */
export function embeddedIds(name: string): Set<string> {
  const stem = fileStem(name).replace(/\b20\d{2}-\d{2}-\d{2}\b/g, ' ');
  const ids = new Set<string>();
  for (const match of stem.matchAll(/#(\d+)/g)) ids.add(match[1]);
  for (const match of stem.matchAll(/\b([A-Z]{2,}-\d+)\b/g)) ids.add(match[1]);
  for (const match of stem.matchAll(/(?:^|[^A-Za-z0-9])([A-Z]\d+)(?=[^A-Za-z0-9]|$)/g)) ids.add(match[1]);
  for (const match of stem.matchAll(/(?:^|[^A-Za-z0-9])(\d{2,})(?=[^A-Za-z0-9]|$)/g)) ids.add(match[1]);
  return ids;
}

/** Brief ids: `#145`, `ENG-5`, `B1`, and a bounded number that is not a date. */
export function briefIds(name: string): Set<string> {
  const stem = fileStem(name);
  const ids = new Set<string>();
  for (const match of stem.matchAll(/#(\d+)/g)) ids.add(match[1]);
  for (const match of stem.matchAll(/\b([A-Z]{2,}-\d+)\b/g)) ids.add(match[1].toUpperCase());
  for (const match of stem.matchAll(/(?:^|[^A-Za-z0-9])([A-Z]\d+)(?=[^A-Za-z0-9]|$)/g)) ids.add(match[1].toUpperCase());
  for (const match of stem.matchAll(/(?:^|[^A-Za-z0-9])(\d{2,})(?=[^A-Za-z0-9]|$)/g)) {
    if (!isDateToken(match[1])) ids.add(match[1]);
  }
  return ids;
}

/** Slug words such as `prodw` and `roles`. Dates, bot names, and stage words are not slugs. */
export function slugTokens(name: string): Set<string> {
  const tokens = fileStem(name).toLowerCase().split(/[^a-z0-9]+/);
  return new Set(tokens.filter((token) => token.length >= 4 && !SLUG_STOP.has(token) && !isDateToken(token) && !/^\d+$/.test(token)));
}

export type PairReason = 'basename' | 'id' | 'slug';

/**
 * Exact basename first, then a shared brief id, then a shared slug token.
 * A date or the word `fable` is not a match.
 */
export function pairReason(brief: string, receipt: string): PairReason | null {
  if (fileStem(brief) === fileStem(receipt)) return 'basename';
  const receiptIds = briefIds(receipt);
  for (const id of briefIds(brief)) {
    if (receiptIds.has(id)) return 'id';
  }
  const receiptSlugs = slugTokens(receipt);
  for (const token of slugTokens(brief)) {
    if (receiptSlugs.has(token)) return 'slug';
  }
  return null;
}

export function receiptMatchesBrief(brief: string, receipt: string): boolean {
  return pairReason(brief, receipt) !== null;
}

function ageSeconds(mtimeMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - mtimeMs) / 1000));
}

export interface Pairing {
  /** Briefs with no paired receipt. Each one is unmatched — a receipt was not guessed. */
  pending: AgedName[];
  unmatched: AgedName[];
  /** Oldest unmatched brief. Null when every brief paired. */
  current: AgedName | null;
  /** Newest outbox file, whether or not it pairs with a brief. */
  newest_receipt: AgedName | null;
}

/** A brief with no basename, id, or slug match stays unmatched. The newest receipt is always listed. */
export function pairInbox(inbox: readonly NamedFile[], outbox: readonly NamedFile[], nowMs: number): Pairing {
  const unmatched = inbox
    .filter((brief) => !outbox.some((receipt) => receiptMatchesBrief(brief.name, receipt.name)))
    .slice()
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
    .map((file) => ({ name: file.name, age_s: ageSeconds(file.mtimeMs, nowMs), status: 'unmatched' as const }));
  const newest = outbox.slice().sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))[0] ?? null;
  return {
    pending: unmatched,
    unmatched,
    current: unmatched[0] ?? null,
    newest_receipt: newest ? { name: newest.name, age_s: ageSeconds(newest.mtimeMs, nowMs) } : null,
  };
}

export type QueueAlert =
  | { kind: 'pending_too_long'; bot: string; name: string; age_s: number }
  | { kind: 'idle_with_pending'; bot: string; pending: number };

export function alertsForBot(
  bot: string,
  state: PaneState,
  pending: readonly AgedName[],
  pendingAlertS: number,
): QueueAlert[] {
  const alerts: QueueAlert[] = [];
  for (const brief of pending) {
    if (brief.age_s > pendingAlertS) {
      alerts.push({ kind: 'pending_too_long', bot, name: brief.name, age_s: brief.age_s });
    }
  }
  if (state === 'idle' && pending.length > 0) {
    alerts.push({ kind: 'idle_with_pending', bot, pending: pending.length });
  }
  return alerts;
}

/** Stages a filename explicitly names. A name that names none is not a stage. */
export function stagesNamedIn(name: string): PipelineStage[] {
  const stem = fileStem(name).toLowerCase();
  const stages: PipelineStage[] = [];
  if (/freeze/.test(stem)) stages.push('freeze');
  if (/verdict|code-review|review-result/.test(stem)) stages.push('review');
  if (/staged|on-staging/.test(stem)) stages.push('staged');
  if (/go-ready|ready-for-prod|ready_for_prod/.test(stem)) stages.push('GO-ready');
  if (/(?:^|[^a-z])live(?:[^a-z]|$)|on-prod|in-prod|production/.test(stem)) stages.push('live');
  return stages;
}

export function filenameMatchesCard(card: string, filename: string): boolean {
  const cardIds = embeddedIds(card);
  const fileIds = embeddedIds(filename);
  for (const id of cardIds) {
    if (fileIds.has(id)) return true;
  }
  return false;
}

export type StageCell =
  | { status: 'unknown' }
  | { status: 'seen'; name: string; age_s: number };

export interface PipelineRow {
  card: string;
  stages: Record<PipelineStage, StageCell>;
}

/**
 * Each stage is evidenced only by a file that names that stage and the card.
 * A later stage is never filled in because an earlier one exists.
 */
export function buildPipeline(cards: readonly string[], files: readonly NamedFile[], nowMs: number): PipelineRow[] {
  return cards.map((card) => {
    const stages = {} as Record<PipelineStage, StageCell>;
    for (const stage of PIPELINE_STAGES) {
      const hits = files.filter((file) => filenameMatchesCard(card, file.name) && stagesNamedIn(file.name).includes(stage));
      if (hits.length === 0) {
        stages[stage] = { status: 'unknown' };
        continue;
      }
      hits.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
      const top = hits[0];
      stages[stage] = { status: 'seen', name: top.name, age_s: ageSeconds(top.mtimeMs, nowMs) };
    }
    return { card, stages };
  });
}
