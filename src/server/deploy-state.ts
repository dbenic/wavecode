/**
 * Derived deploy state for each freeze card.
 *
 * A pass every 90 seconds, and again on push (main tip moved), merge
 * (`pipelineHooks.onMain`), and as soon as a stage or deploy finishes
 * (`pipelineHooks.onDeployed`, including a deploy mirrored from the peer).
 * Anything git or a health probe cannot prove stays unknown — the board
 * never treats a missing tip as "not deployed".
 *
 * `GET /api/reviews/board` reads this snapshot only. It does not run git
 * or the gate. Only the current staging tip is `on_staging`; an older SHA
 * that is merely contained in that tip is superseded.
 *
 * The staging tip is `resolveStagingTip`: the release peer when this project
 * forwards releases, otherwise the health command, then the local deployed row.
 * A failed peer ask stays unknown and is not replaced by the local row.
 * `stage_block` is behind main, forward-only, or the gate for this SHA, plus a
 * closed, merged, superseded, or already-contained refusal. It does not
 * depend on the lane being configured.
 */

import fs from 'node:fs';
import type { DevLane } from './dev-lanes.js';
import { getDb } from './db.js';
import { emit } from './event-bus.js';
import { gitAncestor, gitText } from './git-memo.js';
import logger from './logger.js';
import { commitsBehind, laneAutomationDenied, mainTip, pingLaneAboutMain, projectRepo, resolveMainRef } from './lane-main.js';
import { notify } from './notifications.js';
import { pipelineHooks } from './pipeline-hooks.js';
import { getConfig } from './config.js';
import {
  applyNoteLabels,
  freezeOnReviews,
  getFreeze,
  listFreezes,
  viewShaChecks,
  type ReleaseFreeze,
} from './release-freezes.js';
import { getReview, listPendingReviews, type ReviewItem } from './review-queue.js';
import {
  PRODUCTION_RELEASE_ADMIN_ONLY,
  PRODUCTION_RELEASE_NOT_APPROVER,
  clearSettledReleaseErrors,
  listReleases,
  verificationFor,
  resolveStagingTip,
} from './releases.js';
import { stageEligibility } from './sha-stage-block.js';
import { readProdHealth } from './staging-forward.js';
import { assignmentFacts, reviewStatusForVerdict, reviewerLoads, sameOwnerPoolReviewer, type ReviewerLoadView } from './reviewer-assign.js';
import { developerFor, developerRoster } from './developers.js';
import {
  buildLaneCards, buildReleaseView, conflictFilesFromNote,
  type LaneCard, type LaneFreezeFact, type ReleaseView,
} from './lane-cards.js';
import { readLaneTests, shaChecks, suiteNames, type TestRun } from './test-runs.js';

export const RECONCILE_INTERVAL_MS = 90_000;
export const RECONCILE_STALE_MS = 5 * 60 * 1000;

export const DEPLOY_STATES = [
  'needs_fixes',
  'awaiting_review',
  'awaiting_tests',
  'ready_to_stage',
  'on_staging',
  'awaiting_prod_go',
  'live_on_prod',
  'superseded',
  'stale',
  'unknown',
] as const;

export type DeployState = (typeof DEPLOY_STATES)[number];

/** History is not actionable. */
export const HISTORY_STATES: readonly DeployState[] = ['live_on_prod', 'superseded', 'stale'];

export type Tri = true | false | null;
export type TestWord = 'green' | 'red' | 'pending' | 'missing' | 'unconfigured' | 'unknown';

export interface DeriveFacts {
  /** A newer freeze exists in the same lane, or the row was already marked stale by one. */
  superseded: boolean;
  mergedToMain: Tri;
  containedInStaging: Tri;
  containedInProd: Tri;
  behindMain: Tri;
  verdict: 'pass' | 'needs-fixes' | 'reject' | null;
  quick: TestWord;
  full: TestWord;
  /** Developer marked Ready for prod. Null when the verification table cannot be read. */
  readyForProd: boolean | null;
  /** This SHA is the current staging tip. An ancestor of the tip is not. */
  isStagingTip: boolean;
}

/**
 * One state per card. Order is deliberate:
 * a newer lane freeze retires the card (History); a SHA contained in prod is live;
 * a missing tip, main ancestry, or test probe is unknown;
 * behind main stays in the column the review and tests decide, and locks the buttons;
 * only then do staging, review and tests decide the actionable column.
 */
export function deriveDeployState(facts: DeriveFacts): DeployState {
  if (facts.superseded) return 'superseded';
  if (facts.containedInProd === true) return 'live_on_prod';
  if (
    facts.containedInStaging === null
    || facts.containedInProd === null
    || facts.behindMain === null
    || facts.mergedToMain === null
  ) return 'unknown';
  if (facts.containedInStaging) {
    if (!facts.isStagingTip) return 'superseded';
    if (facts.readyForProd === null) return 'unknown';
    return facts.readyForProd ? 'awaiting_prod_go' : 'on_staging';
  }
  if (facts.verdict === 'needs-fixes' || facts.verdict === 'reject') return 'needs_fixes';
  if (facts.verdict == null) return 'awaiting_review';
  if (facts.quick === 'unknown' || facts.full === 'unknown') return 'unknown';
  if (facts.quick === 'red' || facts.full === 'red') return 'needs_fixes';
  const quickGreen = facts.quick === 'green';
  const fullGreen = facts.full === 'green';
  const noSuites = facts.quick === 'unconfigured' && facts.full === 'unconfigured';
  if (quickGreen || fullGreen || noSuites) return 'ready_to_stage';
  return 'awaiting_tests';
}

