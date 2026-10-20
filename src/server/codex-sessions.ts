/**
 * Which Codex thread belongs to an agent.
 *
 * Codex keeps every thread of a login under `$CODEX_HOME/sessions/YYYY/MM/DD/
 * rollout-<time>-<id>.jsonl`, whose first line is `session_meta` with the
 * thread `id` and the `cwd` it ran in. `codex resume --last` picks the newest
 * thread of the *login*, so on a profile with several agents (codex1 and
 * ultra-scout both on `denis`) a relaunched agent resumed another agent's
 * conversation and hit "This conversation is open in another app".
 *
 * The relaunch now resumes the newest thread whose cwd is the agent's own
 * worktree and that is not a fork of another thread; with none, it starts
 * fresh. Never `--last`.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
const MAX_FILES = 400;
/** The meta line carries instructions and workspace roots and can run to tens of KB. */
const HEAD_BYTES = 512 * 1024;

interface SessionMeta { id: string; cwd: string; forkedFrom: string | null; file: string }

function readMeta(file: string): SessionMeta | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const nl = buf.subarray(0, n).indexOf(0x0a);
    if (nl === -1 && n === HEAD_BYTES) return null; // a first line longer than the window: not a meta line we trust
    const firstLine = buf.subarray(0, nl === -1 ? n : nl).toString('utf8');
    const row = JSON.parse(firstLine) as { type?: string; payload?: { id?: unknown; cwd?: unknown; forked_from_id?: unknown } };
    if (row.type !== 'session_meta' || !row.payload) return null;
    const id = typeof row.payload.id === 'string' ? row.payload.id : null;
    const cwd = typeof row.payload.cwd === 'string' ? row.payload.cwd : null;
    if (!id || !cwd) return null;
    return { id, cwd, forkedFrom: typeof row.payload.forked_from_id === 'string' ? row.payload.forked_from_id : null, file };
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Rollout files newest first (the name carries the timestamp), at most MAX_FILES. */
function rolloutFiles(codexHome: string): string[] {
  const root = path.join(codexHome, 'sessions');
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && ROLLOUT_RE.test(e.name)) out.push(p);
    }
  };
  walk(root, 0);
  out.sort((a, b) => (path.basename(b) < path.basename(a) ? -1 : path.basename(b) > path.basename(a) ? 1 : 0));
  return out.slice(0, MAX_FILES);
}

function sameDir(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * The thread id to resume for an agent working in `workspace`, or null when
 * the login has no thread of its own there (start fresh).
 */
export function ownThreadId(codexHome: string, workspace: string): string | null {
  for (const file of rolloutFiles(codexHome)) {
    const meta = readMeta(file);
    if (!meta || !sameDir(meta.cwd, workspace)) continue;
    if (meta.forkedFrom) continue; // a fork made from the lock screen carries someone else's conversation
    return meta.id;
  }
  return null;
}

/** `resume <id>` for the agent's own thread, or null for a fresh start. */
export function codexResumeArgs(codexHome: string, workspace: string | null | undefined): string | null {
  if (!workspace) return null;
  const id = ownThreadId(codexHome, workspace);
  return id ? `resume ${id}` : null;
}
