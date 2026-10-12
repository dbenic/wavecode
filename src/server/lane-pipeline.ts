/**
 * Hands-free lane pipeline. Every step is a per-project switch and defaults
 * off. Production is never requested from here: the only staging call uses
 * target 'staging' and requested_by 'auto'.
 *
 * Auto-freeze merges a clean origin/main, pushes the lane branch through the
 * configured command, runs the quick check, and writes a freeze note the
 * existing parser already reads. Auto-gate queues one full run per SHA.
 * Auto-review uses the routing map, then the reviewer ladder, and never the
 * author or a denied name. Auto-stage waits for PASS plus GREEN, then a FIFO
 * slot (one lane until Ready for prod or the pin expires).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, type ProjectConfig } from './config.js';
import { getAgent, getDb, getRun, listAgents, resolveAgent, type Agent, type Result } from './db.js';
import { emit } from './event-bus.js';
import { pingReviewersForGreenSha } from './gate-ping.js';
import { alertBehind, alertMerged, changedFiles, commitsBehind, isMergeOnlyDelta, laneAutomationDenied, mainSpec, mainTip, projectRepo, resolveMainRef } from './lane-main.js';
import logger from './logger.js';
import { notify } from './notifications.js';
import { pipelineHooks } from './pipeline-hooks.js';
import { workspaceMatches } from './project-gate.js';
import { getFreeze, ingestFreezeFile, listFreezes, setFreezeGate, viewShaChecks, type ReleaseFreeze } from './release-freezes.js';
import { getRelease, listReleases, requestRelease, type ReleaseRequest } from './releases.js';
import { pickReviewer } from './reviewer-ladder.js';
import { deliverSystemLine } from './wire-lines.js';

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
  review_deny: string[];
  freeze_dir: string | null;
}

type ExecResult = { code: number; stdout: string };
let execForTest: ((argv: string[]) => ExecResult) | null = null;

export function setPipelineExecForTest(fn: ((argv: string[]) => ExecResult) | null): void {
  execForTest = fn;
}

export function pipelineOf(project: string | null): PipelineSwitches {
  const raw: ProjectConfig['pipeline'] = project ? getConfig().projects?.[project]?.pipeline : undefined;
  const off: PipelineSwitches = {
    auto_freeze: false, auto_gate: false, auto_review: false, auto_stage: false, auto_merge_main: false,
    quick_check_command: null, push_command: null, gate_command: null, review_routes: {}, review_deny: [], freeze_dir: null,
  };
  if (!raw) return off;
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
    review_deny: (raw.review_deny ?? []).map((s) => s.toLowerCase()),
    freeze_dir: raw.freeze_dir ?? null,
  };
}

function fill(template: string[], vars: Record<string, string>): string[] {
  return template.map((arg) => arg.replace(/\{(workspace|lane|sha|remote|project)\}/g, (_, key: string) => vars[key] ?? ''));
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
  return null;
}

function runArgv(argv: string[]): ExecResult {
  if (argv.length === 0) return { code: 1, stdout: '' };
  if (execForTest) return execForTest(argv);
  try {
    const stdout = execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    return { code: typeof err.status === 'number' ? err.status : 1, stdout: String(err.stdout ?? '') };
  }
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', '-c', 'user.name=wavecode', '-c', 'user.email=wavecode@localhost', ...args], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
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

function headOf(workspace: string): string | null {
  try {
    const sha = git(workspace, ['rev-parse', 'HEAD']);
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

function branchOf(workspace: string): string | null {
  try {
    const name = git(workspace, ['branch', '--show-current']);
    return name || null;
  } catch {
    return null;
  }
}

/** A checkout owned by a `review_deny` seat (name or alias) is not auto-merged. */
function workspaceOwnedByDenied(workspace: string): boolean {
  const resolved = path.resolve(workspace);
  const owners = listAgents().filter((agent) => agent.workspace && path.resolve(agent.workspace) === resolved);
  if (owners.length === 0) return false;
  const project = projectForWorkspace(workspace);
  const names = project ? [project] : Object.keys(getConfig().projects ?? {});
  return owners.some((owner) => names.some((name) => laneAutomationDenied(name, owner)));
}

