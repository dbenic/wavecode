/**
 * Staging only moves forward, and the requested SHA must contain current main.
 * `force_rollback` skips the staging-ancestor check only, and only for an
 * admin who gives a reason. It does not skip the main check.
 *
 * With no deployed staging tip and no way to know main ancestry, the request
 * is allowed — that is how a box without a git repo stages today.
 */

import { execFileSync } from 'node:child_process';
import { getConfig } from './config.js';
import { gitAncestor, gitAncestorSync, gitText } from './git-memo.js';
import { behindMainLine } from './lane-status.js';
import { commitsBehind, projectRepo } from './lane-main.js';

export interface StagingTip {
  sha: string;
  version: string | null;
  lane: string | null;
}

export interface ForwardOk {
  ok: true;
  rollback: boolean;
  reason: string | null;
}

export interface ForwardNo {
  ok: false;
  error: string;
}

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 8000 }).trim();
  } catch {
    return null;
  }
}

/** Memoised for full-SHA pairs (see git-memo). */
function isAncestor(repo: string, ancestor: string, descendant: string): boolean | null {
  return gitAncestorSync(repo, ancestor, descendant);
}

/** Best-effort refresh. A missing remote or a failed fetch leaves the refs we already have. */
function fetchOrigin(repo: string): void {
  try {
    execFileSync('git', ['-C', repo, 'fetch', '--no-tags', 'origin'], { timeout: 4000, stdio: 'ignore' });
  } catch { /* offline or no remote */ }
}

export function rollbackRefusal(requestedSha: string, missing: number, version: string | null, lane: string | null): string {
  const labels = [version ? `v${version.replace(/^v/, '')}` : null, lane].filter(Boolean).join(', ');
  return `would roll staging back: ${requestedSha.slice(0, 8)} is missing ${missing} commits now on staging (${labels || 'staging'})`;
}

/** True when `ancestor` is not contained in `descendant` and git can say so. */
export function isMissingAncestor(repo: string, ancestor: string, descendant: string): boolean {
  return isAncestor(repo, ancestor, descendant) === false;
}

function readHealthCommand(argv: string[] | undefined, project: string): { sha: string; version: string | null } | null {
  if (!argv?.length) return null;
  const filled = argv.map((part) => part.replaceAll('{project}', project));
  let out = '';
  try {
    out = execFileSync(filled[0], filled.slice(1), { encoding: 'utf8', timeout: 8000, maxBuffer: 1_000_000 });
  } catch {
    return null;
  }
  const sha = out.match(/\b[0-9a-f]{40}\b/i)?.[0]?.toLowerCase() ?? null;
  if (!sha) return null;
  const version = out.match(/\bv?(\d+\.\d+\.\d+(?:[-.][\w.]+)?)\b/)?.[1] ?? null;
  return { sha, version };
}

/** Optional staging probe. A printed 40-character SHA wins over the release record. */
export function readStagingHealth(project: string): { sha: string; version: string | null } | null {
  return readHealthCommand(getConfig().releases?.staging_health_command, project);
}

/** Optional production probe. A printed 40-character SHA wins over the release record. */
export function readProdHealth(project: string): { sha: string; version: string | null } | null {
  return readHealthCommand(getConfig().releases?.prod_health_command, project);
}

export function evaluateForward(opts: {
  project: string;
  requestedSha: string;
  staging: StagingTip | null;
  forceRollback?: boolean;
  forceReason?: string | null;
  actorIsAdmin?: boolean;
}): ForwardOk | ForwardNo {
  const repo = projectRepo(opts.project);
  if (repo) fetchOrigin(repo);
  const behind = commitsBehind(opts.project, opts.requestedSha);
  if (behind != null && behind > 0) return { ok: false, error: behindMainLine(behind) };

  const staging = opts.staging;
  if (!staging?.sha) return { ok: true, rollback: false, reason: null };
  if (staging.sha.toLowerCase() === opts.requestedSha.toLowerCase()) return { ok: true, rollback: false, reason: null };
  const unproven = `cannot prove ${opts.requestedSha.slice(0, 8)} contains staging ${staging.sha.slice(0, 8)}`;
  if (!repo) return { ok: false, error: unproven };

  const contains = isAncestor(repo, staging.sha, opts.requestedSha);
  if (contains === null) return { ok: false, error: unproven };
  if (contains) return { ok: true, rollback: false, reason: null };

  const count = git(repo, ['rev-list', '--count', `${opts.requestedSha}..${staging.sha}`]);
  const missing = count && /^\d+$/.test(count) ? Number(count) : 0;
  const error = rollbackRefusal(opts.requestedSha, missing, staging.version, staging.lane);
  if (opts.forceRollback === true) {
    if (opts.actorIsAdmin !== true) return { ok: false, error: 'force_rollback is admin only' };
    const reason = opts.forceReason?.trim() ?? '';
    if (!reason) return { ok: false, error: 'force_rollback requires a reason' };
    return { ok: true, rollback: true, reason };
  }
  return { ok: false, error };
}

/** Ancestor result for one lane tip against one staging tip. A repeat refresh does not ask git again. */
const forwardMemo = new Map<string, string | null>();

export function resetForwardMemoForTest(): void {
  forwardMemo.clear();
}

/**
 * The card's forward check. Same refusal as `evaluateForward` when the SHA
 * does not contain the staging tip, cached by (lane SHA, staging tip).
 */
export async function stagingForwardBlock(project: string, requestedSha: string, staging: StagingTip | null): Promise<string | null> {
  if (!staging?.sha || !/^[0-9a-f]{40}$/i.test(requestedSha)) return null;
  const laneSha = requestedSha.toLowerCase();
  const stagingSha = staging.sha.toLowerCase();
  if (stagingSha === laneSha) return null;
  const repo = projectRepo(project);
  const key = `${repo ?? ''}:${stagingSha}:${laneSha}`;
  if (forwardMemo.has(key)) return forwardMemo.get(key) ?? null;
  const unproven = `cannot prove ${laneSha.slice(0, 8)} contains staging ${stagingSha.slice(0, 8)}`;
  let block: string | null;
  if (!repo) block = unproven;
  else {
    const contains = await gitAncestor(repo, stagingSha, laneSha);
    if (contains === null) block = unproven;
    else if (contains) block = null;
    else {
      const count = await gitText(repo, ['rev-list', '--count', `${laneSha}..${stagingSha}`]);
      const missing = count && /^\d+$/.test(count) ? Number(count) : 0;
      block = rollbackRefusal(laneSha, missing, staging.version, staging.lane);
    }
  }
  forwardMemo.set(key, block);
  return block;
}
