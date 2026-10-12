/**
 * A lane has to contain the project's current main. Main's remote and branch
 * name come from the project (`main_remote` / `main_branch`, default
 * origin/main). Pings are one per lane per main SHA.
 */

import { execFileSync } from 'node:child_process';
import { getConfig } from './config.js';
import { getAgent, getDb, listAgents, resolveAgent, type Agent } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { deliverSystemLine } from './wire-lines.js';

export const MAIN_PING = 'lane.main_ping';

export interface MainSpec {
  remote: string;
  branch: string;
  ref: string;
}

export function mainSpec(project: string | null): MainSpec {
  const cfg = project ? getConfig().projects?.[project] : undefined;
  const remote = cfg?.main_remote?.trim() || 'origin';
  const branch = cfg?.main_branch?.trim() || 'main';
  return { remote, branch, ref: `${remote}/${branch}` };
}

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
}

export function projectRepo(project: string | null): string | null {
  if (!project) return null;
  return getConfig().projects?.[project]?.repo ?? null;
}

export function resolveMainRef(repo: string, project: string | null): string | null {
  const spec = mainSpec(project);
  for (const ref of [spec.ref, spec.branch]) {
    const sha = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (sha && /^[0-9a-f]{40}$/i.test(sha)) return ref;
  }
  return null;
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

/** How many commits on main this SHA does not contain. Null when git cannot tell. */
export function commitsBehind(project: string | null, sha: string): number | null {
  const repo = projectRepo(project);
  if (!repo || !/^[0-9a-f]{40}$/i.test(sha)) return null;
  const main = resolveMainRef(repo, project);
  if (!main) return null;
  const contains = isAncestor(repo, main, sha);
  if (contains === null) return null;
  if (contains) return 0;
  const n = git(repo, ['rev-list', '--count', `${sha}..${main}`]);
  if (n == null || !/^\d+$/.test(n)) return null;
  return Number(n);
}

export function mainTip(repo: string, project: string | null): { sha: string; subject: string; ref: string } | null {
  const ref = resolveMainRef(repo, project);
  if (!ref) return null;
  const out = git(repo, ['log', '-1', '--format=%H%x00%s', ref]);
  if (!out) return null;
  const [sha, subject] = out.split('\0');
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) return null;
  return { sha, subject: (subject ?? '').replace(/\s+/g, ' ').slice(0, 120), ref };
}

