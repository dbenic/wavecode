/**
 * Developer lanes ahead of main, with one what's-missing line each.
 * Reuses freezes, the test runner, and the reviewer ladder. Not a second queue.
 */

import { getConfig } from './config.js';
import { gitText } from './git-memo.js';
import { getDb, getRun, listAgents, type Agent } from './db.js';
import { getLatestCompletedReview } from './code-review.js';
import { freezeOnReviews, listFreezes, refreshProjectAsync, viewShaChecks, type ReleaseFreeze } from './release-freezes.js';
import { listReleases, resolveStagingTip, stageGateBlock } from './releases.js';
import { prereqStatusNote } from './prereqs.js';
import { pickReviewer } from './reviewer-ladder.js';
import { deliverSystemLine } from './wire-lines.js';
import { latestPipelineNote, requestReviewFor } from './lane-pipeline.js';
import logger from './logger.js';
import { recordJob } from './perf-monitor.js';
import {
  DEFAULT_BEFORE_FREEZE_TIP, behindMainLine, fullFailFlag, laneStatusLine, needsGreenQuick, promoteBlockReason,
  QUICK_CHECK_RUNNING, type CheckState, type GateView,
} from './lane-status.js';
import {
  laneAutomationDenied, withRefMemoAsync, changedFilesAsync, commitsBehindAsync, isMergeOnlyDeltaAsync, mainSpec, projectRepo, reconcileBehindFreezes, resolveMainRef,
} from './lane-main.js';
import { pingReviewersForGreenSha } from './gate-ping.js';
import { stagingForwardBlock } from './staging-forward.js';
import { LIVE_TEST_WINDOW_MS, type TestHostError, type TestRun, freezeAgeMs, fullRunPhrase, hasLogCommand, readLaneReport, readTestLog, selectChipRun, shaChecks, suiteNames, testsConfigured, watchTestRuns } from './test-runs.js';
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
  /** Full gate word from the status command or the freeze note. */
  gate: 'GREEN' | 'RED' | null;
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

function globToRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