export function unknownReason(facts: DeriveFacts): string | null {
  if (deriveDeployState(facts) !== 'unknown') return null;
  if (facts.containedInStaging === null || facts.containedInProd === null) return 'Staging or prod tip is unknown';
  if (facts.behindMain === null) return 'Cannot tell whether this SHA is behind main';
  if (facts.mergedToMain === null) return 'Cannot tell whether this SHA is on origin/main';
  if (facts.readyForProd === null) return 'Cannot tell whether this SHA is Ready for prod';
  if (facts.quick === 'unknown' || facts.full === 'unknown') return 'Test results on this exact SHA are unknown';
  return 'Deploy state is unknown';
}

interface DeployRow {
  sha: string;
  state: DeployState;
  merged_main: number | null;
  in_staging: number | null;
  in_prod: number | null;
  behind_main: number | null;
  superseded: number;
  verdict: string | null;
  quick: string | null;
  full_result: string | null;
  test_kind: string | null;
  test_at: string | null;
  test_word: string | null;
  version: string | null;
  badge: string | null;
  title: string | null;
  summary: string | null;
  desk: number | null;
  lane: string | null;
  unknown_reason: string | null;
  stage_block: string | null;
  last_reconciled_at: string;
}

export interface DeployView {
  state: DeployState;
  version: string | null;
  badge: 'staging' | 'prod' | null;
  test_kind: 'quick' | 'full' | null;
  test_at: string | null;
  test_word: string | null;
  title: string | null;
  summary: string | null;
  desk: number | null;
  lane: string | null;
  verdict: string | null;
  unknown_reason: string | null;
  action: 'stage' | 'ready' | 'promote' | 'none';
  action_lock: string | null;
  /** Admin may stage without the reviewer's PASS. Not a bypass for behind-main, forward-only, or unknown. */
  admin_bypass: boolean;
  hide_errors: boolean;
  show_reject: boolean;
  run_backed: boolean;
  last_reconciled_at: string | null;
}

export type BoardItem = ReviewItem & {
  status_line?: string | null;
  stage_block?: string | null;
  promote_block?: string | null;
  full_fail_flag?: string | null;
  test_run?: DevLane['test_run'];
  test_errors?: DevLane['test_errors'];
  test_log?: boolean;
  delta_review?: DevLane['delta_review'];
  reviewers?: DevLane['reviewers'];
  deploy: DeployView | null;
};

export interface ReviewBoard {
  last_reconciled_at: string | null;
  stale: boolean;
  items: BoardItem[];
  reviewers: ReviewerLoadView[];
  cards: LaneCard[];
  viewer: { name: string | null };
  release: ReleaseView;
}

const KV_AT = 'deploy_reconcile_at';
const KV_ALERTED = 'deploy_reconcile_alerted';

function triNum(v: Tri): number | null {
  if (v === true) return 1;
  if (v === false) return 0;
  return null;
}

