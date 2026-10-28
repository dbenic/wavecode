/**
 * A lane has to contain the project's current main. Main's remote and branch
 * name come from the project (`main_remote` / `main_branch`, default
 * origin/main). Pings are one per lane per main SHA.
 */

import { getConfig } from './config.js';
import { gitAncestor, gitRun, gitText } from './git-memo.js';
import { execFileAsync } from './proc.js';
import { getAgent, getDb, listAgents, resolveAgent, type Agent } from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import { deliverSystemLine } from './wire-lines.js';
import { fireMainAdvanced } from './pipeline-hooks.js';
import { syncNoticesPaused } from './lane-sync-notices.js';

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

/**
 * Inside one board build, a ref's SHA is asked once: `withRefMemo` scopes the
 * memo to that pass, so fifty freezes share one origin/main lookup and every
 * card sees the same main. Outside a pass (ingest, pings, tests) git is asked
 * every time, so a tip that just moved is seen at once.
 */
const refMemo = new Map<string, string | null>();
let refMemoDepth = 0;

export function resetRefMemoForTest(): void {
  refMemo.clear();
  refMemoDepth = 0;
}

export function withRefMemo<T>(fn: () => T): T {
  refMemoDepth++;
  try { return fn(); } finally { if (--refMemoDepth === 0) refMemo.clear(); }
}

export async function withRefMemoAsync<T>(fn: () => Promise<T>): Promise<T> {
  refMemoDepth++;
  try { return await fn(); } finally { if (--refMemoDepth === 0) refMemo.clear(); }
}

function isRefLookup(args: string[]): boolean {
  return args.length === 4 && args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === '--quiet';
}

