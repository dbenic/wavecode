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

function isAncestor(repo: string, ancestor: string, descendant: string): boolean | null {
  try {
    execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 1) return false;
    return null;
  }
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

/** Optional health probe. A printed 40-character SHA wins over the release record. */
export function readStagingHealth(project: string): { sha: string; version: string | null } | null {
  const argv = getConfig().releases?.staging_health_command;
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
