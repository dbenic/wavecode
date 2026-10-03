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

export function browseRoots(cfg: WaveConfig = getConfig()): string[] {
  const roots = [
    cfg.paths.rooms_root,
    cfg.paths.worktrees_root,
    cfg.paths.projects_root,
    cfg.paths.transcripts_root,
    cfg.artifacts?.storage,
    ...(cfg.paths.browse_roots ?? []),
  ].filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
  const resolved: string[] = [];
  for (const root of roots) {
    try {
      resolved.push(fs.realpathSync(root));
    } catch {
      // a configured root that does not exist yet simply serves nothing
    }
  }
  return resolved;
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

  let real: string;
  try {
    real = fs.realpathSync(requested);
  } catch {
    return { ok: false, code: 'not_found', error: 'File not found' };
  }
  if (!browseRoots(cfg).some((root) => under(real, root))) {
    return { ok: false, code: 'forbidden', error: 'Not a browsable location (rooms, worktrees, projects, transcripts, artifacts, paths.browse_roots)' };
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    return { ok: false, code: 'not_found', error: 'File not found' };
  }
  if (!st.isFile()) return { ok: false, code: 'not_found', error: 'Not a file' };
  if (st.size > MAX_VIEW_BYTES) return { ok: false, code: 'too_large', error: `File is larger than ${MAX_VIEW_BYTES / 1024} KB` };

  const buf = fs.readFileSync(real);
  if (buf.subarray(0, 8192).includes(0)) return { ok: false, code: 'binary', error: 'Binary file' };

  const ext = path.extname(real).toLowerCase();
  return {
    ok: true,
    data: {
      path: requested,
      name: path.basename(real),
      size: st.size,
      modified_at: st.mtime.toISOString(),
      kind: ext === '.md' || ext === '.markdown' ? 'markdown' : 'text',
      content: buf.toString('utf8'),
    },
  };
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
