/**
 * Hands-free lane pipeline. Every step is a per-project switch and defaults
 * off. Production is never requested from here: the only staging call uses
 * target 'staging' and requested_by 'auto'.
 *
 * Auto-freeze merges a clean origin/main, pushes the lane branch through the
 * configured command, runs the quick check, and writes a freeze note the
 * existing parser already reads. Auto-gate queues one full run per SHA.
 * Auto-review picks the least-loaded eligible seat. Preference tiers come
 * first, then the author-glob pool, the routing map, and the ladder. Never
 * the author, a denied name, or the author's other seats. Auto-stage waits for PASS plus GREEN, then a FIFO
 * slot (one lane until Ready for prod or the pin expires).
 */

import fs from 'node:fs';
import { execFileAsync } from './proc.js';
import path from 'node:path';
import { getConfig, type ProjectConfig } from './config.js';
import { getAgent, getDb, getRun, listAgents, listAllAgentTags, type Agent, type Result } from './db.js';
import { emit } from './event-bus.js';
import { pingReviewersForGreenSha } from './gate-ping.js';
import { alertBehind, alertMerged, changedFiles, commitsBehind, isMergeOnlyDelta, laneAutomationDenied, laneHasNothingMainLacks, mainSpec, mainTip, projectRepo, resolveMainRef, retireLane } from './lane-main.js';
import logger from './logger.js';
import { notify } from './notifications.js';
import { pipelineHooks } from './pipeline-hooks.js';
import { workspaceMatches } from './project-gate.js';
import { getFreeze, ingestFreezeFile, listFreezes, setFreezeGate, setFreezeReviewer, viewShaChecks, type ReleaseFreeze } from './release-freezes.js';
import { prodDrift, productionSha } from './deployable.js';
import { recordsFor } from './gate-status.js';
import { gateWordsFor, recordGateResult } from './gate-status.js';
import { pickReviewer } from './reviewer-ladder.js';
import { readLaneTests, shaChecks, suiteNames, testsConfigured } from './test-runs.js';
import { getRelease, listReleases, requestRelease, type ReleaseRequest } from './releases.js';
import { assignmentFacts, loadFor, loadMemo, minCapacityPct, projectReassignMs, reviewEvents, SAME_OWNER_POOL_NOTE, sameOwnerPoolReviewer, selectReviewer, shouldReassign, type ReviewerLoad } from './reviewer-assign.js';
import { firstPassFor, firstPassHooks, overdueFirstPasses, requestFirstPass, type FirstPassResult } from './first-pass.js';
import { deliverSystemLine, tellDriverSeats } from './wire-lines.js';
import { candidateHooks, overdueCandidateReviews, requestCandidateReview, type CandidateResult } from './candidate-review.js';

export const PIPELINE_ACTION = 'pipeline.action';
const FROZEN = 'pipeline.frozen';
const GATED = 'pipeline.gate';
const LIVE = 'pipeline.live';

export interface PipelineSwitches {
  auto_freeze: boolean;
  auto_gate: boolean;
  auto_review: boolean;
  auto_stage: boolean;
  auto_merge_main: boolean;
  quick_check_command: string[] | null;
  push_command: string[] | null;
  gate_command: string[] | null;
  review_routes: Record<string, string>;
  /** `review_deny` plus `agent_deny`. A denied agent is never chosen as a reviewer. */
  review_deny: string[];
  lane_deny: string[];
  agent_deny: string[];
  /** Vendor (`claude`, `codex`) → preferred reviewer names. First non-empty tier. */
  reviewer_prefer: Record<string, string[]>;
  /** Author-name glob → seats allowed to review that person, including an own seat. */
  reviewer_pool_by_author_glob: Record<string, string[]>;
  /** Minutes a busy seat may hold a review with no verdict. 0 disables. Default 15. */
  review_reassign_minutes: number;
  freeze_dir: string | null;
  /** One remote run per freeze: no separate quick check, the gate is submitted at freeze time. */
  gate_with_quick: boolean;
  gate_timeout_min: number;
  quick_check_timeout_min: number;
  /** Full gates in flight at once per project. The rest wait here, not on the dispatcher. */
  gate_max_inflight: number;
  /** Lane size warning threshold in changed files. 0 disables. */
  max_lane_files: number;
  /** Rolling candidate review after each main advance. Null = follow `auto_review`. */
  candidate_review: boolean | null;
  candidate_review_timeout_min: number;
  /** Gateway cancel for a superseded run (`{sha}`); null = abandon the local submission only. */
  cancel_command: string[] | null;
  /** Open-ladder allowlist (lowercased). Empty = anyone not denied. */
  reviewer_allow: string[];
  /** Shared service profiles (lowercased): seats on one are independent of each other. */
  service_profiles: string[];
}

type ExecResult = { code: number; stdout: string };
export interface ExecOptions { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }
type ExecForTest = (argv: string[], opts: ExecOptions) => ExecResult | Promise<ExecResult>;
let execForTest: ExecForTest | null = null;

export function setPipelineExecForTest(fn: ExecForTest | null): void {
  execForTest = fn;
}

export function pipelineOf(project: string | null): PipelineSwitches {
  const raw: ProjectConfig['pipeline'] = project ? getConfig().projects?.[project]?.pipeline : undefined;
  const off: PipelineSwitches = {
    auto_freeze: false, auto_gate: false, auto_review: false, auto_stage: false, auto_merge_main: false,
    quick_check_command: null, push_command: null, gate_command: null, review_routes: {}, review_deny: [],
    lane_deny: [], agent_deny: [], reviewer_prefer: {}, reviewer_pool_by_author_glob: {},
    review_reassign_minutes: 15, freeze_dir: null,
    gate_with_quick: false, gate_timeout_min: 120, quick_check_timeout_min: 20, gate_max_inflight: 3, max_lane_files: 40,
    candidate_review: null, candidate_review_timeout_min: 45, cancel_command: null,
    reviewer_allow: [], service_profiles: [],
  };
  if (!raw) return off;
  const reviewDeny = (raw.review_deny ?? []).map((s) => s.toLowerCase());
  const agentDeny = (raw.agent_deny ?? []).map((s) => s.toLowerCase());
  return {
    auto_freeze: raw.auto_freeze === true,
    auto_gate: raw.auto_gate === true,
    auto_review: raw.auto_review === true,
    auto_stage: raw.auto_stage === true,
    auto_merge_main: raw.auto_merge_main === true,
    quick_check_command: raw.quick_check_command ?? null,
    push_command: raw.push_command ?? null,
    gate_command: raw.gate_command ?? null,
    review_routes: raw.review_routes ?? {},
    review_deny: [...new Set([...reviewDeny, ...agentDeny])],
    lane_deny: raw.lane_deny ?? [],
    agent_deny: agentDeny,
    reviewer_prefer: lowerMap(raw.reviewer_prefer),
    reviewer_pool_by_author_glob: lowerMap(raw.reviewer_pool_by_author_glob),
    review_reassign_minutes: reassignMinutes(raw.review_reassign_minutes),
    freeze_dir: raw.freeze_dir ?? null,
    gate_with_quick: raw.gate_with_quick === true,
    gate_timeout_min: minutesOr(raw.gate_timeout_min, 120),
    quick_check_timeout_min: minutesOr(raw.quick_check_timeout_min, 20),
    gate_max_inflight: Math.max(1, minutesOr(raw.gate_max_inflight, 3)),
    max_lane_files: minutesOr(raw.max_lane_files, 40),
    candidate_review: typeof raw.candidate_review === 'boolean' ? raw.candidate_review : null,
    candidate_review_timeout_min: Math.max(1, minutesOr(raw.candidate_review_timeout_min, 45)),
    cancel_command: raw.cancel_command?.length ? raw.cancel_command : null,
    reviewer_allow: (raw.reviewer_allow ?? []).map((s) => s.toLowerCase()),
    service_profiles: (raw.service_profiles ?? []).map((s) => s.toLowerCase()),
  };
}

function minutesOr(raw: number | undefined, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

function lowerMap(raw: Record<string, string[]> | undefined): Record<string, string[]> {
  if (!raw) return {};
  const out: Record<string, string[]> = {};
  for (const [key, names] of Object.entries(raw)) {
    out[key.toLowerCase()] = (names ?? []).map((name) => name.toLowerCase());
  }
  return out;
}

function reassignMinutes(raw: number | undefined): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 15;
  return Math.min(1440, Math.max(0, raw));
}

function fill(template: string[], vars: Record<string, string>): string[] {
  return template.map((arg) => arg.replace(/\{(workspace|lane|sha|remote|project|checkout)\}/g, (_, key: string) => vars[key] ?? ''));
}

/**
 * Environment for a quick check or gate: the exact SHA and lane, and the
 * author's name as the dispatcher's `who` (agents set COUNTIX_REMOTE_TEST_WHO
 * themselves today; the receipts keep attributing the run to the author).
 */
function runEnv(vars: { sha: string; lane: string; author: string; checkout?: string }): Record<string, string> {
  const env: Record<string, string> = {
    WAVECODE_SHA: vars.sha,
    WAVECODE_LANE: vars.lane,
    WAVECODE_AUTHOR: vars.author,
    // The gateway keeps one queued run per `who` and cancels the older one ("superseded by …, one queued
    // run per agent"). Agents submit as <name>.<sha9>; WaveCode's runs for one author must not cancel each other.
    COUNTIX_REMOTE_TEST_WHO: `${vars.author}.${vars.sha.slice(0, 9)}`,
  };
  if (vars.checkout) env.WAVECODE_CHECKOUT = vars.checkout;
  return env;
}

/** Branch names git accepts, with no shell metacharacters. */
const SAFE_LANE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const PROTECTED_BRANCHES = new Set(['main', 'master', 'HEAD', 'trunk', 'develop', 'development', 'release', 'production', 'staging']);

function laneGlobRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

/**
 * A lane may be merged or pushed only when it is a safe ref, matches the
 * project lane glob, and is not main or another protected branch.
 */
export function laneRefError(project: string, lane: string): string | null {
  if (!SAFE_LANE.test(lane)) return `refusing ${lane}: not a safe branch name`;
  const projectCfg = getConfig().projects?.[project];
  const mainBranch = projectCfg?.main_branch?.trim() || 'main';
  if (lane === mainBranch || PROTECTED_BRANCHES.has(lane)) return `refusing ${lane}: protected branch`;
  const glob = projectCfg?.lane_glob?.trim() || 'wc-*';
  if (!laneGlobRe(glob).test(lane)) return `refusing ${lane}: not a developer lane`;
  if (laneAutomationDenied(project, null, lane)) return `refusing ${lane}: denied`;
  return null;
}