export function ensureDeployStateTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS kv_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deploy_card_states (
      sha TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      merged_main INTEGER,
      in_staging INTEGER,
      in_prod INTEGER,
      behind_main INTEGER,
      superseded INTEGER NOT NULL DEFAULT 0,
      verdict TEXT,
      quick TEXT,
      full_result TEXT,
      test_kind TEXT,
      test_at TEXT,
      test_word TEXT,
      version TEXT,
      badge TEXT,
      title TEXT,
      summary TEXT,
      desk INTEGER,
      lane TEXT,
      unknown_reason TEXT,
      stage_block TEXT,
      last_reconciled_at TEXT NOT NULL
    );
  `);
  const cols = getDb().prepare('PRAGMA table_info(deploy_card_states)').all() as { name: string }[];
  if (!cols.some((col) => col.name === 'stage_block')) {
    getDb().exec('ALTER TABLE deploy_card_states ADD COLUMN stage_block TEXT');
  }
}

function withTable<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (!/no such table: deploy_card_states|no such table: kv_settings/.test((e as Error).message)) throw e;
    ensureDeployStateTable();
    return fn();
  }
}

function kvGet(key: string): string | null {
  return withTable(() => {
    const row = getDb().prepare('SELECT value FROM kv_settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  });
}

function kvSet(key: string, value: string): void {
  withTable(() => {
    getDb().prepare(
      'INSERT INTO kv_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  });
}

function kvDel(key: string): void {
  withTable(() => {
    getDb().prepare('DELETE FROM kv_settings WHERE key = ?').run(key);
  });
}

export function lastReconciledAt(): string | null {
  try { return kvGet(KV_AT); } catch { return null; }
}

export function reconcileIsStale(now = Date.now()): boolean {
  const at = lastReconciledAt();
  if (!at) return true;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return true;
  return now - t > RECONCILE_STALE_MS;
}

function readRow(sha: string): DeployRow | null {
  return withTable(() => (getDb().prepare('SELECT * FROM deploy_card_states WHERE sha = ?').get(sha) as DeployRow | undefined) ?? null);
}

function upsert(row: DeployRow): void {
  withTable(() => {
    getDb().prepare(`
      INSERT INTO deploy_card_states (
        sha, state, merged_main, in_staging, in_prod, behind_main, superseded, verdict, quick, full_result,
        test_kind, test_at, test_word, version, badge, title, summary, desk, lane, unknown_reason, stage_block, last_reconciled_at
      ) VALUES (
        @sha, @state, @merged_main, @in_staging, @in_prod, @behind_main, @superseded, @verdict, @quick, @full_result,
        @test_kind, @test_at, @test_word, @version, @badge, @title, @summary, @desk, @lane, @unknown_reason, @stage_block, @last_reconciled_at
      )
      ON CONFLICT(sha) DO UPDATE SET
        state = excluded.state, merged_main = excluded.merged_main, in_staging = excluded.in_staging,
        in_prod = excluded.in_prod, behind_main = excluded.behind_main, superseded = excluded.superseded,
        verdict = excluded.verdict, quick = excluded.quick, full_result = excluded.full_result,
        test_kind = excluded.test_kind, test_at = excluded.test_at, test_word = excluded.test_word,
        version = excluded.version, badge = excluded.badge, title = excluded.title, summary = excluded.summary,
        desk = excluded.desk, lane = excluded.lane, unknown_reason = excluded.unknown_reason,
        stage_block = excluded.stage_block,
        last_reconciled_at = excluded.last_reconciled_at
    `).run(row);
  });
}

interface Tip { sha: string | null; version: string | null; lane: string | null }

interface ProjectTips {
  staging: Tip;
  prod: Tip;
  /** False when `resolveStagingTip` could not ask the peer. The local row is not a substitute. */
  stagingKnown: boolean;
  source: 'peer' | 'health' | 'local';
}

const KV_TIPS = 'deploy_reconcile_tips';
let reconciledTips = new Map<string, ProjectTips>();

function emptyTip(): Tip {
  return { sha: null, version: null, lane: null };
}

function rememberTips(tips: Map<string, ProjectTips>): void {
  reconciledTips = tips;
  try { kvSet(KV_TIPS, JSON.stringify(Object.fromEntries(tips))); } catch { /* kv unavailable */ }
}

function storedTips(): Map<string, ProjectTips> {
  if (reconciledTips.size > 0) return reconciledTips;
  try {
    const raw = kvGet(KV_TIPS);
    if (!raw) return reconciledTips;
    const parsed = JSON.parse(raw) as Record<string, ProjectTips>;
    reconciledTips = new Map(Object.entries(parsed));
  } catch { /* the board stays unknown until the next reconcile */ }
  return reconciledTips;
}

async function containedIn(repo: string | null, sha: string, tip: string | null): Promise<Tri> {
  if (!tip || !/^[0-9a-f]{40}$/i.test(tip)) return null;
  const want = sha.toLowerCase();
  const have = tip.toLowerCase();
  if (want === have) return true;
  if (!repo) return null;
  try { return await gitAncestor(repo, want, have); } catch { return null; }
}

async function mergedToMain(project: string | null, sha: string): Promise<Tri> {
  const repo = projectRepo(project);
  if (!repo || !project) return null;
  const ref = resolveMainRef(repo, project);
  if (!ref) return null;
  const mainSha = await gitText(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!mainSha || !/^[0-9a-f]{40}$/i.test(mainSha)) return null;
  try { return await gitAncestor(repo, sha.toLowerCase(), mainSha.toLowerCase()); } catch { return null; }
}

function newerInLane(freeze: ReleaseFreeze, all: ReleaseFreeze[]): boolean {
  if (freeze.lane) {
    const newer = all.some((o) => o.sha !== freeze.sha && (o.project ?? null) === (freeze.project ?? null) && o.lane === freeze.lane && o.created_at > freeze.created_at);
    if (newer) return true;
  }
  return freeze.status === 'stale' && !!freeze.superseded_by && freeze.superseded_by !== 'main';
}

function displayTest(quick: TestWord, full: TestWord, quickRun: TestRun | null, fullRun: TestRun | null): { kind: 'quick' | 'full' | null; at: string | null; word: string | null } {
  const stamp = (run: TestRun | null) => run?.ended_at ?? run?.started_at ?? null;
  const meaningful = (w: TestWord) => w === 'green' || w === 'red' || w === 'pending';
  if (meaningful(full)) return { kind: 'full', at: stamp(fullRun), word: full };
  if (meaningful(quick)) return { kind: 'quick', at: stamp(quickRun), word: quick };
  return { kind: null, at: null, word: null };
}

function versionFor(sha: string, project: string | null, staging: Tip, prod: Tip): string | null {
  try {
    const prodRow = listReleases({ sha, target: 'production', status: 'deployed', limit: 5 }).find((r) => r.version);
    const stageRow = listReleases({ sha, target: 'staging', status: 'deployed', limit: 5 }).find((r) => r.version);
    if (prod.sha === sha && prod.version) return prod.version;
    if (prodRow?.version) return prodRow.version;
    if (staging.sha === sha && staging.version) return staging.version;
    if (stageRow?.version) return stageRow.version;
    if (project) {
      const any = listReleases({ project, sha, limit: 10 }).find((r) => r.version);
      if (any?.version) return any.version;
    }
  } catch { /* release table missing */ }
  return null;
}

function blankTips(): ProjectTips {
  return { staging: emptyTip(), prod: emptyTip(), stagingKnown: false, source: 'local' };
}

async function tipsFor(project: string): Promise<ProjectTips> {
  const out = blankTips();
  try {
    const resolved = await resolveStagingTip(project);
    out.source = resolved.source;
    if (resolved.state === 'unknown') {
      out.stagingKnown = false;
      out.staging = emptyTip();
    } else {
      out.stagingKnown = true;
      const sha = resolved.tip?.sha;
      if (sha && /^[0-9a-f]{40}$/i.test(sha)) {
        out.staging = { sha: sha.toLowerCase(), version: resolved.tip?.version ?? null, lane: resolved.tip?.lane ?? null };
      }
    }
  } catch { /* unknown: do not fall back to a local staging row */ }
  try {
    const health = readProdHealth(project);
    const row = listReleases({ project, target: 'production', status: 'deployed', limit: 1 })[0]
      ?? listReleases({ target: 'production', status: 'deployed', limit: 20 }).find((r) => r.project == null || r.project === project)
      ?? null;
    if (health?.sha) out.prod = { sha: health.sha, version: health.version ?? row?.version ?? null, lane: row?.lane ?? null };
    else if (row?.sha) out.prod = { sha: (row.deployed_sha || row.sha).toLowerCase(), version: row.version, lane: row.lane };
  } catch { out.prod = emptyTip(); }
  return out;
}

/** The card's stage reason. Same guard as Stage, measured against the tip this pass stored. */
async function stageBlockFor(freeze: ReleaseFreeze, _facts: DeriveFacts, pair: ProjectTips): Promise<string | null> {
  const tip = pair.staging.sha
    ? { sha: pair.staging.sha, version: pair.staging.version, lane: pair.staging.lane }
    : null;
  try {
    const eligible = await stageEligibility(freeze.sha, freeze.project, {
      includeGate: true,
      markStale: false,
      tipResolved: pair.stagingKnown,
      tip,
    });
    return eligible.error;
  } catch { return null; }
}

async function factsFor(freeze: ReleaseFreeze, all: ReleaseFreeze[], tips: Map<string, ProjectTips>): Promise<DeriveFacts> {
  const project = freeze.project;
  let pair = blankTips();
  if (project) {
    const hit = tips.get(project);
    if (hit) pair = hit;
    else {
      pair = await tipsFor(project);
      tips.set(project, pair);
    }
  }
  const repo = projectRepo(project);
  const [merged, inStaging, inProd] = await Promise.all([
    mergedToMain(project, freeze.sha),
    containedIn(repo, freeze.sha, pair.staging.sha),
    containedIn(repo, freeze.sha, pair.prod.sha),
  ]);
  let behind: Tri = null;
  try {
    const n = commitsBehind(project, freeze.sha);
    behind = n == null ? null : n > 0;
  } catch { behind = null; }
  let ready: boolean | null = false;
  try { ready = verificationFor(freeze.sha) != null; } catch { ready = null; }
  let quick: TestWord = 'unknown';
  let full: TestWord = 'unknown';
  try {
    const runs = project ? readLaneTests(project, freeze.lane ?? '', freeze.sha) : [];
    const view = viewShaChecks({
      project, sha: freeze.sha, lane: freeze.lane, gate: freeze.gate, freeze_path: freeze.freeze_path,
    }, runs);
    quick = view.quick;
    full = view.full;
  } catch {
    quick = 'unknown';
    full = 'unknown';
  }
  return {
    superseded: newerInLane(freeze, all),
    mergedToMain: merged,
    containedInStaging: inStaging,
    containedInProd: inProd,
    behindMain: behind,
    verdict: freeze.verdict,
    quick,
    full,
    readyForProd: ready,
    isStagingTip: inStaging === true && !!pair.staging.sha && pair.staging.sha.toLowerCase() === freeze.sha.toLowerCase(),
  };
}

function noteText(freeze: ReleaseFreeze): string | null {
  if (!freeze.freeze_path) return null;
  try { return fs.readFileSync(freeze.freeze_path, 'utf8'); } catch { return null; }
}

/** Freeze verdict for this SHA, else the latest done code review on its run. */
function exactShaVerdict(freeze: ReleaseFreeze): string | null {
  const row = getFreeze(freeze.sha) ?? freeze;
  if (row.verdict) return row.verdict;
  if (!row.run_id) return null;
  try {
    const review = getDb().prepare(
      `SELECT verdict FROM code_reviews
       WHERE run_id = ? AND status = 'done' AND verdict IS NOT NULL
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(row.run_id) as { verdict: string } | undefined;
    return review?.verdict ?? null;
  } catch {
    return null;
  }
}