/** Merge origin/main. A conflict aborts and names the files. A review_deny owner's workspace is left untouched. Never pushes. */
export function mergeMainClean(workspace: string, mainRef: string): { ok: true } | { ok: false; files: string[]; skipped?: boolean } {
  if (workspaceOwnedByDenied(workspace)) return { ok: false, files: [], skipped: true };
  try {
    git(workspace, ['merge', '--no-ff', '--no-edit', '-m', 'merge origin/main', mainRef]);
    return { ok: true };
  } catch {
    let files: string[] = [];
    try {
      files = git(workspace, ['diff', '--name-only', '--diff-filter=U']).split('\n').map((l) => l.trim()).filter(Boolean);
    } catch { /* no unmerged list */ }
    try { git(workspace, ['merge', '--abort']); } catch { /* already clean, or no merge to abort */ }
    return { ok: false, files };
  }
}

function freezeDir(project: string, pipe: PipelineSwitches): string | null {
  if (pipe.freeze_dir) return pipe.freeze_dir;
  const inbox = getConfig().review?.freeze_inbox ?? [];
  return inbox[0] ?? null;
}

function publishFreeze(opts: {
  workspace: string; project: string; lane: string; sha: string; author: Agent; pipe: PipelineSwitches;
}): Result<{ sha: string }> {
  const refused = laneRefError(opts.project, opts.lane);
  if (refused) return { ok: false, error: refused };
  const spec = mainSpec(opts.project);
  const vars = { workspace: opts.workspace, lane: opts.lane, sha: opts.sha, remote: spec.remote, project: opts.project };
  if (opts.pipe.push_command?.length) {
    const pushed = runArgv(fill(opts.pipe.push_command, vars));
    if (pushed.code !== 0) {
      const text = `push of ${opts.lane} failed. The freeze was not written.`;
      tell(opts.author.id, text);
      note(opts.project, opts.lane, opts.sha, 'push', `auto: push failed for ${opts.lane}`);
      return { ok: false, error: text };
    }
  }
  if (opts.pipe.quick_check_command?.length) {
    const checked = runArgv(fill(opts.pipe.quick_check_command, vars));
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
  const ingested = ingestFreezeFile(file);
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

function denied(name: string, pipe: PipelineSwitches): boolean {
  return pipe.review_deny.includes(name.toLowerCase());
}

function badReviewer(agent: Agent, authorId: string, pipe: PipelineSwitches): boolean {
  if (agent.id === authorId) return true;
  if (denied(agent.name, pipe)) return true;
  if (agent.alias && denied(agent.alias, pipe)) return true;
  return false;
}

/** Routing map first, then the reviewer ladder. Never the author, never a denied name. */
export function chooseReviewer(author: Agent, pipe: PipelineSwitches, taskId: string | null): Agent | null {
  const routed = pipe.review_routes[author.name]
    ?? pipe.review_routes[author.alias ?? '']
    ?? Object.entries(pipe.review_routes).find(([key]) => key.toLowerCase() === author.name.toLowerCase())?.[1];
  if (routed && routed.toLowerCase() !== author.name.toLowerCase() && !denied(routed, pipe)) {
    const resolved = resolveAgent(routed);
    if (resolved.ok && !badReviewer(resolved.data, author.id, pipe)) return resolved.data;
  }
  if (!taskId) return null;
  const picked = pickReviewer({ agent_id: author.id, task_id: taskId });
  if (!picked.ok || badReviewer(picked.agent, author.id, pipe)) return null;
  return picked.agent;
}

function deltaSentence(project: string, lane: string, sha: string): string | null {
  const repo = projectRepo(project);
  const mainRef = repo ? resolveMainRef(repo, project) : null;
  if (!repo || !mainRef) return null;
  const previous = listFreezes().find((f) => f.project === project && f.lane === lane && f.sha !== sha && f.verdict === 'pass');
  if (!previous || !isMergeOnlyDelta(repo, previous.sha, sha, mainRef)) return null;
  return `delta review: merge only. Previous verdict: ${previous.verdict_path ?? previous.sha}`;
}

function assignReviewer(freeze: ReleaseFreeze, kind: 'assign' | 'green' = 'assign'): void {
  if (!freeze.project || !freeze.author_agent_id) return;
  const pipe = pipelineOf(freeze.project);
  if (!pipe.auto_review) return;
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
  const delta = freeze.lane ? deltaSentence(freeze.project, freeze.lane, freeze.sha) : null;
  const sha8 = freeze.sha.slice(0, 8);
  const text = delta
    ? `[from WaveCode] ${delta}. New SHA ${sha8} on ${freeze.lane}. Read ${freeze.freeze_path ?? 'the freeze note'}. If the code is OK and the gate is still running, write VERDICT: PASS (gate pending).`
    : `[from WaveCode] Please review freeze ${sha8} on ${freeze.lane ?? 'the lane'} by @${author.data.name}. Read ${freeze.freeze_path ?? 'the freeze note'}. If the code is OK and the gate is still running, write VERDICT: PASS (gate pending).`;
  deliverSystemLine(reviewer, text, { kind: 'info', source: 'review' });
  emit('pipeline.review', 'run', `${freeze.sha}:${kind}`, { sha: freeze.sha, reviewer_id: reviewer.id, kind }, null);
  const shown = kind === 'green'
    ? `auto: GREEN landed — re-pinged @${reviewer.alias ?? reviewer.name}`
    : `auto: review requested — pinged @${reviewer.alias ?? reviewer.name}`;
  note(freeze.project, freeze.lane, freeze.sha, 'review', shown);
}

function gateWord(stdout: string): 'QUEUED' | 'RUNNING' | 'GREEN' | 'RED' | null {
  const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/\b(QUEUED|RUNNING|GREEN|RED)\b/i);
    if (match) return match[1].toUpperCase() as 'QUEUED' | 'RUNNING' | 'GREEN' | 'RED';
  }
  return null;
}