async function tipOf(repo: string, remote: string, lane: string): Promise<string | null> {
  for (const ref of [`refs/remotes/${remote}/${lane}`, lane]) {
    const sha = await gitText(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (sha && /^[0-9a-f]{40}$/i.test(sha)) return sha;
  }
  return null;
}

async function ahead(repo: string, mainSha: string, sha: string): Promise<boolean> {
  const n = await gitText(repo, ['rev-list', '--count', `${mainSha}..${sha}`]);
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

async function deltaFor(repo: string, mainSha: string, lane: string, head: string, freezes: ReleaseFreeze[]): Promise<DeltaReview | null> {
  const previous = freezes
    .filter((f) => f.lane === lane && f.verdict === 'pass' && f.sha !== head)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
  if (!previous) return null;
  if (!await isMergeOnlyDeltaAsync(repo, previous.sha, head, mainSha)) return null;
  return { label: 'delta review: merge only', previous_sha: previous.sha, verdict_path: previous.verdict_path };
}

function reviewerChoices(project: string, authorId: string | null): DevLane['reviewers'] {
  return listAgents()
    .filter((a) => a.id !== authorId && a.role !== 'orchestrator' && a.mode !== 'file' && !laneAutomationDenied(project, a))
    .map((a) => ({ id: a.id, name: a.name, alias: a.alias ?? null }));
}

export function beforeFreezeTip(project: string): string {
  const custom = getConfig().projects?.[project]?.before_freeze_tip;
  return typeof custom === 'string' && custom.trim() ? custom.trim() : DEFAULT_BEFORE_FREEZE_TIP;
}

const LANE_REFRESH_MS = 15_000;
/** A cold board waits at most this long. A warm board returns immediately. */
export const LANE_REQUEST_BUDGET_MS = 1_500;

let laneSnapshot: DevLane[] = [];
let laneSnapshotAt = 0;
let laneRefresh: Promise<DevLane[]> | null = null;
let laneTimer: ReturnType<typeof setInterval> | null = null;
let laneEpoch = 0;

function yieldTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Build the lane board off the request path. Fetch runs at most once per repo
 * per refresh. Git facts are cached by (lane tip, main tip).
 */
export async function loadDevLanes(): Promise<DevLane[]> {
  const started = Date.now();
  try {
    return await withRefMemoAsync(loadDevLanesPass);
  } finally {
    recordJob('lane_board', Date.now() - started);
  }
}

async function loadDevLanesPass(): Promise<DevLane[]> {
  const freezes = (() => { try { return listFreezes(); } catch { return [] as ReleaseFreeze[]; } })();
  for (const freeze of freezes) {
    // only a freeze that can still move behind main needs the count warmed; closed ones stay as they are
    if (!freeze.sha || (freeze.status !== 'open' && freeze.status !== 'behind-main')) continue;
    try { await commitsBehindAsync(freeze.project, freeze.sha); } catch { /* repo missing */ }
  }
  try { await reconcileBehindFreezes(); } catch (e) { logger.debug({ error: (e as Error).message }, 'behind-main reconcile skipped'); }
  const cfg = getConfig();
  const agents = listAgents();
  const out: DevLane[] = [];
  const watched: Array<{ project: string; lane: string; sha: string }> = [];
  const allRuns: TestRun[] = [];

  for (const [project, pc] of Object.entries(cfg.projects ?? {})) {
    if (!pc.repo) continue;
    try { await refreshProjectAsync(project); } catch { /* offline */ }
    const repo = pc.repo;
    const spec = mainSpec(project);
    const mainResolved = await gitText(repo, ['rev-parse', '--verify', '--quiet', `${spec.ref}^{commit}`])
      ?? await gitText(repo, ['rev-parse', '--verify', '--quiet', `${spec.branch}^{commit}`]);
    if (!mainResolved || !/^[0-9a-f]{40}$/i.test(mainResolved)) continue;
    const mainSha = mainResolved;
    const re = globToRe(pc.lane_glob || 'wc-*');
    const names = new Set<string>();
    const listed = await gitText(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
    for (const short of (listed ?? '').split('\n').map((l) => l.trim()).filter(Boolean)) {
      const name = short.startsWith(`${spec.remote}/`) ? short.slice(spec.remote.length + 1) : short;
      if (name === 'HEAD' || name === spec.branch || name.startsWith(spec.branch + '/')) continue;
      if (pc.candidate_refs && globToRe(pc.candidate_refs).test(name)) continue;
      if (re.test(name) && !laneAutomationDenied(project, null, name)) names.add(name);
    }
    for (const f of freezes) {
      if (f.project === project && f.lane && (f.status === 'open' || f.status === 'behind-main') && freezeOnReviews(f)) names.add(f.lane);
    }

    const fileCache = new Map<string, string[]>();
    const filesOf = async (lane: string, sha: string) => {
      const hit = fileCache.get(lane);
      if (hit) return hit;
      const files = await changedFilesAsync(repo, sha, mainSha);
      fileCache.set(lane, files);
      return files;
    };

    let deployed: Array<{ lane: string | null; sha: string }> = [];
    try { deployed = listReleases({ project, target: 'staging', status: 'deployed', limit: 40 }); } catch { deployed = []; }
    const stagingSource = await resolveStagingTip(project).catch(() => ({ state: 'unknown' as const, tip: null }));
    const stagingNow = stagingSource.state === 'unknown' ? null : stagingSource.tip;
    const stagingUnknown = stagingSource.state === 'unknown';

    for (const lane of [...names].sort()) {
      if (laneAutomationDenied(project, null, lane)) continue;
      await yieldTurn();
      const sha = await tipOf(repo, spec.remote, lane);
      if (!sha || !await ahead(repo, mainSha, sha)) continue;
      const laneFreezes = freezes.filter((f) => f.project === project && f.lane === lane && f.status !== 'merged');
      const current = laneFreezes.find((f) => f.sha === sha && (f.status === 'open' || f.status === 'behind-main'))
        ?? laneFreezes.find((f) => f.status === 'open' || f.status === 'behind-main')
        ?? null;
      const freeze = current && current.sha === sha ? current : null;
      const behind = await commitsBehindAsync(project, sha) ?? 0;
      // A lane with a fresh open freeze is read live; a lane behind main or long frozen every thirty
      // minutes; a lane without a freeze every fifteen. A run in flight is followed by the poller
      // (watchTestRuns) once a read has seen it. The board has ~200 lanes; every read is an ssh.
      const freezeAge = freeze ? freezeAgeMs(freeze.created_at) : Number.NaN;
      const staleOkMs = freeze
        ? (freeze.status === 'open' && (!Number.isFinite(freezeAge) || freezeAge <= LIVE_TEST_WINDOW_MS) ? 0 : 30 * 60_000)
        : 15 * 60_000;
      const report = await readLaneReport(project, lane, sha, { staleOkMs });
      allRuns.push(...report.runs);
      watched.push({ project, lane, sha });
      const viewed = checksFor(report.runs, freeze?.sha ?? sha, null, project);
      const files = await filesOf(lane, sha);
      const protectedPath = touches(files, pc.protected_paths ?? []);
      const hasMigration = !!pc.migrations_dir && files.some((f) => f === pc.migrations_dir || f.startsWith(`${pc.migrations_dir}/`));
      let overlap: { lane: string; files: number } | null = null;
      for (const rel of deployed) {
        if (!rel.lane || rel.lane === lane) continue;
        const otherSha = await tipOf(repo, spec.remote, rel.lane);
        if (!otherSha) continue;
        const otherFiles = new Set(await filesOf(rel.lane, otherSha));
        const n = files.filter((f) => otherFiles.has(f)).length;
        if (n > 0 && (!overlap || n > overlap.files)) overlap = { lane: rel.lane, files: n };
      }
      const cardSha = freeze?.sha ?? sha;
      const onStaging = deployed.some((r) => (r.lane === lane || r.sha === cardSha) && r.sha === cardSha);
      const author = authorFor(lane, agents, freeze ?? current);
      const shaView = await viewShaChecks({
        project, sha: cardSha, lane, gate: freeze?.gate ?? null, freeze_path: freeze?.freeze_path ?? null,
      }, report.runs);
      if (shaView.full === 'green') {
        try { pingReviewersForGreenSha(cardSha); } catch { /* table missing */ }
      }
      const fullLabel = fullRunPhrase(viewed.fullRun);
      const forwardBlock = stagingUnknown ? null : await stagingForwardBlock(project, cardSha, stagingNow);
      let prereqNote: string | null = null;
      try { prereqNote = await prereqStatusNote(project, cardSha); } catch { prereqNote = null; }
      const status_line = laneStatusLine({
        sha, author: author.name, reviewer: freeze?.reviewer_name ?? null,
        freeze: freeze ? { sha: freeze.sha, verdict: freeze.verdict, issues: issuesFor(freeze), gate: shaView.gate } : null,
        gate: shaView.full === 'green' ? { state: 'green' } : shaView.full === 'red' ? { state: 'red', failingStep: viewed.gate.failingStep ?? null } : viewed.gate,
        quick: shaView.quick, full: shaView.full, fullRunLabel: fullLabel,
        behindMain: behind, forwardBlock, stagingTipUnknown: stagingUnknown, prereqNote, protectedPath, hasMigration, overlap, onStaging,
        autoNote: latestPipelineNote(project, lane),
      });
      const sha8 = cardSha.slice(0, 8);
      const fullGreen = shaView.full === 'green';
      const stageGreen = shaView.quick === 'green' || fullGreen;
      const testsKnown = shaView.quick !== 'unconfigured' || shaView.full !== 'unconfigured';
      const gateBlock = freeze
        ? await stageGateBlock(freeze, report.runs)
        : !testsKnown || stageGreen
          ? null
          : shaView.quick === 'pending'
            ? QUICK_CHECK_RUNNING
            : needsGreenQuick(sha8);
      const stage_block = behind > 0 ? behindMainLine(behind) : forwardBlock ?? gateBlock;
      const promote_block = fullGreen || shaView.full === 'unconfigured' ? null : promoteBlockReason(sha8);
      const full_fail_flag = onStaging && shaView.full === 'red' ? fullFailFlag(viewed.fullRun?.failing_step) : null;
      out.push({
        project, lane, sha,
        author_name: author.name, author_agent_id: author.id,
        reviewer_name: freeze?.reviewer_name ?? null, reviewer_agent_id: freeze?.reviewer_agent_id ?? null,
        freeze_sha: freeze?.sha ?? null, run_id: freeze?.run_id ?? null,
        status_line, gate: shaView.gate, stage_block, promote_block, full_fail_flag,
        before_freeze_tip: freeze ? null : beforeFreezeTip(project),
        test_run: selectChipRun(report.runs, freeze?.sha ?? sha, lane),
        test_errors: report.errors,
        test_log: hasLogCommand(project),
        reviewers: reviewerChoices(project, author.id),
        delta_review: freeze ? await deltaFor(repo, mainSha, lane, sha, freezes) : null,
      });
    }
  }
  try { watchTestRuns(watched, allRuns); } catch { /* poller is best-effort */ }
  return out;
}

/** Recompute the board. Overlapping callers share one refresh. */
export function refreshLaneBoard(): Promise<DevLane[]> {
  if (laneRefresh) return laneRefresh;
  const epoch = laneEpoch;
  laneRefresh = loadDevLanes()
    .then((lanes) => {
      if (epoch === laneEpoch) {
        laneSnapshot = lanes;
        laneSnapshotAt = Date.now();
      }
      return lanes;
    })
    .finally(() => { if (epoch === laneEpoch) laneRefresh = null; });
  return laneRefresh;
}

/**
 * What GET /api/reviews reads. A warm snapshot returns immediately.
 * A cold one waits up to {@link LANE_REQUEST_BUDGET_MS}, then returns whatever is ready.
 */
export async function lanesForRequest(): Promise<DevLane[]> {
  const fresh = laneSnapshotAt !== 0 && Date.now() - laneSnapshotAt <= LANE_REFRESH_MS;
  if (fresh) return laneSnapshot;
  const job = refreshLaneBoard().catch((e) => {
    logger.warn({ error: (e as Error).message }, 'Lane board refresh failed');
    return laneSnapshot;
  });
  if (laneSnapshotAt === 0) {
    await Promise.race([
      job,
      new Promise((resolve) => setTimeout(resolve, LANE_REQUEST_BUDGET_MS)),
    ]);
  }
  return laneSnapshot;
}

export function startLaneBoard(): void {
  void refreshLaneBoard().catch((e) => logger.warn({ error: (e as Error).message }, 'Lane board refresh failed'));
  if (laneTimer) return;
  laneTimer = setInterval(() => {
    void refreshLaneBoard().catch((e) => logger.warn({ error: (e as Error).message }, 'Lane board refresh failed'));
  }, LANE_REFRESH_MS);
  laneTimer.unref?.();
}

export function stopLaneBoard(): void {
  if (laneTimer) clearInterval(laneTimer);
  laneTimer = null;
}

export function resetLaneBoardForTest(): void {
  laneEpoch++;
  stopLaneBoard();
  laneSnapshot = [];
  laneSnapshotAt = 0;
  laneRefresh = null;
}

export async function requestLaneReview(opts: { project: string; lane: string; reviewer?: string | null; by?: string | null }): Promise<Result<{ reviewer: string; delta: boolean }>> {
  const project = opts.project?.trim();
  const lane = opts.lane?.trim();
  const reviewer = opts.reviewer?.trim();
  if (!project || !lane) return { ok: false, error: 'project and lane are required' };
  if (!reviewer) {
    // No seat named: the author (or maestro) asks and the picker chooses, as for an inbox review request.
    const rows = getDb().prepare(
      "SELECT sha FROM release_freezes WHERE project = ? AND lane = ? AND status IN ('open', 'behind-main') ORDER BY created_at DESC LIMIT 1",
    ).all(project, lane) as Array<{ sha: string }>;
    if (!rows[0]) return { ok: false, error: 'needs an author freeze first' };
    const asked = await requestReviewFor(rows[0].sha, { reviewer: null, by: opts.by ?? 'api' });
    return asked.ok ? { ok: true, data: { reviewer: asked.data.reviewer, delta: false } } : asked;
  }
  if (laneAutomationDenied(project, null, lane)) return { ok: false, error: `refusing ${lane}: denied` };
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
  if (laneAutomationDenied(project, picked.agent)) return { ok: false, error: `${picked.agent.alias ?? picked.agent.name} is denied` };
  const repo = projectRepo(project);
  const mainRef = repo ? await resolveMainRef(repo, project) : null;
  const delta = repo && mainRef ? await deltaFor(repo, mainRef, lane, freeze.sha, listFreezes()) : null;
  const sha8 = freeze.sha.slice(0, 8);
  const text = delta
    ? `[from WaveCode] delta review: merge only. Previous verdict: ${delta.verdict_path ?? delta.previous_sha}. New SHA ${sha8} on ${lane} only brings in main. Quick check, one full gate, and a re-verdict.`
    : `[from WaveCode] Please review freeze ${sha8} on ${lane} by @${freeze.author_name ?? 'author'}. Read ${freeze.freeze_path ?? 'the freeze note'}. If the code is OK and the gate is still running, write VERDICT: PASS (gate pending).`;
  deliverSystemLine(picked.agent, text, { kind: 'info', source: 'review' });
  return { ok: true, data: { reviewer: picked.agent.alias ?? picked.agent.name, delta: !!delta } };
}

export async function laneTestLog(project: string, id: string): Promise<Result<{ log: string | null }>> {
  if (!hasLogCommand(project)) return { ok: false, error: 'tests.log_command is not configured' };
  const text = await readTestLog(project, { id });
  if (text == null) return { ok: false, error: 'log command failed' };
  return { ok: true, data: { log: text } };
}
