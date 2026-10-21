/**
 * Safe tmux command execution layer.
 *
 * All tmux interactions go through this module. Uses execFile with
 * argument arrays to eliminate shell injection vulnerabilities entirely.
 * No shell is spawned — arguments are passed directly to the tmux binary.
 * Calls share a concurrency limit so a burst of captures cannot pile up
 * on the event loop. Sleeps are timers, never Atomics.wait.
 */

import type { Result } from './db.js';
import logger from './logger.js';
import { delay, execFileAsync } from './proc.js';

const TMUX_TIMEOUT = 5000;
/** How many tmux processes may run at once. The rest wait on the loop. */
export const TMUX_CONCURRENCY = 4;

let tmuxInflight = 0;
const tmuxWaiters: Array<() => void> = [];

function acquireTmux(): Promise<void> {
  if (tmuxInflight < TMUX_CONCURRENCY) {
    tmuxInflight += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    tmuxWaiters.push(() => {
      tmuxInflight += 1;
      resolve();
    });
  });
}

function releaseTmux(): void {
  tmuxInflight = Math.max(0, tmuxInflight - 1);
  const next = tmuxWaiters.shift();
  if (next) next();
}

async function runTmux(args: string[], opts: { timeout?: number; input?: string } = {}): Promise<string> {
  await acquireTmux();
  try {
    return await execFileAsync('tmux', args, { timeout: opts.timeout ?? TMUX_TIMEOUT, input: opts.input });
  } finally {
    releaseTmux();
  }
}

// --- Allowed raw key names for sendRawKeys ---

const ALLOWED_RAW_KEYS = new Set([
  'C-c', 'C-d', 'C-u', 'C-l', 'C-z', 'C-m', 'C-a', 'C-e', 'C-k', 'C-w',
  'Escape', 'Enter', 'Tab', 'BSpace', 'DC', 'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown', 'Space',
  'q', // leave a Codex lock screen ("open in another app"): the relaunch then resumes the right thread
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  // y/n for CLI confirmation prompts
  'y', 'n', 'Y', 'N',
]);

/**
 * Validate a raw key name against the allowlist.
 * Prevents arbitrary string injection via the raw keys endpoint.
 */
export function isAllowedRawKey(key: string): boolean {
  return ALLOWED_RAW_KEYS.has(key);
}

/**
 * Validate a tmux session name.
 * Session names should be alphanumeric with hyphens/underscores/dots.
 */
export function isValidSessionName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name.length > 0 && name.length <= 256;
}

/** tmux socket names (`-L`) use the same safe character set as session names. */
export function isValidSocketName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name) && name.length > 0 && name.length <= 64;
}

/** Session name → tmux server socket. Unset means the default server (no `-L`). */
const sessionSockets = new Map<string, string>();

export function bindSessionSocket(sessionName: string, socket: string | null | undefined): void {
  const name = socket?.trim() || '';
  if (!name) sessionSockets.delete(sessionName);
  else sessionSockets.set(sessionName, name);
}

export function resetTmuxSocketsForTest(): void {
  sessionSockets.clear();
}

function socketPrefix(sessionName: string | null): string[] {
  if (!sessionName) return [];
  const socket = sessionSockets.get(sessionName);
  return socket ? ['-L', socket] : [];
}

function sessionFromArgs(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-t' || args[i] === '-s') && args[i + 1] && !args[i + 1].startsWith('-')) {
      return args[i + 1].split(':')[0];
    }
  }
  return null;
}

// --- Core tmux operations ---

/**
 * Execute a tmux command with argument array (no shell).
 * Returns stdout on success.
 */
export async function tmuxExec(args: string[], timeout = TMUX_TIMEOUT): Promise<string> {
  const full = [...socketPrefix(sessionFromArgs(args)), ...args];
  return runTmux(full, { timeout });
}

/**
 * Execute a tmux command, returning null on failure instead of throwing.
 */
export async function tmuxExecSafe(args: string[], timeout = TMUX_TIMEOUT): Promise<string | null> {
  try {
    return await tmuxExec(args, timeout);
  } catch {
    return null;
  }
}

// --- Session operations ---

export async function hasSession(sessionName: string): Promise<boolean> {
  return (await tmuxExecSafe(['has-session', '-t', sessionName])) !== null;
}