/** Write the derived status onto runs that are still pending. Approved and rejected rows stay. */
function backfillRunReviewStatus(freeze: ReleaseFreeze): void {
  const row = getFreeze(freeze.sha) ?? freeze;
  if (!row.run_id) return;
  const derived = reviewStatusForVerdict(exactShaVerdict(row));
  if (derived === 'pending') return;
  try {
    getDb().prepare(
      `UPDATE runs SET review_status = ? WHERE id = ? AND review_status = 'pending'`,
    ).run(derived, row.run_id);
  } catch (e) {
    logger.debug({ sha: row.sha, error: (e as Error).message }, 'Review status backfill skipped');
  }
}

/**
 * Authors of behind-main cards that are still actionable (not superseded, not
 * already in staging or prod) get the merge-and-refreeze checklist once per
 * lane and main SHA. Denied lanes and agents are skipped.
 */
function pingBehindMain(freeze: ReleaseFreeze, facts: DeriveFacts): void {
  if (facts.behindMain !== true || facts.superseded) return;
  if (facts.containedInStaging === true || facts.containedInProd === true) return;
  if (!freeze.project || !freeze.lane) return;
  if (laneAutomationDenied(freeze.project, freeze.author_name ? { name: freeze.author_name } : null, freeze.lane)) return;
  const repo = projectRepo(freeze.project);
  const tip = repo ? mainTip(repo, freeze.project) : null;
  if (!tip) return;
  try {
    pingLaneAboutMain({
      lane: freeze.lane,
      project: freeze.project,
      mainSha: tip.sha,
      subject: tip.subject,
      authorAgentId: freeze.author_agent_id,
      authorName: freeze.author_name,
      kind: 'freeze',
    });
  } catch (e) {
    logger.debug({ sha: freeze.sha, error: (e as Error).message }, 'Behind-main ping skipped');
  }
}