function queueFullGate(freeze: ReleaseFreeze): void {
  if (!freeze.project) return;
  const pipe = pipelineOf(freeze.project);
  if (!pipe.auto_gate || !pipe.gate_command?.length) return;
  if (acted(`${freeze.sha}:full`, GATED)) return;
  const spec = mainSpec(freeze.project);
  const argv = fill(pipe.gate_command, {
    sha: freeze.sha, lane: freeze.lane ?? '', workspace: '', remote: spec.remote, project: freeze.project,
  });
  const result = runArgv(argv);
  const word = gateWord(result.stdout) ?? (result.code === 0 ? 'QUEUED' : 'RED');
  setFreezeGate(freeze.sha, word);
  emit(GATED, 'run', `${freeze.sha}:full`, { sha: freeze.sha, project: freeze.project, lane: freeze.lane, gate: word }, null);
  note(freeze.project, freeze.lane, freeze.sha, 'gate', `auto: full gate ${word} on ${freeze.sha.slice(0, 8)}`);
  if (word === 'GREEN') {
    pingReviewersForGreenSha(freeze.sha);
    const fresh = getFreeze(freeze.sha);
    if (fresh && fresh.verdict !== 'pass' && pipelineOf(fresh.project).auto_review) assignReviewer(fresh, 'green');
  }
}

function isGreen(freeze: ReleaseFreeze): boolean {
  return viewShaChecks(freeze).full === 'green';
}

function touches(files: string[], paths: string[]): string | null {
  for (const protectedPath of paths) {
    if (files.some((file) => file === protectedPath || file.startsWith(`${protectedPath}/`))) return protectedPath;
  }
  return null;
}