/** Diff of the lane's own changes against the merge-base with main. */
export function laneOnlyDiff(repo: string, sha: string, mainRef: string): string | null {
  const base = git(repo, ['merge-base', mainRef, sha]);
  if (!base) return null;
  try {
    return execFileSync('git', ['-C', repo, 'diff', '--no-color', '--find-renames', base, sha], {
      encoding: 'utf8', timeout: 8000, maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * True when `newSha` contains main and its lane-only diff equals `oldSha`'s.
 * A clean merge of main does not change the lane's own patch.
 */
export function isMergeOnlyDelta(repo: string, oldSha: string, newSha: string, mainRef: string): boolean {
  if (isAncestor(repo, mainRef, newSha) !== true) return false;
  const before = laneOnlyDiff(repo, oldSha, mainRef);
  const after = laneOnlyDiff(repo, newSha, mainRef);
  if (before == null || after == null) return false;
  return before === after;
}

export function changedFiles(repo: string, ref: string, mainRef: string): string[] {
  const base = git(repo, ['merge-base', mainRef, ref]);
  if (!base) return [];
  const out = git(repo, ['diff', '--name-only', base, ref]);
  return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

function pingKey(lane: string, mainSha: string): string {
  return `${lane}:${mainSha}`;
}

export function alreadyMainPinged(lane: string, mainSha: string): boolean {
  try {
    const row = getDb().prepare('SELECT id FROM events WHERE type = ? AND entity_id = ? LIMIT 1').get(MAIN_PING, pingKey(lane, mainSha)) as { id: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

function authorForLane(lane: string, authorAgentId: string | null, authorName: string | null): Agent | null {
  if (authorAgentId) {
    const a = getAgent(authorAgentId);
    if (a.ok) return a.data;
  }
  if (authorName) {
    const a = resolveAgent(authorName);
    if (a.ok) return a.data;
  }
  const bare = lane.replace(/^wc-/, '');
  return listAgents().find((a) => a.tmux_session === lane || a.name === bare || a.name === lane || a.alias === bare) ?? null;
}

/**
 * One delivery per lane per main SHA. `freeze` is the merge-and-refreeze
 * instruction; `moved` is the short "main moved" notice. Whichever lands
 * first is the one the author sees.
 */
export function pingLaneAboutMain(opts: {
  lane: string;
  project: string | null;
  mainSha: string;
  subject?: string | null;
  authorAgentId?: string | null;
  authorName?: string | null;
  kind: 'freeze' | 'moved';
}): boolean {
  if (!opts.lane || !opts.mainSha) return false;
  if (alreadyMainPinged(opts.lane, opts.mainSha)) return false;
  const agent = authorForLane(opts.lane, opts.authorAgentId ?? null, opts.authorName ?? null);
  if (!agent) return false;
  const spec = mainSpec(opts.project);
  const sha8 = opts.mainSha.slice(0, 8);
  const text = opts.kind === 'moved'
    ? `main moved to ${sha8}${opts.subject ? ` (${opts.subject})` : ''}; merge it now`
    : `Merge ${spec.remote}/${spec.branch} into this lane (merge, not rebase, so existing review records keep their SHAs), rerun the quick check, then refreeze.`;
  deliverSystemLine(agent, text, { kind: 'info', source: 'main' });
  emit(MAIN_PING, 'lane', pingKey(opts.lane, opts.mainSha), {
    lane: opts.lane, project: opts.project, main_sha: opts.mainSha, kind: opts.kind,
  }, null);
  return true;
}

function kvGet(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM kv_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function kvSet(key: string, value: string): void {
  getDb().prepare(
    'INSERT INTO kv_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

function laneGlobRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

interface FreezeRow {
  sha: string;
  project: string | null;
  lane: string | null;
  status: string;
  author_agent_id: string | null;
  author_name: string | null;
}

/** After a fetch, if main's tip changed, tell every developer lane that is now behind. The first tip seen is stored quietly. */
export function observeRepo(repo: string): void {
  let projects: Record<string, { repo?: string; lane_glob?: string }> = {};
  try { projects = getConfig().projects ?? {}; } catch { return; }
  for (const [name, project] of Object.entries(projects)) {
    if (project.repo !== repo) continue;
    const tip = mainTip(repo, name);
    if (!tip) continue;
    const key = `main_tip:${name}`;
    const prev = kvGet(key);
    try { kvSet(key, tip.sha); } catch (e) { logger.debug({ error: (e as Error).message }, 'main tip not stored'); continue; }
    if (!prev || prev === tip.sha) continue;
    notifyBehindLanes(name, repo, tip.sha, tip.subject, project.lane_glob || 'wc-*');
  }
}

function notifyBehindLanes(project: string, repo: string, mainSha: string, subject: string, glob: string): void {
  const main = resolveMainRef(repo, project);
  if (!main) return;
  const re = laneGlobRe(glob);
  const listed = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  const names = new Set<string>();
  for (const short of (listed ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const name = short.replace(/^[^/]+\//, '');
    if (name === 'HEAD' || name === mainSpec(project).branch) continue;
    if (re.test(name)) names.add(name);
  }
  try {
    const rows = getDb().prepare(
      "SELECT lane FROM release_freezes WHERE project = ? AND status IN ('open', 'behind-main') AND lane IS NOT NULL",
    ).all(project) as { lane: string }[];
    for (const row of rows) names.add(row.lane);
  } catch { /* table missing */ }
  for (const lane of names) {
    const ref = git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${mainSpec(project).remote}/${lane}^{commit}`])
      ?? git(repo, ['rev-parse', '--verify', '--quiet', `${lane}^{commit}`]);
    if (!ref || !/^[0-9a-f]{40}$/i.test(ref)) continue;
    const behind = isAncestor(repo, main, ref);
    if (behind !== false) continue;
    pingLaneAboutMain({ lane, project, mainSha, subject, kind: 'moved' });
    try {
      getDb().prepare(
        "UPDATE release_freezes SET status = 'behind-main', updated_at = datetime('now') WHERE project = ? AND lane = ? AND status = 'open'",
      ).run(project, lane);
    } catch { /* ignore */ }
  }
}

/** Open freezes whose SHA no longer contains main become behind-main, and the author is pinged once for this main tip. */
export function reconcileBehindFreezes(): void {
  let rows: FreezeRow[] = [];
  try {
    rows = getDb().prepare("SELECT sha, project, lane, status, author_agent_id, author_name FROM release_freezes WHERE status IN ('open', 'behind-main')").all() as FreezeRow[];
  } catch {
    return;
  }
  for (const f of rows) {
    const n = commitsBehind(f.project, f.sha);
    if (n == null || n <= 0) continue;
    if (f.status === 'open') {
      try {
        getDb().prepare("UPDATE release_freezes SET status = 'behind-main', updated_at = datetime('now') WHERE sha = ? AND status = 'open'").run(f.sha);
      } catch { /* ignore */ }
    }
    const repo = projectRepo(f.project);
    const tip = repo ? mainTip(repo, f.project) : null;
    if (!tip || !f.lane) continue;
    pingLaneAboutMain({
      lane: f.lane, project: f.project, mainSha: tip.sha, subject: tip.subject,
      authorAgentId: f.author_agent_id, authorName: f.author_name, kind: 'freeze',
    });
  }
}