/** Recompute every freeze. Returns the number of cards written. */
export async function reconcileDeployStates(now = new Date()): Promise<number> {
  ensureDeployStateTable();
  let freezes: ReleaseFreeze[] = [];
  try { freezes = listFreezes(); } catch { freezes = []; }
  const labelsBySha = new Map<string, ReturnType<typeof applyNoteLabels>>();
  for (const freeze of freezes) {
    const text = noteText(freeze);
    if (!text || !freeze.freeze_path) continue;
    try { labelsBySha.set(freeze.sha, applyNoteLabels(freeze.sha, text, freeze.freeze_path)); } catch (e) {
      logger.debug({ sha: freeze.sha, error: (e as Error).message }, 'Freeze label revise skipped');
    }
  }
  try { freezes = listFreezes(); } catch { /* keep the first list */ }
  const tips = new Map<string, ProjectTips>();
  const at = now.toISOString();
  const seen = new Set<string>();
  for (const freeze of freezes) {
    seen.add(freeze.sha);
    const project = freeze.project;
    if (project && !tips.has(project)) tips.set(project, await tipsFor(project));
    const pair = project ? tips.get(project)! : blankTips();
    const facts = await factsFor(freeze, freezes, tips);
    const state = deriveDeployState(facts);
    backfillRunReviewStatus(freeze);
    pingBehindMain(freeze, facts);
    if (facts.superseded || facts.containedInStaging === true || facts.containedInProd === true) {
      try { clearSettledReleaseErrors(freeze.sha); } catch { /* release table missing */ }
    }
    let quick: TestWord = facts.quick;
    let full: TestWord = facts.full;
    let quickRun: TestRun | null = null;
    let fullRun: TestRun | null = null;
    try {
      if (project) {
        const runs = readLaneTests(project, freeze.lane ?? '', freeze.sha);
        const checks = shaChecks(runs, freeze.sha, suiteNames(project));
        quickRun = checks.quickRun;
        fullRun = checks.fullRun;
      }
    } catch { /* times stay empty; the words already failed closed */ }
    const shown = displayTest(quick, full, quickRun, fullRun);
    const labels = labelsBySha.get(freeze.sha) ?? null;
    const fresh = getFreeze(freeze.sha) ?? freeze;
    const badge = facts.containedInProd === true ? 'prod' : facts.containedInStaging === true ? 'staging' : null;
    upsert({
      sha: freeze.sha,
      state,
      merged_main: triNum(facts.mergedToMain),
      in_staging: triNum(facts.containedInStaging),
      in_prod: triNum(facts.containedInProd),
      behind_main: triNum(facts.behindMain),
      superseded: facts.superseded ? 1 : 0,
      verdict: fresh.verdict,
      quick,
      full_result: full,
      test_kind: shown.kind,
      test_at: shown.at,
      test_word: shown.word,
      version: versionFor(freeze.sha, project, pair.staging, pair.prod),
      badge,
      title: labels?.title ?? null,
      summary: labels?.summary ?? null,
      desk: labels ? labels.desk : fresh.desk,
      lane: labels ? labels.lane : fresh.lane,
      unknown_reason: unknownReason(facts),
      stage_block: await stageBlockFor(fresh, facts, pair),
      last_reconciled_at: at,
    });
  }
  const staleRows = withTable(() => getDb().prepare('SELECT sha FROM deploy_card_states').all() as { sha: string }[]);
  for (const row of staleRows) {
    if (!seen.has(row.sha)) getDb().prepare('DELETE FROM deploy_card_states WHERE sha = ?').run(row.sha);
  }
  try {
    for (const project of Object.keys(getConfig().projects ?? {})) {
      if (!tips.has(project)) tips.set(project, await tipsFor(project));
    }
  } catch { /* config unavailable: keep the tips already resolved for these freezes */ }
  rememberTips(tips);
  kvSet(KV_AT, at);
  kvDel(KV_ALERTED);
  emit('deploy.reconciled', 'release', 'board', { at, count: seen.size }, null);
  return seen.size;
}

const bootedAt = Date.now();
let alertedThisGap = false;

function maybeAlertStale(now = Date.now()): void {
  const at = lastReconciledAt();
  const anchor = at && Number.isFinite(Date.parse(at)) ? Date.parse(at) : bootedAt;
  if (now - anchor <= RECONCILE_STALE_MS) {
    alertedThisGap = false;
    try { kvDel(KV_ALERTED); } catch { /* ignore */ }
    return;
  }
  if (alertedThisGap || kvGet(KV_ALERTED) === '1') return;
  alertedThisGap = true;
  try { kvSet(KV_ALERTED, '1'); } catch { /* ignore */ }
  const when = at ?? 'never';
  void notify({
    title: 'Reviews reconcile is stale',
    body: `Deploy state has not reconciled since ${when}.`,
    url: '/review',
    tag: 'deploy-reconcile-stale',
  }).catch(() => {});
  logger.warn({ last_reconciled_at: at }, 'Deploy reconcile is more than 5 minutes stale');
}

let running = false;
let again = false;
let debounce: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let hooked = false;
let started = false;

async function runOnce(reason: string): Promise<void> {
  if (running) { again = true; return; }
  running = true;
  try {
    maybeAlertStale();
    try {
      await reconcileDeployStates();
    } catch (e) {
      logger.warn({ reason, error: (e as Error).message }, 'Deploy reconcile failed');
      maybeAlertStale();
    }
    try {
      const pipeline = await import('./lane-pipeline.js');
      pipeline.reassignWaitingReviews();
    } catch (e) {
      logger.warn({ reason, error: (e as Error).message }, 'Review reassignment skipped');
    }
  } finally {
    running = false;
    if (again) {
      again = false;
      scheduleReconcile('follow-up');
    }
  }
}

/** Coalesce a burst of push / merge / deploy hooks into one pass. Idle until the reconciler is started. */
export function scheduleReconcile(reason: string): void {
  if (!started) return;
  if (running) { again = true; return; }
  if (debounce) return;
  debounce = setTimeout(() => {
    debounce = null;
    void runOnce(reason);
  }, 300);
  debounce.unref?.();
}