function overlapWithStaging(project: string, lane: string, files: string[], repo: string, mainRef: string): { lane: string; files: number } | null {
  const deployed = listReleases({ project, target: 'staging', status: 'deployed', limit: 40 });
  let overlap: { lane: string; files: number } | null = null;
  const spec = mainSpec(project);
  for (const rel of deployed) {
    if (!rel.lane || rel.lane === lane) continue;
    let otherSha = rel.sha;
    try {
      const tip = git(repo, ['rev-parse', '--verify', `${spec.remote}/${rel.lane}^{commit}`]);
      if (/^[0-9a-f]{40}$/i.test(tip)) otherSha = tip;
    } catch { /* the deployed SHA is enough */ }
    const other = new Set(changedFiles(repo, otherSha, mainRef));
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
  if (!isGreen(freeze)) {
    note(row.project, row.lane, row.sha, 'hold', `auto: waiting for GREEN on ${row.sha.slice(0, 8)}`);
    return;
  }
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
  const pipe = pipelineOf(freeze.project);
  if (!pipe.auto_stage) return;
  if (freeze.status === 'behind-main') {
    note(freeze.project, freeze.lane, freeze.sha, 'hold', 'auto: behind main — not staged');
    return;
  }
  if (freeze.status !== 'open') return;
  if (listReleases({ project: freeze.project, sha: freeze.sha, target: 'staging', limit: 5 }).some((r) => r.status !== 'failed' && r.status !== 'rejected')) return;
  const behind = commitsBehind(freeze.project, freeze.sha);
  if (behind == null || behind > 0) {
    note(freeze.project, freeze.lane, freeze.sha, 'hold', `auto: behind main — not staged`);
    return;
  }
  if (!isGreen(freeze)) {
    note(freeze.project, freeze.lane, freeze.sha, 'hold', `auto: waiting for GREEN on ${freeze.sha.slice(0, 8)}`);
    return;
  }
  const repo = projectRepo(freeze.project);
  const mainRef = repo ? resolveMainRef(repo, freeze.project) : null;
  if (!repo || !mainRef) {
    note(freeze.project, freeze.lane, freeze.sha, 'hold', 'auto: repo unavailable — not staged');
    return;
  }
  const project = getConfig().projects?.[freeze.project];
  const files = changedFiles(repo, freeze.sha, mainRef);
  const protectedPath = touches(files, project?.protected_paths ?? []);
  if (protectedPath) {
    note(freeze.project, freeze.lane, freeze.sha, 'hold', `auto: touches ${protectedPath} — not staged`);
    return;
  }
  const overlap = overlapWithStaging(freeze.project, freeze.lane, files, repo, mainRef);
  if (overlap) {
    note(freeze.project, freeze.lane, freeze.sha, 'hold', `auto: overlaps lane ${overlap.lane} in ${overlap.files} files — not staged`);
    return;
  }
  const hasMigration = !!project?.migrations_dir && files.some((file) => file === project.migrations_dir || file.startsWith(`${project.migrations_dir}/`));
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
export function onAuthorDone(agentId: string): Result<{ sha: string }> {
  try {
    const agent = getAgent(agentId);
    if (!agent.ok || !agent.data.workspace) return { ok: false, error: 'no workspace' };
    const project = projectForWorkspace(agent.data.workspace);
    if (!project) return { ok: false, error: 'no project' };
    const pipe = pipelineOf(project);
    if (!pipe.auto_freeze) return { ok: false, error: 'auto-freeze off' };
    const lane = branchOf(agent.data.workspace);
    const spec = mainSpec(project);
    const refused = lane ? laneRefError(project, lane) : 'not a developer lane';
    if (!lane || refused) return { ok: false, error: refused ?? 'not a developer lane' };
    const repo = projectRepo(project) ?? agent.data.workspace;
    const mainRef = resolveMainRef(repo, project) ?? `${spec.remote}/${spec.branch}`;
    let sha = headOf(agent.data.workspace);
    if (!sha) return { ok: false, error: 'no HEAD' };
    const behind = commitsBehind(project, sha);
    if (behind != null && behind > 0) {
      if (laneAutomationDenied(project, agent.data)) return { ok: false, error: 'excluded from lane automation' };
      const merged = mergeMainClean(agent.data.workspace, mainRef);
      if (!merged.ok) {
        if (merged.skipped) return { ok: false, error: 'excluded from lane automation' };
        const files = merged.files.length ? merged.files.join(', ') : 'unknown files';
        alertBehind({ lane, project, authorAgentId: agent.data.id, authorName: agent.data.name });
        const text = behindConflict(lane);
        note(project, lane, sha, 'merge', `auto: merge conflict in ${files} — @${agent.data.name}`);
        return { ok: false, error: text };
      }
      sha = headOf(agent.data.workspace) ?? sha;
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
export function onMainAdvanced(project: string, mainSha?: string): void {
  const pipe = pipelineOf(project);
  if (!pipe.auto_merge_main) return;
  const repo = projectRepo(project);
  if (!repo) return;
  const mainRef = resolveMainRef(repo, project);
  if (!mainRef) return;
  const lanes = new Set<string>();
  for (const freeze of listFreezes()) {
    if (freeze.project === project && freeze.lane && !laneRefError(project, freeze.lane) && (freeze.status === 'open' || freeze.status === 'behind-main')) lanes.add(freeze.lane);
  }
  for (const agent of listAgents()) {
    if (!agent.workspace) continue;
    const branch = branchOf(agent.workspace);
    if (branch && !laneRefError(project, branch)) lanes.add(branch);
  }
  for (const lane of lanes) {
    if (laneRefError(project, lane)) continue;
    const author = listAgents().find((agent) => agent.workspace && branchOf(agent.workspace) === lane);
    if (!author?.workspace || laneAutomationDenied(project, author)) continue;
    const before = headOf(author.workspace);
    if (!before) continue;
    const behind = commitsBehind(project, before);
    if (behind == null || behind <= 0) continue;
    const merged = mergeMainClean(author.workspace, mainRef);
    if (!merged.ok) {
      if (merged.skipped) continue;
      const files = merged.files.length ? merged.files.join(', ') : 'unknown files';
      const shaNow = mainSha ?? mainTip(repo, project)?.sha ?? '';
      if (shaNow) alertBehind({ lane, project, authorAgentId: author.id, authorName: author.name });
      note(project, lane, before, 'merge', `auto: merge conflict in ${files} — @${author.name}`);
      continue;
    }
    const sha = headOf(author.workspace);
    const mergedTip = mainSha ?? mainTip(repo, project)?.sha ?? '';
    if (mergedTip) alertMerged({ lane, project, mainSha: mergedTip, authorAgentId: author.id, authorName: author.name });
    if (!sha || sha === before || acted(sha, FROZEN)) continue;
    publishFreeze({ workspace: author.workspace, project, lane, sha, author, pipe });
  }
}

export function onFreezeRecorded(sha: string): void {
  const freeze = getFreeze(sha);
  if (!freeze || (freeze.status !== 'open' && freeze.status !== 'behind-main')) return;
  try { queueFullGate(freeze); } catch (e) { logger.debug({ sha, error: (e as Error).message }, 'Auto-gate skipped'); }
  try { assignReviewer(getFreeze(sha) ?? freeze); } catch (e) { logger.debug({ sha, error: (e as Error).message }, 'Auto-review skipped'); }
  void considerAutoStage(sha).catch((e) => logger.debug({ sha, error: (e as Error).message }, 'Auto-stage skipped'));
}

export function onStagingDeployed(releaseId: string): void {
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
  if (release.project) void drainStagingQueue(release.project);
}

pipelineHooks.onFreeze = onFreezeRecorded;
pipelineHooks.onAuthorDone = (agentId) => { onAuthorDone(agentId); };
pipelineHooks.onMain = (project, sha) => { onMainAdvanced(project, sha); };
pipelineHooks.onDeployed = onStagingDeployed;
pipelineHooks.onVerified = (project) => { if (project) void drainStagingQueue(project); };
