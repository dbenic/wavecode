/**
 * Safe tmux command execution layer.
 *
 * All tmux interactions go through this module. Uses execFileSync with
 * argument arrays to eliminate shell injection vulnerabilities entirely.
 * No shell is spawned — arguments are passed directly to the tmux binary.
 */

import { execFileSync } from 'node:child_process';
import type { Result } from './db.js';

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

// --- Core tmux operations ---

/**
 * Execute a tmux command with argument array (no shell).
 * Returns stdout on success.
 */
export function tmuxExec(args: string[], timeout = TMUX_TIMEOUT): string {
  return execFileSync('tmux', args, {
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

export function listSessions(): Result<Array<{ name: string; created: number; lastActivity: number }>> {
  try {
    const output = tmuxExec(
      ['list-sessions', '-F', '#{session_name}:#{session_created}:#{session_activity}'],
    ).trim();

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

export function newSession(sessionName: string, workDir: string, command?: string): void {
  // Always create with a shell first — if a command is passed directly to
  // new-session and it exits (even on error), tmux destroys the session
  // immediately, making failures invisible. Instead we create a shell session
  // and then send the command as keystrokes so the session survives errors.
  const args = ['new-session', '-d', '-s', sessionName, '-c', workDir];
  tmuxExec(args);

  if (command) {
    // Small delay to let the shell initialize, then send command
    sleepSync(300);
    sendTextAndEnter(sessionName, command);
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
    tmuxExec(['send-keys', '-t', sessionName, '-l', chunk]);
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

export function sendTextAndEnter(sessionName: string, text: string): void {
  sendLiteralText(sessionName, text);
  // Small delay for tmux to process chunked text
  sleepSync(300);
  tmuxExec(['send-keys', '-t', sessionName, 'C-m']);
}

/**
 * Capture pane output (plain text, no ANSI).
 */
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
