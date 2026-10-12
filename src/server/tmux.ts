/**
 * Safe tmux command execution layer.
 *
 * All tmux interactions go through this module. Uses execFileSync with
 * argument arrays to eliminate shell injection vulnerabilities entirely.
 * No shell is spawned — arguments are passed directly to the tmux binary.
 */

import { execFileSync } from 'node:child_process';
import type { Result } from './db.js';
import logger from './logger.js';

const TMUX_TIMEOUT = 5000;

// --- Allowed raw key names for sendRawKeys ---

const ALLOWED_RAW_KEYS = new Set([
  'C-c', 'C-d', 'C-u', 'C-l', 'C-z', 'C-m', 'C-a', 'C-e', 'C-k', 'C-w',
  'Escape', 'Enter', 'Tab', 'BSpace', 'DC', 'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown', 'Space',
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
export function tmuxExec(args: string[], timeout = TMUX_TIMEOUT): string {
  const full = [...socketPrefix(sessionFromArgs(args)), ...args];
  return execFileSync('tmux', full, {
    encoding: 'utf-8',
    timeout,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Execute a tmux command, returning null on failure instead of throwing.
 */
export function tmuxExecSafe(args: string[], timeout = TMUX_TIMEOUT): string | null {
  try {
    return tmuxExec(args, timeout);
  } catch {
    return null;
  }
}

// --- Session operations ---

export function hasSession(sessionName: string): boolean {
  return tmuxExecSafe(['has-session', '-t', sessionName]) !== null;
}

export function listSessions(socket?: string | null): Result<Array<{ name: string; created: number; lastActivity: number }>> {
  try {
    const prefix = socket?.trim() ? ['-L', socket.trim()] : [];
    const output = execFileSync('tmux', [
      ...prefix,
      'list-sessions', '-F', '#{session_name}:#{session_created}:#{session_activity}',
    ], {
      encoding: 'utf-8',
      timeout: TMUX_TIMEOUT,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

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

export function newSession(sessionName: string, workDir: string, command?: string): void {
  // Always create with a shell first — if a command is passed directly to
  // new-session and it exits (even on error), tmux destroys the session
  // immediately, making failures invisible. Instead we create a shell session
  // and then send the command as keystrokes so the session survives errors.
  // A detached session defaults to 80x24. TUIs run on the alternate screen
  // (no scrollback), so the visible window is all capture-pane ever sees —
  // give spawned sessions a tall, wide virtual terminal so long answers and
  // the prompt echo stay on screen together.
  const args = ['new-session', '-d', '-s', sessionName, '-c', workDir, '-x', String(SPAWN_COLS), '-y', String(SPAWN_ROWS)];
  tmuxExec(args);

  if (command) {
    // Small delay to let the shell initialize, then send command
    sleepSync(300);
    sendTextAndEnter(sessionName, command, { mode: 'type' });
  }
}

export function killSession(sessionName: string): void {
  tmuxExecSafe(['kill-session', '-t', sessionName]);
}

/**
 * Send literal text to a tmux pane using -l flag (safe, no key interpretation).
 * Text is chunked to avoid tmux's command length limits.
 */
export function sendLiteralText(sessionName: string, text: string): void {
  // Clear readline buffer first
  tmuxExec(['send-keys', '-t', sessionName, 'C-u']);

  // Chunk to avoid tmux length limits
  const CHUNK_SIZE = 150;
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    const chunk = text.substring(i, i + CHUNK_SIZE);
    // `--` so a chunk that starts with `-` is never parsed as a tmux flag
    tmuxExec(['send-keys', '-t', sessionName, '-l', '--', chunk]);
  }
}

/**
 * Send a raw tmux key name (C-c, Escape, Enter, etc.).
 * Only allows keys from the ALLOWED_RAW_KEYS set.
 */
export function sendRawKey(sessionName: string, key: string): void {
  if (!isAllowedRawKey(key)) {
    throw new Error(`Disallowed raw key: ${key}`);
  }
  tmuxExec(['send-keys', '-t', sessionName, key]);
}

/**
 * Send literal text followed by C-m (Enter).
 * This is the primary way to send commands/prompts to agents.
 */
/**
 * Synchronous sleep without spawning a process.
 * Uses SharedArrayBuffer + Atomics.wait for a true blocking sleep.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

/** Exported for tests: timers are real setTimeouts, tests use fake timers. */
export function sendTextAndEnter(sessionName: string, text: string, opts: SendOptions = {}): void {
  const mode = opts.mode ?? 'paste';
  // A send that arrives while a previous one is still waiting for its Enter is
  // chained behind it so the two never share an input box.
  const prev = sendChains.get(sessionName);
  const run = () => (mode === 'type' ? typeAndSubmit(sessionName, text) : pasteAndSubmit(sessionName, text));
  const next = prev ? prev.catch(() => undefined).then(run) : run();
  sendChains.set(sessionName, next);
  void next.finally(() => { if (sendChains.get(sessionName) === next) sendChains.delete(sessionName); });
}

function typeAndSubmit(sessionName: string, text: string): Promise<void> {
  sendLiteralText(sessionName, text);
  sleepSync(TYPE_ENTER_DELAY_MS);
  tmuxExec(['send-keys', '-t', sessionName, 'C-m']);
  return new Promise((resolve) => confirmOrRetry(sessionName, text, 0, resolve));
}

function pasteAndSubmit(sessionName: string, text: string): Promise<void> {
  // Clear whatever is in the input box, then one atomic bracketed paste.
  // Enter is never in this argv: it is a later send-keys, after the TUI has the text.
  tmuxExec(['send-keys', '-t', sessionName, 'C-u']);
  const buf = `wc-${process.pid}-${Date.now()}`;
  execFileSync('tmux', [...socketPrefix(sessionName), 'load-buffer', '-b', buf, '-'], { input: text, timeout: TMUX_TIMEOUT, stdio: ['pipe', 'pipe', 'pipe'] });
  tmuxExec(['paste-buffer', '-p', '-d', '-b', buf, '-t', sessionName]);
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      tmuxExecSafe(['send-keys', '-t', sessionName, 'C-m']);
      confirmOrRetry(sessionName, text, 0, resolve);
    }, PASTE_ENTER_DELAY_MS);
  });
}

/** Capture the pane. If the text is still on the input line, press Enter again (up to 2 retries). */
function confirmOrRetry(sessionName: string, text: string, retriesUsed: number, resolve: () => void): void {
  setTimeout(() => {
    if (!inputStillHolds(sessionName, text)) {
      resolve();
      return;
    }
    if (retriesUsed < MAX_ENTER_RETRIES) {
      tmuxExecSafe(['send-keys', '-t', sessionName, 'C-m']);
      confirmOrRetry(sessionName, text, retriesUsed + 1, resolve);
      return;
    }
    logger.error(
      { session: sessionName, preview: text.slice(0, 80) },
      'typed notification still on the input line after Enter retries',
    );
    resolve();
  }, PASTE_CONFIRM_DELAY_MS);
}

/** The TUI's input line (❯ / ›) still shows the start of the text → the Enter was swallowed. */
export function inputStillHolds(sessionName: string, text: string): boolean {
  const pane = tmuxExecSafe(['capture-pane', '-t', sessionName, '-p', '-S', '-15']);
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
export function capturePaneJoined(sessionName: string, lines = 50): Result<string> {
  try {
    return { ok: true, data: tmuxExec(['capture-pane', '-t', sessionName, '-p', '-J', '-S', `-${lines}`]) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function capturePane(sessionName: string, lines = 50): Result<string> {
  try {
    const output = tmuxExec(['capture-pane', '-t', sessionName, '-p', '-S', `-${lines}`]);
    return { ok: true, data: output };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Capture pane output with ANSI escape sequences preserved.
 */
export function capturePaneAnsi(sessionName: string, lines = 50): Result<string> {
  try {
    const output = tmuxExec(['capture-pane', '-t', sessionName, '-p', '-e', '-S', `-${lines}`]);
    return { ok: true, data: output };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Capture a range of scrollback lines with ANSI.
 */
export function capturePaneRange(sessionName: string, start: number, end: number): Result<string> {
  try {
    const output = tmuxExec([
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
export function getScrollbackSize(sessionName: string): Result<number> {
  try {
    const output = tmuxExec([
      'display-message', '-t', sessionName, '-p', '#{history_size}',
    ]).trim();
    return { ok: true, data: parseInt(output, 10) || 0 };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Get the current working directory of a tmux pane.
 */
export function getPaneDir(sessionName: string): string | null {
  const output = tmuxExecSafe([
    'display-message', '-t', sessionName, '-p', '#{pane_current_path}',
  ]);
  return output?.trim() || null;
}
