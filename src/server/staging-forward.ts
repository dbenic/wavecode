/**
 * Staging only moves forward, and the requested SHA must contain current main.
 * `force_rollback` skips the staging-ancestor check only, and only for an
 * admin who gives a reason. It does not skip the main check.
 *
 * An unknown staging version, or a SHA git cannot compare with main, is refused.
 * A resolved tip that is simply empty (nothing deployed yet) is not unknown.
 */

import { getConfig } from './config.js';
import { gitAncestor, gitText } from './git-memo.js';
import { execFileAsync } from './proc.js';
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

async function git(repo: string, args: string[]): Promise<string | null> {
  return gitText(repo, args);
}

/** Memoised for full-SHA pairs (see git-memo). */
async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean | null> {
  return gitAncestor(repo, ancestor, descendant);
}

/** One fetch per repo per minute: a reconcile pass asks about every freeze, not every freeze about origin. */
const FETCH_MEMO_MS = 60_000;
const lastFetchAt = new Map<string, number>();

export function resetFetchMemoForTest(): void {
  lastFetchAt.clear();
}

/** Best-effort refresh. A missing remote or a failed fetch leaves the refs we already have. Exported for tests. */
export async function fetchOrigin(repo: string): Promise<void> {
  const at = lastFetchAt.get(repo);
  if (at !== undefined && Date.now() - at < FETCH_MEMO_MS) return;
  lastFetchAt.set(repo, Date.now());
  try {
    await execFileAsync('git', ['-C', repo, 'fetch', '--no-tags', 'origin'], { timeout: 4000 });
  } catch { /* offline or no remote */ }
}

/** Stage and the snapshot both refuse with this when the peer tip could not be read. */
export const STAGING_VERSION_UNKNOWN = 'staging version unknown, try again';

/** Stage and the snapshot both refuse with this when the SHA cannot be compared with main. */
export const CANNOT_VERIFY_MAIN = 'cannot verify against main';

export function rollbackRefusal(requestedSha: string, missing: number, version: string | null, lane: string | null): string {
  const labels = [version ? `v${version.replace(/^v/, '')}` : null, lane].filter(Boolean).join(', ');
  return `would roll staging back: ${requestedSha.slice(0, 8)} is missing ${missing} commits now on staging (${labels || 'staging'})`;
}

/** True when `ancestor` is not contained in `descendant` and git can say so. */
export async function isMissingAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await isAncestor(repo, ancestor, descendant)) === false;
}

async function readHealthCommand(argv: string[] | undefined, project: string): Promise<{ sha: string; version: string | null } | null> {
  if (!argv?.length) return null;
  const filled = argv.map((part) => part.replaceAll('{project}', project));
  let out = '';
  try {
    out = await execFileAsync(filled[0], filled.slice(1), { timeout: 8000, maxBuffer: 1_000_000 });
  } catch {
    return null;
  }
  const sha = out.match(/\b[0-9a-f]{40}\b/i)?.[0]?.toLowerCase() ?? null;
  if (!sha) return null;
  const version = out.match(/\bv?(\d+\.\d+\.\d+(?:[-.][\w.]+)?)\b/)?.[1] ?? null;
  return { sha, version };
}

/** Optional staging probe. A printed 40-character SHA wins over the release record. */
export function readStagingHealth(project: string): Promise<{ sha: string; version: string | null } | null> {
  return readHealthCommand(getConfig().releases?.staging_health_command, project);
}

/** Optional production probe. A printed 40-character SHA wins over the release record. */
export function readProdHealth(project: string): Promise<{ sha: string; version: string | null } | null> {
  return readHealthCommand(getConfig().releases?.prod_health_command, project);
}

export async function evaluateForward(opts: {
  project: string;
  requestedSha: string;
  staging: StagingTip | null;
  /** The caller could not read a staging version. Distinct from an empty tip. */
  tipUnknown?: boolean;
  forceRollback?: boolean;
  forceReason?: string | null;
  actorIsAdmin?: boolean;
}): Promise<ForwardOk | ForwardNo> {
  const repo = projectRepo(opts.project);
  if (repo) await fetchOrigin(repo);
  const behind = await commitsBehind(opts.project, opts.requestedSha);
  // No repo keeps the old allow (a box that does not have the git checkout).
  // A repo that does not contain the SHA, or cannot compare it with main, refuses.
  if (repo && behind == null) return { ok: false, error: CANNOT_VERIFY_MAIN };
  if (behind != null && behind > 0) return { ok: false, error: behindMainLine(behind) };
  if (opts.tipUnknown) return { ok: false, error: STAGING_VERSION_UNKNOWN };

  const staging = opts.staging;
  if (!staging?.sha) return { ok: true, rollback: false, reason: null };
  if (staging.sha.toLowerCase() === opts.requestedSha.toLowerCase()) return { ok: true, rollback: false, reason: null };
  const unproven = `cannot prove ${opts.requestedSha.slice(0, 8)} contains staging ${staging.sha.slice(0, 8)}`;
  if (!repo) return { ok: false, error: unproven };

  const contains = await isAncestor(repo, staging.sha, opts.requestedSha);
  if (contains === null) return { ok: false, error: unproven };
  if (contains) return { ok: true, rollback: false, reason: null };

  const count = await git(repo, ['rev-list', '--count', `${opts.requestedSha}..${staging.sha}`]);
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
