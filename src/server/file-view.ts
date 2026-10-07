/**
 * Read-only file viewer behind "a path in an agent's reply is a link".
 *
 * Agents write paths (`/home/wave/.wavecode-data/rooms/x/REPORTS/a.md`,
 * `~/inbox/proposal.md`); the UI turns them into links that open here.
 * Only files under known roots are served — the rooms, worktrees, projects,
 * transcripts and artifacts directories plus `paths.browse_roots` from
 * config — resolved through realpath so symlinks cannot escape. Text only,
 * size-capped. Never credential dirs: profiles are not a root.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getConfig, type WaveConfig } from './config.js';

export const MAX_VIEW_BYTES = 1024 * 1024;

export interface ViewableFile {
  path: string;
  name: string;
  size: number;
  modified_at: string;
  kind: 'markdown' | 'text';
  content: string;
}

export type FileViewCode = 'invalid' | 'forbidden' | 'not_found' | 'too_large' | 'binary';
export type FileViewResult = { ok: true; data: ViewableFile } | { ok: false; code: FileViewCode; error: string };

/** Roots as configured and as resolved on disk (macOS /var → /private/var, symlinked homes…). */
export function browseRoots(cfg: WaveConfig = getConfig()): string[] {
  return browseRootPairs(cfg).map((r) => r.real).filter((r): r is string => r !== null);
}

function browseRootPairs(cfg: WaveConfig): Array<{ given: string; real: string | null }> {
  const roots = [
    cfg.paths.rooms_root,
    cfg.paths.worktrees_root,
    cfg.paths.projects_root,
    cfg.paths.transcripts_root,
    cfg.artifacts?.storage,
    ...(cfg.paths.browse_roots ?? []),
  ].filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
  const out: Array<{ given: string; real: string | null }> = [];
  for (const root of roots) {
    let real: string | null = null;
    try { real = fs.realpathSync(root); } catch { /* configured root that does not exist yet: serves nothing, but is still "ours" */ }
    out.push({ given: path.normalize(root), real });
  }
  return out;
}

function under(file: string, root: string): boolean {
  return file === root || file.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

export function readViewableFile(requested: string, cfg: WaveConfig = getConfig()): FileViewResult {
  if (typeof requested !== 'string' || !requested.trim()) return { ok: false, code: 'invalid', error: 'path is required' };
  if (requested.includes('\0')) return { ok: false, code: 'invalid', error: 'invalid path' };
  // `~/inbox/x.md` as agents write it: the daemon user's home
  if (requested === '~' || requested.startsWith('~/')) requested = path.join(os.homedir(), requested.slice(1));
  if (!path.isAbsolute(requested)) return { ok: false, code: 'invalid', error: 'path must be absolute' };

  // Per-directory confinement: the root is chosen from the path AS REQUESTED
  // (no `..`, no symlink games), and the resolved parent must stay under THAT
  // root — a link from one allowed directory cannot reach another.
  if (requested.split(/[\\/]+/).includes('..')) return { ok: false, code: 'invalid', error: 'invalid path' };
  const normalized = path.normalize(requested);
  const root = browseRootPairs(cfg).find((r) => under(normalized, r.given) || (r.real !== null && under(normalized, r.real)));
  if (!root) {
    return { ok: false, code: 'forbidden', error: 'Not a browsable location (rooms, worktrees, projects, transcripts, artifacts, paths.browse_roots)' };
  }
  if (root.real === null) return { ok: false, code: 'not_found', error: 'File not found' };
  let realDir: string;
  try {
    realDir = fs.realpathSync(path.dirname(normalized));
  } catch {
    return { ok: false, code: 'not_found', error: 'File not found' };
  }
  if (!under(realDir, root.real)) return { ok: false, code: 'forbidden', error: 'Path escapes its directory (symlink)' };

  // Open-then-check on the final component with O_NOFOLLOW: what we stat is what we read.
  const target = path.join(realDir, path.basename(normalized));
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'EMLINK') return { ok: false, code: 'forbidden', error: 'Symlinks are not followed' };
    return { ok: false, code: 'not_found', error: 'File not found' };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, code: 'not_found', error: 'Not a file' };
    if (st.size > MAX_VIEW_BYTES) return { ok: false, code: 'too_large', error: `File is larger than ${MAX_VIEW_BYTES / 1024} KB` };
    const buf = fs.readFileSync(fd);
    if (buf.subarray(0, 8192).includes(0)) return { ok: false, code: 'binary', error: 'Binary file' };
    const ext = path.extname(target).toLowerCase();
    return {
      ok: true,
      data: {
        path: requested,
        name: path.basename(target),
        size: st.size,
        modified_at: st.mtime.toISOString(),
        kind: ext === '.md' || ext === '.markdown' ? 'markdown' : 'text',
        content: buf.toString('utf8'),
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function fileViewStatus(code: FileViewCode): 400 | 403 | 404 | 413 | 415 {
  switch (code) {
    case 'invalid': return 400;
    case 'forbidden': return 403;
    case 'not_found': return 404;
    case 'too_large': return 413;
    case 'binary': return 415;
  }
}
