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
}

export interface ReceiptCheck {
  name: string;
  status: 'present' | 'missing';
}

export interface BriefPair extends AgedName {
  /** `done` only when every Expected receipt exists. `unpaired` means neither rule matched. */
  status: 'done' | 'pending' | 'paired' | 'unpaired';
  match: 'exact' | 'fallback' | 'unpaired';
  expected?: ReceiptCheck[];
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

const BRIEF_NAME_RE = /^maestro-to-(fable\d*)-(.+)-(\d{4})$/i;
const RECEIPT_NAME_RE = /^(fable\d*)-(.+)-(\d{8})$/i;
const EXPECTED_RECEIPT_RE = /^\s*Expected receipt:\s*(\S+)\s*$/;

export interface TopicName {
  bot: string;
  /** Topic between the bot and the time or date suffix. */
  topic: string;
  tokens: string[];
}

function topicTokens(topic: string): string[] {
  return topic.split(/[^A-Za-z0-9]+/).filter(Boolean).map((token) => token.toLowerCase());
}

/** `maestro-to-fable4-onboard-1644.md` → bot `fable4`, topic `onboard`. The HHMM suffix is dropped. */
export function parseBriefName(name: string): TopicName | null {
  const match = BRIEF_NAME_RE.exec(fileStem(name));
  if (!match) return null;
  return { bot: match[1].toLowerCase(), topic: match[2], tokens: topicTokens(match[2]) };
}

/** `fable-prodw-roles-20261023.md` → bot `fable`, topic `prodw-roles`. The YYYYMMDD suffix is dropped. */
export function parseReceiptName(name: string): TopicName | null {
  const match = RECEIPT_NAME_RE.exec(fileStem(name));
  if (!match) return null;
  return { bot: match[1].toLowerCase(), topic: match[2], tokens: topicTokens(match[2]) };
}

/**
 * Basenames named by `Expected receipt:` lines. Every other line is ignored,
 * so a caller that already dropped non-matching lines cannot leak them here either.
 */
export function expectedReceiptNames(lines: readonly string[]): string[] {
  const names: string[] = [];
  for (const line of lines) {
    const match = EXPECTED_RECEIPT_RE.exec(line);
    if (!match) continue;
    names.push(match[1].split(/[/\\]/).pop() ?? match[1]);
  }
  return names;
}

/** Same bot and a shared topic token (a card number or a keyword). Time and date suffixes are not tokens. */
export function fallbackMatch(briefName: string, receiptName: string): boolean {
  const brief = parseBriefName(briefName);
  const receipt = parseReceiptName(receiptName);
  if (!brief || !receipt || brief.bot !== receipt.bot) return false;
  const receiptTokens = new Set(receipt.tokens);
  return brief.tokens.some((token) => receiptTokens.has(token));
}

function ageSeconds(mtimeMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - mtimeMs) / 1000));
}

export interface Pairing {
  briefs: BriefPair[];
  /** Not done: an exact list with a missing receipt, or an unpaired brief. */
  pending: BriefPair[];
  unpaired: BriefPair[];
  /** Oldest brief that is not done. */
  current: BriefPair | null;
  /** Newest outbox file, whether or not it pairs with a brief. */
  newest_receipt: AgedName | null;
}

function expectedOf(expectedByBrief: Readonly<Record<string, readonly string[]>> | undefined, name: string): readonly string[] {
  return expectedByBrief?.[name] ?? [];
}

/**
 * Expected-receipt lines win. Otherwise the same bot plus a shared topic token.
 * Anything else is unpaired — a shared date or a different bot is not a match.
 */
export function pairInbox(
  inbox: readonly NamedFile[],
  outbox: readonly NamedFile[],
  nowMs: number,
  expectedByBrief?: Readonly<Record<string, readonly string[]>>,
): Pairing {
  const outboxNames = new Set(outbox.map((file) => file.name));
  const briefs = inbox
    .slice()
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
    .map((file): BriefPair => {
      const age_s = ageSeconds(file.mtimeMs, nowMs);
      const expectedNames = expectedOf(expectedByBrief, file.name);
      if (expectedNames.length > 0) {
        const expected = expectedNames.map((name) => ({
          name,
          status: (outboxNames.has(name) ? 'present' : 'missing') as ReceiptCheck['status'],
        }));
        const done = expected.every((item) => item.status === 'present');
        return { name: file.name, age_s, status: done ? 'done' : 'pending', match: 'exact', expected };
      }
      if (outbox.some((receipt) => fallbackMatch(file.name, receipt.name))) {
        return { name: file.name, age_s, status: 'paired', match: 'fallback' };
      }
      return { name: file.name, age_s, status: 'unpaired', match: 'unpaired' };
    });
  const pending = briefs.filter((brief) => brief.status === 'pending' || brief.status === 'unpaired');
  const newest = outbox.slice().sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))[0] ?? null;
  return {
    briefs,
    pending,
    unpaired: briefs.filter((brief) => brief.status === 'unpaired'),
    current: pending[0] ?? null,
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
