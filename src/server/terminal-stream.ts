/**
 * Live pane streams for the agent page's terminal view.
 *
 * One stream per tmux session: `tmux pipe-pane` copies every byte the agent
 * writes to its pty into a FIFO the daemon reads, and the bytes fan out to
 * every open viewer (terminal-ws.ts). A viewer renders them with xterm.js,
 * so colours, cursor moves and full redraws arrive exactly as a terminal
 * would see them. Nothing here writes to the pane: the view is read-only
 * and prompts still go through POST /api/agents/:id/send.
 *
 * The pipe opens with the first viewer and closes shortly after the last one
 * leaves, so an idle daemon costs tmux nothing. A pane keeps at most one pipe;
 * a stale pipe from an earlier daemon is closed at startup (resetStalePipes).
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { getConfig } from './config.js';
import logger from './logger.js';
import * as tmux from './tmux.js';
import { execFileAsync } from './proc.js';
import type { Result } from './db.js';

export type Sink = (chunk: Buffer) => void;

export interface PaneGeometry {
  cols: number;
  rows: number;
  history_size: number;
  cursor_x: number;
  cursor_y: number;
}

export interface StreamHandle {
  geometry: PaneGeometry;
  /** The pane as it looks now (history + screen, escapes kept), already filtered. */
  seed: Buffer;
  close: () => void;
}

/** DEC private modes the viewer must not see: the alternate screen (would hide
 *  scrollback, like tmux's `alternate-screen off` prevents) and mouse tracking
 *  (would stop the viewer's own wheel/touch scrolling). */
const DROPPED_PRIVATE_MODES = new Set(['47', '1047', '1049', '1000', '1001', '1002', '1003', '1005', '1006', '1015']);

/**
 * Removes the dropped private-mode sets/resets from a byte stream, keeping any
 * other parameters of the same sequence. A sequence split across two chunks is
 * held back until it is complete.
 */
export class PrivateModeFilter {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer {
    const data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    const holdAt = incompleteCsiStart(data);
    const body = holdAt === -1 ? data : data.subarray(0, holdAt);
    if (holdAt !== -1) this.pending = Buffer.from(data.subarray(holdAt));
    return Buffer.from(filterPrivateModes(body.toString('latin1')), 'latin1');
  }

  flush(): Buffer {
    const out = this.pending;
    this.pending = Buffer.alloc(0);
    return out;
  }
}

/** Index of a trailing `ESC [ ?` sequence that has no final byte yet, or -1. */
function incompleteCsiStart(data: Buffer): number {
  const from = Math.max(0, data.length - 24);
  for (let i = data.length - 1; i >= from; i--) {
    if (data[i] !== 0x1b) continue;
    // ESC at the very end, or ESC [ (?) digits/semicolons with no letter after
    let j = i + 1;
    if (j >= data.length) return i;
    if (data[j] !== 0x5b) return -1; // not a CSI: a complete other escape
    j++;
    if (j < data.length && data[j] === 0x3f) j++;
    while (j < data.length && ((data[j] >= 0x30 && data[j] <= 0x39) || data[j] === 0x3b)) j++;
    return j >= data.length ? i : -1;
  }
  return -1;
}

