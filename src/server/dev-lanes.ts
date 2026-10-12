/**
 * Developer lanes ahead of main, with one what's-missing line each.
 * Reuses freezes, the test runner, and the reviewer ladder. Not a second queue.
 */

import { execFileSync } from 'node:child_process';
import { getConfig } from './config.js';
import { getDb, getRun, listAgents, type Agent } from './db.js';
import { getLatestCompletedReview } from './code-review.js';
import { listFreezes, refreshProject, type ReleaseFreeze } from './release-freezes.js';
import { currentStagingTip, listReleases } from './releases.js';
import { prereqStatusNote } from './prereqs.js';
import { isMissingAncestor } from './staging-forward.js';
import { pickReviewer } from './reviewer-ladder.js';
import { deliverSystemLine } from './wire-lines.js';
import { latestPipelineNote } from './lane-pipeline.js';
import logger from './logger.js';
import {
  BEHIND_STAGING_LINE, DEFAULT_BEFORE_FREEZE_TIP, behindMainLine, fullFailFlag, laneStatusLine, needsGreenQuick, promoteBlockReason,
  QUICK_CHECK_RUNNING, type CheckState, type GateView,
} from './lane-status.js';
import {
  changedFiles, commitsBehind, isMergeOnlyDelta, mainSpec, projectRepo, reconcileBehindFreezes, resolveMainRef,
} from './lane-main.js';
import { pingReviewersForGreenSha } from './gate-ping.js';
import {
  fullRunPhrase, hasLogCommand, readLaneReport, readTestLog, selectChipRun, shaChecks, suiteNames,
  testsConfigured, watchTestRuns, type TestHostError, type TestRun,
} from './test-runs.js';
import type { Result } from './db.js';

export interface DeltaReview {
  label: 'delta review: merge only';
  previous_sha: string;
  verdict_path: string | null;
}

export interface DevLane {
  project: string;
  lane: string;
  sha: string;
  author_name: string | null;
  author_agent_id: string | null;
  reviewer_name: string | null;
  reviewer_agent_id: string | null;
  freeze_sha: string | null;
  run_id: string | null;
  status_line: string;
  /** Why STAGE stays disabled. Staleness is separate. Admins are not exempt. */
  stage_block: string | null;
  promote_block: string | null;
  full_fail_flag: string | null;
  before_freeze_tip: string | null;
  test_run: TestRun | null;
  test_errors: TestHostError[];
  test_log: boolean;
  reviewers: Array<{ id: string; name: string; alias: string | null }>;
  delta_review: DeltaReview | null;
}

function git(repo: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
}

function globToRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

function tipOf(repo: string, remote: string, lane: string): string | null {
  for (const ref of [`refs/remotes/${remote}/${lane}`, lane]) {
    const sha = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (sha && /^[0-9a-f]{40}$/i.test(sha)) return sha;
  }
  return null;
}

function ahead(repo: string, mainRef: string, sha: string): boolean {
  const n = git(repo, ['rev-list', '--count', `${mainRef}..${sha}`]);
  return !!n && /^\d+$/.test(n) && Number(n) > 0;
}

function authorFor(lane: string, agents: Agent[], freeze: ReleaseFreeze | null): { id: string | null; name: string | null } {
  if (freeze?.author_agent_id) {
    const a = agents.find((x) => x.id === freeze.author_agent_id);
    return { id: freeze.author_agent_id, name: a?.alias ?? a?.name ?? freeze.author_name };
  }
  const bare = lane.replace(/^wc-/, '');
  const a = agents.find((x) => x.tmux_session === lane || x.name === bare || x.name === lane || x.alias === bare);
  return a ? { id: a.id, name: a.alias ?? a.name } : { id: null, name: bare || null };
}

function touches(files: string[], paths: string[]): string | null {
  for (const p of paths) {
    if (files.some((f) => f === p || f.startsWith(`${p}/`))) return p;
  }
  return null;
}