function attachHooks(): void {
  if (hooked) return;
  hooked = true;
  const prevMain = pipelineHooks.onMain;
  pipelineHooks.onMain = (project, sha) => {
    prevMain?.(project, sha);
    scheduleReconcile('merge');
  };
  const prevDeployed = pipelineHooks.onDeployed;
  pipelineHooks.onDeployed = (id) => {
    prevDeployed?.(id);
    scheduleReconcile('deploy');
  };
  const prevVerified = pipelineHooks.onVerified;
  pipelineHooks.onVerified = (project) => {
    prevVerified?.(project);
    scheduleReconcile('deploy');
  };
}

export function startDeployReconciler(): void {
  if (started) return;
  started = true;
  void import('./lane-pipeline.js').then(() => {
    if (!started) return;
    attachHooks();
    void runOnce('startup');
  }).catch((e) => logger.warn({ error: (e as Error).message }, 'Deploy reconcile hooks not attached'));
  if (interval) return;
  interval = setInterval(() => { void runOnce('interval'); }, RECONCILE_INTERVAL_MS);
  interval.unref?.();
}

export function stopDeployReconciler(): void {
  started = false;
  if (interval) clearInterval(interval);
  interval = null;
  if (debounce) clearTimeout(debounce);
  debounce = null;
}

export function resetDeployReconcilerForTest(): void {
  stopDeployReconciler();
  hooked = false;
  running = false;
  again = false;
  alertedThisGap = false;
  reconciledTips = new Map();
}

function promoteLock(user: { name: string; role: string }, project: string | null): string | null {
  if (user.role !== 'admin') return PRODUCTION_RELEASE_ADMIN_ONLY;
  if (!project) return null;
  const peer = getConfig().projects?.[project]?.release_peer;
  if (!peer) return null;
  const list = getConfig().releases?.production_approvers ?? [];
  const allowed = list.some((n) => n.toLowerCase() === user.name.toLowerCase());
  if (!allowed) return PRODUCTION_RELEASE_NOT_APPROVER;
  return null;
}

function actionsFor(row: DeployRow, stageBlock: string | null, promoteBlock: string | null, user: { name: string; role: string }, project: string | null): Pick<DeployView, 'action' | 'action_lock' | 'admin_bypass'> {
  const behindOpen = row.behind_main === 1 && row.superseded !== 1 && row.in_staging !== 1 && row.in_prod !== 1
    && row.state !== 'superseded' && row.state !== 'live_on_prod';
  if (behindOpen) {
    return { action: 'none', action_lock: 'Behind main — merge main and freeze the new SHA', admin_bypass: false };
  }
  if (row.state === 'ready_to_stage') return { action: 'stage', action_lock: stageBlock, admin_bypass: false };
  if (row.state === 'on_staging') {
    return { action: 'ready', action_lock: user.role === 'observer' ? 'Observers cannot mark Ready for prod' : null, admin_bypass: false };
  }
  if (row.state === 'awaiting_prod_go') {
    return { action: 'promote', action_lock: promoteLock(user, project) ?? promoteBlock, admin_bypass: false };
  }
  if (row.state === 'awaiting_tests') {
    return { action: 'stage', action_lock: 'Waiting for quick or full tests on this exact SHA', admin_bypass: false };
  }
  if (row.state === 'awaiting_review' || (row.state === 'needs_fixes' && row.verdict !== 'pass')) {
    return { action: 'stage', action_lock: "Stage needs the reviewer's PASS on this exact SHA", admin_bypass: true };
  }
  if (row.state === 'needs_fixes') {
    return { action: 'stage', action_lock: 'Tests on this exact SHA are not green', admin_bypass: false };
  }
  if (row.state === 'unknown') {
    return { action: 'none', action_lock: row.unknown_reason ?? 'Deploy state is unknown', admin_bypass: false };
  }
  if (row.state === 'stale') {
    return { action: 'none', action_lock: 'Behind main — merge main and freeze the new SHA', admin_bypass: false };
  }
  return { action: 'none', action_lock: null, admin_bypass: false };
}

function asState(value: string): DeployState {
  return (DEPLOY_STATES as readonly string[]).includes(value) ? value as DeployState : 'unknown';
}

function toView(row: DeployRow, user: { name: string; role: string }, project: string | null, stageBlock: string | null, promoteBlock: string | null, runBacked: boolean): DeployView {
  row = { ...row, state: asState(row.state) };
  const badge = row.badge === 'prod' || row.badge === 'staging' ? row.badge : null;
  const kind = row.test_kind === 'quick' || row.test_kind === 'full' ? row.test_kind : null;
  const acted = actionsFor(row, stageBlock, promoteBlock, user, project);
  const history = row.state === 'live_on_prod' || row.state === 'superseded' || row.state === 'stale';
  return {
    state: row.state,
    version: row.version,
    badge,
    test_kind: kind,
    test_at: row.test_at,
    test_word: row.test_word,
    title: row.title,
    summary: row.summary,
    desk: row.desk,
    lane: row.lane,
    verdict: row.verdict,
    unknown_reason: row.unknown_reason,
    ...acted,
    hide_errors: row.superseded === 1 || row.in_staging === 1 || row.in_prod === 1,
    show_reject: runBacked && !history,
    run_backed: runBacked,
    last_reconciled_at: row.last_reconciled_at,
  };
}

