/**
 * A lane has to contain the project's current main. Main's remote and branch
 * name come from the project (`main_remote` / `main_branch`, default
 * origin/main). Pings are one per lane per main SHA.
 */

import { execFileSync } from 'node:child_process';
import { getConfig } from './config.js';
import { gitAncestor, gitText } from './git-memo.js';
import { getAgent, getDb, listAgents, resolveAgent, type Agent } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { deliverSystemLine } from './wire-lines.js';
import { countixDenied } from './pipeline-deny.js';
import { fireMainAdvanced } from './pipeline-hooks.js';

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

/** Keyed by the main tip SHA and the lane tip SHA. A repeat review refresh does not re-diff. */
const behindCache = new Map<string, number | null>();
const filesCache = new Map<string, string[]>();
const deltaCache = new Map<string, boolean>();

function pairKey(mainSha: string, sha: string): string {
  return `${mainSha}:${sha}`;
}

export function resetLaneGitCacheForTest(): void {
  behindCache.clear();
  filesCache.clear();
  deltaCache.clear();
}

export function rememberBehind(mainSha: string, sha: string, n: number | null): void {
  if (/^[0-9a-f]{40}$/i.test(mainSha) && /^[0-9a-f]{40}$/i.test(sha)) behindCache.set(pairKey(mainSha, sha), n);
}

export function recallBehind(mainSha: string, sha: string): number | null | undefined {
  const key = pairKey(mainSha, sha);
  return behindCache.has(key) ? behindCache.get(key) : undefined;
}

export function rememberFiles(mainSha: string, sha: string, files: string[]): void {
  if (/^[0-9a-f]{40}$/i.test(mainSha) && /^[0-9a-f]{40}$/i.test(sha)) filesCache.set(pairKey(mainSha, sha), files);
}

export function recallFiles(mainSha: string, sha: string): string[] | undefined {
  return filesCache.get(pairKey(mainSha, sha));
}

export function rememberDelta(mainSha: string, oldSha: string, newSha: string, value: boolean): void {
  if ([mainSha, oldSha, newSha].every((sha) => /^[0-9a-f]{40}$/i.test(sha))) {
    deltaCache.set(`${mainSha}:${oldSha}:${newSha}`, value);
  }
}