export function filterPrivateModes(text: string): string {
  return text.replace(/\x1b\[\?([0-9;]+)([hl])/g, (whole, params: string, final: string) => {
    const kept = params.split(';').filter((p) => p !== '' && !DROPPED_PRIVATE_MODES.has(p));
    if (kept.length === params.split(';').length) return whole;
    return kept.length === 0 ? '' : `\x1b[?${kept.join(';')}${final}`;
  });
}

interface PaneStream {
  session: string;
  fifo: string;
  socket: net.Socket | null;
  sinks: Set<Sink>;
  filter: PrivateModeFilter;
  closeTimer: NodeJS.Timeout | null;
  bytes: number;
}

const streams = new Map<string, PaneStream>();
const CLOSE_GRACE_MS = 15_000;
const SEED_MAX_LINES = 5000;

function fifoDir(): string {
  try {
    const configured = getConfig().terminal_stream?.fifo_dir;
    if (configured) return configured;
  } catch { /* no config loaded */ }
  return path.join(process.cwd(), '.wavecode-data', 'terminal');
}

export function terminalStreamEnabled(): boolean {
  try {
    return getConfig().terminal_stream?.enabled !== false;
  } catch {
    return true; // no config loaded (tests): the default applies
  }
}

export function viewerCount(session: string): number {
  return streams.get(session)?.sinks.size ?? 0;
}

export function totalViewers(): number {
  let n = 0;
  for (const s of streams.values()) n += s.sinks.size;
  return n;
}

export async function paneGeometry(session: string): Promise<Result<PaneGeometry>> {
  try {
    const raw = (await tmux.tmuxExec(['display-message', '-t', session, '-p', '#{pane_width} #{pane_height} #{history_size} #{cursor_x} #{cursor_y}'])).trim();
    const [cols, rows, history, cx, cy] = raw.split(/\s+/).map((v) => parseInt(v, 10) || 0);
    if (!cols || !rows) return { ok: false, error: `pane geometry unavailable for ${session}` };
    return { ok: true, data: { cols, rows, history_size: history, cursor_x: cx, cursor_y: cy } };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * The current pane contents as terminal bytes: `history + screen` lines with
 * their escapes, then the cursor put back where the pane has it. Written into
 * a fresh xterm of the pane's size this reproduces the screen, with the
 * history above it as scrollback.
 */
export async function seedBytes(session: string, geometry: PaneGeometry, maxLines = SEED_MAX_LINES): Promise<Buffer> {
  const back = Math.min(maxLines, geometry.history_size);
  let captured = '';
  try {
    captured = await tmux.tmuxExec(['capture-pane', '-t', session, '-p', '-e', '-S', `-${back}`, '-E', String(geometry.rows - 1)]);
  } catch {
    return Buffer.alloc(0);
  }
  const lines = captured.replace(/\n$/, '').split('\n');
  // Each line ends in a reset so an open attribute never bleeds into the next row.
  const body = lines.map((l) => `${l}\x1b[0m`).join('\r\n');
  const cursor = `\x1b[${geometry.cursor_y + 1};${geometry.cursor_x + 1}H`;
  return Buffer.from(filterPrivateModes(body) + cursor, 'latin1');
}

/**
 * Attach a viewer to the session's pane output. Opens the pipe on the first
 * viewer. The returned seed is the pane as of just after the pipe opened; a
 * few bytes may appear in both seed and stream, which a terminal renders as
 * a harmless repeated redraw.
 */
export async function openPaneStream(session: string, sink: Sink): Promise<Result<StreamHandle>> {
  if (!tmux.isValidSessionName(session)) return { ok: false, error: 'invalid session name' };
  const max = getConfig().terminal_stream?.max_viewers ?? 20;
  if (totalViewers() >= max) return { ok: false, error: `too many open terminal viewers (max ${max})` };

  let stream = streams.get(session);
  if (!stream) {
    const started = await startPipe(session);
    if (!started.ok) return started;
    stream = started.data;
  }
  if (stream.closeTimer) {
    clearTimeout(stream.closeTimer);
    stream.closeTimer = null;
  }

  const geometry = await paneGeometry(session);
  if (!geometry.ok) {
    if (stream.sinks.size === 0) stopPipe(session);
    return geometry;
  }
  const seed = await seedBytes(session, geometry.data);
  stream.sinks.add(sink);
  logger.debug({ session, viewers: stream.sinks.size }, 'terminal viewer attached');

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    const s = streams.get(session);
    if (!s) return;
    s.sinks.delete(sink);
    if (s.sinks.size === 0 && !s.closeTimer) {
      s.closeTimer = setTimeout(() => stopPipe(session), CLOSE_GRACE_MS);
      s.closeTimer.unref();
    }
  };
  return { ok: true, data: { geometry: geometry.data, seed, close } };
}

async function startPipe(session: string): Promise<Result<PaneStream>> {
  const dir = fifoDir();
  const fifo = path.join(dir, `${session}.fifo`);
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.promises.unlink(fifo).catch(() => undefined); // none yet
    await execFileAsync('mkfifo', ['-m', '600', fifo], { timeout: 5000 });
  } catch (e) {
    return { ok: false, error: `cannot create terminal fifo: ${(e as Error).message}` };
  }

  // O_RDWR: the daemon counts as a writer too, so the read side never sees EOF
  // between tmux's `cat` instances, and the open never blocks on a writer.
  let socket: net.Socket;
  try {
    const fd = fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    socket = new net.Socket({ fd, readable: true, writable: false });
  } catch (e) {
    try { fs.unlinkSync(fifo); } catch { /* ignore */ }
    return { ok: false, error: `cannot open terminal fifo: ${(e as Error).message}` };
  }

  const stream: PaneStream = { session, fifo, socket, sinks: new Set(), filter: new PrivateModeFilter(), closeTimer: null, bytes: 0 };
  socket.on('data', (chunk: Buffer) => {
    stream.bytes += chunk.length;
    const out = stream.filter.push(chunk);
    if (out.length === 0) return;
    for (const sink of stream.sinks) {
      try { sink(out); } catch (e) { logger.warn({ session, error: (e as Error).message }, 'terminal sink failed'); }
    }
  });
  socket.on('error', (e) => logger.warn({ session, error: e.message }, 'terminal fifo error'));

  // `pipe-pane` replaces any pipe the pane already has. `exec cat` keeps the
  // shell out of the way; the path has no shell-special characters (session
  // names are [A-Za-z0-9._-], the dir is a config path we quote).
  try {
    await tmux.tmuxExec(['pipe-pane', '-O', '-t', session, `exec cat >'${fifo}'`]);
  } catch (e) {
    socket.destroy();
    try { fs.unlinkSync(fifo); } catch { /* ignore */ }
    return { ok: false, error: `pipe-pane failed: ${(e as Error).message}` };
  }
  streams.set(session, stream);
  logger.info({ session, fifo }, 'terminal pipe opened');
  return { ok: true, data: stream };
}

function stopPipe(session: string): void {
  const stream = streams.get(session);
  if (!stream) return;
  streams.delete(session);
  if (stream.closeTimer) clearTimeout(stream.closeTimer);
  // Closing the pipe first makes tmux end `cat`; then the fifo can go.
  void tmux.tmuxExecSafe(['pipe-pane', '-t', session]).finally(() => {
    stream.socket?.destroy();
    stream.socket = null;
    try { fs.unlinkSync(stream.fifo); } catch { /* already gone */ }
    logger.info({ session, bytes: stream.bytes }, 'terminal pipe closed');
  });
}

/** Detach every viewer and close every pipe (daemon shutdown). */
export function closeAllPaneStreams(): void {
  for (const session of [...streams.keys()]) stopPipe(session);
}

/**
 * Close pipes a previous daemon left on agent panes. Without a reader, tmux
 * would buffer pane output for a `cat` that can never drain it.
 */
export async function resetStalePipes(): Promise<void> {
  const listed = await tmux.tmuxExecSafe(['list-panes', '-a', '-F', '#{session_name}']);
  const sessions = new Set((listed ?? '').split('\n').map((l) => l.trim()).filter((l) => /^wc-/.test(l)));
  for (const session of sessions) await tmux.tmuxExecSafe(['pipe-pane', '-t', session]);
  try {
    const dir = fifoDir();
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (f.endsWith('.fifo')) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
    }
  } catch { /* best effort */ }
}

export function terminalStreamStats(): { sessions: number; viewers: number } {
  return { sessions: streams.size, viewers: totalViewers() };
}

export function resetTerminalStreamsForTest(): void {
  for (const s of streams.values()) {
    if (s.closeTimer) clearTimeout(s.closeTimer);
    s.socket?.destroy();
  }
  streams.clear();
}