function syntheticItem(freeze: ReleaseFreeze, title: string | null): ReviewItem {
  const when = freeze.created_at;
  return {
    run: {
      id: `freeze-${freeze.sha}`,
      task_id: `freeze-task-${freeze.sha}`,
      agent_id: freeze.author_agent_id ?? 'freeze',
      attempt: 1,
      status: 'done',
      started_at: when,
      finished_at: when,
      exit_code: 0,
      transcript_path: null,
      review_status: 'pending',
      changed_files: null,
      result_path: null,
      summary: null,
    },
    task: {
      id: `freeze-task-${freeze.sha}`,
      agent_id: freeze.author_agent_id,
      prompt: title || `Release freeze ${freeze.sha.slice(0, 8)}`,
      status: 'done',
      priority: 0,
      created_at: when,
      goal_id: null,
    },
    agentName: freeze.author_name ?? 'unknown',
    artifacts: [],
    duration: null,
    latestReview: null,
    freeze: {
      sha: freeze.sha,
      project: freeze.project,
      desk: freeze.desk,
      lane: freeze.lane,
      author_name: freeze.author_name,
      reviewer_name: freeze.reviewer_name,
      verdict: freeze.verdict,
      freeze_path: freeze.freeze_path,
      verdict_path: freeze.verdict_path,
      gate: freeze.gate,
      status: freeze.status,
      superseded_by: freeze.superseded_by,
    },
  };
}

function itemFor(freeze: ReleaseFreeze, title: string | null): { item: ReviewItem; runBacked: boolean } {
  if (freeze.run_id) {
    const got = getReview(freeze.run_id);
    if (got.ok) return { item: got.data, runBacked: true };
  }
  return { item: syntheticItem(freeze, title), runBacked: false };
}

function overlay(item: ReviewItem, lane: DevLane | undefined): BoardItem {
  if (!lane) return { ...item, deploy: null };
  return {
    ...item,
    status_line: lane.status_line,
    stage_block: lane.stage_block,
    promote_block: lane.promote_block,
    full_fail_flag: lane.full_fail_flag,
    test_run: lane.test_run,
    test_errors: lane.test_errors,
    test_log: lane.test_log,
    delta_review: lane.delta_review,
    reviewers: lane.reviewers,
    freeze: item.freeze ? { ...item.freeze, gate: lane.gate ?? item.freeze.gate } : item.freeze,
    deploy: null,
  };
}

const NOT_RECONCILED: DeployView = {
  state: 'unknown',
  version: null,
  badge: null,
  test_kind: null,
  test_at: null,
  test_word: null,
  title: null,
  summary: null,
  desk: null,
  lane: null,
  verdict: null,
  unknown_reason: 'Not reconciled yet',
  action: 'none',
  action_lock: 'Not reconciled yet',
  admin_bypass: false,
  hide_errors: false,
  show_reject: false,
  run_backed: false,
  last_reconciled_at: null,
};

function pipelineFlag(project: string | null, flag: 'auto_merge_main' | 'auto_stage'): boolean {
  if (!project) return false;
  try { return getConfig().projects?.[project]?.pipeline?.[flag] === true; } catch { return false; }
}

