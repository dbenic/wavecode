/**
 * Close freezes the overview must not ask anyone about.
 * Runs in the background reconciler, never on GET /api/overview.
 *
 * Shipped: the SHA is already in origin/main and in the deploy tip.
 * Superseded: `git cherry` shows nothing new against main, or a rejected
 * freeze whose lane tip has moved far ahead.
 */

import { execFileSync } from 'node:child_process';
import { getDb } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { mainSpec, projectRepo } from './lane-main.js';
import { ensureReleaseFreezeTable, type ReleaseFreeze } from './release-freezes.js';
import { currentStagingTip, ensureReleaseTables, listReleases } from './releases.js';

/** Commits the lane tip must be ahead of a rejected freeze before it is closed. */
export const FAR_AHEAD_COMMITS = 20;
let farAheadCommits = FAR_AHEAD_COMMITS;

export function setFarAheadForTest(n: number | null): void {
  farAheadCommits = n ?? FAR_AHEAD_COMMITS;
}

function gitOk(repo: string, args: string[]): boolean | null {
  try {
    execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore', timeout: 8000 });
    return true;
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status === 1) return false;
    return null;
  }
}

function gitText(repo: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** True when `sha` is an ancestor of `ref`. Null when git cannot say. A commit contains itself. */
function containedIn(repo: string, sha: string, ref: string): boolean | null {
  return gitOk(repo, ['merge-base', '--is-ancestor', sha, ref]);
}

function onMain(repo: string, sha: string): boolean | null {
  for (const ref of ['origin/main', 'main']) {
    const hit = containedIn(repo, sha, ref);
    if (hit === true) return true;
    if (hit === false) return false;
  }
  return null;
}

/**
 * `git cherry` prefixes commits still missing from main with `+`.
 * Nothing new (empty output, or only `-` equivalents) is an empty diff.
 * Null when git cannot say — those freezes stay open.
 */
function cherryEmpty(repo: string, sha: string): boolean | null {
  const out = gitText(repo, ['cherry', 'origin/main', sha]) ?? gitText(repo, ['cherry', 'main', sha]);
  if (out == null) return null;
  const lines = out.split('\n').map((line) => line.trim()).filter(Boolean);
  return !lines.some((line) => line.startsWith('+'));
}

function deployTip(project: string | null): string | null {
  if (!project) return null;
  try {
    ensureReleaseTables();
    const staging = currentStagingTip(project)?.sha ?? null;
    if (staging && /^[0-9a-f]{40}$/i.test(staging)) return staging.toLowerCase();
    const prod = listReleases({ project, target: 'production', status: 'deployed', limit: 1 })[0];
    const sha = prod?.deployed_sha || prod?.sha || null;
    return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
  } catch {
    return null;
  }
}

function laneTip(repo: string, project: string | null, lane: string): string | null {
  const spec = mainSpec(project);
  for (const ref of [`refs/remotes/${spec.remote}/${lane}`, lane]) {
    const sha = gitText(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (sha && /^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
  }
  return null;
}

function closeFreeze(freeze: ReleaseFreeze, status: 'merged' | 'stale', supersededBy: string): void {
  getDb().prepare(
    `UPDATE release_freezes SET status = ?, superseded_by = ?, updated_at = datetime('now') WHERE sha = ? AND status IN ('open', 'behind-main', 'rejected')`,
  ).run(status, supersededBy, freeze.sha);
  if (status === 'merged' && freeze.run_id) {
    getDb().prepare("UPDATE runs SET review_status = 'approved' WHERE id = ? AND review_status = 'pending'").run(freeze.run_id);
  }
  if (freeze.run_id) {
    emit('review.superseded', 'run', freeze.run_id, { sha: freeze.sha, superseded_by: supersededBy, by: status === 'merged' ? 'shipped' : 'superseded' }, null);
  }
  logger.info({ sha: freeze.sha, project: freeze.project, status, superseded_by: supersededBy }, 'Freeze auto-resolved');
}

/**
 * Close obsolete freezes so the overview never lists them as promotable or unassigned fixes.
 * Returns how many rows changed.
 */
export function autoResolveObsoleteFreezes(): number {
  let rows: ReleaseFreeze[] = [];
  try {
    ensureReleaseFreezeTable();
    rows = getDb().prepare(
      "SELECT * FROM release_freezes WHERE status IN ('open', 'behind-main', 'rejected')",
    ).all() as ReleaseFreeze[];
  } catch {
    return 0;
  }
  let n = 0;
  for (const freeze of rows) {
    const repo = projectRepo(freeze.project);
    if (!repo || !/^[0-9a-f]{40}$/i.test(freeze.sha)) continue;
    const tip = deployTip(freeze.project);
    const shipped = onMain(repo, freeze.sha) === true && !!tip && containedIn(repo, freeze.sha, tip) === true;
    if (shipped) {
      closeFreeze(freeze, 'merged', 'shipped');
      n++;
      continue;
    }
    if (cherryEmpty(repo, freeze.sha) === true) {
      closeFreeze(freeze, 'stale', 'empty');
      n++;
      continue;
    }
    if (freeze.status === 'rejected' && freeze.lane) {
      const head = laneTip(repo, freeze.project, freeze.lane);
      if (!head || head === freeze.sha.toLowerCase()) continue;
      const ahead = gitText(repo, ['rev-list', '--count', `${freeze.sha}..${head}`]);
      if (ahead != null && /^\d+$/.test(ahead) && Number(ahead) >= farAheadCommits) {
        closeFreeze(freeze, 'stale', head);
        n++;
      }
    }
  }
  return n;
}
