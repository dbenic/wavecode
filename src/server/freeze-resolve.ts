/**
 * Close freezes the overview must not ask anyone about.
 * Runs in the background reconciler, never on GET /api/overview.
 *
 * Shipped: the SHA, or the main commit with the same patch, is contained in
 * a deploy tip we could read. An empty `git cherry` or a `-` line (cherry-pick
 * or squash) is not enough — the equivalent commit has to be in that tip.
 * A missing, null, or unreadable tip closes nothing and is not "merged, not yet
 * deployed". The tip is resolveStagingTip: the release peer when this project
 * forwards, otherwise the health command, then the local deployed row. A failed
 * health command and an unreadable peer stay unknown. The local row never
 * stands in for a forwarding peer.
 * Superseded: a rejected freeze whose lane tip has moved far ahead, and only
 * when that tip was readable.
 */

import { execFileSync } from 'node:child_process';
import { getDb } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { mainSpec, projectRepo } from './lane-main.js';
import { ensureReleaseFreezeTable, type ReleaseFreeze } from './release-freezes.js';
import { ensureReleaseTables, resolveStagingTip } from './releases.js';

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

/** A readable deploy tip. `unknown` is a read error — callers fail closed and do not close. */
export type DeployTipRead = { state: 'known'; sha: string | null } | { state: 'unknown' };

function upstreamRef(repo: string): 'origin/main' | 'main' | null {
  if (gitOk(repo, ['rev-parse', '--verify', '--quiet', 'origin/main']) === true) return 'origin/main';
  if (gitOk(repo, ['rev-parse', '--verify', '--quiet', 'main']) === true) return 'main';
  return null;
}

/**
 * Main commits that carry the same patch as `sha`.
 * Empty when `git cherry` still shows a `+` (work that is not on main).
 * Null when git cannot say — callers leave the freeze open.
 */
function mainEquivalents(repo: string, sha: string): string[] | null {
  const upstream = upstreamRef(repo);
  if (!upstream) return null;
  const out = gitText(repo, ['cherry', upstream, sha]);
  if (out == null) return null;
  const lines = out.split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.some((line) => line.startsWith('+'))) return [];
  if (lines.length === 0) {
    const hit = containedIn(repo, sha, upstream);
    if (hit === true) return [sha.toLowerCase()];
    return hit === false ? [] : null;
  }
  const laneShas: string[] = [];
  for (const line of lines) {
    const match = /^-\s+([0-9a-f]{40})$/i.exec(line);
    if (!match?.[1]) return null;
    laneShas.push(match[1].toLowerCase());
  }
  const marked = gitText(repo, ['rev-list', '--cherry-mark', `${upstream}...${sha}`]);
  if (marked == null) return null;
  const onMain: string[] = [];
  for (const line of marked.split('\n').map((item) => item.trim()).filter(Boolean)) {
    if (!line.startsWith('=')) continue;
    const id = line.slice(1).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(id) || laneShas.includes(id)) continue;
    const hit = containedIn(repo, id, upstream);
    if (hit === null) return null;
    if (hit) onMain.push(id);
  }
  if (onMain.length !== laneShas.length) return null;
  return onMain;
}

/**
 * The staging tip from resolveStagingTip.
 * Unknown when the peer cannot be asked, the health command returns nothing,
 * the tip is missing, or the SHA cannot be read. Never the local row of a
 * forwarding project.
 */
async function deployTip(project: string | null): Promise<DeployTipRead> {
  if (!project) return { state: 'unknown' };
  try {
    ensureReleaseTables();
    const resolved = await resolveStagingTip(project);
    if (resolved.state === 'unknown') return { state: 'unknown' };
    const sha = resolved.tip?.sha ?? null;
    if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) return { state: 'unknown' };
    return { state: 'known', sha: sha.toLowerCase() };
  } catch {
    return { state: 'unknown' };
  }
}

export async function deployTipsForProjects(projects: Array<string | null>): Promise<Map<string, DeployTipRead>> {
  const tips = new Map<string, DeployTipRead>();
  for (const project of projects) {
    if (!project || tips.has(project)) continue;
    tips.set(project, await deployTip(project));
  }
  return tips;
}

/**
 * The patch is already on main, and a readable deploy tip does not contain it.
 * A missing or unknown tip stays false so the row remains a decision.
 */
export function isMergedNotDeployed(project: string | null, sha: string, tip: DeployTipRead): boolean {
  if (tip.state !== 'known' || !tip.sha) return false;
  const repo = projectRepo(project);
  if (!repo || !/^[0-9a-f]{40}$/i.test(sha)) return false;
  const equivalents = mainEquivalents(repo, sha);
  if (!equivalents || equivalents.length === 0) return false;
  const hits = equivalents.map((id) => containedIn(repo, id, tip.sha!));
  if (hits.some((hit) => hit == null)) return false;
  return hits.some((hit) => hit === false);
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
export async function autoResolveObsoleteFreezes(): Promise<number> {
  let rows: ReleaseFreeze[] = [];
  try {
    ensureReleaseFreezeTable();
    rows = getDb().prepare(
      "SELECT * FROM release_freezes WHERE status IN ('open', 'behind-main', 'rejected')",
    ).all() as ReleaseFreeze[];
  } catch {
    return 0;
  }
  const tips = await deployTipsForProjects(rows.map((freeze) => freeze.project));
  let n = 0;
  for (const freeze of rows) {
    const repo = projectRepo(freeze.project);
    if (!repo || !/^[0-9a-f]{40}$/i.test(freeze.sha)) continue;
    const tip = freeze.project ? tips.get(freeze.project) : undefined;
    const tipSha = tip?.state === 'known' ? tip.sha : null;
    // Missing or unreadable tip: fail closed. Never close, and never use a local row in place of the peer.
    if (!tipSha) continue;
    const shipped = onMain(repo, freeze.sha) === true && containedIn(repo, freeze.sha, tipSha) === true;
    if (shipped) {
      closeFreeze(freeze, 'merged', 'shipped');
      n++;
      continue;
    }
    const equivalents = mainEquivalents(repo, freeze.sha);
    const deployed = !!equivalents?.length && equivalents.every((id) => containedIn(repo, id, tipSha) === true);
    if (deployed && equivalents) {
      closeFreeze(freeze, 'merged', equivalents[0] ?? 'shipped');
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