export function recallDelta(mainSha: string, oldSha: string, newSha: string): boolean | undefined {
  const key = `${mainSha}:${oldSha}:${newSha}`;
  return deltaCache.has(key) ? deltaCache.get(key) : undefined;
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

function mainTipSha(repo: string, ref: string): string | null {
  const sha = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/** How many commits on main this SHA does not contain. Null when git cannot tell. */
export function commitsBehind(project: string | null, sha: string): number | null {
  const repo = projectRepo(project);
  if (!repo || !/^[0-9a-f]{40}$/i.test(sha)) return null;
  const main = resolveMainRef(repo, project);
  if (!main) return null;
  const mainSha = mainTipSha(repo, main);
  if (mainSha) {
    const hit = recallBehind(mainSha, sha);
    if (hit !== undefined) return hit;
  }
  const contains = isAncestor(repo, mainSha ?? main, sha);
  if (contains === null) return null;
  if (contains) {
    if (mainSha) rememberBehind(mainSha, sha, 0);
    return 0;
  }
  const n = git(repo, ['rev-list', '--count', `${sha}..${mainSha ?? main}`]);
  if (n == null || !/^\d+$/.test(n)) return null;
  const value = Number(n);
  if (mainSha) rememberBehind(mainSha, sha, value);
  return value;
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
  const mainSha = /^[0-9a-f]{40}$/i.test(mainRef) ? mainRef : mainTipSha(repo, mainRef);
  if (mainSha) {
    const hit = recallDelta(mainSha, oldSha, newSha);
    if (hit !== undefined) return hit;
  }
  if (isAncestor(repo, mainSha ?? mainRef, newSha) !== true) {
    if (mainSha) rememberDelta(mainSha, oldSha, newSha, false);
    return false;
  }
  const before = laneOnlyDiff(repo, oldSha, mainSha ?? mainRef);
  const after = laneOnlyDiff(repo, newSha, mainSha ?? mainRef);
  if (before == null || after == null) return false;
  const value = before === after;
  if (mainSha) rememberDelta(mainSha, oldSha, newSha, value);
  return value;
}

export function changedFiles(repo: string, ref: string, mainRef: string): string[] {
  const mainSha = /^[0-9a-f]{40}$/i.test(mainRef) ? mainRef : null;
  const refSha = /^[0-9a-f]{40}$/i.test(ref) ? ref : null;
  if (mainSha && refSha) {
    const hit = recallFiles(mainSha, refSha);
    if (hit) return hit;
  }
  const base = git(repo, ['merge-base', mainSha ?? mainRef, refSha ?? ref]);
  if (!base) return [];
  const out = git(repo, ['diff', '--name-only', base, refSha ?? ref]);
  const files = out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  if (mainSha && refSha) rememberFiles(mainSha, refSha, files);
  return files;
}

async function resolveMainSha(repo: string, project: string | null): Promise<{ ref: string; sha: string } | null> {
  const spec = mainSpec(project);
  for (const ref of [spec.ref, spec.branch]) {
    const sha = await gitText(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (sha && /^[0-9a-f]{40}$/i.test(sha)) return { ref, sha };
  }
  return null;
}

/** Same answer as `commitsBehind`, computed without blocking the event loop. */
export async function commitsBehindAsync(project: string | null, sha: string): Promise<number | null> {
  const repo = projectRepo(project);
  if (!repo || !/^[0-9a-f]{40}$/i.test(sha)) return null;
  const main = await resolveMainSha(repo, project);
  if (!main) return null;
  const hit = recallBehind(main.sha, sha);
  if (hit !== undefined) return hit;
  const contains = await gitAncestor(repo, main.sha, sha);
  if (contains === null) return null;
  if (contains) {
    rememberBehind(main.sha, sha, 0);
    return 0;
  }
  const n = await gitText(repo, ['rev-list', '--count', `${sha}..${main.sha}`]);
  if (n == null || !/^\d+$/.test(n)) return null;
  const value = Number(n);
  rememberBehind(main.sha, sha, value);
  return value;
}

export async function changedFilesAsync(repo: string, sha: string, mainSha: string): Promise<string[]> {
  const hit = recallFiles(mainSha, sha);
  if (hit) return hit;
  const base = await gitText(repo, ['merge-base', mainSha, sha]);
  if (!base) return [];
  const out = await gitText(repo, ['diff', '--name-only', base, sha]);
  const files = out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  rememberFiles(mainSha, sha, files);
  return files;
}

async function laneOnlyDiffAsync(repo: string, sha: string, mainSha: string): Promise<string | null> {
  const base = await gitText(repo, ['merge-base', mainSha, sha]);
  if (!base) return null;
  return gitText(repo, ['diff', '--no-color', '--find-renames', base, sha]);
}

export async function isMergeOnlyDeltaAsync(repo: string, oldSha: string, newSha: string, mainSha: string): Promise<boolean> {
  const hit = recallDelta(mainSha, oldSha, newSha);
  if (hit !== undefined) return hit;
  if (await gitAncestor(repo, mainSha, newSha) !== true) {
    rememberDelta(mainSha, oldSha, newSha, false);
    return false;
  }
  const before = await laneOnlyDiffAsync(repo, oldSha, mainSha);
  const after = await laneOnlyDiffAsync(repo, newSha, mainSha);
  if (before == null || after == null) return false;
  const value = before === after;
  rememberDelta(mainSha, oldSha, newSha, value);
  return value;
}

function pingKey(lane: string, mainSha: string): string {
  return `${lane}:${mainSha}`;
}

const REPEAT_MS = 30 * 60 * 1000;
let nowMs = (): number => Date.now();

/** Tests inject the clock so a 30-minute repeat does not wait. */
export function setLaneAlertNowForTest(fn: (() => number) | null): void {
  nowMs = fn ?? (() => Date.now());
}

export function behindMainAlert(lane: string): string {
  return `Your lane ${lane} is behind main. Run: git fetch origin && git merge origin/main, fix any conflicts, run the quick check, then write your freeze note. Nothing else to do.`;
}

export function mergedMainAlert(lane: string): string {
  return `Merged latest main into ${lane} for you; quick check running. You don't need to do anything unless it goes red.`;
}

function latestPing(lane: string, mainSha: string): { at: number } | null {
  try {
    const row = getDb().prepare(
      'SELECT payload_json, created_at FROM events WHERE type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1',
    ).get(MAIN_PING, pingKey(lane, mainSha)) as { payload_json: string | null; created_at: string } | undefined;
    if (!row) return null;
    if (row.payload_json) {
      const payload = JSON.parse(row.payload_json) as { at?: unknown };
      if (typeof payload.at === 'number') return { at: payload.at };
    }
    const parsed = Date.parse(row.created_at.includes('T') ? row.created_at : `${row.created_at.replace(' ', 'T')}Z`);
    return { at: Number.isNaN(parsed) ? 0 : parsed };
  } catch {
    return null;
  }
}

export function alreadyMainPinged(lane: string, mainSha: string): boolean {
  const latest = latestPing(lane, mainSha);
  if (!latest) return false;
  return nowMs() - latest.at < REPEAT_MS;
}

function laneTipSha(project: string | null, lane: string): string | null {
  const repo = projectRepo(project);
  if (!repo) return null;
  const spec = mainSpec(project);
  const remote = git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${spec.remote}/${lane}^{commit}`]);
  if (remote && /^[0-9a-f]{40}$/i.test(remote)) return remote;
  const local = git(repo, ['rev-parse', '--verify', '--quiet', `${lane}^{commit}`]);
  return local && /^[0-9a-f]{40}$/i.test(local) ? local : null;
}

function stillBehind(project: string | null, lane: string): boolean {
  const tip = laneTipSha(project, lane);
  if (!tip) return false;
  const n = commitsBehind(project, tip);
  return n != null && n > 0;
}

/** A PASS on a SHA that does not contain this main still counts as unreviewed. */
function stillUnreviewed(project: string | null, lane: string, mainSha: string): boolean {
  const repo = projectRepo(project);
  let rows: { sha: string }[] = [];
  try {
    rows = getDb().prepare(
      "SELECT sha FROM release_freezes WHERE lane = ? AND verdict = 'pass'",
    ).all(lane) as { sha: string }[];
  } catch {
    return true;
  }
  if (!repo) return true;
  for (const row of rows) {
    if (isAncestor(repo, mainSha, row.sha) === true) return false;
  }
  return true;
}

function authorForLane(lane: string, authorAgentId: string | null, authorName: string | null, project: string | null): Agent | null {
  let agent: Agent | null = null;
  if (authorAgentId) {
    const a = getAgent(authorAgentId);
    if (a.ok) agent = a.data;
  }
  if (!agent && authorName) {
    const a = resolveAgent(authorName);
    if (a.ok) agent = a.data;
  }
  if (!agent) {
    const bare = lane.replace(/^wc-/, '');
    agent = listAgents().find((a) => a.tmux_session === lane || a.name === bare || a.name === lane || a.alias === bare) ?? null;
  }
  if (!agent || countixDenied(project, lane, agent)) return null;
  return agent;
}

/**
 * One plain alert per lane per main SHA. The same sentence is used when main
 * moves, staging moves past the lane, or Stage is refused for being behind.
 * A second send inside 30 minutes is dropped. After 30 minutes it is sent
 * again only while the lane is still behind and still has no PASS on a SHA
 * that contains this main. `merged` is the auto-merge sentence and shares
 * the same dedupe key.
 */
export function pingLaneAboutMain(opts: {
  lane: string;
  project: string | null;
  mainSha: string;
  subject?: string | null;
  authorAgentId?: string | null;
  authorName?: string | null;
  kind: 'freeze' | 'moved' | 'merged';
}): boolean {
  if (!opts.lane || !opts.mainSha) return false;
  if (countixDenied(opts.project, opts.lane, opts.authorName ? { name: opts.authorName } : null)) return false;
  const latest = latestPing(opts.lane, opts.mainSha);
  if (latest) {
    if (nowMs() - latest.at < REPEAT_MS) return false;
    if (!stillBehind(opts.project, opts.lane) || !stillUnreviewed(opts.project, opts.lane, opts.mainSha)) return false;
  }
  const agent = authorForLane(opts.lane, opts.authorAgentId ?? null, opts.authorName ?? null, opts.project);
  if (!agent) return false;
  const text = opts.kind === 'merged' ? mergedMainAlert(opts.lane) : behindMainAlert(opts.lane);
  deliverSystemLine(agent, text, { kind: 'info', source: 'main' });
  emit(MAIN_PING, 'lane', pingKey(opts.lane, opts.mainSha), {
    lane: opts.lane, project: opts.project, main_sha: opts.mainSha, kind: opts.kind, at: nowMs(),
  }, null);
  return true;
}

/** The behind-main sentence, deduped per lane per current main SHA. */
export function alertBehind(opts: {
  lane: string;
  project: string | null;
  authorAgentId?: string | null;
  authorName?: string | null;
}): boolean {
  if (countixDenied(opts.project, opts.lane, opts.authorName ? { name: opts.authorName } : null)) return false;
  const repo = projectRepo(opts.project);
  const tip = repo ? mainTip(repo, opts.project) : null;
  if (!tip) return false;
  return pingLaneAboutMain({
    lane: opts.lane, project: opts.project, mainSha: tip.sha, subject: tip.subject,
    authorAgentId: opts.authorAgentId, authorName: opts.authorName, kind: 'moved',
  });
}

/** Clean auto-merge sentence. Same dedupe key as the behind alert. */
export function alertMerged(opts: {
  lane: string;
  project: string | null;
  mainSha: string;
  authorAgentId?: string | null;
  authorName?: string | null;
}): boolean {
  if (countixDenied(opts.project, opts.lane, opts.authorName ? { name: opts.authorName } : null)) return false;
  return pingLaneAboutMain({ ...opts, kind: 'merged' });
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
    void import('./deploy-state.js').then((m) => m.scheduleReconcile('push')).catch(() => {});
    const switches = (project as { pipeline?: { auto_merge_main?: boolean } }).pipeline;
    if (switches?.auto_merge_main === true) fireMainAdvanced(name, tip.sha);
    else notifyBehindLanes(name, repo, tip.sha, tip.subject, project.lane_glob || 'wc-*');
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
    if (re.test(name) && !countixDenied(project, name)) names.add(name);
  }
  try {
    const rows = getDb().prepare(
      "SELECT lane FROM release_freezes WHERE project = ? AND status IN ('open', 'behind-main') AND lane IS NOT NULL",
    ).all(project) as { lane: string }[];
    for (const row of rows) if (!countixDenied(project, row.lane)) names.add(row.lane);
  } catch { /* table missing */ }
  for (const lane of names) {
    if (countixDenied(project, lane)) continue;
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

/**
 * Staging moved. Tell each developer lane that does not contain the new
 * staging SHA. The dedupe key is still the lane plus current main, so a
 * staging-only move does not send a second message inside 30 minutes.
 */
export function alertLanesPastStaging(project: string | null, stagingSha: string): void {
  if (!project || !/^[0-9a-f]{40}$/i.test(stagingSha)) return;
  const repo = projectRepo(project);
  const tip = repo ? mainTip(repo, project) : null;
  if (!repo || !tip) return;
  const glob = getConfig().projects?.[project]?.lane_glob || 'wc-*';
  const re = laneGlobRe(glob);
  const names = new Set<string>();
  const listed = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  for (const short of (listed ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const name = short.replace(/^[^/]+\//, '');
    if (name === 'HEAD' || name === mainSpec(project).branch) continue;
    if (re.test(name) && !countixDenied(project, name)) names.add(name);
  }
  try {
    const rows = getDb().prepare(
      "SELECT lane FROM release_freezes WHERE project = ? AND lane IS NOT NULL",
    ).all(project) as { lane: string }[];
    for (const row of rows) {
      if (countixDenied(project, row.lane)) continue;
      if (re.test(row.lane) || row.lane.startsWith('wc-')) names.add(row.lane);
    }
  } catch { /* table missing */ }
  for (const lane of names) {
    if (countixDenied(project, lane)) continue;
    const ref = laneTipSha(project, lane);
    if (!ref) continue;
    if (isAncestor(repo, stagingSha, ref) !== false) continue;
    pingLaneAboutMain({ lane, project, mainSha: tip.sha, subject: tip.subject, kind: 'moved' });
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
    if (countixDenied(f.project, f.lane, { name: f.author_name })) continue;
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