function checksFor(runs: TestRun[], sha: string, freezeGate: 'GREEN' | 'RED' | null, project: string): {
  gate: GateView; quick: CheckState; full: CheckState; fullRun: TestRun | null;
} {
  const names = suiteNames(project);
  const live = shaChecks(runs, sha, names);
  if (!testsConfigured(project)) {
    const full: CheckState = freezeGate === 'GREEN' ? 'green' : freezeGate === 'RED' ? 'red' : 'unconfigured';
    return {
      quick: 'unconfigured',
      full,
      fullRun: null,
      gate: full === 'green' ? { state: 'green' } : full === 'red' ? { state: 'red', failingStep: 'failed' } : { state: 'unconfigured' },
    };
  }
  const full = live.full;
  const gate: GateView = full === 'pending'
    ? { state: live.fullRun?.state === 'queued' ? 'queued' : 'running' }
    : full === 'green' ? { state: 'green' }
    : full === 'red' ? { state: 'red', failingStep: live.fullRun?.failing_step ?? null }
    : { state: 'not_run' };
  return { gate, quick: live.quick, full, fullRun: live.fullRun };
}

function issuesFor(freeze: ReleaseFreeze | null): number {
  if (!freeze?.run_id) return 0;
  return getLatestCompletedReview(freeze.run_id)?.issues_found ?? 0;
}

function deltaFor(repo: string, mainRef: string, lane: string, head: string, freezes: ReleaseFreeze[]): DeltaReview | null {
  const previous = freezes
    .filter((f) => f.lane === lane && f.verdict === 'pass' && f.sha !== head)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  if (!previous) return null;
  if (!isMergeOnlyDelta(repo, previous.sha, head, mainRef)) return null;
  return { label: 'delta review: merge only', previous_sha: previous.sha, verdict_path: previous.verdict_path };
}

function reviewerChoices(authorId: string | null): DevLane['reviewers'] {
  return listAgents()
    .filter((a) => a.id !== authorId && a.role !== 'orchestrator' && a.mode !== 'file')
    .map((a) => ({ id: a.id, name: a.name, alias: a.alias ?? null }));
}

export function beforeFreezeTip(project: string): string {
  const custom = getConfig().projects?.[project]?.before_freeze_tip;
  return typeof custom === 'string' && custom.trim() ? custom.trim() : DEFAULT_BEFORE_FREEZE_TIP;
}