function pipelineNote(project: string | null, lane: string | null): string | null {
  if (!project || !lane) return null;
  try {
    const row = getDb().prepare(
      `SELECT payload_json FROM events WHERE type = 'pipeline.action' AND entity_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(`${project}:${lane}`) as { payload_json: string | null } | undefined;
    if (!row?.payload_json) return null;
    const payload = JSON.parse(row.payload_json) as { note?: string };
    return payload.note ?? null;
  } catch {
    return null;
  }
}

function quickCheck(lane: DevLane | undefined, sha: string): { running: boolean; etaMin: number | null } {
  const run = lane?.test_run;
  if (!run || (run.sha && run.sha !== sha)) return { running: false, etaMin: null };
  const active = run.state === 'running' || run.state === 'queued';
  if (!active) return { running: false, etaMin: null };
  let quick = true;
  const suite = (run.suite ?? '').trim().toLowerCase();
  if (suite) {
    try {
      const names = suiteNames(lane?.project ?? null);
      quick = names.quick.includes(suite) || suite === 'quick' || suite === 'tier1';
    } catch {
      quick = suite === 'quick' || suite === 'tier1';
    }
  }
  if (!quick) return { running: false, etaMin: null };
  const etaMin = run.wait_s != null && run.wait_s > 0 ? Math.max(1, Math.ceil(run.wait_s / 60)) : null;
  return { running: true, etaMin };
}

function factFor(
  freeze: ReleaseFreeze,
  lane: DevLane | undefined,
  view: DeployView,
  row: DeployRow | null,
): LaneFreezeFact {
  const behind = !!row && row.behind_main === 1 && row.superseded !== 1 && row.in_staging !== 1 && row.in_prod !== 1
    && row.state !== 'superseded' && row.state !== 'live_on_prod';
  const quick = quickCheck(lane, freeze.sha);
  const since = assignmentFacts(freeze.sha);
  return {
    sha: freeze.sha,
    project: freeze.project,
    lane: row?.lane ?? freeze.lane,
    desk: row?.desk ?? freeze.desk,
    title: row?.title ?? null,
    summary: row?.summary ?? null,
    author_name: freeze.author_name,
    reviewer_name: freeze.reviewer_name,
    verdict: row?.verdict ?? freeze.verdict,
    verdict_path: freeze.verdict_path,
    created_at: freeze.created_at,
    state: view.state,
    version: row?.version ?? null,
    behind_main: behind,
    superseded: row?.superseded === 1 || freeze.status === 'stale',
    in_staging: row?.in_staging === 1,
    in_prod: row?.in_prod === 1,
    action: view.action,
    action_lock: view.action_lock,
    run_id: freeze.run_id,
    run_backed: view.run_backed,
    quick_running: quick.running && view.state !== 'needs_fixes',
    eta_min: quick.etaMin,
    conflict_files: behind ? conflictFilesFromNote(pipelineNote(freeze.project, freeze.lane)) : [],
    auto_merge_main: pipelineFlag(freeze.project, 'auto_merge_main'),
    auto_stage: pipelineFlag(freeze.project, 'auto_stage'),
    reviewing_since: since ? new Date(since.at).toISOString() : freeze.created_at,
    unknown_reason: view.unknown_reason,
    live_at: row?.last_reconciled_at ?? freeze.updated_at,
    same_owner_pool: sameOwnerOnCard(freeze),
  };
}

function sameOwnerOnCard(freeze: ReleaseFreeze): boolean {
  if (!freeze.project || !freeze.author_name || !freeze.reviewer_name) return false;
  const pools = getConfig().projects?.[freeze.project]?.pipeline?.reviewer_pool_by_author_glob;
  if (!pools) return false;
  return sameOwnerPoolReviewer({ name: freeze.author_name }, { name: freeze.reviewer_name }, pools);
}

function emptyRelease(): ReleaseView {
  return { prod: { version: null, sha: null }, staging: { version: null, sha: null }, next_version: null, queued: [] };
}

function deployTips(): { prod: { version: string | null; sha: string | null }; staging: { version: string | null; sha: string | null } } {
  const empty = { version: null as string | null, sha: null as string | null };
  const out = { prod: { ...empty }, staging: { ...empty } };
  for (const pair of storedTips().values()) {
    if (!out.prod.sha && pair.prod.sha) out.prod = { sha: pair.prod.sha, version: pair.prod.version };
    if (!out.staging.sha && pair.stagingKnown && pair.staging.sha) out.staging = { sha: pair.staging.sha, version: pair.staging.version };
  }
  return out;
}

interface PreparedFreeze {
  freeze: ReleaseFreeze;
  row: DeployRow | null;
  stageBlock: string | null;
  item: ReviewItem;
  runBacked: boolean;
  lane: DevLane | undefined;
  deploy: DeployView;
}

/** One read of the stored row. The lane card and the item share this view. */
function prepareFreeze(freeze: ReleaseFreeze, user: { name: string; role: string }, bySha: Map<string, DevLane>, byLane: Map<string, DevLane>): PreparedFreeze {
  const row = readRow(freeze.sha);
  const stageBlock = row?.stage_block ?? null;
  const { item, runBacked } = itemFor(freeze, row?.title ?? null);
  const lane = bySha.get(freeze.sha) ?? (freeze.lane ? byLane.get(`${freeze.project}:${freeze.lane}`) : undefined);
  const deploy = row
    ? toView(row, user, freeze.project, stageBlock, lane?.promote_block ?? null, runBacked)
    : { ...NOT_RECONCILED, run_backed: runBacked, show_reject: runBacked };
  return { freeze, row, stageBlock, item, runBacked, lane, deploy };
}

/**
 * The Reviews page, from the last reconcile. `lanes` may overlay test chips
 * already in memory. This function does not scan git or the gate, and it does
 * not add Working lanes — those are not part of the action set.
 */
export async function reviewBoard(user: { name: string; role: string }, lanes: DevLane[], token: string | null = null): Promise<ReviewBoard> {
  try { ensureDeployStateTable(); } catch { /* the board still renders from the lane list */ }
  const bySha = new Map(lanes.filter((l) => l.freeze_sha).map((l) => [l.freeze_sha as string, l]));
  const byLane = new Map(lanes.map((l) => [`${l.project}:${l.lane}`, l]));
  let freezes: ReleaseFreeze[] = [];
  try { freezes = listFreezes().filter(freezeOnReviews); } catch { freezes = []; }
  const prepared = freezes.map((freeze) => prepareFreeze(freeze, user, bySha, byLane));
  const items: BoardItem[] = [];
  const seen = new Set<string>();
  for (const row of prepared) {
    if (seen.has(row.item.run.id)) continue;
    seen.add(row.item.run.id);
    const merged = overlay(row.item, row.lane);
    merged.stage_block = row.stageBlock;
    if (row.deploy.hide_errors) {
      merged.test_errors = [];
      if (row.deploy.state === 'superseded' || row.deploy.state === 'live_on_prod') merged.full_fail_flag = null;
    }
    if (merged.freeze && row.row) {
      merged.freeze = {
        ...merged.freeze,
        desk: row.row.desk,
        lane: row.row.lane,
        verdict: (row.row.verdict as ReleaseFreeze['verdict']) ?? merged.freeze.verdict,
      };
    }
    items.push({ ...merged, deploy: row.deploy });
  }
  for (const pending of listPendingReviews()) {
    if (pending.freeze || seen.has(pending.run.id)) continue;
    items.push({ ...pending, deploy: null });
  }
  let reviewers: ReviewerLoadView[] = [];
  try { reviewers = reviewerLoads(); } catch { reviewers = []; }
  let cards: LaneCard[] = [];
  let release = emptyRelease();
  let viewerName: string | null = null;
  try {
    const viewerDev = developerFor(user, token);
    viewerName = viewerDev?.name ?? null;
    const viewer = viewerDev ? { name: viewerDev.name, lanes: viewerDev.lanes } : null;
    const owners = developerRoster();
    const facts: LaneFreezeFact[] = [];
    for (const row of prepared) {
      const laneName = row.row?.lane ?? row.freeze.lane;
      if (!laneName) continue;
      facts.push(factFor({ ...row.freeze, lane: laneName }, row.lane, row.deploy, row.row));
    }
    // Working lanes and live (on staging / prod) cards stay out of the action set.
    cards = buildLaneCards(facts, [], viewer, owners);
    release = buildReleaseView(cards, deployTips());
  } catch (e) {
    logger.debug({ error: (e as Error).message }, 'Lane cards skipped');
  }
  return {
    last_reconciled_at: lastReconciledAt(),
    stale: reconcileIsStale(),
    items,
    reviewers,
    cards,
    viewer: { name: viewerName },
    release,
  };
}
