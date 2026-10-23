/**
 * Read-only Fable Queue collector.
 * Captures panes with `tmux -L <socket> capture-pane -p -t <session>` only.
 * It does not type into the pane and never writes.
 * From a maestro brief it keeps only `Expected receipt:` lines.
 * A missing socket or directory is a field on the snapshot.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { getConfig } from './config.js';
import {
  alertsForBot,
  buildPipeline,
  classifyPane,
  expectedReceiptNames,
  pairInbox,
  redactSecrets,
  type AgedName,
  type BriefPair,
  type NamedFile,
  type PaneState,
  type PipelineRow,
  type QueueAlert,
} from './fable-queue-classify.js';
import { resolveFableQueue, type FableBotConfig, type ResolvedFableQueue } from './fable-queue-config.js';
import logger from './logger.js';
import { execFileAsync } from './proc.js';
import { isValidSessionName, isValidSocketName } from './tmux.js';

const CAPTURE_TIMEOUT_MS = 5000;

export interface QueueBot {
  id: string;
  socket: string;
  session: string;
  state: PaneState;
  /** Fixed phrase. Raw tmux stderr is not copied (it can carry local paths). */
  state_error: 'socket unavailable' | 'invalid name' | null;
  inbox_error: 'missing' | 'unavailable' | null;
  outbox_error: 'missing' | 'unavailable' | null;
  briefs: BriefPair[];
  pending: BriefPair[];
  unpaired: BriefPair[];
  current: BriefPair | null;
  newest_receipt: AgedName | null;
  /** Visible pane after secret redaction. Null when the capture failed. */
  capture: string | null;
}

export interface QueueReport {
  collected_at: string | null;
  poll_s: number;
  pending_alert_min: number;
  bots: QueueBot[];
  alerts: QueueAlert[];
  pipeline: PipelineRow[];
  /** Note directories that could not be listed. Their stages stay unknown. */
  notes_unavailable: number;
}

export interface DirList {
  files: NamedFile[];
  error: 'missing' | 'unavailable' | null;
}

export interface QueueDeps {
  now?: () => number;
  capture?: (session: string, socket: string) => Promise<{ ok: true; data: string } | { ok: false; error: string }>;
  listDir?: (dir: string) => Promise<DirList>;
  /** Lines kept from one brief. The default keeps only `Expected receipt:` lines. */
  readExpected?: (filePath: string) => Promise<string[]>;
  config?: ResolvedFableQueue;
}

/** Keep `Expected receipt:` lines. Any other line is dropped before it can be stored. A read error is an empty list. */
export async function readExpectedReceiptLines(filePath: string): Promise<string[]> {
  const kept: string[] = [];
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (expectedReceiptNames([line]).length > 0) kept.push(line.trim());
    }
  } catch {
    return [];
  } finally {
    rl.close();
  }
  return kept;
}

async function expectedByBriefName(
  inboxDir: string,
  files: readonly NamedFile[],
  readExpected: (filePath: string) => Promise<string[]>,
): Promise<Record<string, string[]>> {
  const expected: Record<string, string[]> = {};
  for (const file of files) {
    if (!file.name.startsWith('maestro-to-')) continue;
    try {
      const lines = await readExpected(path.join(inboxDir, file.name));
      expected[file.name] = expectedReceiptNames(lines);
    } catch {
      expected[file.name] = [];
    }
  }
  return expected;
}

let snapshot: QueueReport | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<QueueReport> | null = null;

function resolvedConfig(override?: ResolvedFableQueue): ResolvedFableQueue {
  if (override) return override;
  try {
    return resolveFableQueue(getConfig());
  } catch {
    return resolveFableQueue(undefined);
  }
}

export function emptyReport(cfg: ResolvedFableQueue): QueueReport {
  return {
    collected_at: null,
    poll_s: cfg.pollS,
    pending_alert_min: cfg.pendingAlertMin,
    bots: cfg.bots.map((bot) => ({
      id: bot.id,
      socket: bot.socket,
      session: bot.session,
      state: 'unknown',
      state_error: null,
      inbox_error: null,
      outbox_error: null,
      briefs: [],
      pending: [],
      unpaired: [],
      current: null,
      newest_receipt: null,
      capture: null,
    })),
    alerts: [],
    pipeline: buildPipeline(cfg.cards, [], Date.now()),
    notes_unavailable: 0,
  };
}

/** Last snapshot. Before the first collect, the configured bots with unknown state. */
export function queueSnapshot(): QueueReport {
  return snapshot ?? emptyReport(resolvedConfig());
}