export async function listSessions(socket?: string | null): Promise<Result<Array<{ name: string; created: number; lastActivity: number }>>> {
  try {
    const prefix = socket?.trim() ? ['-L', socket.trim()] : [];
    const output = (await runTmux([
      ...prefix,
      'list-sessions', '-F', '#{session_name}:#{session_created}:#{session_activity}',
    ])).trim();

    if (!output) return { ok: true, data: [] };

    const sessions = output.split('\n').map((line) => {
      const parts = line.split(':');
      // Session names can contain colons — only the last two fields are numeric
      const activity = parseInt(parts.pop()!, 10);
      const created = parseInt(parts.pop()!, 10);
      const name = parts.join(':');
      return { name, created, lastActivity: activity };
    });

    return { ok: true, data: sessions };
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes('no server running') || msg.includes('no sessions')) {
      return { ok: true, data: [] };
    }
    return { ok: false, error: msg };
  }
}

// 140 columns: wide enough that prompts and tables do not wrap (reply capture),
// narrow enough that Claude Code's TUI stays single-column — at ≥ ~160 cols it
// opens a "changes" side panel that halves the readable width in the captured output.
export const SPAWN_COLS = 140;
export const SPAWN_ROWS = 80;

export async function newSession(sessionName: string, workDir: string, command?: string): Promise<void> {
  // Always create with a shell first — if a command is passed directly to
  // new-session and it exits (even on error), tmux destroys the session
  // immediately, making failures invisible. Instead we create a shell session
  // and then send the command as keystrokes so the session survives errors.
  // A detached session defaults to 80x24. TUIs run on the alternate screen
  // (no scrollback), so the visible window is all capture-pane ever sees —
  // give spawned sessions a tall, wide virtual terminal so long answers and
  // the prompt echo stay on screen together.
  const args = ['new-session', '-d', '-s', sessionName, '-c', workDir, '-x', String(SPAWN_COLS), '-y', String(SPAWN_ROWS)];
  await tmuxExec(args);
  await disableAlternateScreen(sessionName); // the agent page's history depends on scrollback

  if (command) {
    // Let the shell initialize without blocking the event loop, then send the command.
    await delay(300);
    await sendTextAndEnter(sessionName, command, { mode: 'type' });
  }
}

export async function killSession(sessionName: string): Promise<void> {
  await tmuxExecSafe(['kill-session', '-t', sessionName]);
}

/**
 * Send literal text to a tmux pane using -l flag (safe, no key interpretation).
 * Text is chunked to avoid tmux's command length limits.
 */
export async function sendLiteralText(sessionName: string, text: string): Promise<void> {
  // Clear readline buffer first
  await tmuxExec(['send-keys', '-t', sessionName, 'C-u']);

  // Chunk to avoid tmux length limits
  const CHUNK_SIZE = 150;
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    const chunk = text.substring(i, i + CHUNK_SIZE);
    // `--` so a chunk that starts with `-` is never parsed as a tmux flag
    await tmuxExec(['send-keys', '-t', sessionName, '-l', '--', chunk]);
  }
}

/**
 * Send a raw tmux key name (C-c, Escape, Enter, etc.).
 * Only allows keys from the ALLOWED_RAW_KEYS set.
 */
export function sendRawKey(sessionName: string, key: string): Promise<void> {
  if (!isAllowedRawKey(key)) {
    throw new Error(`Disallowed raw key: ${key}`);
  }
  return enqueueSession(sessionName, () => tmuxExec(['send-keys', '-t', sessionName, key]));
}

export type SendMode = 'paste' | 'type';

export interface SendOptions {
  /**
   * 'paste' (default): the whole text goes in as one bracketed paste
   * (load-buffer + paste-buffer -p). Enter is a separate send-keys after ~1 s.
   * The pane is then captured; if the input line still holds the text, Enter
   * is pressed again, up to 2 retries. A line that is still sitting there is
   * logged. Claude Code / Codex sometimes swallow an Enter that arrives right
   * behind the paste, leaving the message unsent in the box.
   * 'type': 150-char send-keys -l chunks, then Enter as its own send-keys
   * after 300 ms, with the same capture-and-retry. For shell prompts.
   */
  mode?: SendMode;
}

const PASTE_ENTER_DELAY_MS = 1000;
const PASTE_CONFIRM_DELAY_MS = 900;
const TYPE_ENTER_DELAY_MS = 300;
/** Extra Enters after the first one, when the input line still shows the text. */
const MAX_ENTER_RETRIES = 2;
/** Pending send per session so two messages never interleave inside one input box. */
const sendChains = new Map<string, Promise<void>>();
/** Paste buffer names are server-global, so each call needs its own. */
let pasteBufferSeq = 0;