async function runArgv(argv: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  if (argv.length === 0) return { code: 1, stdout: '' };
  if (execForTest) return await execForTest(argv, opts);
  try {
    const stdout = await execFileAsync(argv[0], argv.slice(1), {
      timeout: opts.timeoutMs ?? 20000,
      maxBuffer: 4 * 1024 * 1024,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { status?: number | null; code?: number | string | null; stdout?: string; killed?: boolean };
    const code = typeof err.status === 'number' ? err.status : typeof err.code === 'number' ? err.code : 1;
    return { code, stdout: String(err.stdout ?? '') };
  }
}

/**
 * The freeze's exact SHA must already be on the remote lane branch: agents push
 * their lane themselves before they freeze, and WaveCode never pushes for them.
 * Null when it is; otherwise the reason. Unknown repos and lanes are not checked.
 */
export async function pushedShaError(project: string, lane: string | null, sha: string): Promise<string | null> {
  const repo = projectRepo(project);
  if (!repo || !lane || !SAFE_LANE.test(lane)) return null;
  const spec = mainSpec(project);
  try {
    await git(repo, ['fetch', '--quiet', spec.remote, lane]);
  } catch (e) {
    const message = (e as Error).message ?? '';
    if (/couldn't find remote ref|not found|no such ref/i.test(message)) return `${lane} is not on ${spec.remote} — push the lane first`;
    logger.debug({ project, lane, error: message }, 'Lane fetch failed; push check skipped');
    return null;
  }
  try {
    await git(repo, ['merge-base', '--is-ancestor', sha, `${spec.remote}/${lane}`]);
    return null;
  } catch {
    let tip = '';
    try { tip = (await git(repo, ['rev-parse', '--short=9', `${spec.remote}/${lane}`])) || ''; } catch { /* no tip */ }
    return `${sha.slice(0, 9)} is not on ${spec.remote}/${lane}${tip ? ` (remote tip ${tip})` : ''} — push the exact SHA first`;
  }
}

/** A clean detached checkout of the exact SHA for a gate run. Removed by `dropCheckout`. */
async function makeCheckout(project: string, lane: string | null, sha: string): Promise<string | null> {
  const repo = projectRepo(project);
  if (!repo) return null;
  const dir = path.join(path.dirname(repo), '.wavecode-gates', `${path.basename(repo)}-${sha.slice(0, 9)}`);
  try {
    if (lane && SAFE_LANE.test(lane)) {
      try { await git(repo, ['fetch', '--quiet', mainSpec(project).remote, lane]); } catch { /* the SHA may already be local */ }
    }
    if (fs.existsSync(dir)) {
      try { await git(repo, ['worktree', 'remove', '--force', dir]); } catch { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(repo, ['worktree', 'add', '--detach', dir, sha]);
    return dir;
  } catch (e) {
    logger.warn({ project, sha, error: (e as Error).message }, 'Gate checkout failed');
    return null;
  }
}

async function dropCheckout(project: string, dir: string | null): Promise<void> {
  if (!dir) return;
  const repo = projectRepo(project);
  try {
    if (repo) await git(repo, ['worktree', 'remove', '--force', dir]);
  } catch { /* fall through */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  try { if (repo) await git(repo, ['worktree', 'prune']); } catch { /* best effort */ }
}

async function git(repo: string, args: string[]): Promise<string> {
  const out = await execFileAsync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', '-c', 'user.name=wavecode', '-c', 'user.email=wavecode@localhost', ...args], {
    timeout: 15000, maxBuffer: 4 * 1024 * 1024,
  });
  return out.trim();
}

function ensureQueue(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS pipeline_queue (
      sha TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      lane TEXT,
      kind TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

function acted(sha: string, type: string): boolean {
  try {
    const row = getDb().prepare('SELECT id FROM events WHERE type = ? AND entity_id = ? LIMIT 1').get(type, sha) as { id: number } | undefined;
    return !!row;
  } catch {
    return false;
  }
}

function note(project: string, lane: string | null, sha: string, action: string, text: string): void {
  emit(PIPELINE_ACTION, 'run', `${project}:${lane ?? ''}`, { action, sha, project, lane, note: text }, null);
}

export function latestPipelineNote(project: string, lane: string): string | null {
  try {
    const row = getDb().prepare(
      `SELECT payload_json FROM events WHERE type = ? AND entity_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(PIPELINE_ACTION, `${project}:${lane}`) as { payload_json: string | null } | undefined;
    if (!row?.payload_json) return null;
    const payload = JSON.parse(row.payload_json) as { note?: string };
    return payload.note ?? null;
  } catch {
    return null;
  }
}

function projectForWorkspace(workspace: string): string | null {
  const projects = getConfig().projects ?? {};
  const resolved = path.resolve(workspace);
  for (const [name, project] of Object.entries(projects)) {
    if (project.repo && path.resolve(project.repo) === resolved) return name;
    if (project.workspace_match && workspaceMatches(workspace, project.workspace_match)) return name;
  }
  return null;
}

function tell(agentId: string | null, text: string): void {
  if (!agentId) return;
  const agent = getAgent(agentId);
  if (!agent.ok) return;
  deliverSystemLine(agent.data, text, { kind: 'info', source: 'pipeline' });
}

async function headOf(workspace: string): Promise<string | null> {
  try {
    const sha = await git(workspace, ['rev-parse', 'HEAD']);
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

async function branchOf(workspace: string): Promise<string | null> {
  try {
    const name = await git(workspace, ['branch', '--show-current']);
    return name || null;
  } catch {
    return null;
  }
}

/** A checkout owned by a `review_deny` or `agent_deny` seat (name or alias) is not auto-merged. */
function workspaceOwnedByDenied(workspace: string): boolean {
  const resolved = path.resolve(workspace);
  const owners = listAgents().filter((agent) => agent.workspace && path.resolve(agent.workspace) === resolved);
  if (owners.length === 0) return false;
  const project = projectForWorkspace(workspace);
  const names = project ? [project] : Object.keys(getConfig().projects ?? {});
  return owners.some((owner) => names.some((name) => laneAutomationDenied(name, owner)));
}

/** Merge origin/main. A conflict aborts and names the files. A denied owner's workspace is left untouched. Never pushes. */
export async function mergeMainClean(workspace: string, mainRef: string): Promise<{ ok: true } | { ok: false; files: string[]; skipped?: boolean }> {
  if (workspaceOwnedByDenied(workspace)) return { ok: false, files: [], skipped: true };
  try {
    await git(workspace, ['merge', '--no-ff', '--no-edit', '-m', 'merge origin/main', mainRef]);
    return { ok: true };
  } catch {
    let files: string[] = [];
    try {
      files = (await git(workspace, ['diff', '--name-only', '--diff-filter=U'])).split('\n').map((l) => l.trim()).filter(Boolean);
    } catch { /* no unmerged list */ }
    try { await git(workspace, ['merge', '--abort']); } catch { /* already clean, or no merge to abort */ }
    return { ok: false, files };
  }
}

function freezeDir(project: string, pipe: PipelineSwitches): string | null {
  if (pipe.freeze_dir) return pipe.freeze_dir;
  const inbox = getConfig().review?.freeze_inbox ?? [];
  return inbox[0] ?? null;
}

/** A SHA refused by publishFreeze (not on the remote lane) is not re-checked, re-noted or re-told for this long. */
let publishRefusalQuietMs = 2 * 60_000;
export function setPublishRefusalQuietMsForTest(ms: number | null): void { publishRefusalQuietMs = ms ?? 2 * 60_000; }
const refusedPublish = new Map<string, number>();

async function publishFreeze(opts: {
  workspace: string; project: string; lane: string; sha: string; author: Agent; pipe: PipelineSwitches;
}): Promise<Result<{ sha: string }>> {
  const refused = laneRefError(opts.project, opts.lane);
  if (refused) return { ok: false, error: refused };
  // onAuthorDone runs on every pane poll: a refusal said once is enough (28 Oct 2026: one lane
  // drew 16 "not on origin" notes in two minutes).
  const quietKey = `${opts.lane}:${opts.sha}`;
  const refusedAt = refusedPublish.get(quietKey);
  if (refusedAt !== undefined && Date.now() - refusedAt < publishRefusalQuietMs) return { ok: false, error: 'refused recently' };
  const spec = mainSpec(opts.project);
  const vars = { workspace: opts.workspace, lane: opts.lane, sha: opts.sha, remote: spec.remote, project: opts.project, checkout: opts.workspace };
  if (opts.pipe.push_command?.length) {
    const pushed = await runArgv(fill(opts.pipe.push_command, vars), { cwd: opts.workspace, timeoutMs: 60_000 });
    if (pushed.code !== 0) {
      const text = `push of ${opts.lane} failed. The freeze was not written.`;
      tell(opts.author.id, text);
      note(opts.project, opts.lane, opts.sha, 'push', `auto: push failed for ${opts.lane}`);
      return { ok: false, error: text };
    }
  } else {
    // No push command: the author pushed. The exact SHA must be on the remote lane.
    const missing = await pushedShaError(opts.project, opts.lane, opts.sha);
    if (missing) {
      refusedPublish.set(quietKey, Date.now());
      const text = `freeze refused: ${missing}. The freeze was not written.`;
      tell(opts.author.id, text);
      note(opts.project, opts.lane, opts.sha, 'push', `auto: freeze refused — ${missing}`);
      return { ok: false, error: text };
    }
  }
  // With gate_with_quick the full gate is the one remote run per freeze; the quick check is the author's.
  if (opts.pipe.quick_check_command?.length && !opts.pipe.gate_with_quick) {
    const checked = await runArgv(fill(opts.pipe.quick_check_command, vars), {
      cwd: opts.workspace,
      env: runEnv({ sha: opts.sha, lane: opts.lane, author: opts.author.name, checkout: opts.workspace }),
      timeoutMs: Math.max(1, opts.pipe.quick_check_timeout_min) * 60_000,
    });
    if (checked.code !== 0) {
      const text = `quick check failed on ${opts.sha.slice(0, 8)}. The freeze was not written.`;
      tell(opts.author.id, text);
      note(opts.project, opts.lane, opts.sha, 'quick', `auto: quick check failed on ${opts.sha.slice(0, 8)}`);
      return { ok: false, error: text };
    }
  }
  const dir = freezeDir(opts.project, opts.pipe);
  if (!dir) return { ok: false, error: 'no freeze directory' };
  const file = writeFreeze(dir, opts.author.name, opts.project, opts.lane, opts.sha);
  const ingested = await ingestFreezeFile(file);
  if (!ingested.ok) return ingested;
  emit(FROZEN, 'run', opts.sha, { sha: opts.sha, project: opts.project, lane: opts.lane, file }, null);
  note(opts.project, opts.lane, opts.sha, 'freeze', `auto: freeze written on ${opts.sha.slice(0, 8)}`);
  return { ok: true, data: { sha: opts.sha } };
}

function writeFreeze(dir: string, author: string, project: string, lane: string, sha: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${author}-auto-freeze-${sha.slice(0, 8)}.md`);
  const body = [
    `# ${lane} freeze note`,
    '',
    `Project: ${project} · Author: ${author}`,
    `- Lane: \`${lane}\``,
    `- Freeze SHA: \`${sha}\``,
    '',
  ].join('\n');
  fs.writeFileSync(file, body);
  return file;
}

function routeTargetOf(author: Agent, pipe: PipelineSwitches): string | null {
  return pipe.review_routes[author.name]
    ?? (author.alias ? pipe.review_routes[author.alias] : undefined)
    ?? Object.entries(pipe.review_routes).find(([key]) => key.toLowerCase() === author.name.toLowerCase())?.[1]
    ?? null;
}

function reviewTagIds(): Set<string> {
  try {
    const ids = new Set<string>();
    for (const [id, tags] of listAllAgentTags()) {
      if (tags.includes('review')) ids.add(id);
    }
    return ids;
  } catch {
    return new Set();
  }
}

/**
 * Least-loaded eligible reviewer. Independent seats come first: the prefer
 * tier, then the route, the default, tagged reviewers, and the rest of the
 * ladder. A same-person seat is last, and only when the author-glob pool
 * names it.
 */
export function chooseReviewer(author: Agent, pipe: PipelineSwitches, _taskId: string | null, load: (agent: Agent) => ReviewerLoad = loadFor): Agent | null {
  const review = getConfig().review;
  return selectReviewer({
    author,
    agents: listAgents(),
    deny: pipe.review_deny,
    prefer: pipe.reviewer_prefer,
    pools: pipe.reviewer_pool_by_author_glob,
    routeReviewers: Object.values(pipe.review_routes),
    routeTarget: routeTargetOf(author, pipe),
    defaultReviewer: review?.default_reviewer ?? null,
    autoPick: review?.auto_pick !== false,
    reviewTagIds: reviewTagIds(),
    load,
    minCapacityPct: minCapacityPct(),
    allow: pipe.reviewer_allow,
    serviceProfiles: pipe.service_profiles,
  });
}

/** One sentence about a first pass already on file, for the reviewer's ping. */
function firstPassSentence(sha: string): string | null {
  const fp = firstPassFor(sha);
  if (!fp) return null;
  const word = fp.result === 'pass' ? 'PASS' : `NEEDS FIXES (${fp.issues} issue${fp.issues === 1 ? '' : 's'})`;
  return `First pass${fp.seat ? ` by @${fp.seat}` : ''}: ${word}, see ${fp.file} — a checklist, your verdict decides.`;
}

/** A size warning when the lane changes more files than `max_lane_files`. Noted once per SHA. */
async function laneSizeSentence(freeze: ReleaseFreeze, pipe: PipelineSwitches): Promise<string | null> {
  if (!pipe.max_lane_files || !freeze.project) return null;
  const repo = projectRepo(freeze.project);
  if (!repo) return null;
  try {
    const mainRef = await resolveMainRef(repo, freeze.project);
    if (!mainRef) return null;
    const n = (await changedFiles(repo, freeze.sha, mainRef)).length;
    if (n <= pipe.max_lane_files) return null;
    if (!acted(`${freeze.sha}:size`, PIPELINE_ACTION)) {
      emit(PIPELINE_ACTION, 'run', `${freeze.sha}:size`, { action: 'size', sha: freeze.sha, project: freeze.project, lane: freeze.lane, files: n, limit: pipe.max_lane_files, note: `auto: large lane — ${n} files changed (limit ${pipe.max_lane_files})` }, null);
      note(freeze.project, freeze.lane, freeze.sha, 'size', `auto: large lane — ${n} files changed (limit ${pipe.max_lane_files})`);
    }
    return `Large lane: ${n} files changed (limit ${pipe.max_lane_files}) — review in chunks and ask for a split if it is more than one change.`;
  } catch {
    return null;
  }
}

/**
 * The earlier PASS on this lane whose patch this SHA repeats (only main merged since), or null.
 * The merge queue carries that PASS and its api GREEN over (patch-id rule), so such a freeze
 * needs no first pass and no reviewer: only the quick check runs again.
 */
async function carriedPassFreeze(project: string, lane: string, sha: string): Promise<ReleaseFreeze | null> {
  const repo = projectRepo(project);
  const mainRef = repo ? await resolveMainRef(repo, project) : null;
  if (!repo || !mainRef) return null;
  const previous = listFreezes().find((f) => f.project === project && f.lane === lane && f.sha !== sha && f.verdict === 'pass');
  if (!previous || !await isMergeOnlyDelta(repo, previous.sha, sha, mainRef)) return null;
  return previous;
}

async function deltaSentence(project: string, lane: string, sha: string): Promise<string | null> {
  const previous = await carriedPassFreeze(project, lane, sha);
  if (!previous) return null;
  return `delta review: merge only. Previous verdict: ${previous.verdict_path ?? previous.sha}`;
}

async function assignReviewer(freeze: ReleaseFreeze, kind: 'assign' | 'green' = 'assign'): Promise<void> {
  if (!freeze.project || !freeze.author_agent_id) return;
  const pipe = pipelineOf(freeze.project);
  if (!pipe.auto_review) return;
  if (laneAutomationDenied(freeze.project, { name: freeze.author_name }, freeze.lane)) return;
  if (kind === 'green' && freeze.verdict === 'pass') return;
  if (acted(`${freeze.sha}:${kind}`, 'pipeline.review')) return;
  const author = getAgent(freeze.author_agent_id);
  if (!author.ok) return;
  const run = freeze.run_id ? getRun(freeze.run_id) : null;
  const reviewer = chooseReviewer(author.data, pipe, run?.ok ? run.data.task_id : 'none');
  if (!reviewer) {
    const text = `auto: no reviewer for ${freeze.sha.slice(0, 8)} — the route was the author or a denied name, and the ladder had no one else`;
    note(freeze.project, freeze.lane, freeze.sha, 'review', text);
    tell(author.data.id, text);
    return;
  }
  const delta = freeze.lane ? await deltaSentence(freeze.project, freeze.lane, freeze.sha) : null;
  const sha8 = freeze.sha.slice(0, 8);
  const extras = [firstPassSentence(freeze.sha), await laneSizeSentence(freeze, pipe)].filter((s): s is string => !!s);
  const tail = extras.length ? ` ${extras.join(' ')}` : '';
  const text = delta
    ? `[from WaveCode] ${delta}. New SHA ${sha8} on ${freeze.lane}. Read ${freeze.freeze_path ?? 'the freeze note'}. If the code is OK and the gate is still running, write VERDICT: PASS (gate pending).${tail}`
    : `[from WaveCode] Please review freeze ${sha8} on ${freeze.lane ?? 'the lane'} by @${author.data.name}. Read ${freeze.freeze_path ?? 'the freeze note'}. If the code is OK and the gate is still running, write VERDICT: PASS (gate pending).${tail}`;
  deliverSystemLine(reviewer, text, { kind: 'info', source: 'review' });
  emit('pipeline.review', 'run', `${freeze.sha}:${kind}`, {
    sha: freeze.sha, reviewer_id: reviewer.id, kind, assigned_at_ms: Date.now(), reassigned: false,
  }, null);
  if (!freeze.verdict) setFreezeReviewer(freeze.sha, { id: reviewer.id, name: reviewer.name });
  const own = sameOwnerPoolReviewer(author.data, reviewer, pipe.reviewer_pool_by_author_glob, pipe.service_profiles)
    ? ` — ${SAME_OWNER_POOL_NOTE}`
    : '';
  const shown = kind === 'green'
    ? `auto: GREEN landed — re-pinged @${reviewer.alias ?? reviewer.name}${own}`
    : `auto: review requested — pinged @${reviewer.alias ?? reviewer.name}${own}`;
  note(freeze.project, freeze.lane, freeze.sha, 'review', shown);
}

/**
 * An agent asks for a review itself, after development: through the inbox file
 * `<you>-<lane>-review-request-<sha8>.md` or `POST /api/reviews/lanes/request-review`.
 * The freeze note for that SHA must exist (it is what the reviewer reads). A named
 * seat is honoured through the ladder's checks; otherwise the picker chooses the
 * least-loaded eligible seat on a different profile. The ask works whether or
 * not `auto_review` is on, and again on a SHA that was already assigned: a
 * second ask moves the review when the first seat has not answered.
 */
export async function requestReviewFor(
  sha: string,
  opts: { reviewer?: string | null; by: string },
): Promise<Result<{ reviewer: string; sha: string; lane: string | null }>> {
  const freeze = getFreeze(sha);
  if (!freeze) return { ok: false, error: `no freeze note for ${sha.slice(0, 8)}; write the freeze note first, it is what the reviewer reads` };
  if (!freeze.project) return { ok: false, error: 'the freeze names no project' };
  if (freeze.status !== 'open' && freeze.status !== 'behind-main') return { ok: false, error: `freeze ${sha.slice(0, 8)} is ${freeze.status}; freeze the current SHA` };
  if (freeze.verdict === 'pass') return { ok: false, error: `${sha.slice(0, 8)} already has a PASS from @${freeze.reviewer_name ?? '?'}` };
  if (!freeze.author_agent_id) return { ok: false, error: 'the freeze has no author agent' };
  if (laneAutomationDenied(freeze.project, { name: freeze.author_name }, freeze.lane)) return { ok: false, error: `refusing ${freeze.lane ?? sha.slice(0, 8)}: denied` };
  const author = getAgent(freeze.author_agent_id);
  if (!author.ok) return { ok: false, error: 'the author agent is gone' };
  const pipe = pipelineOf(freeze.project);
  const run = freeze.run_id ? getRun(freeze.run_id) : null;
  const taskId = run?.ok ? run.data.task_id : 'none';
  let reviewer: Agent | null;
  if (opts.reviewer?.trim()) {
    const picked = pickReviewer({ agent_id: author.data.id, task_id: taskId }, { explicit: opts.reviewer.trim() });
    if (!picked.ok) return { ok: false, error: picked.reason };
    if (laneAutomationDenied(freeze.project, picked.agent)) return { ok: false, error: `${picked.agent.alias ?? picked.agent.name} is denied` };
    reviewer = picked.agent;
  } else {
    reviewer = chooseReviewer(author.data, pipe, taskId);
    if (!reviewer) return { ok: false, error: 'no eligible reviewer with plan capacity right now; WaveCode asks again on the next pass' };
  }
  const sha8 = sha.slice(0, 8);
  const delta = freeze.lane ? await deltaSentence(freeze.project, freeze.lane, sha) : null;
  const extras = [firstPassSentence(sha), await laneSizeSentence(freeze, pipe)].filter((s): s is string => !!s);
  const tail = extras.length ? ` ${extras.join(' ')}` : '';
  const text = delta
    ? `[from WaveCode] ${delta}. New SHA ${sha8} on ${freeze.lane}, review asked by @${author.data.alias ?? author.data.name}. Read ${freeze.freeze_path ?? 'the freeze note'}. If the code is OK and the gate is still running, write VERDICT: PASS (gate pending).${tail}`
    : `[from WaveCode] @${author.data.alias ?? author.data.name} asks for a review of freeze ${sha8} on ${freeze.lane ?? 'the lane'}. Read ${freeze.freeze_path ?? 'the freeze note'}. If the code is OK and the gate is still running, write VERDICT: PASS (gate pending).${tail}`;
  deliverSystemLine(reviewer, text, { kind: 'info', source: 'review' });
  emit('pipeline.review', 'run', `${sha}:request`, {
    sha, reviewer_id: reviewer.id, kind: 'request', by: opts.by, assigned_at_ms: Date.now(), reassigned: false,
  }, null);
  if (!freeze.verdict) setFreezeReviewer(sha, { id: reviewer.id, name: reviewer.name });
  note(freeze.project, freeze.lane, sha, 'review', `review asked by @${opts.by} — pinged @${reviewer.alias ?? reviewer.name}`);
  return { ok: true, data: { reviewer: reviewer.alias ?? reviewer.name, sha, lane: freeze.lane } };
}

const REQUEST_SHA_RE = /\b([0-9a-f]{40})\b/i;
const REQUEST_LANE_RE = /^\s*(?:[-*>]\s*)?\**\s*(?:lane|branch)\s*\**\s*[:：]\s*\**\s*`?([A-Za-z0-9][A-Za-z0-9._/-]{0,63})`?/im;
const REQUEST_REVIEWER_RE = /^\s*(?:[-*>]\s*)?\**\s*reviewer\s*\**\s*[:：]\s*\**\s*@?([A-Za-z][\w-]*)/im;

/**
 * The inbox form of the ask. Lines: `Lane:` (or the file name), the exact SHA (or
 * the lane's newest open freeze when the SHA is missing), optional `Reviewer: @seat`.
 * The author is told what happened in their pane; nothing else is written.
 */
export async function ingestReviewRequestFile(file: string): Promise<Result<{ reviewer: string; sha: string }>> {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, error: (e as Error).message }; }
  const base = path.basename(file);
  const by = base.match(/^([A-Za-z][\w-]*?)-(?:[\w-]*-)?review-request-/i)?.[1] ?? text.match(/\bauthor\b\**\s*[:：]?\**\s*@?([A-Za-z][\w-]*)/i)?.[1] ?? null;
  const lane = text.match(REQUEST_LANE_RE)?.[1] ?? null;
  const reviewer = text.match(REQUEST_REVIEWER_RE)?.[1] ?? null;
  let sha = text.match(REQUEST_SHA_RE)?.[1]?.toLowerCase() ?? null;
  if (!sha && lane) sha = listFreezes().find((f) => f.lane === lane && (f.status === 'open' || f.status === 'behind-main'))?.sha ?? null;
  const author = by ? listAgents().find((a) => a.name.toLowerCase() === by.toLowerCase() || (a.alias ?? '').toLowerCase() === by.toLowerCase()) ?? null : null;
  const result: Result<{ reviewer: string; sha: string; lane: string | null }> = sha
    ? await requestReviewFor(sha, { reviewer, by: by ?? 'inbox' })
    : { ok: false, error: `${base}: no exact SHA and no open freeze on ${lane ?? 'the lane'}; freeze first, then ask` };
  if (result.ok) {
    tell(author?.id ?? null, `[from WaveCode] review of ${result.data.sha.slice(0, 8)} asked from @${result.data.reviewer} (${base}). Their verdict lands in the inbox.`);
    logger.info({ file, sha, reviewer: result.data.reviewer }, 'Review requested by the author');
  } else {
    tell(author?.id ?? null, `[from WaveCode] review request ${base} not sent: ${result.error}`);
    logger.info({ file, error: result.error }, 'Review request skipped');
  }
  return result.ok ? { ok: true, data: { reviewer: result.data.reviewer, sha: result.data.sha } } : result;
}

/**
 * A review with no verdict that has sat on a busy seat longer than
 * `review_reassign_minutes` moves to the least-loaded eligible seat.
 * The next seat is chosen with the same tier order as the first assignment.
 * Once per freeze, unless the new seat is idle. Returns how many moved.
 */
export function reassignWaitingReviews(now = Date.now()): number {
  let freezes: ReleaseFreeze[] = [];
  try { freezes = listFreezes(); } catch { return 0; }
  const events = reviewEvents();
  const load = loadMemo(events);
  let moved = 0;
  for (const freeze of freezes) {
    if (!freeze.project || !freeze.reviewer_agent_id || freeze.verdict) continue;
    if (freeze.status !== 'open' && freeze.status !== 'behind-main') continue;
    const pipe = pipelineOf(freeze.project);
    if (!pipe.auto_review) continue;
    if (laneAutomationDenied(freeze.project, { name: freeze.author_name }, freeze.lane)) continue;
    const facts = assignmentFacts(freeze.sha, events);
    if (!facts) continue;
    const limitMs = projectReassignMs(freeze.project);
    if (!(limitMs > 0) || now - facts.at < limitMs) continue; // not waited long enough: no candidate search
    const current = getAgent(freeze.reviewer_agent_id);
    const author = freeze.author_agent_id ? getAgent(freeze.author_agent_id) : null;
    if (!current.ok || !author?.ok) continue;
    if (!load(current.data).busy) continue; // the reviewer is free: it stays theirs
    const next = chooseReviewer(author.data, pipe, null, load);
    const nextLoad = next ? load(next) : null;
    if (!shouldReassign({
      hasVerdict: false,
      waitedMs: now - facts.at,
      limitMs,
      currentBusy: true,
      reassignCount: facts.reassigns,
      nextId: next?.id ?? null,
      currentId: current.data.id,
      nextIdle: nextLoad ? !nextLoad.busy : false,
    }) || !next) continue;
    setFreezeReviewer(freeze.sha, { id: next.id, name: next.name });
    const sha8 = freeze.sha.slice(0, 8);
    const ask = `[from WaveCode] Please review freeze ${sha8} on ${freeze.lane ?? 'the lane'} by @${author.data.name}. Read ${freeze.freeze_path ?? 'the freeze note'}. If the code is OK and the gate is still running, write VERDICT: PASS (gate pending).`;
    deliverSystemLine(next, ask, { kind: 'info', source: 'review' });
    const from = current.data.alias ?? current.data.name;
    const to = next.alias ?? next.name;
    const own = sameOwnerPoolReviewer(author.data, next, pipe.reviewer_pool_by_author_glob, pipe.service_profiles)
      ? ` — ${SAME_OWNER_POOL_NOTE}`
      : '';
    const text = `reassigned @${from} → @${to} (busy, no verdict)${own}`;
    note(freeze.project, freeze.lane, freeze.sha, 'review', text);
    emit('pipeline.review', 'run', `${freeze.sha}:reassign`, {
      sha: freeze.sha, reviewer_id: next.id, kind: 'reassign', assigned_at_ms: Date.now(), reassigned: true,
    }, null);
    moved += 1;
  }
  return moved;
}

function gateWord(stdout: string): 'QUEUED' | 'RUNNING' | 'GREEN' | 'RED' | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/\b(QUEUED|RUNNING|GREEN|RED)\b/i);
    if (match) return match[1].toUpperCase() as 'QUEUED' | 'RUNNING' | 'GREEN' | 'RED';
  }
  return null;
}

/**
 * The gate's word once the command has returned. A tool that waits for the
 * remote suite answers with its exit code (0 green, 1 red); 7 is the
 * dispatcher's "same SHA already running or queued", which the tests history
 * then reports. A submit-only tool prints QUEUED or RUNNING instead.
 */
export function gateOutcome(result: ExecResult): 'QUEUED' | 'RUNNING' | 'GREEN' | 'RED' {
  // A `=== RESULT GREEN|RED ... ===` line is the suite's own verdict and wins over the tool's exit
  // code (the gateway has exited 5 from post-run bookkeeping after a GREEN, 26 Oct 2026).
  const stated = result.stdout.match(/=== RESULT (GREEN|RED)\b[^\n]*===/g)?.pop()?.match(/RESULT (GREEN|RED)/)?.[1];
  if (stated === 'GREEN' || stated === 'RED') return stated;
  // Otherwise only the last line speaks for the outcome: "queued #2" earlier in a waiting tool's output is history.
  const last = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const word = gateWord(last);
  if (result.code === 0) return word && word !== 'GREEN' ? word : 'GREEN';
  if (result.code === 7) return 'QUEUED';
  return word === 'GREEN' ? 'GREEN' : 'RED';
}

/**
 * One full gate per SHA, submitted the moment the freeze lands and run in a
 * clean detached checkout of the exact SHA, with the author as `who`. The
 * freeze shows QUEUED at once; the final word lands when the command returns,
 * which for a tool that waits on the remote suite is as long as the suite.
 * Callers do not await this.
 */
/** Gates this daemon is running right now, per project, and the SHAs waiting for a slot (FIFO). */
const gateInflight = new Map<string, Set<string>>();
const gatePending: string[] = [];
/** SHAs whose gate was lost at a restart and already handled once. */
const gateRecovered = new Set<string>();
const GATE_RECOVER_MAX_AGE_MS = 6 * 60 * 60_000;
const GATE_RECONCILE_PER_TICK = 10;

function inflightFor(project: string): Set<string> {
  let set = gateInflight.get(project);
  if (!set) { set = new Set(); gateInflight.set(project, set); }
  return set;
}

export function gateLoadForTest(): { inflight: Record<string, string[]>; pending: string[] } {
  return { inflight: Object.fromEntries([...gateInflight].map(([p, s]) => [p, [...s]])), pending: [...gatePending] };
}

export function quickLoadForTest(): { inflight: Record<string, string[]>; pending: string[] } {
  return { inflight: Object.fromEntries([...quickInflight].map(([p, s]) => [p, [...s]])), pending: [...quickPending] };
}

/** The merge-queue priority an admin set on this SHA (0 when none): a priority lane takes the next free slot first. */
function queuePriorityOf(sha: string): number {
  try {
    const row = getDb().prepare('SELECT priority FROM merge_queue WHERE sha = ?').get(sha) as { priority?: number } | undefined;
    return row?.priority ?? 0;
  } catch { return 0; }
}

/**
 * Highest queue priority first, then SHAs that replaced a cancelled run (the lane already paid for a
 * slot), then the order the SHAs arrived (Denis, 26 Oct 2026: "put this lane in front of the gate runners").
 */
function sortByQueuePriority(pending: string[]): void {
  const keyed = pending.map((sha, i) => ({ sha, i, p: queuePriorityOf(sha), j: jumped.has(sha) ? 1 : 0 }));
  keyed.sort((a, b) => b.p - a.p || b.j - a.j || a.i - b.i);
  pending.splice(0, pending.length, ...keyed.map((k) => k.sha));
}

// --- runs on replaced SHAs (27 Oct retro, cause 3) ----------------------------------------
// A newer freeze on the same lane makes the old SHA's runs worthless. WaveCode stops waiting for its
// own submissions on it (the local tool process is killed), records them as cancelled, never RED, and
// the new SHA takes the next free slot ahead of older waiters. The remote run is told to stop through
// `pipeline.cancel_command` when the gateway has a cancel verb; without it, it finishes on its own.
const liveRuns = new Map<string, AbortController>();
const cancelledRuns = new Map<string, string>();
/** SHAs that replaced a cancelled run: next in line after admin priority. */
const jumped = new Set<string>();
function runKey(sha: string, kind: 'quick' | 'full'): string { return `${sha}:${kind}`; }

/** Stop WaveCode's own quick and full-gate submissions on a SHA. Returns how many were stopped. */
export function cancelRunsFor(sha: string, reason: string, opts: { project?: string | null; by?: string | null } = {}): number {
  let n = 0;
  for (const kind of ['quick', 'full'] as const) {
    const key = runKey(sha, kind);
    const live = liveRuns.get(key);
    if (live) { cancelledRuns.set(key, reason); live.abort(); n++; }
    refusedRuns.delete(refusedKey(sha, kind));
  }
  // Waiting here, never submitted: dropped with the word, no gate record (nothing ran).
  const freeze = getFreeze(sha);
  const project = opts.project ?? freeze?.project ?? null;
  const lane = freeze?.lane ?? null;
  const qi = quickPending.indexOf(sha);
  if (qi >= 0) {
    quickPending.splice(qi, 1); n++;
    emit(QUICK, 'run', `${sha}:quick`, { sha, project, lane, quick: 'CANCELLED', reason }, null);
  }
  const gi = gatePending.indexOf(sha);
  if (gi >= 0) {
    gatePending.splice(gi, 1); n++;
    setFreezeGate(sha, 'CANCELLED');
    emit(GATED, 'run', `${sha}:full`, { sha, project, lane, gate: 'CANCELLED', reason }, null);
  }
  gateAfterQuick.delete(sha); // a gate still waiting for its quick never ran: nothing to stop
  if (opts.by) jumped.add(opts.by);
  const pipe = pipelineOf(opts.project ?? null);
  if (n && pipe.cancel_command?.length) {
    const argv = fill(pipe.cancel_command, { sha, lane: '', workspace: '', checkout: '', remote: mainSpec(opts.project ?? '').remote, project: opts.project ?? '' });
    void runArgv(argv, { timeoutMs: 60_000 }).then((r) => {
      logger.info({ sha, code: r.code, said: r.stdout.trim().split(/\r?\n/).slice(-1)[0] ?? '' }, 'Gateway cancel asked');
    }).catch((e) => logger.debug({ sha, error: (e as Error).message }, 'Gateway cancel failed'));
  }
  return n;
}

/** The reason this run was cancelled while it waited on the tool, consumed once. */
function takeCancelled(sha: string, kind: 'quick' | 'full'): string | null {
  const key = runKey(sha, kind);
  const reason = cancelledRuns.get(key) ?? null;
  cancelledRuns.delete(key);
  return reason;
}

export function cancelStateForTest(): { live: string[]; jumped: string[] } {
  return { live: [...liveRuns.keys()], jumped: [...jumped] };
}

// --- the quick check WaveCode runs when nobody did ---------------------------------------
// With gate_with_quick the full gate is WaveCode's and the quick check is the author's; on 26 Oct 2026
// seven api-green lanes sat at "quick missing" because no author had run tier1 on the exact SHA.
// WaveCode now runs the quick_check_command on the frozen SHA when the checker finds no quick result,
// under the same per-project cap as the full gate and in the same priority order.
const QUICK = 'pipeline.quick';
const quickInflight = new Map<string, Set<string>>();
const quickPending: string[] = [];

/**
 * A run the tool never carried out: non-zero exit and no `=== RESULT` line (the gateway cancelled it
 * as superseded, refused a duplicate, could not reach the host). Not a verdict on the code: retried
 * a few times, then left for the author with the reason. Returns the line that says why.
 */
export function runRefusal(result: ExecResult): string | null {
  if (result.code === 0) return null;
  if (/=== RESULT (GREEN|RED)\b/.test(result.stdout)) return null;
  const lines = result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = gateWord(lines[lines.length - 1] ?? '');
  if (last === 'GREEN' || last === 'RED') return null; // a bare verdict word on the last line is a verdict (older gate tools)
  const said = lines.filter((l) => !/remote exit \d+ on host=/.test(l)).slice(-1)[0] ?? lines.slice(-1)[0] ?? '';
  return (said || `exit ${result.code ?? 'none'} with no RESULT line`).slice(0, 160);
}
/**
 * The gateway keeps one queued run per agent name and cancels the older one when a second arrives
 * ("CANCELLED while queued: superseded by …", seen 26 Oct 2026 even with distinct `who` suffixes).
 * WaveCode therefore runs at most one of its own submissions per author at a time, quick before full.
 */
const authorInflight = new Map<string, number>();
function authorOf(freeze: ReleaseFreeze): string { return (freeze.author_name ?? 'wavecode').toLowerCase(); }
function authorBusy(freeze: ReleaseFreeze): boolean { return (authorInflight.get(authorOf(freeze)) ?? 0) > 0; }
function authorStart(freeze: ReleaseFreeze): void { const a = authorOf(freeze); authorInflight.set(a, (authorInflight.get(a) ?? 0) + 1); }
function authorDone(freeze: ReleaseFreeze): void { const a = authorOf(freeze); const n = (authorInflight.get(a) ?? 1) - 1; if (n <= 0) authorInflight.delete(a); else authorInflight.set(a, n); }
export function authorLoadForTest(): Record<string, number> { return Object.fromEntries(authorInflight); }
const REFUSED_MAX_TRIES = 3;
let refusedRetryMs = 90_000;
export function setRefusedRetryMsForTest(ms: number | null): void { refusedRetryMs = ms ?? 90_000; }
/** sha → tries so far, and the time before which it is not resubmitted. */
const refusedRuns = new Map<string, { tries: number; notBefore: number }>();
function refusedKey(sha: string, kind: 'quick' | 'full'): string { return `${sha}:${kind}`; }
/** Records a refusal; true when the run should go back to the pending list, false when it is given up. */
function noteRefusal(sha: string, kind: 'quick' | 'full'): boolean {
  const key = refusedKey(sha, kind);
  const prev = refusedRuns.get(key)?.tries ?? 0;
  if (prev + 1 >= REFUSED_MAX_TRIES) { refusedRuns.delete(key); return false; }
  refusedRuns.set(key, { tries: prev + 1, notBefore: Date.now() + refusedRetryMs });
  return true;
}
function refusedWait(sha: string, kind: 'quick' | 'full'): boolean {
  const r = refusedRuns.get(refusedKey(sha, kind));
  return !!r && Date.now() < r.notBefore;
}

function quickInflightFor(project: string): Set<string> {
  let set = quickInflight.get(project);
  if (!set) { set = new Set(); quickInflight.set(project, set); }
  return set;
}

/**
 * Quick first, gate after (28 Oct 2026): the full gate is submitted only once the quick check on the
 * SHA is GREEN. A RED quick ends the matter after four minutes instead of twenty-seven, and a red lane
 * no longer holds a gate slot. SHAs whose gate waits for their quick check live here.
 */
const gateAfterQuick = new Set<string>();
type QuickDecision = 'off' | 'submitted' | 'known:green' | 'known:red' | 'known:pending';

/** Decide the quick check for a fresh freeze: not WaveCode's, already known, or submitted (it runs in the background). */
async function queueQuickCheck(freeze: ReleaseFreeze): Promise<QuickDecision> {
  if (!freeze.project) return 'off';
  if (laneAutomationDenied(freeze.project, { name: freeze.author_name }, freeze.lane)) return 'off';
  const pipe = pipelineOf(freeze.project);
  if (!pipe.auto_gate || !pipe.gate_with_quick || !pipe.quick_check_command?.length) return 'off';
  const sha8 = freeze.sha.slice(0, 8);
  // WaveCode already ran or queued it (a re-ingest): its word decides the gate; none yet = still running.
  if (acted(`${freeze.sha}:quick`, QUICK)) {
    try { const words = await gateWordsFor(freeze); return words.quick === 'missing' ? 'known:pending' : `known:${words.quick}` as QuickDecision; } catch { return 'known:pending'; }
  }
  // The author's own quick on the exact SHA counts; only a missing one is WaveCode's to run.
  try {
    const words = await gateWordsFor(freeze);
    if (words.quick !== 'missing') return `known:${words.quick}` as QuickDecision;
  } catch (e) { logger.debug({ sha: freeze.sha, error: (e as Error).message }, 'quick check: checker read failed; running it'); }
  emit(QUICK, 'run', `${freeze.sha}:quick`, { sha: freeze.sha, project: freeze.project, lane: freeze.lane, quick: 'QUEUED' }, null);
  if (quickInflightFor(freeze.project).size >= pipe.gate_max_inflight || authorBusy(freeze)) {
    if (!quickPending.includes(freeze.sha)) quickPending.push(freeze.sha);
    note(freeze.project, freeze.lane, freeze.sha, 'quick', authorBusy(freeze) ? `auto: quick check on ${sha8} waits for @${freeze.author_name ?? 'wavecode'}'s other run (the gateway keeps one queued run per agent)` : `auto: quick check on ${sha8} waits for a slot (${quickInflightFor(freeze.project).size} running, ${quickPending.length} waiting)`);
    return 'submitted';
  }
  void runQuick(freeze).catch((e) => logger.debug({ sha: freeze.sha, error: (e as Error).message }, 'Quick check failed'));
  return 'submitted';
}

/** Gates waiting on a quick WaveCode is not running itself (the author's own run, or one lost to a restart): settle them from the checker's word. */
async function settleGatesWaitingOnQuick(): Promise<void> {
  for (const sha of [...gateAfterQuick]) {
    if (liveRuns.has(runKey(sha, 'quick')) || quickPending.includes(sha) || refusedRuns.has(refusedKey(sha, 'quick'))) continue;
    const freeze = getFreeze(sha);
    if (!freeze?.project || (freeze.status !== 'open' && freeze.status !== 'behind-main')) { gateAfterQuick.delete(sha); continue; }
    try {
      const words = await gateWordsFor(freeze);
      if (words.quick === 'green') afterQuickSettled(sha, 'GREEN');
      else if (words.quick === 'red') afterQuickSettled(sha, 'RED');
    } catch (e) { logger.debug({ sha, error: (e as Error).message }, 'quick word read failed'); }
  }
}

/** The quick check on a SHA settled: a GREEN releases its full gate, a RED cancels it, a given-up refusal lets the gate run anyway. */
function afterQuickSettled(sha: string, outcome: 'GREEN' | 'RED' | 'GAVE_UP' | 'CANCELLED'): void {
  if (!gateAfterQuick.delete(sha)) return;
  const freeze = getFreeze(sha);
  if (!freeze?.project || (freeze.status !== 'open' && freeze.status !== 'behind-main')) return;
  const sha8 = sha.slice(0, 8);
  if (outcome === 'RED') {
    note(freeze.project, freeze.lane, sha, 'gate', `auto: full gate not submitted on ${sha8} — the quick check is RED; fix, push and freeze a new SHA`);
    return;
  }
  if (outcome === 'CANCELLED') return;
  if (outcome === 'GAVE_UP') note(freeze.project, freeze.lane, sha, 'gate', `auto: quick check on ${sha8} could not run; submitting the full gate anyway`);
  void queueFullGate(freeze).catch((e) => logger.debug({ sha, error: (e as Error).message }, 'Auto-gate skipped'));
}

function drainQuickPending(): void {
  sortByQueuePriority(quickPending);
  for (let i = 0; i < quickPending.length;) {
    const sha = quickPending[i];
    const freeze = getFreeze(sha);
    if (!freeze?.project || (freeze.status !== 'open' && freeze.status !== 'behind-main')) { quickPending.splice(i, 1); continue; }
    const pipe = pipelineOf(freeze.project);
    if (!pipe.auto_gate || !pipe.gate_with_quick || !pipe.quick_check_command?.length) { quickPending.splice(i, 1); continue; }
    if (quickInflightFor(freeze.project).size >= pipe.gate_max_inflight || refusedWait(sha, 'quick') || authorBusy(freeze)) { i++; continue; }
    quickPending.splice(i, 1);
    void runQuick(freeze).catch((e) => logger.debug({ sha, error: (e as Error).message }, 'Pending quick check failed'));
  }
}

async function runQuick(freeze: ReleaseFreeze): Promise<void> {
  if (!freeze.project) return;
  const pipe = pipelineOf(freeze.project);
  if (!pipe.quick_check_command?.length) return;
  const inflight = quickInflightFor(freeze.project);
  if (inflight.has(freeze.sha)) return;
  inflight.add(freeze.sha);
  authorStart(freeze);
  try {
    const spec = mainSpec(freeze.project);
    const sha8 = freeze.sha.slice(0, 8);
    note(freeze.project, freeze.lane, freeze.sha, 'quick', `auto: quick check submitted on ${sha8} (no quick result on this SHA)`);
    const checkout = await makeCheckout(freeze.project, freeze.lane, freeze.sha);
    const author = freeze.author_name ?? 'wavecode';
    const argv = fill(pipe.quick_check_command, {
      sha: freeze.sha, lane: freeze.lane ?? '', workspace: checkout ?? '', checkout: checkout ?? '', remote: spec.remote, project: freeze.project,
    });
    const started = new Date();
    const controller = new AbortController();
    liveRuns.set(runKey(freeze.sha, 'quick'), controller);
    let result: ExecResult;
    try {
      result = await runArgv(argv, {
        ...(checkout ? { cwd: checkout } : {}),
        env: runEnv({ sha: freeze.sha, lane: freeze.lane ?? '', author, ...(checkout ? { checkout } : {}) }),
        timeoutMs: Math.max(1, pipe.quick_check_timeout_min) * 60_000,
        signal: controller.signal,
      });
    } finally {
      liveRuns.delete(runKey(freeze.sha, 'quick'));
    }
    await dropCheckout(freeze.project, checkout);
    const cancelled = takeCancelled(freeze.sha, 'quick');
    if (cancelled) {
      await recordGateResult({ project: freeze.project, sha: freeze.sha, argv, stdout: `${result.stdout}\nCANCELLED by WaveCode: ${cancelled}`, exit_code: result.code, started_at: started, finished_at: new Date(), dispatch_failure: `cancelled: ${cancelled}` });
      emit(QUICK, 'run', `${freeze.sha}:quick`, { sha: freeze.sha, project: freeze.project, lane: freeze.lane, quick: 'CANCELLED', reason: cancelled }, null);
      note(freeze.project, freeze.lane, freeze.sha, 'quick', `auto: quick check on ${sha8} stopped — ${cancelled}`);
      afterQuickSettled(freeze.sha, 'CANCELLED');
      return;
    }
    const refusal = runRefusal(result);
    const word = refusal ? 'QUEUED' : gateOutcome(result);
    await recordGateResult({ project: freeze.project, sha: freeze.sha, argv, stdout: result.stdout, exit_code: result.code, started_at: started, finished_at: new Date(), dispatch_failure: refusal });
    if (refusal) {
      const again = noteRefusal(freeze.sha, 'quick');
      if (again && !quickPending.includes(freeze.sha)) quickPending.push(freeze.sha);
      note(freeze.project, freeze.lane, freeze.sha, 'quick', again ? `auto: quick check on ${sha8} not run (${refusal}); trying again in a few minutes` : `auto: quick check on ${sha8} not run after ${REFUSED_MAX_TRIES} tries (${refusal}); run countix-remote-test tier1 on it yourself`);
      emit(QUICK, 'run', `${freeze.sha}:quick`, { sha: freeze.sha, project: freeze.project, lane: freeze.lane, quick: 'QUEUED', refusal, retry: again }, null);
      if (!again) afterQuickSettled(freeze.sha, 'GAVE_UP');
      return;
    }
    emit(QUICK, 'run', `${freeze.sha}:quick`, { sha: freeze.sha, project: freeze.project, lane: freeze.lane, quick: word, exit_code: result.code }, null);
    note(freeze.project, freeze.lane, freeze.sha, 'quick', `auto: quick check ${word} on ${sha8}`);
    if (word === 'RED') tell(freeze.author_agent_id, `[from WaveCode] quick check RED on ${sha8} (${freeze.lane ?? 'your lane'}). Fix, push and freeze a new SHA; the full gate was not submitted.`);
    if (word === 'GREEN' || word === 'RED') afterQuickSettled(freeze.sha, word);
  } finally {
    inflight.delete(freeze.sha);
    authorDone(freeze);
    drainQuickPending();
    drainGatePending();
  }
}

/**
 * One full gate per freeze SHA, at most `gate_max_inflight` running per project.
 * The freeze shows QUEUED at once; a SHA over the cap waits in this daemon until a
 * slot frees, so a burst of freezes never floods the dispatcher.
 */
async function queueFullGate(freeze: ReleaseFreeze): Promise<void> {
  if (!freeze.project) return;
  if (laneAutomationDenied(freeze.project, { name: freeze.author_name }, freeze.lane)) return;
  const pipe = pipelineOf(freeze.project);
  if (!pipe.auto_gate || !pipe.gate_command?.length) return;
  if (acted(`${freeze.sha}:full`, GATED)) return;
  const sha8 = freeze.sha.slice(0, 8);
  setFreezeGate(freeze.sha, 'QUEUED');
  emit(GATED, 'run', `${freeze.sha}:full`, { sha: freeze.sha, project: freeze.project, lane: freeze.lane, gate: 'QUEUED' }, null);
  if (inflightFor(freeze.project).size >= pipe.gate_max_inflight || authorBusy(freeze)) {
    if (!gatePending.includes(freeze.sha)) gatePending.push(freeze.sha);
    note(freeze.project, freeze.lane, freeze.sha, 'gate', authorBusy(freeze) ? `auto: full gate on ${sha8} waits for @${freeze.author_name ?? 'wavecode'}'s other run (the gateway keeps one queued run per agent)` : `auto: full gate on ${sha8} waits for a slot (${inflightFor(freeze.project).size} running, ${gatePending.length} waiting)`);
    return;
  }
  await runGate(freeze);
}

/** Start waiting gates while slots are free. Freezes that closed meanwhile are dropped. */
function drainGatePending(): void {
  sortByQueuePriority(gatePending);
  for (let i = 0; i < gatePending.length;) {
    const sha = gatePending[i];
    const freeze = getFreeze(sha);
    if (!freeze?.project || (freeze.status !== 'open' && freeze.status !== 'behind-main')) { gatePending.splice(i, 1); continue; }
    const pipe = pipelineOf(freeze.project);
    if (!pipe.auto_gate || !pipe.gate_command?.length) { gatePending.splice(i, 1); continue; }
    if (inflightFor(freeze.project).size >= pipe.gate_max_inflight || refusedWait(sha, 'full') || authorBusy(freeze)) { i++; continue; }
    gatePending.splice(i, 1);
    void runGate(freeze).catch((e) => logger.debug({ sha, error: (e as Error).message }, 'Pending gate failed'));
  }
}

async function runGate(freeze: ReleaseFreeze): Promise<void> {
  if (!freeze.project) return;
  const pipe = pipelineOf(freeze.project);
  if (!pipe.gate_command?.length) return;
  const spec = mainSpec(freeze.project);
  const sha8 = freeze.sha.slice(0, 8);
  const inflight = inflightFor(freeze.project);
  if (inflight.has(freeze.sha)) return;
  inflight.add(freeze.sha);
  authorStart(freeze);
  try {
    await runGateBody(freeze, pipe, spec, sha8);
  } finally {
    inflight.delete(freeze.sha);
    authorDone(freeze);
    drainGatePending();
    drainQuickPending();
  }
}

async function runGateBody(freeze: ReleaseFreeze, pipe: PipelineSwitches, spec: ReturnType<typeof mainSpec>, sha8: string): Promise<void> {
  if (!freeze.project || !pipe.gate_command) return;
  note(freeze.project, freeze.lane, freeze.sha, 'gate', `auto: full gate submitted on ${sha8}`);
  const checkout = await makeCheckout(freeze.project, freeze.lane, freeze.sha);
  const author = freeze.author_name ?? 'wavecode';
  const argv = fill(pipe.gate_command, {
    sha: freeze.sha, lane: freeze.lane ?? '', workspace: checkout ?? '', checkout: checkout ?? '', remote: spec.remote, project: freeze.project,
  });
  const started = new Date();
  const controller = new AbortController();
  liveRuns.set(runKey(freeze.sha, 'full'), controller);
  let result: ExecResult;
  try {
    result = await runArgv(argv, {
      ...(checkout ? { cwd: checkout } : {}),
      env: runEnv({ sha: freeze.sha, lane: freeze.lane ?? '', author, ...(checkout ? { checkout } : {}) }),
      timeoutMs: Math.max(1, pipe.gate_timeout_min) * 60_000,
      signal: controller.signal,
    });
  } finally {
    liveRuns.delete(runKey(freeze.sha, 'full'));
  }
  await dropCheckout(freeze.project, checkout);
  const cancelled = takeCancelled(freeze.sha, 'full');
  if (cancelled) {
    await recordGateResult({ project: freeze.project, sha: freeze.sha, argv, stdout: `${result.stdout}\nCANCELLED by WaveCode: ${cancelled}`, exit_code: result.code, started_at: started, finished_at: new Date(), dispatch_failure: `cancelled: ${cancelled}` });
    setFreezeGate(freeze.sha, 'CANCELLED');
    emit(GATED, 'run', `${freeze.sha}:full`, { sha: freeze.sha, project: freeze.project, lane: freeze.lane, gate: 'CANCELLED', reason: cancelled }, null);
    note(freeze.project, freeze.lane, freeze.sha, 'gate', `auto: full gate on ${sha8} stopped — ${cancelled}`);
    return;
  }
  const refusal = runRefusal(result);
  const word = refusal ? 'QUEUED' : gateOutcome(result);
  // One immutable record per gate WaveCode ran (the checker reads it; legacy pipeline.gate stays for older readers).
  await recordGateResult({ project: freeze.project, sha: freeze.sha, argv, stdout: result.stdout, exit_code: result.code, started_at: started, finished_at: new Date(), dispatch_failure: refusal });
  if (refusal) {
    // The tool never ran the suite (cancelled as superseded, duplicate, host unreachable): not RED, not the author's.
    const again = noteRefusal(freeze.sha, 'full');
    if (again && !gatePending.includes(freeze.sha)) gatePending.push(freeze.sha);
    note(freeze.project, freeze.lane, freeze.sha, 'gate', again ? `auto: full gate on ${sha8} not run (${refusal}); trying again in a few minutes` : `auto: full gate on ${sha8} not run after ${REFUSED_MAX_TRIES} tries (${refusal}); run countix-remote-test --suite api on it yourself`);
    emit(GATED, 'run', `${freeze.sha}:full`, { sha: freeze.sha, project: freeze.project, lane: freeze.lane, gate: 'QUEUED', refusal, retry: again }, null);
    return;
  }
  await settleGate(freeze, word, result.code);
}

/** Record the gate word and act on it: RED tells the author, GREEN re-pings the reviewer. */
async function settleGate(freeze: ReleaseFreeze, word: 'QUEUED' | 'RUNNING' | 'GREEN' | 'RED', exitCode: number | null): Promise<void> {
  if (!freeze.project) return;
  const sha8 = freeze.sha.slice(0, 8);
  setFreezeGate(freeze.sha, word);
  emit(GATED, 'run', `${freeze.sha}:full`, { sha: freeze.sha, project: freeze.project, lane: freeze.lane, gate: word, ...(exitCode === null ? {} : { exit_code: exitCode }) }, null);
  note(freeze.project, freeze.lane, freeze.sha, 'gate', `auto: full gate ${word} on ${sha8}`);
  if (word === 'RED') {
    const repo = projectRepo(freeze.project);
    const tip = repo ? await mainTip(repo, freeze.project).catch(() => null) : null;
    const mainRed = mainApiState(freeze.project, tip?.sha ?? null) === 'RED';
    tell(freeze.author_agent_id, mainRed
      ? `[from WaveCode] full gate RED on ${sha8} (${freeze.lane ?? 'lane'}), but main itself (${(tip?.sha ?? '').slice(0, 8)}) is api RED right now: this is probably not your lane. Compare the failing file with countix-remote-test log; if it is the same, wait for the main fix, nothing to do.`
      : `[from WaveCode] full gate RED on ${sha8} (${freeze.lane ?? 'lane'}). Read the failing step with countix-remote-test log, fix, push, and refreeze.`);
    if (mainRed) note(freeze.project, freeze.lane, freeze.sha, 'gate', `auto: full gate RED on ${sha8}; main ${(tip?.sha ?? '').slice(0, 8)} is api RED too, so the lane may not be at fault [MAIN_RED]`);
  }
  if (word === 'GREEN') {
    pingReviewersForGreenSha(freeze.sha);
    const fresh = getFreeze(freeze.sha);
    if (fresh && fresh.verdict !== 'pass' && pipelineOf(fresh.project).auto_review) await assignReviewer(fresh, 'green');
  }
}

/**
 * A restart kills the blocking gate submitters. Freezes left at QUEUED or RUNNING
 * with nothing running here are settled from the dispatcher's history when `tests`
 * is configured; a run the dispatcher never saw is resubmitted once for a fresh
 * freeze, and otherwise noted. Bounded per tick.
 */
async function reconcileLostGates(now: number): Promise<void> {
  let looked = 0;
  for (const freeze of listFreezes()) {
    if (looked >= GATE_RECONCILE_PER_TICK) break;
    if (!freeze.project || (freeze.status !== 'open' && freeze.status !== 'behind-main')) continue;
    const stored = (freeze.gate ?? '').toUpperCase();
    if (stored !== 'QUEUED' && stored !== 'RUNNING') continue;
    if (inflightFor(freeze.project).has(freeze.sha) || gatePending.includes(freeze.sha) || gateRecovered.has(freeze.sha)) continue;
    const pipe = pipelineOf(freeze.project);
    if (!pipe.auto_gate || !pipe.gate_command?.length) continue;
    looked++;
    let live: 'green' | 'red' | 'pending' | 'missing' = 'missing';
    if (testsConfigured(freeze.project)) {
      try {
        live = shaChecks(await readLaneTests(freeze.project, freeze.lane ?? '', freeze.sha), freeze.sha, suiteNames(freeze.project)).full;
      } catch { live = 'missing'; }
    }
    if (live === 'pending') continue; // still on the dispatcher; the cards read the history
    gateRecovered.add(freeze.sha);
    if (live === 'green' || live === 'red') { await settleGate(freeze, live === 'green' ? 'GREEN' : 'RED', null); continue; }
    const age = now - Date.parse(`${freeze.created_at.replace(' ', 'T')}Z`);
    if (Number.isFinite(age) && age <= GATE_RECOVER_MAX_AGE_MS) {
      note(freeze.project, freeze.lane, freeze.sha, 'gate', `auto: gate run on ${freeze.sha.slice(0, 8)} was lost at a restart — submitting it again`);
      if (inflightFor(freeze.project).size >= pipe.gate_max_inflight || authorBusy(freeze)) { gatePending.push(freeze.sha); continue; }
      void runGate(freeze).catch((e) => logger.debug({ sha: freeze.sha, error: (e as Error).message }, 'Gate recovery failed'));
    } else {
      note(freeze.project, freeze.lane, freeze.sha, 'gate', `auto: gate run on ${freeze.sha.slice(0, 8)} was lost at a restart and the freeze is older than 6 h — refreeze to run it again`);
    }
  }
}

async function isGreen(freeze: ReleaseFreeze): Promise<boolean> {
  return (await viewShaChecks(freeze, undefined, { staleOkMs: 0 })).full === 'green'; // a decision: read fresh
}

function touches(files: string[], paths: string[]): string | null {
  for (const protectedPath of paths) {
    if (files.some((file) => file === protectedPath || file.startsWith(`${protectedPath}/`))) return protectedPath;
  }
  return null;
}

async function overlapWithStaging(project: string, lane: string, files: string[], repo: string, mainRef: string): Promise<{ lane: string; files: number } | null> {
  const deployed = listReleases({ project, target: 'staging', status: 'deployed', limit: 40 });
  let overlap: { lane: string; files: number } | null = null;
  const spec = mainSpec(project);
  for (const rel of deployed) {
    if (!rel.lane || rel.lane === lane) continue;
    let otherSha = rel.sha;
    try {
      const tip = await git(repo, ['rev-parse', '--verify', `${spec.remote}/${rel.lane}^{commit}`]);
      if (/^[0-9a-f]{40}$/i.test(tip)) otherSha = tip;
    } catch { /* the deployed SHA is enough */ }
    const other = new Set(await changedFiles(repo, otherSha, mainRef));
    const n = files.filter((file) => other.has(file)).length;
    if (n > 0 && (!overlap || n > overlap.files)) overlap = { lane: rel.lane, files: n };
  }
  return overlap;
}

function slotBusy(project: string, now = Date.now()): boolean {
  for (const row of listReleases({ project, target: 'staging', limit: 40 })) {
    if (row.status === 'requested' || row.status === 'sent') return true;
    if (row.status !== 'deployed' || row.verified_at) continue;
    if (row.pin_until) {
      const until = Date.parse(row.pin_until);
      if (!Number.isNaN(until) && until <= now) continue;
    }
    return true;
  }
  return false;
}

function alreadyQueued(sha: string): boolean {
  try {
    ensureQueue();
    const row = getDb().prepare('SELECT sha FROM pipeline_queue WHERE sha = ?').get(sha);
    return !!row;
  } catch {
    return false;
  }
}

function enqueue(freeze: ReleaseFreeze, kind: 'stage' | 'dump'): void {
  ensureQueue();
  getDb().prepare(
    `INSERT INTO pipeline_queue (sha, project, lane, kind, note) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(sha) DO NOTHING`,
  ).run(freeze.sha, freeze.project, freeze.lane, kind, kind === 'dump' ? 'needs pre-deploy dump' : null);
}

/** One staging slot per project. The next lane waits for Ready for prod or pin expiry. */
export async function drainStagingQueue(project: string): Promise<void> {
  try {
    await drainStagingQueueBody(project);
  } catch (e) {
    const message = (e as Error).message ?? '';
    if (/no such table: pipeline_queue/i.test(message)) {
      logger.debug({ project, error: message }, 'Staging queue drain skipped');
      return;
    }
    throw e;
  }
}

async function drainStagingQueueBody(project: string): Promise<void> {
  if (!project || slotBusy(project)) return;
  ensureQueue();
  const row = getDb().prepare(
    `SELECT sha, project, lane, kind FROM pipeline_queue WHERE project = ? ORDER BY created_at ASC, sha ASC LIMIT 1`,
  ).get(project) as { sha: string; project: string; lane: string | null; kind: string } | undefined;
  if (!row) return;
  const freeze = getFreeze(row.sha);
  if (!freeze) {
    getDb().prepare('DELETE FROM pipeline_queue WHERE sha = ?').run(row.sha);
    return drainStagingQueue(project);
  }
  if (!await isGreen(freeze)) {
    note(row.project, row.lane, row.sha, 'hold', `auto: waiting for GREEN on ${row.sha.slice(0, 8)}`);
    return;
  }
  if (slotBusy(project)) return;
  const { stageEligibility } = await import('./sha-stage-block.js');
  const eligible = await stageEligibility(row.sha, row.project, { markStale: true });
  if (eligible.error) {
    note(row.project, row.lane, row.sha, 'hold', `auto: ${eligible.error}`);
    getDb().prepare('DELETE FROM pipeline_queue WHERE sha = ?').run(row.sha);
    logger.warn({ sha: row.sha, error: eligible.error }, 'Auto-stage refused');
    return;
  }
  if (slotBusy(project)) return;
  const dump = row.kind === 'dump';
  // Staging only. This function has no production target.
  const sent = await requestRelease({
    project: row.project,
    sha: row.sha,
    lane: row.lane,
    target: 'staging',
    desk: freeze.desk != null ? String(freeze.desk) : null,
    reviewer: freeze.verdict === 'pass' ? freeze.reviewer_name : null,
    actorName: 'auto',
    runId: freeze.run_id,
    note: dump ? 'needs pre-deploy dump' : null,
  });
  if (!sent.ok) {
    logger.warn({ sha: row.sha, error: sent.error }, 'Auto-stage request failed');
    return;
  }
  getDb().prepare('DELETE FROM pipeline_queue WHERE sha = ?').run(row.sha);
  const text = dump
    ? `auto: needs pre-deploy dump — handed to deploy (${row.sha.slice(0, 8)})`
    : `auto-staged — waiting for Ready for prod (${row.sha.slice(0, 8)})`;
  note(row.project, row.lane, row.sha, dump ? 'dump' : 'stage', text);
  if (dump) {
    void notify({
      title: 'needs pre-deploy dump',
      body: `${row.lane ?? 'lane'} ${row.sha.slice(0, 8)} needs pre-deploy dump`,
      url: '/release',
      tag: `dump-${row.sha}`,
    }).catch(() => {});
  }
}

export async function considerAutoStage(sha: string): Promise<void> {
  const freeze = getFreeze(sha);
  if (!freeze?.project || !freeze.lane || freeze.verdict !== 'pass') return;
  if (laneAutomationDenied(freeze.project, { name: freeze.author_name }, freeze.lane)) return;
  const pipe = pipelineOf(freeze.project);
  if (!pipe.auto_stage) return;
  if (freeze.status === 'behind-main') {
    note(freeze.project, freeze.lane, freeze.sha, 'hold', 'auto: behind main — not staged');
    return;
  }
  if (freeze.status !== 'open') return;
  if (listReleases({ project: freeze.project, sha: freeze.sha, target: 'staging', limit: 5 }).some((r) => r.status !== 'failed' && r.status !== 'rejected')) return;
  const behind = await commitsBehind(freeze.project, freeze.sha);
  if (behind == null || behind > 0) {
    note(freeze.project, freeze.lane, freeze.sha, 'hold', `auto: behind main — not staged`);
    return;
  }
  if (!await isGreen(freeze)) {
    note(freeze.project, freeze.lane, freeze.sha, 'hold', `auto: waiting for GREEN on ${freeze.sha.slice(0, 8)}`);
    return;
  }
  const repo = projectRepo(freeze.project);
  const mainRef = repo ? await resolveMainRef(repo, freeze.project) : null;
  if (!repo || !mainRef) {
    note(freeze.project, freeze.lane, freeze.sha, 'hold', 'auto: repo unavailable — not staged');
    return;
  }
  const project = getConfig().projects?.[freeze.project];
  const files = await changedFiles(repo, freeze.sha, mainRef);
  const protectedPath = touches(files, project?.protected_paths ?? []);
  if (protectedPath) {
    note(freeze.project, freeze.lane, freeze.sha, 'hold', `auto: touches ${protectedPath} — not staged`);
    return;
  }
  const overlap = await overlapWithStaging(freeze.project, freeze.lane, files, repo, mainRef);
  if (overlap) {
    note(freeze.project, freeze.lane, freeze.sha, 'hold', `auto: overlaps lane ${overlap.lane} in ${overlap.files} files — not staged`);
    return;
  }
  const hasMigration = !!project?.migrations_dir && files.some((file) => file === project.migrations_dir || file.startsWith(`${project.migrations_dir}/`));
  const { stageEligibility } = await import('./sha-stage-block.js');
  const eligible = await stageEligibility(freeze.sha, freeze.project, { markStale: true });
  if (eligible.error) {
    note(freeze.project, freeze.lane, freeze.sha, 'hold', `auto: ${eligible.error}`);
    return;
  }
  if (alreadyQueued(freeze.sha)) {
    await drainStagingQueue(freeze.project);
    return;
  }
  enqueue(freeze, hasMigration ? 'dump' : 'stage');
  if (hasMigration) note(freeze.project, freeze.lane, freeze.sha, 'dump', 'auto: has migration — queued for a pre-deploy dump');
  await drainStagingQueue(freeze.project);
}

/**
 * Author reported the lane done (`DONE` / `FROZEN`, or a passing task).
 * Merges a clean main, pushes only the lane branch, runs the quick check,
 * and writes the freeze note.
 */
export async function onAuthorDone(agentId: string): Promise<Result<{ sha: string }>> {
  try {
    const agent = getAgent(agentId);
    if (!agent.ok || !agent.data.workspace) return { ok: false, error: 'no workspace' };
    const project = projectForWorkspace(agent.data.workspace);
    if (!project) return { ok: false, error: 'no project' };
    const pipe = pipelineOf(project);
    if (!pipe.auto_freeze) return { ok: false, error: 'auto-freeze off' };
    const lane = await branchOf(agent.data.workspace);
    const spec = mainSpec(project);
    const refused = lane ? laneRefError(project, lane) : 'not a developer lane';
    if (!lane || refused) return { ok: false, error: refused ?? 'not a developer lane' };
    if (laneAutomationDenied(project, agent.data, lane)) return { ok: false, error: `refusing ${lane}: denied` };
    const repo = projectRepo(project) ?? agent.data.workspace;
    const mainRef = await resolveMainRef(repo, project) ?? `${spec.remote}/${spec.branch}`;
    let sha = await headOf(agent.data.workspace);
    if (!sha) return { ok: false, error: 'no HEAD' };
    const behind = await commitsBehind(project, sha);
    if (behind != null && behind > 0) {
      if (laneAutomationDenied(project, agent.data)) return { ok: false, error: 'excluded from lane automation' };
      const merged = await mergeMainClean(agent.data.workspace, mainRef);
      if (!merged.ok) {
        if (merged.skipped) return { ok: false, error: 'excluded from lane automation' };
        const files = merged.files.length ? merged.files.join(', ') : 'unknown files';
        await alertBehind({ lane, project, authorAgentId: agent.data.id, authorName: agent.data.name });
        const text = behindConflict(lane);
        note(project, lane, sha, 'merge', `auto: merge conflict in ${files} — @${agent.data.name}`);
        return { ok: false, error: text };
      }
      sha = await headOf(agent.data.workspace) ?? sha;
    }
    if (acted(sha, FROZEN)) return { ok: false, error: 'already frozen' };
    return publishFreeze({ workspace: agent.data.workspace, project, lane, sha, author: agent.data, pipe });
  } catch (e) {
    logger.debug({ agentId, error: (e as Error).message }, 'Auto-freeze skipped');
    return { ok: false, error: (e as Error).message };
  }
}

function behindConflict(lane: string): string {
  return `Your lane ${lane} is behind main. Run: git fetch origin && git merge origin/main, fix any conflicts, run the quick check, then write your freeze note. Nothing else to do.`;
}

/** Main moved: clean-merge every open lane that is now behind, then refreeze. `review_deny` seats are left alone. */
/** A lane is synced at most this often, unless its queue row bounced on a merge conflict. */
const SYNC_MIN_MS = 30 * 60_000;
const SYNC = 'sync';

function lastNoteAt(project: string, lane: string, action: string): number | null {
  try {
    const row = getDb().prepare(
      `SELECT created_at FROM events WHERE type = ? AND entity_id = ? AND json_extract(payload_json, '$.action') = ? ORDER BY id DESC LIMIT 1`,
    ).get(PIPELINE_ACTION, `${project}:${lane}`, action) as { created_at: string } | undefined;
    if (!row) return null;
    const at = Date.parse(row.created_at.includes('T') ? row.created_at : `${row.created_at.replace(' ', 'T')}Z`);
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

function queueRowOf(sha: string): { state: string; reason: string | null } | null {
  try {
    return (getDb().prepare('SELECT state, reason FROM merge_queue WHERE sha = ?').get(sha) as { state: string; reason: string | null } | undefined) ?? null;
  } catch {
    return null;
  }
}

/** Newest freeze on the lane, any status. */
function newestFreezeOf(project: string, lane: string): ReleaseFreeze | null {
  for (const freeze of listFreezes()) if (freeze.project === project && freeze.lane === lane) return freeze;
  return null;
}

async function workspaceClean(workspace: string): Promise<boolean> {
  try {
    return (await git(workspace, ['status', '--porcelain', '--untracked-files=no'])) === '';
  } catch {
    return false;
  }
}

/** The lane's tip on the remote, after a fetch when the remote answers. */
async function remoteLaneTip(project: string, lane: string): Promise<string | null> {
  const repo = projectRepo(project);
  if (!repo || !SAFE_LANE.test(lane)) return null;
  const spec = mainSpec(project);
  try { await git(repo, ['fetch', '--quiet', spec.remote, lane]); } catch { /* offline or no remote: the stored ref is used */ }
  try {
    const sha = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/${spec.remote}/${lane}^{commit}`]);
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Why a lane is not synced now, or null. Said once per (lane, tip): the owner gets one message,
 * not one per tick.
 */
async function syncSkipReason(project: string, lane: string, workspace: string, before: string, author: Agent): Promise<string | null> {
  const newest = newestFreezeOf(project, lane);
  const row = newest ? queueRowOf(newest.sha) : null;
  if (row && (row.state === 'queued' || row.state === 'merging')) return `${lane} is ${row.state === 'merging' ? 'merging now' : 'next to merge'}; not synced`;
  const conflictBounce = row?.state === 'bounced' && /conflict/i.test(row.reason ?? '');
  const last = lastNoteAt(project, lane, SYNC);
  if (!conflictBounce && last != null && Date.now() - last < SYNC_MIN_MS) return `${lane} was synced ${Math.round((Date.now() - last) / 60_000)} min ago; the next sync waits (every ${SYNC_MIN_MS / 60_000} min unless the lane bounces on a conflict)`;
  if (!(await workspaceClean(workspace))) return `${lane} has uncommitted changes in @${author.name}'s checkout; @${author.name} commits or stashes, merges main and pushes [LANE_DIRTY]`;
  const tip = await remoteLaneTip(project, lane);
  if (tip && tip.toLowerCase() !== before.toLowerCase()) return `${lane} is not at its origin tip (checkout ${before.slice(0, 8)}, origin ${tip.slice(0, 8)}); @${author.name} pushes or pulls, then WaveCode syncs [LANE_NOT_AT_TIP]`;
  return null;
}

/** Push the sync merge to the lane, plain (never force). The configured push command wins. */
async function pushSync(project: string, lane: string, workspace: string, pipe: PipelineSwitches): Promise<ExecResult> {
  const spec = mainSpec(project);
  const argv = pipe.push_command?.length
    ? fill(pipe.push_command, { workspace, lane, sha: '', remote: spec.remote, project, checkout: workspace })
    : ['git', 'push', spec.remote, `HEAD:refs/heads/${lane}`];
  return runArgv(argv, { cwd: workspace, timeoutMs: 60_000 });
}

const MAIN_GATE = 'pipeline.main-gate';

/** The api verdict WaveCode recorded for the current main tip, or null. */
export function mainApiState(project: string, mainSha: string | null): 'GREEN' | 'RED' | null {
  if (!mainSha) return null;
  const api = recordsFor(mainSha).filter((r) => r.suite === 'api' && (r.state === 'GREEN' || r.state === 'RED'));
  const last = api[api.length - 1];
  return last ? (last.state as 'GREEN' | 'RED') : null;
}

/**
 * Every new main tip gets the api suite once ("main is the only road to prod": a deployable main
 * SHA needs quick + api GREEN on it, and a RED main stops owners being blamed for its failures).
 * One run per tip; the gateway sees author `main`.
 */
export async function ensureMainGate(project: string, mainSha: string | null): Promise<void> {
  const pipe = pipelineOf(project);
  if (!mainSha || !pipe.auto_gate || !pipe.gate_command?.length) return;
  if (acted(mainSha, MAIN_GATE)) return;
  if (recordsFor(mainSha).some((r) => r.suite === 'api')) return;
  emit(MAIN_GATE, 'run', mainSha, { sha: mainSha, project }, null);
  const pseudo = {
    sha: mainSha, project, lane: null, author_name: 'main', author_agent_id: null, status: 'open', created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  } as unknown as ReleaseFreeze;
  note(project, null, mainSha, 'gate', `auto: api suite on the new main tip ${mainSha.slice(0, 8)}`);
  await queueFullGate(pseudo);
}

const PROD_SYNC = 'pipeline.prod-sync';

/**
 * Prod drift (production on a SHA that is not on main): open the sync lane once — main with
 * prod merged in, pushed as wc-wavecode-prod-sync-<day>, frozen under author wavecode — unless
 * an open lane already contains prod's SHA. The queue merges it like any lane (gates, one PASS).
 */
export async function ensureProdSyncLane(project: string): Promise<string | null> {
  const drift = await prodDrift(project).catch(() => null);
  const repo = projectRepo(project);
  if (!drift || !repo) return null;
  const key = `${project}:${drift.prod_sha}`;
  if (acted(key, PROD_SYNC)) return null;
  const spec = mainSpec(project);
  const mainRef = await resolveMainRef(repo, project);
  if (!mainRef) return null;
  let containing: string[] = [];
  try {
    containing = (await git(repo, ['branch', '-r', '--contains', drift.prod_sha, '--format=%(refname:short)'])).split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`${spec.remote}/`)).map((l) => l.slice(spec.remote.length + 1)).filter((l) => l !== spec.branch);
  } catch { /* none */ }
  const existing = containing.find((lane) => listFreezes().some((f) => f.project === project && f.lane === lane && (f.status === 'open' || f.status === 'behind-main')));
  if (existing) {
    emit(PROD_SYNC, 'project', key, { project, prod_sha: drift.prod_sha, lane: existing, opened: false }, null);
    note(project, existing, drift.prod_sha, 'prod-sync', `auto: production runs ${drift.prod_sha.slice(0, 8)}, not on main; ${existing} already contains it and merges through the queue`);
    return existing;
  }
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const lane = `wc-wavecode-prod-sync-${day}`;
  const dir = path.join(path.dirname(repo), '.wavecode-gates', `${path.basename(repo)}-prod-sync-${day}`);
  try {
    if (fs.existsSync(dir)) { try { await git(repo, ['worktree', 'remove', '--force', dir]); } catch { fs.rmSync(dir, { recursive: true, force: true }); } }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    await git(repo, ['worktree', 'add', '--detach', dir, mainRef]);
    try {
      await git(dir, ['merge', '--no-ff', '--no-edit', '-m', `Merge production ${drift.prod_sha.slice(0, 8)} into main (prod sync)`, drift.prod_sha]);
    } catch {
      let files: string[] = [];
      try { files = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).split('\n').map((l) => l.trim()).filter(Boolean); } catch { /* none */ }
      try { await git(dir, ['merge', '--abort']); } catch { /* clean */ }
      emit(PROD_SYNC, 'project', key, { project, prod_sha: drift.prod_sha, lane: null, opened: false, conflict: files }, null);
      note(project, null, drift.prod_sha, 'prod-sync', `auto: production ${drift.prod_sha.slice(0, 8)} does not merge cleanly into main (${files.join(', ') || 'unknown files'}): Maestro assigns an owner to open the sync lane by hand [PROD_SYNC_CONFLICT]`);
      return null;
    }
    const sha = await git(dir, ['rev-parse', 'HEAD']);
    const pushed = await runArgv(['git', 'push', spec.remote, `HEAD:refs/heads/${lane}`], { cwd: dir, timeoutMs: 60_000 });
    if (pushed.code !== 0) {
      note(project, lane, sha, 'prod-sync', `auto: could not push the prod sync lane ${lane} (exit ${pushed.code}); trying again on the next tick`);
      return null;
    }
    emit(PROD_SYNC, 'project', key, { project, prod_sha: drift.prod_sha, lane, sha, opened: true }, null);
    note(project, lane, sha, 'prod-sync', `auto: production runs ${drift.prod_sha.slice(0, 8)}, not on main; opened ${lane} (${sha.slice(0, 8)} = main + prod) and froze it; it merges through the queue`);
    const dirFreeze = freezeDir(project, pipelineOf(project));
    if (dirFreeze) await ingestFreezeFile(writeFreeze(dirFreeze, 'wavecode', project, lane, sha));
    return lane;
  } catch (e) {
    logger.warn({ project, error: (e as Error).message }, 'Prod sync lane failed');
    return null;
  } finally {
    try { await git(repo, ['worktree', 'remove', '--force', dir]); } catch { /* gone */ }
    try { await git(repo, ['worktree', 'prune']); } catch { /* best effort */ }
  }
}

export async function onMainAdvanced(project: string, mainSha?: string): Promise<void> {
  const pipe = pipelineOf(project);
  try { await ensureMainGate(project, mainSha ?? (projectRepo(project) ? (await mainTip(projectRepo(project)!, project))?.sha ?? null : null)); } catch (e) { logger.debug({ project, error: (e as Error).message }, 'Main gate skipped'); }
  if (mainSha) { try { await requestCandidateReviewFor(project, mainSha); } catch (e) { logger.debug({ project, error: (e as Error).message }, 'Candidate review skipped'); } }
  if (!pipe.auto_merge_main) return;
  const repo = projectRepo(project);
  if (!repo) return;
  const mainRef = await resolveMainRef(repo, project);
  if (!mainRef) return;
  const lanes = new Set<string>();
  for (const freeze of listFreezes()) {
    if (freeze.project === project && freeze.lane && !laneRefError(project, freeze.lane) && (freeze.status === 'open' || freeze.status === 'behind-main')) lanes.add(freeze.lane);
  }
  for (const agent of listAgents()) {
    if (!agent.workspace) continue;
    const branch = await branchOf(agent.workspace);
    if (branch && !laneRefError(project, branch)) lanes.add(branch);
  }
  for (const lane of lanes) {
    if (laneRefError(project, lane)) continue;
    let author: Agent | undefined;
    for (const agent of listAgents()) {
      if (!agent.workspace) continue;
      if (await branchOf(agent.workspace) === lane) { author = agent; break; }
    }
    if (!author?.workspace || laneAutomationDenied(project, author, lane)) continue;
    const before = await headOf(author.workspace);
    if (!before) continue;
    const behind = await commitsBehind(project, before);
    if (behind == null || behind <= 0) continue;
    // A lane with no commit main lacks is done: retire it instead of merging main into it and
    // freezing again (28 Oct 2026: six merged lanes got 19 sync freezes each in a day). The
    // author hears it once per tip and moves the checkout off the lane.
    if (await laneHasNothingMainLacks(repo, mainRef, before) === true) {
      const key = `${lane}@${before.slice(0, 8)}`;
      const fresh = !acted(key, 'lane.retired');
      retireLane(project, lane, before, `git cherry ${mainRef} ${lane} is empty: every commit of the lane is on main (sync skipped)`);
      if (fresh) {
        note(project, lane, before, SYNC, `auto: ${lane} has nothing main lacks — retired, not synced; @${author.name} switches the checkout to main`);
        tell(author.id, `[from WaveCode] ${lane} is fully on main. Not synced or frozen again; run git checkout main in ${author.workspace} (or start the next lane) so main moves stop touching it.`);
      }
      continue;
    }
    // Only a clean checkout at the lane's origin tip is synced: the merge is pushed first and
    // frozen second, so the frozen SHA is always the origin tip (spec item 2, 26 Oct 2026).
    const skip = await syncSkipReason(project, lane, author.workspace, before, author);
    if (skip) {
      const key = `${lane}@${before.slice(0, 8)}`;
      if (!acted(key, 'pipeline.sync-skip')) {
        emit('pipeline.sync-skip', 'lane', key, { project, lane, sha: before, reason: skip }, null);
        note(project, lane, before, 'sync-skip', `auto: main moved; ${skip}`);
        if (/\[LANE_(DIRTY|NOT_AT_TIP)\]/.test(skip)) tell(author.id, `[from WaveCode] main moved and ${skip}`);
      }
      continue;
    }
    const merged = await mergeMainClean(author.workspace, mainRef);
    if (!merged.ok) {
      if (merged.skipped) continue;
      const files = merged.files.length ? merged.files.join(', ') : 'unknown files';
      const tip = await mainTip(repo, project);
      const shaNow = mainSha ?? tip?.sha ?? '';
      if (shaNow) await alertBehind({ lane, project, authorAgentId: author.id, authorName: author.name });
      note(project, lane, before, 'merge', `auto: merge conflict in ${files}: @${author.name} merges main, resolves ${files}, pushes and freezes [MERGE_CONFLICT]`);
      continue;
    }
    const sha = await headOf(author.workspace);
    if (!sha || sha === before) continue;
    const pushed = await pushSync(project, lane, author.workspace, pipe);
    if (pushed.code !== 0) {
      try { await git(author.workspace, ['reset', '--hard', before]); } catch { /* left for the owner */ }
      note(project, lane, before, SYNC, `auto: main merged into ${lane} but the push was refused (origin moved?); checkout reset to ${before.slice(0, 8)}, tried again on the next main advance`);
      continue;
    }
    note(project, lane, sha, SYNC, `auto: merged main into ${lane} and pushed ${sha.slice(0, 8)}; freezing it now`);
    const tip = await mainTip(repo, project);
    const mergedTip = mainSha ?? tip?.sha ?? '';
    if (mergedTip) await alertMerged({ lane, project, mainSha: mergedTip, authorAgentId: author.id, authorName: author.name });
    if (acted(sha, FROZEN)) continue;
    await publishFreeze({ workspace: author.workspace, project, lane, sha, author, pipe });
  }
}

/** Freezes refused because the SHA was not on the remote lane yet; re-checked on the tick. */
const refusedFreezes = new Map<string, number>();
const REFUSED_RECHECK_MS = 2 * 60_000;
const REFUSED_TTL_MS = 12 * 60 * 60_000;

/** True when `git cherry main <sha>` is empty: no commit of the frozen SHA is missing from main. */
async function freezeHasNothingMainLacks(project: string, sha: string): Promise<boolean> {
  try {
    const repo = projectRepo(project);
    const mainRef = repo ? await resolveMainRef(repo, project) : null;
    if (!repo || !mainRef) return false;
    return (await laneHasNothingMainLacks(repo, mainRef, sha)) === true;
  } catch (e) {
    logger.debug({ project, sha, error: (e as Error).message }, 'Nothing-main-lacks check skipped');
    return false;
  }
}

export async function onFreezeRecorded(sha: string): Promise<void> {
  const freeze = getFreeze(sha);
  if (!freeze || (freeze.status !== 'open' && freeze.status !== 'behind-main')) return;
  if (laneAutomationDenied(freeze.project, { name: freeze.author_name }, freeze.lane)) return;
  const pipe = pipelineOf(freeze.project);
  if (freeze.project && (pipe.auto_gate || pipe.auto_review)) {
    const missing = await pushedShaError(freeze.project, freeze.lane, sha);
    if (missing) {
      refusedFreezes.set(sha, Date.now());
      if (!acted(sha, 'pipeline.refused')) {
        emit('pipeline.refused', 'run', sha, { sha, project: freeze.project, lane: freeze.lane, reason: missing }, null);
        note(freeze.project, freeze.lane, sha, 'push', `auto: freeze refused — ${missing}`);
        tell(freeze.author_agent_id, `[from WaveCode] freeze ${sha.slice(0, 8)} on hold: ${missing}. Push the exact SHA; WaveCode re-checks every few minutes.`);
      }
      return;
    }
    refusedFreezes.delete(sha);
  }
  // A freeze whose every commit is already on main has nothing to check, review or merge: the lane
  // is retired and the author told once. 28 Oct 2026: one seat wrote 14 such freezes on 7 merged
  // lanes in an hour, each costing a quick run, a gate run and two review pings. The check reads
  // the frozen SHA itself (fetched just above), so a stale lane ref cannot retire a live lane.
  if (freeze.project && freeze.lane && await freezeHasNothingMainLacks(freeze.project, sha)) {
    const sha8 = sha.slice(0, 8);
    retireLane(freeze.project, freeze.lane, sha, `git cherry main ${sha8} is empty: every commit of the freeze is on main`);
    if (!acted(sha, 'pipeline.retired')) {
      emit('pipeline.retired', 'run', sha, { sha, project: freeze.project, lane: freeze.lane }, null);
      note(freeze.project, freeze.lane, sha, 'review', `auto: freeze ${sha8} closed — every commit of ${freeze.lane} is already on main; nothing to check, review or merge`);
      tell(freeze.author_agent_id, `[from WaveCode] freeze ${sha8} on ${freeze.lane} closed: every commit of the lane is already on main, so there is nothing to review or merge. Run git checkout main in your workspace and start the next lane instead of refreezing.`);
    }
    return;
  }
  // Runs on the SHA this freeze replaced are worthless now: stop them and let this SHA go first.
  for (const old of freeze.project ? listFreezes() : []) {
    if (old.sha === sha || old.lane !== freeze.lane || old.project !== freeze.project || (old.superseded_by ?? '').toLowerCase() !== sha.toLowerCase()) continue;
    const stopped = cancelRunsFor(old.sha, `superseded by ${sha.slice(0, 8)}`, { project: freeze.project, by: sha });
    if (stopped) note(freeze.project!, freeze.lane, old.sha, 'cancel', `auto: ${stopped} run${stopped === 1 ? '' : 's'} on ${old.sha.slice(0, 8)} stopped — superseded by ${sha.slice(0, 8)}, which goes next`);
  }
  // Quick first (minutes), the full gate only once it is GREEN; the review starts now.
  let quick: QuickDecision = 'off';
  try { quick = await queueQuickCheck(freeze); } catch (e) { logger.debug({ sha, error: (e as Error).message }, 'Auto-quick skipped'); }
  if (quick === 'submitted' || quick === 'known:pending') gateAfterQuick.add(sha); // settles from the run, or from the tick once the word is in
  else if (quick === 'known:red') note(freeze.project!, freeze.lane, sha, 'gate', `auto: full gate not submitted on ${sha.slice(0, 8)} — the quick check on it is RED; fix, push and freeze a new SHA`);
  else void queueFullGate(freeze).catch((e) => logger.debug({ sha, error: (e as Error).message }, 'Auto-gate skipped'));
  // A merge-only SHA (same patch as an earlier PASS, main merged since) carries that PASS in the
  // queue: no first pass, no reviewer ping. 28 Oct 2026: 340 of 471 freezes in a day were such
  // syncs, each costing a first-pass prompt and a review ask.
  let carried: ReleaseFreeze | null = null;
  try { carried = freeze.lane ? await carriedPassFreeze(freeze.project!, freeze.lane, sha) : null; } catch (e) { logger.debug({ sha, error: (e as Error).message }, 'Carried-pass check skipped'); }
  if (carried) {
    if (!acted(sha, 'pipeline.carried')) {
      emit('pipeline.carried', 'run', sha, { sha, project: freeze.project, lane: freeze.lane, from: carried.sha }, null);
      note(freeze.project!, freeze.lane, sha, 'review', `auto: merge-only delta from ${carried.sha.slice(0, 8)} — its PASS carries over; no first pass or review asked on ${sha.slice(0, 8)}`);
    }
  } else {
    try { await requestFirstPassFor(freeze); } catch (e) { logger.debug({ sha, error: (e as Error).message }, 'First pass skipped'); }
    try { await assignReviewer(getFreeze(sha) ?? freeze); } catch (e) { logger.debug({ sha, error: (e as Error).message }, 'Auto-review skipped'); }
  }
  try { await considerAutoStage(sha); } catch (e) { logger.debug({ sha, error: (e as Error).message }, 'Auto-stage skipped'); }
}

async function requestFirstPassFor(freeze: ReleaseFreeze): Promise<void> {
  if (!freeze.project || !freeze.author_agent_id) return;
  const pipe = pipelineOf(freeze.project);
  if (!pipe.auto_review) return;
  const author = getAgent(freeze.author_agent_id);
  if (!author.ok) return;
  const result = await requestFirstPass(freeze, author.data, {
    repo: projectRepo(freeze.project), remote: mainSpec(freeze.project).remote,
    serviceProfiles: pipe.service_profiles, deny: pipe.review_deny,
  });
  if (result.ok) {
    note(freeze.project, freeze.lane, freeze.sha, 'first-pass', `auto: first pass asked from @${result.data.seat.alias ?? result.data.seat.name}`);
  } else if (result.error !== 'off' && result.error !== 'already requested') {
    note(freeze.project, freeze.lane, freeze.sha, 'first-pass', `auto: no first pass — ${result.error}`);
  }
}

function announceFirstPass(result: FirstPassResult): void {
  const freeze = getFreeze(result.sha);
  if (!freeze?.project) return;
  const sha8 = result.sha.slice(0, 8);
  const word = result.result === 'pass' ? 'PASS' : `NEEDS FIXES (${result.issues} issue${result.issues === 1 ? '' : 's'})`;
  const by = result.seat ? ` by @${result.seat}` : '';
  note(freeze.project, freeze.lane, freeze.sha, 'first-pass', `auto: first pass${by} — ${word}`);
  if (freeze.reviewer_agent_id && !freeze.verdict) {
    const reviewer = getAgent(freeze.reviewer_agent_id);
    if (reviewer.ok) {
      deliverSystemLine(reviewer.data, `[from WaveCode] First pass on ${sha8}${by}: ${word}, see ${result.file}. Use it as a checklist; your verdict decides.`, { kind: 'info', source: 'first-pass' });
    }
  }
  if (result.result === 'needs-fixes') {
    tell(freeze.author_agent_id, `[from WaveCode] First pass on ${sha8}${by}: NEEDS FIXES, ${result.issues} issue${result.issues === 1 ? '' : 's'} in ${result.file}. Fix what is real now, push, and refreeze; the reviewer has the same list.`);
  }
}

/**
 * Periodic pipeline work beyond review reassignment: re-check freezes that
 * were refused for an unpushed SHA, and note first passes that never arrived.
 */
export async function pipelineTick(now = Date.now()): Promise<void> {
  drainGatePending();
  drainQuickPending();
  for (const project of Object.keys(getConfig().projects ?? {})) {
    if (!productionSha(project)) continue;
    try { await ensureProdSyncLane(project); } catch (e) { logger.debug({ project, error: (e as Error).message }, 'Prod sync skipped'); }
  }
  try { await reconcileLostGates(now); } catch (e) { logger.debug({ error: (e as Error).message }, 'Gate reconcile skipped'); }
  await settleGatesWaitingOnQuick();
  for (const [sha, at] of [...refusedFreezes.entries()]) {
    if (now - at > REFUSED_TTL_MS) { refusedFreezes.delete(sha); continue; }
    if (now - at < REFUSED_RECHECK_MS) continue;
    refusedFreezes.set(sha, now);
    const freeze = getFreeze(sha);
    if (!freeze?.project || (freeze.status !== 'open' && freeze.status !== 'behind-main')) { refusedFreezes.delete(sha); continue; }
    if (await pushedShaError(freeze.project, freeze.lane, sha)) continue;
    refusedFreezes.delete(sha);
    note(freeze.project, freeze.lane, sha, 'push', `auto: ${sha.slice(0, 8)} is now on the remote lane — continuing`);
    await onFreezeRecorded(sha);
  }
  for (const req of overdueFirstPasses(now)) {
    const freeze = getFreeze(req.sha);
    if (!freeze?.project) continue;
    note(freeze.project, freeze.lane, req.sha, 'first-pass', `auto: no first pass from @${req.seat} after ${Math.round((now - req.atMs) / 60_000)} min — the reviewer continues without it`);
  }
  for (const req of overdueCandidateReviews(now)) {
    const minutes = Math.round((now - req.atMs) / 60_000);
    const text = `[from WaveCode] candidate review of main ${req.sha.slice(0, 8)} by @${req.reviewer} has no answer after ${minutes} min (${req.file}). Finish it or say who takes it.`;
    note(req.project, req.lane, req.sha, CANDIDATE_NOTE, `auto: no candidate review from @${req.reviewer} after ${minutes} min`);
    tell(req.reviewerId, text);
    void tellDriverSeats(text, null, CANDIDATE_NOTE).catch(() => {});
  }
}

export function resetPipelineForTest(): void {
  refusedFreezes.clear();
  refusedPublish.clear();
  publishRefusalQuietMs = 2 * 60_000;
  gateInflight.clear();
  gatePending.length = 0;
  gateRecovered.clear();
  quickInflight.clear();
  quickPending.length = 0;
  refusedRuns.clear();
  refusedRetryMs = 90_000;
  authorInflight.clear();
  liveRuns.clear();
  cancelledRuns.clear();
  jumped.clear();
  gateAfterQuick.clear();
}

firstPassHooks.onResult = announceFirstPass;

// --- rolling candidate review (27 Oct retro, cause 2) --------------------------------------
const CANDIDATE_NOTE = 'candidate-review';

/** The queue merge that produced this main SHA: its lane, author and the main it merged onto. */
function mergeThatMade(project: string, mainSha: string): { lane: string | null; author: Agent | null; mainBefore: string | null } {
  try {
    const rows = getDb().prepare(
      "SELECT payload_json FROM events WHERE type = 'merge_queue.merged' ORDER BY id DESC LIMIT 100",
    ).all() as Array<{ payload_json: string | null }>;
    for (const row of rows) {
      if (!row.payload_json) continue;
      const p = JSON.parse(row.payload_json) as { project?: string; sha_out?: string; lane?: string; author?: string; main_before?: string };
      if (p.project !== project || (p.sha_out ?? '').toLowerCase() !== mainSha.toLowerCase()) continue;
      const name = (p.author ?? '').toLowerCase();
      const author = name ? listAgents().find((a) => a.name.toLowerCase() === name || (a.alias ?? '').toLowerCase() === name) ?? null : null;
      return { lane: p.lane ?? null, author, mainBefore: p.main_before?.toLowerCase() ?? null };
    }
  } catch { /* no events */ }
  return { lane: null, author: null, mainBefore: null };
}

/** Pseudo-author for a main advance nobody merged through the queue: the picker needs someone to avoid. */
const MAIN_AUTHOR = { id: 'main', name: 'main', runtime: 'none', tmux_session: '', workspace: null, mode: 'adopted', status: 'idle', model: null, effort: null } as unknown as Agent;

export async function requestCandidateReviewFor(project: string, mainSha: string): Promise<void> {
  const pipe = pipelineOf(project);
  const on = pipe.candidate_review ?? pipe.auto_review;
  if (!on) return;
  const merge = mergeThatMade(project, mainSha);
  const spec = mainSpec(project);
  const result = await requestCandidateReview({
    project, sha: mainSha, repo: projectRepo(project), remote: spec.remote, lane: merge.lane, author: merge.author,
    mainBefore: merge.mainBefore, productionSha: productionSha(project)?.sha ?? null,
    pick: (author) => chooseReviewer(author ?? MAIN_AUTHOR, pipe, null),
    deliver: (agent, text) => deliverSystemLine(agent, text, { kind: 'info', source: CANDIDATE_NOTE }),
  });
  if (result.ok) {
    const d = result.data;
    note(project, merge.lane, mainSha, CANDIDATE_NOTE, `auto: candidate review of ${mainSha.slice(0, 8)} (since ${d.base.slice(0, 8)}: ${d.merges} merge${d.merges === 1 ? '' : 's'}, ${d.files} file${d.files === 1 ? '' : 's'}) asked from @${d.reviewer}${d.folded ? `, ${d.folded.slice(0, 8)} folded in` : ''}`);
  } else if (result.error !== 'off' && result.error !== 'already requested' && result.error !== 'empty') {
    note(project, merge.lane, mainSha, CANDIDATE_NOTE, `auto: no candidate review of ${mainSha.slice(0, 8)} — ${result.error}`);
  }
}

function announceCandidateReview(result: CandidateResult): void {
  const sha8 = result.sha.slice(0, 8);
  const by = result.seat ? ` by @${result.seat}` : '';
  let project: string | null = null;
  let lane: string | null = null;
  let authorId: string | null = null;
  try {
    const row = getDb().prepare("SELECT payload_json FROM events WHERE type = 'pipeline.candidate_review' AND entity_id = ? ORDER BY id DESC LIMIT 1").get(result.sha) as { payload_json: string | null } | undefined;
    const p = row?.payload_json ? JSON.parse(row.payload_json) as { project?: string | null; lane?: string | null; author_id?: string | null } : {};
    project = p.project ?? null; lane = p.lane ?? null; authorId = p.author_id ?? null;
  } catch { /* no record */ }
  if (result.result === 'pass') {
    if (project) note(project, lane, result.sha, CANDIDATE_NOTE, `auto: candidate review${by} — PASS on ${sha8}`);
    return;
  }
  const word = `NEEDS FIXES (${result.issues} issue${result.issues === 1 ? '' : 's'})`;
  if (project) note(project, lane, result.sha, CANDIDATE_NOTE, `auto: candidate review${by} — ${word} on ${sha8}, see ${result.file}`);
  const text = `[from WaveCode] Candidate review of main ${sha8}${by}: ${word}, see ${result.file}. This is already on main: open a fix lane now so the next release does not carry it.`;
  // The merged lane's author and the driver seats, each once.
  void tellDriverSeats(text, authorId, CANDIDATE_NOTE).catch((e) => logger.debug({ sha: result.sha, error: (e as Error).message }, 'Candidate review line failed'));
}

candidateHooks.onResult = announceCandidateReview;

export async function onStagingDeployed(releaseId: string): Promise<void> {
  const release = getRelease(releaseId);
  if (!release || release.target !== 'staging' || release.status !== 'deployed' || release.requested_by !== 'auto') return;
  if (acted(release.sha, LIVE)) return;
  const url = release.staging_url ?? '';
  const version = release.version ? `v${release.version}` : 'v?';
  const text = `live on staging: ${url} ${version} — please check and press Ready for prod`;
  const freeze = getFreeze(release.sha);
  tell(freeze?.author_agent_id ?? null, text);
  void notify({ title: 'Live on staging', body: text, url: '/release', tag: `live-${release.sha}` }).catch(() => {});
  emit(LIVE, 'run', release.sha, { sha: release.sha, project: release.project, lane: release.lane, text }, null);
  if (release.project && release.lane) note(release.project, release.lane, release.sha, 'live', text);
  if (release.project) await drainStagingQueue(release.project);
}

pipelineHooks.onFreeze = onFreezeRecorded;
pipelineHooks.onReviewRequest = (file) => ingestReviewRequestFile(file).then(() => undefined);
pipelineHooks.onAuthorDone = (agentId) => {
  void onAuthorDone(agentId).catch((e) => logger.debug({ agentId, error: (e as Error).message }, 'Auto-freeze skipped'));
};
pipelineHooks.onMain = (project, sha) => {
  void onMainAdvanced(project, sha).catch((e) => logger.debug({ project, error: (e as Error).message }, 'Auto-merge skipped'));
};
pipelineHooks.onDeployed = onStagingDeployed;
pipelineHooks.onVerified = (project) => (project ? drainStagingQueue(project) : undefined);