export function listDevLanes(): DevLane[] {
  try { reconcileBehindFreezes(); } catch (e) { logger.debug({ error: (e as Error).message }, 'behind-main reconcile skipped'); }
  const cfg = getConfig();
  const agents = listAgents();
  const freezes = (() => { try { return listFreezes(); } catch { return [] as ReleaseFreeze[]; } })();
  const out: DevLane[] = [];
  const watched: Array<{ project: string; lane: string; sha: string }> = [];
  const allRuns: TestRun[] = [];

  for (const [project, pc] of Object.entries(cfg.projects ?? {})) {
    if (!pc.repo) continue;
    try { refreshProject(project); } catch { /* offline */ }
    const repo = pc.repo;
    const spec = mainSpec(project);
    const mainRef = resolveMainRef(repo, project);
    if (!mainRef) continue;
    const re = globToRe(pc.lane_glob || 'wc-*');
    const names = new Set<string>();
    const listed = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
    for (const short of (listed ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
      const name = short.startsWith(`${spec.remote}/`) ? short.slice(spec.remote.length + 1) : short;
      if (name === 'HEAD' || name === spec.branch || name.startsWith(spec.branch + '/')) continue;
      if (pc.candidate_refs && globToRe(pc.candidate_refs).test(name)) continue;
      if (re.test(name)) names.add(name);
    }
    for (const f of freezes) if (f.project === project && f.lane && (f.status === 'open' || f.status === 'behind-main')) names.add(f.lane);

    const fileCache = new Map<string, string[]>();
    const filesOf = (lane: string, sha: string) => {
      const hit = fileCache.get(lane);
      if (hit) return hit;
      const files = changedFiles(repo, sha, mainRef);
      fileCache.set(lane, files);
      return files;
    };

    let deployed: Array<{ lane: string | null; sha: string }> = [];
    try { deployed = listReleases({ project, target: 'staging', status: 'deployed', limit: 40 }); } catch { deployed = []; }
    const stagingNow = (() => { try { return currentStagingTip(project); } catch { return null; } })();

    for (const lane of [...names].sort()) {
      const sha = tipOf(repo, spec.remote, lane);
      if (!sha || !ahead(repo, mainRef, sha)) continue;
      const laneFreezes = freezes.filter((f) => f.project === project && f.lane === lane && f.status !== 'merged');
      const current = laneFreezes.find((f) => f.sha === sha && (f.status === 'open' || f.status === 'behind-main'))
        ?? laneFreezes.find((f) => f.status === 'open' || f.status === 'behind-main')
        ?? null;
      const freeze = current && current.sha === sha ? current : null;
      const behind = commitsBehind(project, sha) ?? 0;
      const report = readLaneReport(project, lane, sha);
      allRuns.push(...report.runs);
      watched.push({ project, lane, sha });
      const freezeGate = freeze?.gate === 'GREEN' || freeze?.gate === 'RED' ? freeze.gate : null;
      const viewed = checksFor(report.runs, freeze?.sha ?? sha, freezeGate, project);
      if (viewed.full === 'green') {
        try { pingReviewersForGreenSha(freeze?.sha ?? sha); } catch { /* table missing */ }
      }
      const files = filesOf(lane, sha);
      const protectedPath = touches(files, pc.protected_paths ?? []);
      const hasMigration = !!pc.migrations_dir && files.some((f) => f === pc.migrations_dir || f.startsWith(`${pc.migrations_dir}/`));
      let overlap: { lane: string; files: number } | null = null;
      for (const rel of deployed) {
        if (!rel.lane || rel.lane === lane) continue;
        const otherSha = tipOf(repo, spec.remote, rel.lane);
        if (!otherSha) continue;
        const otherFiles = new Set(filesOf(rel.lane, otherSha));
        const n = files.filter((f) => otherFiles.has(f)).length;
        if (n > 0 && (!overlap || n > overlap.files)) overlap = { lane: rel.lane, files: n };
      }
      const cardSha = freeze?.sha ?? sha;
      const onStaging = deployed.some((r) => (r.lane === lane || r.sha === cardSha) && r.sha === cardSha);
      const author = authorFor(lane, agents, freeze ?? current);
      const fullLabel = fullRunPhrase(viewed.fullRun);
      const behindStaging = !!(repo && stagingNow?.sha && isMissingAncestor(repo, stagingNow.sha, sha));
      let prereqNote: string | null = null;
      try { prereqNote = prereqStatusNote(project, cardSha); } catch { prereqNote = null; }
      const status_line = laneStatusLine({
        sha, author: author.name, reviewer: freeze?.reviewer_name ?? null,
        freeze: freeze ? { sha: freeze.sha, verdict: freeze.verdict, issues: issuesFor(freeze), gate: freezeGate } : null,
        gate: viewed.gate, quick: viewed.quick, full: viewed.full, fullRunLabel: fullLabel,
        behindMain: behind, behindStaging, prereqNote, protectedPath, hasMigration, overlap, onStaging,
        autoNote: latestPipelineNote(project, lane),
      });
      const sha8 = cardSha.slice(0, 8);
      const fullGreen = viewed.full === 'green';
      const stageGreen = viewed.quick === 'green' || fullGreen;
      const testsKnown = viewed.quick !== 'unconfigured' || viewed.full !== 'unconfigured';
      const stage_block = behind > 0
        ? behindMainLine(behind)
        : behindStaging
          ? BEHIND_STAGING_LINE
          : !testsKnown || stageGreen
            ? null
            : viewed.quick === 'pending'
              ? QUICK_CHECK_RUNNING
              : needsGreenQuick(sha8);
      const promote_block = fullGreen || viewed.full === 'unconfigured' ? null : promoteBlockReason(sha8);
      const full_fail_flag = onStaging && viewed.full === 'red' ? fullFailFlag(viewed.fullRun?.failing_step) : null;
      out.push({
        project, lane, sha,
        author_name: author.name, author_agent_id: author.id,
        reviewer_name: freeze?.reviewer_name ?? null, reviewer_agent_id: freeze?.reviewer_agent_id ?? null,
        freeze_sha: freeze?.sha ?? null, run_id: freeze?.run_id ?? null,
        status_line, stage_block, promote_block, full_fail_flag,
        before_freeze_tip: freeze ? null : beforeFreezeTip(project),
        test_run: selectChipRun(report.runs, freeze?.sha ?? sha, lane),
        test_errors: report.errors,
        test_log: hasLogCommand(project),
        reviewers: reviewerChoices(author.id),
        delta_review: freeze ? deltaFor(repo, mainRef, lane, sha, freezes) : null,
      });
    }
  }
  try { watchTestRuns(watched, allRuns); } catch { /* poller is best-effort */ }
  return out;
}

export function requestLaneReview(opts: { project: string; lane: string; reviewer: string }): Result<{ reviewer: string; delta: boolean }> {
  const project = opts.project?.trim();
  const lane = opts.lane?.trim();
  const reviewer = opts.reviewer?.trim();
  if (!project || !lane || !reviewer) return { ok: false, error: 'project, lane, and reviewer are required' };
  let freeze: ReleaseFreeze | null = null;
  try {
    const rows = getDb().prepare(
      "SELECT * FROM release_freezes WHERE project = ? AND lane = ? AND status IN ('open', 'behind-main') ORDER BY created_at DESC LIMIT 1",
    ).all(project, lane) as ReleaseFreeze[];
    freeze = rows[0] ?? null;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!freeze) return { ok: false, error: 'needs an author freeze first' };
  if (freeze.status === 'behind-main') return { ok: false, error: 'behind main: merge main' };
  const authorId = freeze.author_agent_id;
  if (!authorId) return { ok: false, error: 'the freeze has no author agent' };
  const run = freeze.run_id ? getRun(freeze.run_id) : null;
  const picked = pickReviewer(
    { agent_id: authorId, task_id: run?.ok ? run.data.task_id : 'none' },
    { explicit: reviewer },
  );
  if (!picked.ok) return { ok: false, error: picked.reason };
  const repo = projectRepo(project);
  const mainRef = repo ? resolveMainRef(repo, project) : null;
  const delta = repo && mainRef ? deltaFor(repo, mainRef, lane, freeze.sha, listFreezes()) : null;
  const sha8 = freeze.sha.slice(0, 8);
  const text = delta
    ? `[from WaveCode] delta review: merge only. Previous verdict: ${delta.verdict_path ?? delta.previous_sha}. New SHA ${sha8} on ${lane} only brings in main. Quick check, one full gate, and a re-verdict.`
    : `[from WaveCode] Please review freeze ${sha8} on ${lane} by @${freeze.author_name ?? 'author'}. Read ${freeze.freeze_path ?? 'the freeze note'}. If the code is OK and the gate is still running, write VERDICT: PASS (gate pending).`;
  deliverSystemLine(picked.agent, text, { kind: 'info', source: 'review' });
  return { ok: true, data: { reviewer: picked.agent.alias ?? picked.agent.name, delta: !!delta } };
}

export function laneTestLog(project: string, id: string): Result<{ log: string | null }> {
  if (!hasLogCommand(project)) return { ok: false, error: 'tests.log_command is not configured' };
  const text = readTestLog(project, { id });
  if (text == null) return { ok: false, error: 'log command failed' };
  return { ok: true, data: { log: text } };
}