/**
 * Serialize pane mutations for one session. A rejection does not stick the
 * chain; the derived finally promise is caught so it cannot crash the daemon.
 */
function enqueueSession(sessionName: string, job: () => Promise<unknown>): Promise<void> {
  const prev = sendChains.get(sessionName);
  const next = (prev ? prev.catch(() => undefined).then(job) : job()).then(() => undefined);
  sendChains.set(sessionName, next);
  void next.finally(() => {
    if (sendChains.get(sessionName) === next) sendChains.delete(sessionName);
  }).catch(() => undefined);
  return next;
}

function pasteBufferName(sessionName: string): string {
  pasteBufferSeq += 1;
  const session = sessionName.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 's';
  const rand = Math.random().toString(36).slice(2, 10).padEnd(6, '0');
  return `wc-${session}-${pasteBufferSeq}-${rand}`;
}

/** Exported for tests: timers are real setTimeouts, tests use fake timers. */
export function sendTextAndEnter(sessionName: string, text: string, opts: SendOptions = {}): Promise<void> {
  const mode = opts.mode ?? 'paste';
  // A send that arrives while a previous one is still waiting for its Enter is
  // chained behind it so the two never share an input box. Raw keys (watcher
  // dismiss) join the same chain.
  return enqueueSession(sessionName, () => (mode === 'type' ? typeAndSubmit(sessionName, text) : pasteAndSubmit(sessionName, text)));
}

async function typeAndSubmit(sessionName: string, text: string): Promise<void> {
  await sendLiteralText(sessionName, text);
  await delay(TYPE_ENTER_DELAY_MS);
  await tmuxExec(['send-keys', '-t', sessionName, 'C-m']);
  await confirmOrRetry(sessionName, text, 0);
}

async function pasteAndSubmit(sessionName: string, text: string): Promise<void> {
  // Clear whatever is in the input box, then one atomic bracketed paste.
  // Enter is never in this argv: it is a later send-keys, after the TUI has the text.
  await tmuxExec(['send-keys', '-t', sessionName, 'C-u']);
  const buf = pasteBufferName(sessionName);
  await runTmux([...socketPrefix(sessionName), 'load-buffer', '-b', buf, '-'], { input: text });
  await tmuxExec(['paste-buffer', '-p', '-d', '-b', buf, '-t', sessionName]);
  await delay(PASTE_ENTER_DELAY_MS);
  await tmuxExecSafe(['send-keys', '-t', sessionName, 'C-m']);
  await confirmOrRetry(sessionName, text, 0);
}

/** Capture the pane. If the text is still on the input line, press Enter again (up to 2 retries). */
async function confirmOrRetry(sessionName: string, text: string, retriesUsed: number): Promise<void> {
  await delay(PASTE_CONFIRM_DELAY_MS);
  if (!(await inputStillHolds(sessionName, text))) return;
  if (retriesUsed < MAX_ENTER_RETRIES) {
    await tmuxExecSafe(['send-keys', '-t', sessionName, 'C-m']);
    await confirmOrRetry(sessionName, text, retriesUsed + 1);
    return;
  }
  logger.error(
    { session: sessionName, preview: text.slice(0, 80) },
    'typed notification still on the input line after Enter retries',
  );
}

/** The TUI's input line (❯ / ›) still shows the start of the text → the Enter was swallowed. */
export async function inputStillHolds(sessionName: string, text: string): Promise<boolean> {
  const pane = await tmuxExecSafe(['capture-pane', '-t', sessionName, '-p', '-S', '-15']);
  if (pane === null) return false;
  return paneInputHolds(pane, text);
}

/** Exported for tests. */
export function paneInputHolds(pane: string, text: string): boolean {
  const head = text.replace(/\s+/g, ' ').trim().slice(0, 24);
  if (head.length < 4) return false;
  const lines = pane.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
    const m = /^\s*[❯›]\s?(.*)$/.exec(lines[i]);
    if (m) return m[1].replace(/\s+/g, ' ').trim().startsWith(head);
  }
  return false;
}

/**
 * Capture pane output (plain text, no ANSI).
 */