async function git(repo: string, args: string[]): Promise<string | null> {
  const key = refMemoDepth > 0 && isRefLookup(args) ? `${repo}\0${args[3]}` : null;
  if (key && refMemo.has(key)) return refMemo.get(key) ?? null;
  const value = await gitText(repo, args);
  if (key) refMemo.set(key, value);
  return value;
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

export async function resolveMainRef(repo: string, project: string | null): Promise<string | null> {
  const spec = mainSpec(project);
  for (const ref of [spec.ref, spec.branch]) {
    const sha = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (sha && /^[0-9a-f]{40}$/i.test(sha)) return ref;
  }
  return null;
}

/** Memoised for full-SHA pairs (see git-memo); a ref name is asked every time. */
async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean | null> {
  return gitAncestor(repo, ancestor, descendant);
}

async function mainTipSha(repo: string, ref: string): Promise<string | null> {
  const sha = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return sha && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

/** How many commits on main this SHA does not contain. Null when git cannot tell. */
export async function commitsBehind(project: string | null, sha: string): Promise<number | null> {
  const repo = projectRepo(project);
  if (!repo || !/^[0-9a-f]{40}$/i.test(sha)) return null;
  const main = await resolveMainRef(repo, project);
  if (!main) return null;
  const mainSha = await mainTipSha(repo, main);
  if (mainSha) {
    const hit = recallBehind(mainSha, sha);
    if (hit !== undefined) return hit;
  }
  const contains = await isAncestor(repo, mainSha ?? main, sha);
  if (contains === null) return null;
  if (contains) {
    if (mainSha) rememberBehind(mainSha, sha, 0);
    return 0;
  }
  const n = await git(repo, ['rev-list', '--count', `${sha}..${mainSha ?? main}`]);
  if (n == null || !/^\d+$/.test(n)) return null;
  const value = Number(n);
  if (mainSha) rememberBehind(mainSha, sha, value);
  return value;
}

export async function mainTip(repo: string, project: string | null): Promise<{ sha: string; subject: string; ref: string } | null> {
  const ref = await resolveMainRef(repo, project);
  if (!ref) return null;
  const out = await git(repo, ['log', '-1', '--format=%H%x00%s', ref]);
  if (!out) return null;
  const [sha, subject] = out.split('\0');
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) return null;
  return { sha, subject: (subject ?? '').replace(/\s+/g, ' ').slice(0, 120), ref };
}

/** Diff of the lane's own changes against the merge-base with main. Stdout is not trimmed. */
export async function laneOnlyDiff(repo: string, sha: string, mainRef: string): Promise<string | null> {
  const base = await git(repo, ['merge-base', mainRef, sha]);
  if (!base) return null;
  try {
    return await execFileAsync('git', ['-C', repo, 'diff', '--no-color', '--find-renames', base, sha], {
      timeout: 8000, maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * True when `newSha` contains main and its lane-only diff equals `oldSha`'s.
 * A clean merge of main does not change the lane's own patch.
 */
export async function isMergeOnlyDelta(repo: string, oldSha: string, newSha: string, mainRef: string): Promise<boolean> {
  const mainSha = /^[0-9a-f]{40}$/i.test(mainRef) ? mainRef : await mainTipSha(repo, mainRef);
  if (mainSha) {
    const hit = recallDelta(mainSha, oldSha, newSha);
    if (hit !== undefined) return hit;
  }
  if (await isAncestor(repo, mainSha ?? mainRef, newSha) !== true) {
    if (mainSha) rememberDelta(mainSha, oldSha, newSha, false);
    return false;
  }
  const before = await laneOnlyDiff(repo, oldSha, mainSha ?? mainRef);
  const after = await laneOnlyDiff(repo, newSha, mainSha ?? mainRef);
  if (before == null || after == null) return false;
  const value = before === after;
  if (mainSha) rememberDelta(mainSha, oldSha, newSha, value);
  return value;
}

export async function changedFiles(repo: string, ref: string, mainRef: string): Promise<string[]> {
  const mainSha = /^[0-9a-f]{40}$/i.test(mainRef) ? mainRef : null;
  const refSha = /^[0-9a-f]{40}$/i.test(ref) ? ref : null;
  if (mainSha && refSha) {
    const hit = recallFiles(mainSha, refSha);
    if (hit) return hit;
  }
  const base = await git(repo, ['merge-base', mainSha ?? mainRef, refSha ?? ref]);
  if (!base) return [];
  const out = await git(repo, ['diff', '--name-only', base, refSha ?? ref]);
  const files = out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  if (mainSha && refSha) rememberFiles(mainSha, refSha, files);
  return files;
}

async function resolveMainSha(repo: string, project: string | null): Promise<{ ref: string; sha: string } | null> {
  const spec = mainSpec(project);
  for (const ref of [spec.ref, spec.branch]) {
    const sha = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (sha && /^[0-9a-f]{40}$/i.test(sha)) return { ref, sha };
  }
  return null;
}

/**
 * Main's SHA through the per-pass ref memo. 28 Oct 2026: the deploy reconcile asked git for
 * origin/main once per card (10 spawns a second); inside a pass this is one ask.
 */
export async function mainRefSha(repo: string, project: string | null): Promise<string | null> {
  return (await resolveMainSha(repo, project))?.sha ?? null;
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
/** The behind-main nudge for an open freeze (reconcile pass) repeats at most once a day per lane. */
const FREEZE_NUDGE_REPEAT_MS = 24 * 60 * 60 * 1000;
/** An open freeze whose lane has not been pushed for this long is closed as stale. */
const STALE_FREEZE_MS = 48 * 60 * 60 * 1000;
/** An open freeze whose commit the repo still does not have after this long is closed as stale. */
const UNKNOWN_SHA_STALE_MS = 24 * 60 * 60 * 1000;
export const FREEZE_STALE = 'freeze.stale';
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
      // entity_type first so idx_events_entity serves it; (type, entity_id) alone scans the whole table
      "SELECT payload_json, created_at FROM events WHERE entity_type = 'lane' AND entity_id = ? AND type = ? ORDER BY id DESC LIMIT 1",
    ).get(pingKey(lane, mainSha), MAIN_PING) as { payload_json: string | null; created_at: string } | undefined;
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

async function laneTipSha(project: string | null, lane: string): Promise<string | null> {
  const repo = projectRepo(project);
  if (!repo) return null;
  const spec = mainSpec(project);
  const remote = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${spec.remote}/${lane}^{commit}`]);
  if (remote && /^[0-9a-f]{40}$/i.test(remote)) return remote;
  const local = await git(repo, ['rev-parse', '--verify', '--quiet', `${lane}^{commit}`]);
  return local && /^[0-9a-f]{40}$/i.test(local) ? local : null;
}

async function stillBehind(project: string | null, lane: string): Promise<boolean> {
  const tip = await laneTipSha(project, lane);
  if (!tip) return false;
  const n = await commitsBehind(project, tip);
  return n != null && n > 0;
}

/** A PASS on a SHA that does not contain this main still counts as unreviewed. */
async function stillUnreviewed(project: string | null, lane: string, mainSha: string): Promise<boolean> {
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
    if (await isAncestor(repo, mainSha, row.sha) === true) return false;
  }
  return true;
}

type DenyHandle = { name?: string | null; alias?: string | null };

function pipelineHandles(project: string, key: 'review_deny' | 'agent_deny' | 'lane_deny'): string[] {
  const raw = getConfig().projects?.[project]?.pipeline?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
}

function automationDenySet(project: string): Set<string> {
  const deny = new Set<string>();
  for (const handle of [...pipelineHandles(project, 'review_deny'), ...pipelineHandles(project, 'agent_deny')]) {
    deny.add(handle.trim().toLowerCase());
  }
  return deny;
}

function handleDenied(deny: Set<string>, agent: DenyHandle | null | undefined): boolean {
  if (!agent || deny.size === 0) return false;
  if (agent.name && deny.has(agent.name.toLowerCase())) return true;
  return !!agent.alias && deny.has(agent.alias.toLowerCase());
}

function laneGlobDenied(project: string, lane: string): boolean {
  return pipelineHandles(project, 'lane_deny').some((glob) => {
    try { return laneGlobRe(glob.trim()).test(lane); } catch { return false; }
  });
}

/** The agent a `wc-<name>` lane belongs to, when one is registered. */
function registeredLaneAgent(lane: string): DenyHandle | null {
  const bare = lane.replace(/^wc-/i, '');
  try {
    return listAgents().find((a) =>
      a.tmux_session === lane
      || a.name.toLowerCase() === bare.toLowerCase()
      || a.name.toLowerCase() === lane.toLowerCase()
      || a.alias?.toLowerCase() === bare.toLowerCase()
      || a.alias?.toLowerCase() === lane.toLowerCase(),
    ) ?? null;
  } catch {
    return null;
  }
}

/**
 * `review_deny` and `agent_deny` (name or alias) get no lane automation.
 * A lane is denied when it matches `lane_deny`, or when `wc-<name>` names a denied seat.
 */
export function laneAutomationDenied(project: string | null, agent: DenyHandle | null, lane?: string | null): boolean {
  if (!project) return false;
  if (lane && laneGlobDenied(project, lane)) return true;
  const deny = automationDenySet(project);
  if (handleDenied(deny, agent)) return true;
  if (!lane) return false;
  const bare = lane.replace(/^wc-/i, '');
  if (handleDenied(deny, { name: bare, alias: lane })) return true;
  const implied = registeredLaneAgent(lane);
  return implied ? handleDenied(deny, implied) : false;
}

function authorForLane(lane: string, authorAgentId: string | null, authorName: string | null, project: string | null): Agent | null {
  let agent: Agent | null = null;
  if (authorAgentId) {
    const found = getAgent(authorAgentId);
    if (found.ok) agent = found.data;
  }
  if (!agent && authorName) {
    const found = resolveAgent(authorName);
    if (found.ok) agent = found.data;
  }
  if (!agent) {
    const bare = lane.replace(/^wc-/, '');
    agent = listAgents().find((a) => a.tmux_session === lane || a.name === bare || a.name === lane || a.alias === bare) ?? null;
  }
  if (!agent || laneAutomationDenied(project, agent, lane)) return null;
  return agent;
}

/**
 * One plain alert per lane per main SHA. The same sentence is used when main
 * moves, staging moves past the lane, or Stage is refused for being behind.
 * A second send inside 30 minutes is dropped. After 30 minutes it is sent
 * again only while the lane is still behind and still has no PASS on a SHA
 * that contains this main. `merged` is the auto-merge sentence and shares
 * the same dedupe key. `review_deny`, `agent_deny`, and `lane_deny` are not delivered to.
 */
/** (lane, main SHA) pairs found no longer behind or already reviewed: not re-asked for REPEAT_MS. */
const caughtUp = new Map<string, number>();

export function resetMainPingMemoForTest(): void {
  caughtUp.clear();
}

export const LANE_RETIRED = 'lane.retired';

/**
 * `git cherry <main> <tip>` empty, or every line `-`: the lane has no commit that main lacks
 * (its tip is a merge of main, or its commits landed through another merge). Null when git
 * cannot answer.
 */
export async function laneHasNothingMainLacks(repo: string, mainRef: string, tip: string): Promise<boolean | null> {
  const out = await git(repo, ['cherry', mainRef, tip]);
  if (out === null) return null;
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length === 0 || lines.every((l) => l.startsWith('-'));
}

/**
 * Retire a lane whose work is all on main: its open, behind-main and stale freezes become
 * `merged` (superseded by main), one `lane.retired` event per lane and tip, and no more
 * behind-main pings. The branch is left alone. Returns the number of freezes closed.
 */
export function retireLane(project: string | null, lane: string, tip: string, why: string): number {
  let n = 0;
  try {
    const r = getDb().prepare(
      "UPDATE release_freezes SET status = 'merged', superseded_by = 'main', updated_at = datetime('now') WHERE lane = ? AND (project = ? OR ? IS NULL) AND status IN ('open', 'behind-main', 'stale')",
    ).run(lane, project, project);
    n = r.changes;
  } catch { /* no freeze table */ }
  const key = `${lane}@${tip.slice(0, 8)}`;
  let seen = false;
  try { seen = !!getDb().prepare('SELECT id FROM events WHERE type = ? AND entity_id = ? LIMIT 1').get(LANE_RETIRED, key); } catch { /* none */ }
  if (!seen) {
    emit(LANE_RETIRED, 'lane', key, { lane, project, tip, why, freezes_closed: n }, null);
    logger.info({ lane, project, tip, why, freezes_closed: n }, 'Lane retired: nothing main lacks');
  }
  return n;
}

/**
 * Retire instead of pinging when the lane has no commit main lacks. The cherry answer is
 * remembered per lane, tip and main for 10 minutes so a reconcile pass does not re-run git for
 * every lane every time.
 */
const retiredMemo = new Map<string, { at: number; retired: boolean }>();
export async function retireIfNothingMainLacks(project: string | null, lane: string): Promise<boolean> {
  const repo = projectRepo(project);
  if (!repo) return false;
  const tip = await laneTipSha(project, lane);
  if (!tip) return false;
  const mainRef = await resolveMainRef(repo, project);
  if (!mainRef) return false;
  const mainSha = await mainTipSha(repo, mainRef);
  const key = `${lane}@${tip}@${mainSha ?? mainRef}`;
  const memo = retiredMemo.get(key);
  if (memo && nowMs() - memo.at < 10 * 60_000) return memo.retired;
  const nothing = await laneHasNothingMainLacks(repo, mainRef, tip);
  if (nothing === null) return false;
  retiredMemo.set(key, { at: nowMs(), retired: nothing });
  if (!nothing) return false;
  retireLane(project, lane, tip, `git cherry ${mainRef} ${lane} is empty: every commit of the lane is on main`);
  return true;
}

export function resetLaneRetireMemoForTest(): void { retiredMemo.clear(); }

export async function pingLaneAboutMain(opts: {
  lane: string;
  project: string | null;
  mainSha: string;
  subject?: string | null;
  authorAgentId?: string | null;
  authorName?: string | null;
  kind: 'freeze' | 'moved' | 'merged';
}): Promise<boolean> {
  if (!opts.lane || !opts.mainSha) return false;
  if (laneAutomationDenied(opts.project, opts.authorName ? { name: opts.authorName } : null, opts.lane)) return false;
  // A paused lane skips the notice only. Freeze status and Stage eligibility are decided by the caller.
  if (syncNoticesPaused(opts.lane)) return false;
  // A lane with no commit main lacks is retired, not pinged (rule of 26 Oct 2026).
  if (opts.kind !== 'merged' && await retireIfNothingMainLacks(opts.project, opts.lane)) return false;
  const key = pingKey(opts.lane, opts.mainSha);
  const latest = latestPing(opts.lane, opts.mainSha);
  const repeat = opts.kind === 'freeze' ? FREEZE_NUDGE_REPEAT_MS : REPEAT_MS;
  // The freeze nudge repeats once a day per lane, whatever main is at: keyed per main SHA it
  // fired once per main move (28 Oct 2026: 56 nudges on 26 lanes in 80 min, main moved 5 times).
  if (opts.kind === 'freeze' && laneNudgedRecently(opts.lane, repeat)) return false;
  if (latest) {
    if (nowMs() - latest.at < repeat) return false;
    // A lane that has caught up with this main cannot fall behind the same main again, so
    // the git questions are asked once per lane and main, not on every board refresh.
    const settled = caughtUp.get(key);
    if (settled !== undefined && nowMs() - settled < REPEAT_MS) return false;
    if (!(await stillBehind(opts.project, opts.lane)) || !(await stillUnreviewed(opts.project, opts.lane, opts.mainSha))) {
      caughtUp.set(key, nowMs());
      return false;
    }
  }
  const agent = authorForLane(opts.lane, opts.authorAgentId ?? null, opts.authorName ?? null, opts.project);
  if (!agent || laneAutomationDenied(opts.project, agent, opts.lane)) return false;
  const text = opts.kind === 'merged' ? mergedMainAlert(opts.lane) : behindMainAlert(opts.lane);
  deliverSystemLine(agent, text, { kind: 'info', source: 'main' });
  emit(MAIN_PING, 'lane', pingKey(opts.lane, opts.mainSha), {
    lane: opts.lane, project: opts.project, main_sha: opts.mainSha, kind: opts.kind, at: nowMs(),
  }, null);
  return true;
}

/** The behind-main sentence, deduped per lane per current main SHA. */
export async function alertBehind(opts: {
  lane: string;
  project: string | null;
  authorAgentId?: string | null;
  authorName?: string | null;
}): Promise<boolean> {
  if (laneAutomationDenied(opts.project, opts.authorName ? { name: opts.authorName } : null, opts.lane)) return false;
  const repo = projectRepo(opts.project);
  const tip = repo ? await mainTip(repo, opts.project) : null;
  if (!tip) return false;
  return pingLaneAboutMain({
    lane: opts.lane, project: opts.project, mainSha: tip.sha, subject: tip.subject,
    authorAgentId: opts.authorAgentId, authorName: opts.authorName, kind: 'moved',
  });
}

/** Clean auto-merge sentence. Same dedupe key as the behind alert. */
export async function alertMerged(opts: {
  lane: string;
  project: string | null;
  mainSha: string;
  authorAgentId?: string | null;
  authorName?: string | null;
}): Promise<boolean> {
  if (laneAutomationDenied(opts.project, opts.authorName ? { name: opts.authorName } : null, opts.lane)) return false;
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
export async function observeRepo(repo: string): Promise<void> {
  let projects: Record<string, { repo?: string; lane_glob?: string }> = {};
  try { projects = getConfig().projects ?? {}; } catch { return; }
  for (const [name, project] of Object.entries(projects)) {
    if (project.repo !== repo) continue;
    const tip = await mainTip(repo, name);
    if (!tip) continue;
    const key = `main_tip:${name}`;
    const prev = kvGet(key);
    try { kvSet(key, tip.sha); } catch (e) { logger.debug({ error: (e as Error).message }, 'main tip not stored'); continue; }
    if (!prev || prev === tip.sha) continue;
    void import('./deploy-state.js').then((m) => m.scheduleReconcile('push')).catch(() => {});
    const switches = (project as { pipeline?: { auto_merge_main?: boolean } }).pipeline;
    if (switches?.auto_merge_main === true) await fireMainAdvanced(name, tip.sha);
    else await notifyBehindLanes(name, repo, tip.sha, tip.subject, project.lane_glob || 'wc-*');
  }
}

async function notifyBehindLanes(project: string, repo: string, mainSha: string, subject: string, glob: string): Promise<void> {
  const main = await resolveMainRef(repo, project);
  if (!main) return;
  const re = laneGlobRe(glob);
  const listed = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  const names = new Set<string>();
  for (const short of (listed ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const name = short.replace(/^[^/]+\//, '');
    if (name === 'HEAD' || name === mainSpec(project).branch) continue;
    if (re.test(name) && !laneAutomationDenied(project, null, name)) names.add(name);
  }
  try {
    const rows = getDb().prepare(
      "SELECT lane FROM release_freezes WHERE project = ? AND status IN ('open', 'behind-main') AND lane IS NOT NULL",
    ).all(project) as { lane: string }[];
    for (const row of rows) if (!laneAutomationDenied(project, null, row.lane)) names.add(row.lane);
  } catch { /* table missing */ }
  for (const lane of names) {
    if (laneAutomationDenied(project, null, lane)) continue;
    const ref = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${mainSpec(project).remote}/${lane}^{commit}`])
      ?? await git(repo, ['rev-parse', '--verify', '--quiet', `${lane}^{commit}`]);
    if (!ref || !/^[0-9a-f]{40}$/i.test(ref)) continue;
    const behind = await isAncestor(repo, main, ref);
    if (behind !== false) continue;
    if (await retireIfNothingMainLacks(project, lane)) continue;
    await pingLaneAboutMain({ lane, project, mainSha, subject, kind: 'moved' });
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
export async function alertLanesPastStaging(project: string | null, stagingSha: string): Promise<void> {
  if (!project || !/^[0-9a-f]{40}$/i.test(stagingSha)) return;
  const repo = projectRepo(project);
  const tip = repo ? await mainTip(repo, project) : null;
  if (!repo || !tip) return;
  const glob = getConfig().projects?.[project]?.lane_glob || 'wc-*';
  const re = laneGlobRe(glob);
  const names = new Set<string>();
  const listed = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  for (const short of (listed ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    const name = short.replace(/^[^/]+\//, '');
    if (name === 'HEAD' || name === mainSpec(project).branch) continue;
    if (re.test(name) && !laneAutomationDenied(project, null, name)) names.add(name);
  }
  try {
    const rows = getDb().prepare(
      "SELECT lane FROM release_freezes WHERE project = ? AND lane IS NOT NULL",
    ).all(project) as { lane: string }[];
    for (const row of rows) {
      if (laneAutomationDenied(project, null, row.lane)) continue;
      if (re.test(row.lane) || row.lane.startsWith('wc-')) names.add(row.lane);
    }
  } catch { /* table missing */ }
  for (const lane of names) {
    if (laneAutomationDenied(project, null, lane)) continue;
    const ref = await laneTipSha(project, lane);
    if (!ref) continue;
    if (await isAncestor(repo, stagingSha, ref) !== false) continue;
    await pingLaneAboutMain({ lane, project, mainSha: tip.sha, subject: tip.subject, kind: 'moved' });
  }
}

/** Latest nudge for this lane, whatever main SHA it named. A new main tip must not ping again inside 30 minutes. */
function autoMergeMain(project: string | null): boolean {
  if (!project) return false;
  try { return getConfig().projects?.[project]?.pipeline?.auto_merge_main === true; } catch { return false; }
}

function freezeAgeMs(createdAt: string): number {
  const at = Date.parse(createdAt.includes('T') ? createdAt : `${createdAt.replace(' ', 'T')}Z`);
  return Number.isFinite(at) ? at : nowMs();
}

/** True when the repo has the commit; null answers (git could not say) count as known. */
async function commitKnown(repo: string, sha: string): Promise<boolean> {
  const r = await gitRun(repo, ['cat-file', '-e', `${sha}^{commit}`], 5000);
  return r.status !== 128;
}

function closeStaleFreeze(f: FreezeRow & { created_at: string }, why: string): void {
  try {
    getDb().prepare(
      "UPDATE release_freezes SET status = 'stale', decision_reason = ?, updated_at = datetime('now') WHERE sha = ? AND status IN ('open', 'behind-main')",
    ).run(why, f.sha);
  } catch { return; }
  emit(FREEZE_STALE, 'run', f.sha, { sha: f.sha, project: f.project, lane: f.lane, why }, null);
  const agent = authorForLane(f.lane ?? '', f.author_agent_id ?? null, f.author_name ?? null, f.project);
  if (agent) deliverSystemLine(agent, `[from WaveCode] freeze ${f.sha.slice(0, 8)} on ${f.lane} closed as stale: ${why}. Push and freeze again when the lane is live.`, { kind: 'info', source: 'main' });
  logger.info({ sha: f.sha, lane: f.lane, project: f.project, why }, 'Freeze closed as stale');
}

/** Lane → the agent whose workspace has it checked out; computed once per reconcile pass. */
let checkedOutMemo: { at: number; map: Map<string, Agent> } | null = null;
async function lanesCheckedOut(): Promise<Map<string, Agent>> {
  if (checkedOutMemo && nowMs() - checkedOutMemo.at < 60_000) return checkedOutMemo.map;
  const map = new Map<string, Agent>();
  for (const agent of listAgents()) {
    if (!agent.workspace) continue;
    const branch = await git(agent.workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch && branch !== 'HEAD' && !map.has(branch)) map.set(branch, agent);
  }
  checkedOutMemo = { at: nowMs(), map };
  return map;
}
export function resetLanesCheckedOutForTest(): void { checkedOutMemo = null; }

function laneNudgedRecently(lane: string, within = REPEAT_MS): boolean {
  try {
    const rows = getDb().prepare(
      "SELECT entity_id, payload_json, created_at FROM events WHERE entity_type = 'lane' AND type = ? ORDER BY id DESC LIMIT 200",
    ).all(MAIN_PING) as { entity_id: string; payload_json: string | null; created_at: string }[];
    const prefix = `${lane}:`;
    const row = rows.find((item) => item.entity_id.startsWith(prefix));
    if (!row) return false;
    let at = 0;
    if (row.payload_json) {
      const payload = JSON.parse(row.payload_json) as { at?: unknown };
      if (typeof payload.at === 'number') at = payload.at;
    }
    if (!at) {
      const parsed = Date.parse(row.created_at.includes('T') ? row.created_at : `${row.created_at.replace(' ', 'T')}Z`);
      at = Number.isNaN(parsed) ? 0 : parsed;
    }
    return nowMs() - at < within;
  } catch {
    return false;
  }
}

/**
 * Open freezes whose SHA no longer contains main become behind-main.
 * Only the newest freeze on a lane is considered. A tip that is only a merge
 * of main (no new lane commits) is not marked and not pinged — that nudge is
 * what left one lane with a pile of stale freezes. The same lane is not
 * nudged again inside 30 minutes, even when main moves again.
 */
export async function reconcileBehindFreezes(): Promise<void> {
  let rows: Array<FreezeRow & { created_at: string }> = [];
  try {
    rows = getDb().prepare(
      "SELECT sha, project, lane, status, author_agent_id, author_name, created_at FROM release_freezes WHERE status IN ('open', 'behind-main') ORDER BY created_at DESC, rowid DESC",
    ).all() as Array<FreezeRow & { created_at: string }>;
  } catch {
    return;
  }
  const seen = new Set<string>();
  for (const f of rows) {
    const key = `${f.project ?? ''}\0${f.lane ?? f.sha}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (laneAutomationDenied(f.project, { name: f.author_name }, f.lane)) continue;
    const repo = projectRepo(f.project);
    // 28 Oct 2026: six freezes on commits nobody ever pushed sat open for three days; every pass
    // asked git about them, and the partial clone went to the remote for each ask.
    if (repo && nowMs() - freezeAgeMs(f.created_at) >= UNKNOWN_SHA_STALE_MS && !(await commitKnown(repo, f.sha))) {
      closeStaleFreeze(f, `commit ${f.sha.slice(0, 8)} is not in the repo after a day (never pushed, or rewritten)`);
      continue;
    }
    const mainRef = repo ? await resolveMainRef(repo, f.project) : null;
    const tip = f.lane ? await laneTipSha(f.project, f.lane) : null;
    if (repo && mainRef && tip && tip !== f.sha && await isMergeOnlyDelta(repo, f.sha, tip, mainRef)) continue;
    if (f.lane && await retireIfNothingMainLacks(f.project, f.lane)) continue;
    const n = await commitsBehind(f.project, f.sha);
    if (n == null || n <= 0) continue;
    if (f.status === 'open') {
      try {
        getDb().prepare("UPDATE release_freezes SET status = 'behind-main', updated_at = datetime('now') WHERE sha = ? AND status = 'open'").run(f.sha);
      } catch { /* ignore */ }
    }
    const main = repo ? await mainTip(repo, f.project) : null;
    if (!main || !f.lane) continue;
    // No push on the lane for 48 h: the freeze is abandoned. Close it as stale (the queue drops
    // it) and say so once; a new push and freeze reopen the lane. 28 Oct 2026: open freezes from
    // days ago drew 54 nudges a day each.
    if (tip && tip === f.sha && nowMs() - freezeAgeMs(f.created_at) >= STALE_FREEZE_MS) {
      closeStaleFreeze(f, 'no push on the lane for 48 h');
      continue;
    }
    // When WaveCode syncs main itself (auto_merge_main) and a seat has the lane checked out, the
    // sync pass merges, pushes and refreezes, or tells the author what blocks it. The nudge is
    // for a lane nobody has checked out.
    if (autoMergeMain(f.project) && (await lanesCheckedOut()).has(f.lane)) continue;
    if (laneNudgedRecently(f.lane, FREEZE_NUDGE_REPEAT_MS)) continue;
    await pingLaneAboutMain({
      lane: f.lane, project: f.project, mainSha: main.sha, subject: main.subject,
      authorAgentId: f.author_agent_id, authorName: f.author_name, kind: 'freeze',
    });
  }
}