async function listDir(dir: string): Promise<DirList> {
  if (!dir.trim()) return { files: [], error: 'missing' };
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { files: [], error: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unavailable' };
  }
  const files: NamedFile[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    try {
      const st = await fs.promises.stat(path.join(dir, entry.name));
      if (!st.isFile()) continue;
      files.push({ name: entry.name, mtimeMs: st.mtimeMs });
    } catch {
      // A broken symlink or a raced delete is not a directory failure.
    }
  }
  return { files, error: null };
}

async function captureSession(session: string, socket: string): Promise<{ ok: true; data: string } | { ok: false; error: string }> {
  if (!isValidSocketName(socket) || !isValidSessionName(session)) {
    return { ok: false, error: 'invalid name' };
  }
  try {
    const data = await execFileAsync('tmux', ['-L', socket, 'capture-pane', '-p', '-t', session], { timeout: CAPTURE_TIMEOUT_MS });
    return { ok: true, data: redactSecrets(data) };
  } catch {
    return { ok: false, error: 'socket unavailable' };
  }
}

async function inspectBot(
  bot: FableBotConfig,
  nowMs: number,
  deps: QueueDeps,
): Promise<QueueBot & { receipts: NamedFile[] }> {
  const capture = deps.capture ?? captureSession;
  const read = deps.listDir ?? listDir;
  let state: PaneState = 'unknown';
  let stateError: QueueBot['state_error'] = null;
  let captureText: string | null = null;
  try {
    if (!isValidSocketName(bot.socket) || !isValidSessionName(bot.session)) {
      stateError = 'invalid name';
    } else {
      const captured = await capture(bot.session, bot.socket);
      if (!captured.ok) stateError = 'socket unavailable';
      else {
        captureText = redactSecrets(captured.data);
        state = classifyPane(captureText);
      }
    }
  } catch {
    stateError = 'socket unavailable';
  }
  const inbox = await read(bot.inbox);
  const outbox = await read(bot.outbox);
  const expected = await expectedByBriefName(bot.inbox, inbox.files, deps.readExpected ?? readExpectedReceiptLines);
  const paired = pairInbox(inbox.files, outbox.files, nowMs, expected);
  return {
    id: bot.id,
    socket: bot.socket,
    session: bot.session,
    state,
    state_error: stateError,
    inbox_error: inbox.error,
    outbox_error: outbox.error,
    briefs: paired.briefs,
    pending: paired.pending,
    unpaired: paired.unpaired,
    current: paired.current,
    newest_receipt: paired.newest_receipt,
    capture: captureText,
    receipts: outbox.files,
  };
}

async function collectNow(deps: QueueDeps): Promise<QueueReport> {
  try {
    return await collectReport(deps);
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'Fable queue collect failed');
    return snapshot ?? emptyReport(resolvedConfig(deps.config));
  }
}

async function collectReport(deps: QueueDeps): Promise<QueueReport> {
  const cfg = resolvedConfig(deps.config);
  const nowMs = deps.now?.() ?? Date.now();
  const read = deps.listDir ?? listDir;
  const bots = [];
  for (const bot of cfg.bots) bots.push(await inspectBot(bot, nowMs, deps));
  const noteFiles: NamedFile[] = [];
  let notesUnavailable = 0;
  for (const dir of cfg.noteDirs) {
    const listed = await read(dir);
    if (listed.error) notesUnavailable += 1;
    else noteFiles.push(...listed.files);
  }
  const evidence = [...noteFiles, ...bots.flatMap((bot) => bot.receipts)];
  const publicBots: QueueBot[] = bots.map(({ receipts: _receipts, ...bot }) => bot);
  const report: QueueReport = {
    collected_at: new Date(nowMs).toISOString(),
    poll_s: cfg.pollS,
    pending_alert_min: cfg.pendingAlertMin,
    bots: publicBots,
    alerts: publicBots.flatMap((bot) => alertsForBot(bot.id, bot.state, bot.pending, cfg.pendingAlertS)),
    pipeline: buildPipeline(cfg.cards, evidence, nowMs),
    notes_unavailable: notesUnavailable,
  };
  snapshot = report;
  return report;
}

function usesTestDeps(deps: QueueDeps): boolean {
  return Boolean(deps.capture || deps.listDir || deps.config || deps.now || deps.readExpected);
}

export function collectOnce(deps: QueueDeps = {}): Promise<QueueReport> {
  if (!usesTestDeps(deps) && inflight) return inflight;
  const run = collectNow(deps).finally(() => {
    if (inflight === run) inflight = null;
  });
  if (!usesTestDeps(deps)) inflight = run;
  return run;
}

export function startFableQueue(): void {
  if (timer) return;
  const ms = resolvedConfig().pollS * 1000;
  void collectOnce();
  timer = setInterval(() => { void collectOnce(); }, ms);
  timer.unref?.();
}

export function stopFableQueue(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function resetFableQueueForTest(): void {
  stopFableQueue();
  snapshot = null;
  inflight = null;
}