/** Like capturePane, but wrapped lines are joined back (`-J`) — for URLs and codes the pane wrapped. */
export async function capturePaneJoined(sessionName: string, lines = 50): Promise<Result<string>> {
  try {
    return { ok: true, data: await tmuxExec(['capture-pane', '-t', sessionName, '-p', '-J', '-S', `-${lines}`]) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function capturePane(sessionName: string, lines = 50): Promise<Result<string>> {
  try {
    const output = await tmuxExec(['capture-pane', '-t', sessionName, '-p', '-S', `-${lines}`]);
    return { ok: true, data: output };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Capture pane output with ANSI escape sequences preserved.
 */
export async function capturePaneAnsi(sessionName: string, lines = 50): Promise<Result<string>> {
  try {
    const output = await tmuxExec(['capture-pane', '-t', sessionName, '-p', '-e', '-S', `-${lines}`]);
    return { ok: true, data: output };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Scrollback kept per pane once the daemon has set its tmux defaults. */
export const AGENT_HISTORY_LIMIT = 20000;

/**
 * tmux defaults for agent panes. Claude Code and Codex draw on the alternate
 * screen, which tmux keeps no scrollback for: the agent page could only ever
 * show the visible rows. With the alternate screen off they draw on the
 * normal screen and what scrolls off the top becomes history (history-limit
 * applies to panes created afterwards; a running TUI takes the screen change
 * on its next launch). Best effort: no tmux server yet is not an error.
 */
export async function applyAgentPaneDefaults(): Promise<void> {
  await tmuxExecSafe(['set-option', '-g', 'history-limit', String(AGENT_HISTORY_LIMIT)]);
  await tmuxExecSafe(['set-option', '-gw', 'alternate-screen', 'off']);
  // windows that already exist carry their own copy of the option: set it on each agent window too
  const listed = await tmuxExecSafe(['list-windows', '-a', '-F', '#{session_name}:#{window_index}']);
  for (const target of (listed ?? '').split('\n').map((l) => l.trim()).filter((l) => /^wc-/.test(l))) {
    await tmuxExecSafe(['set-option', '-w', '-t', target, 'alternate-screen', 'off']);
  }
}

/**
 * Replace the pane's process with a fresh pane at a shell prompt (same session
 * and window). A pane stuck on the alternate screen starts clean this way.
 */
export async function respawnPane(sessionName: string): Promise<boolean> {
  return (await tmuxExecSafe(['respawn-pane', '-k', '-t', sessionName])) !== null;
}

/** A new agent session: the window keeps scrollback (no alternate screen). Called right after new-session. */
export async function disableAlternateScreen(sessionName: string): Promise<void> {
  await tmuxExecSafe(['set-option', '-w', '-t', sessionName, 'alternate-screen', 'off']);
}

/**
 * The pane in two captures: the last `historyLines` of frozen history above
 * the visible screen (tmux lines -N..-1) and the visible screen (0..rows-1).
 */
export async function capturePaneSplit(sessionName: string, historyLines = 400): Promise<Result<{ history: string; screen: string; history_size: number; rows: number }>> {
  try {
    const meta = (await tmuxExec(['display-message', '-t', sessionName, '-p', '#{history_size} #{pane_height}'])).trim().split(/\s+/);
    const historySize = parseInt(meta[0] ?? '0', 10) || 0;
    const rows = parseInt(meta[1] ?? '0', 10) || 0;
    const n = Math.min(historyLines, historySize);
    const history = n > 0 ? await tmuxExec(['capture-pane', '-t', sessionName, '-p', '-e', '-S', `-${n}`, '-E', '-1']) : '';
    const screen = await tmuxExec(['capture-pane', '-t', sessionName, '-p', '-e', '-S', '0', '-E', String(Math.max(0, rows - 1))]);
    return { ok: true, data: { history, screen, history_size: historySize, rows } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Capture a range of scrollback lines with ANSI.
 */
export async function capturePaneRange(sessionName: string, start: number, end: number): Promise<Result<string>> {
  try {
    const output = await tmuxExec([
      'capture-pane', '-t', sessionName, '-p', '-e',
      '-S', String(start), '-E', String(end),
    ]);
    return { ok: true, data: output };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Get scrollback history size.
 */
export async function getScrollbackSize(sessionName: string): Promise<Result<number>> {
  try {
    const output = (await tmuxExec([
      'display-message', '-t', sessionName, '-p', '#{history_size}',
    ])).trim();
    return { ok: true, data: parseInt(output, 10) || 0 };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Get the current working directory of a tmux pane.
 */
export async function getPaneDir(sessionName: string): Promise<string | null> {
  const output = await tmuxExecSafe([
    'display-message', '-t', sessionName, '-p', '#{pane_current_path}',
  ]);
  return output?.trim() || null;
}
