import {
  getDb,
  getRun,
  getTask,
  finishRun,
  listReviewableRuns,
  updateRunReviewStatus,
  updateTaskStatus,
  getRunArtifacts,
  getAgent,
  type Run,
  type Task,
  type Artifact,
  type Result,
  getUser,
} from './db.js';
import { emit } from './event-bus.js';
import { getConfig } from './config.js';
import { dispatchNext, onRunComplete, unblockDependentsPublic } from './task-dispatcher.js';
import { getLatestCompletedReview, type CodeReview } from './code-review.js';
import { evaluateRefereeForPromote } from './project-gate.js';
import { resultPathForRun, settleRunResultFile } from './run-result.js';
import logger from './logger.js';
import * as peers from './peers.js';
import { currentActorId } from './request-context.js';
import { OWNER_USER_ID } from './users.js';
import * as freezes from './release-freezes.js';
import * as releases from './releases.js';

export interface ReviewItem {
  run: Run;
  task: Task;
  agentName: string;
  artifacts: Artifact[];
  duration: number | null;
  /** Latest completed AI review, so the queue UI can show the verdict inline */
  latestReview: Pick<CodeReview, 'id' | 'verdict' | 'issues_found' | 'fix_round' | 'created_at'> | null;
  /** Set when this run stands for an externally reviewed release freeze (release-freezes.ts). */
  freeze: freezes.FreezeCard | null;
}

/**
 * Get all runs pending review.
 */
export function listPendingReviews(): ReviewItem[] {
  const runs = listReviewableRuns();
  return runs.map(runToReviewItem).filter((r): r is ReviewItem => r !== null);
}

/**
 * Get a single review item by run ID.
 */
export function getReview(runId: string): Result<ReviewItem> {
  const runResult = getRun(runId);
  if (!runResult.ok) return { ok: false, error: runResult.error };

  const item = runToReviewItem(runResult.data);
  if (!item) return { ok: false, error: 'Could not build review item' };

  return { ok: true, data: item };
}

/**
 * Promote: approve the work. Mark run as approved.
 *
 * When promote-gating is active (review.require_pass_to_promote, or
 * review.auto_review which implies it), the latest completed AI review must
 * have a 'pass' verdict — otherwise promotion is blocked unless the caller
 * supplies an explicit override reason, which is stored in the audit event.
 */
export function promote(runId: string, opts: { overrideReason?: string } = {}): Result<Run> {
  const runResult = getRun(runId);
  if (!runResult.ok) return runResult;

  const config = getConfig();
  const author = getAgent(runResult.data.agent_id);
  const overrideReason = opts.overrideReason?.trim() || null;

  // A release freeze has its own rules (PASS on the exact SHA, independent
  // reviewer, lane unchanged); the referee result file belongs to WaveCode runs.
  const freeze = freezes.getFreezeByRun(runId);
  if (freeze) {
    const rule = freezes.checkPromotable(freeze, { overrideReason });
    if (!rule.ok) return rule;
  } else {
    const referee = evaluateRefereeForPromote(
      runId,
      author.ok ? author.data.workspace : null,
    );
    if (!referee.ok) return referee;
  }

  const gated = config.review.require_pass_to_promote || config.review.auto_review;
  const latestReview = getLatestCompletedReview(runId);

  if (!freeze && gated && latestReview?.verdict !== 'pass' && !overrideReason) {
    const state = latestReview
      ? `latest review verdict is '${latestReview.verdict}'`
      : 'no completed review exists for this run';
    return {
      ok: false,
      error: `Promotion blocked: ${state}. Provide an explicit override reason to promote anyway.`,
    };
  }

  try {
    getDb().transaction(() => {
      ensurePendingReview(runId);
      const info = getDb().prepare(
        `UPDATE runs SET review_status = 'approved' WHERE id = ?`,
      ).run(runId);
      if (info.changes === 0) {
        throw new Error(`Run ${runId} not found`);
      }
    })();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const actor = currentActorId();
  const actorUser = actor && actor !== OWNER_USER_ID ? getUser(actor) : null;
  const actorName = actor ? (actor === OWNER_USER_ID ? 'owner' : actorUser?.ok ? actorUser.data.name : actor) : null;

  emit('review.promoted', 'run', runId, {
    task_id: runResult.data.task_id,
    verdict: freeze ? freeze.verdict : latestReview?.verdict ?? null,
    override_reason: overrideReason,
    ...(freeze ? { freeze: { sha: freeze.sha, project: freeze.project, desk: freeze.desk, lane: freeze.lane, reviewer: freeze.reviewer_name, author: freeze.author_name, promoted_by: actorName } } : {}),
  });

  if (overrideReason) {
    logger.warn({ runId, overrideReason }, 'Run promoted with verdict override');
  }
  if (freeze) freezes.markPromoted(runId, actorName);

  // projects.<name>.release_peer: the person's Promote is the GO the deployer acts on.
  // A freeze goes as a release record (releases.ts); a plain run keeps the chat relay.
  try {
    if (freeze?.project) {
      void releases.requestRelease({
        project: freeze.project, sha: freeze.sha, lane: freeze.lane, target: 'production', desk: freeze.desk != null ? String(freeze.desk) : null,
        reviewer: freeze.reviewer_name, actorName, runId,
      }).then((r) => { if (!r.ok) logger.warn({ runId, error: r.error }, 'production release request failed'); })
        .catch((e) => logger.warn({ runId, error: (e as Error).message }, 'production release request failed'));
    } else {
      void peers.onRunPromoted(runResult.data, actorName, freeze ?? undefined).catch((e) => logger.warn({ runId, error: (e as Error).message }, 'release relay failed'));
    }
  } catch (e) {
    logger.warn({ runId, error: (e as Error).message }, 'release relay failed');
  }

  // With approval-gated dependents, downstream tasks wait for this moment.
  if (config.review.gate_dependents_on_approval) {
    unblockDependentsPublic(runResult.data.task_id);
    setTimeout(() => dispatchNext(), 500);
  }

  return getRun(runId);
}

/**
 * Retry: create a new run for the same task.
 */
export function retry(runId: string): Result<Run> {
  const runResult = getRun(runId);
  if (!runResult.ok) return runResult;
  if (freezes.getFreezeByRun(runId)) return { ok: false, error: 'A release freeze is not a WaveCode run: there is nothing to retry. Reject it, or wait for a new freeze.' };

  const run = runResult.data;

  try {
    getDb().transaction(() => {
      ensurePendingReview(runId);
      const runUpdate = updateRunReviewStatus(runId, 'rejected');
      if (!runUpdate.ok) {
        throw new Error(runUpdate.error);
      }
      const taskUpdate = updateTaskStatus(run.task_id, 'pending');
      if (!taskUpdate.ok) {
        throw new Error(taskUpdate.error);
      }
    })();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  emit('review.retried', 'run', runId, {
    task_id: run.task_id,
  });

  // Trigger dispatch to pick up the task again
  setTimeout(() => dispatchNext(), 500);

  return getRun(runId);
}

/**
 * Hand off: reassign to a different agent and create a new run.
 */
export function handOff(runId: string, targetAgentId: string): Result<Run> {
  const runResult = getRun(runId);
  if (!runResult.ok) return runResult;
  if (freezes.getFreezeByRun(runId)) return { ok: false, error: 'A release freeze is not a WaveCode run: it cannot be handed off.' };

  const run = runResult.data;

  // Verify target agent exists
  const agentResult = getAgent(targetAgentId);
  if (!agentResult.ok) return { ok: false, error: agentResult.error };

  try {
    getDb().transaction(() => {
      ensurePendingReview(runId);
      const runUpdate = updateRunReviewStatus(runId, 'rejected');
      if (!runUpdate.ok) {
        throw new Error(runUpdate.error);
      }
      const info = getDb().prepare(
        'UPDATE tasks SET agent_id = ?, status = ? WHERE id = ?',
      ).run(targetAgentId, 'pending', run.task_id);
      if (info.changes === 0) {
        throw new Error(`Task ${run.task_id} not found`);
      }
    })();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  emit('review.handed_off', 'run', runId, {
    task_id: run.task_id,
    from_agent_id: run.agent_id,
    to_agent_id: targetAgentId,
  });

  // Trigger dispatch
  setTimeout(() => dispatchNext(), 500);

  return getRun(runId);
}

/**
 * Reject: mark the work as rejected. Block dependents.
 */
/**
 * Stage a reviewed freeze: an automated staging deploy through the release
 * pipeline, no human GO. Any verdict may be staged; a stale SHA may not.
 */
export async function stage(runId: string): Promise<Result<releases.ReleaseRequest>> {
  const freeze = freezes.getFreezeByRun(runId);
  if (!freeze) return { ok: false, error: 'Only a release freeze can be staged (the card must carry an exact SHA)' };
  if (freeze.status === 'stale') return { ok: false, error: `Freeze ${freeze.sha.slice(0, 8)} is stale — lane ${freeze.lane ?? '?'} moved on; freeze the new SHA` };
  if (!freeze.project) return { ok: false, error: 'The freeze names no project, so no release peer can be chosen' };
  const actor = currentActorId();
  const actorUser = actor && actor !== OWNER_USER_ID ? getUser(actor) : null;
  const actorName = actor ? (actor === OWNER_USER_ID ? 'owner' : actorUser?.ok ? actorUser.data.name : actor) : null;
  return releases.requestRelease({
    project: freeze.project, sha: freeze.sha, lane: freeze.lane, target: 'staging', desk: freeze.desk != null ? String(freeze.desk) : null,
    reviewer: freeze.verdict === 'pass' ? freeze.reviewer_name : null, actorName, runId,
  });
}

export function reject(runId: string, opts: { reason?: string | null } = {}): Result<Run> {
  const runResult = getRun(runId);
  if (!runResult.ok) return runResult;

  const run = runResult.data;
  const reason = opts.reason?.trim() || null;
  const author = getAgent(run.agent_id);
  settleRunResultFile(
    resultPathForRun(run, author.ok ? author.data.workspace : null),
    'Run rejected',
    { forceFail: true },
  );
  const exitCode = run.status === 'running' || !run.finished_at ? 1 : (run.exit_code ?? 0);
  const finished = finishRun(runId, exitCode);
  if (!finished.ok) return finished;

  try {
    getDb().transaction(() => {
      ensurePendingReview(runId);
      const runUpdate = updateRunReviewStatus(runId, 'rejected');
      if (!runUpdate.ok) {
        throw new Error(runUpdate.error);
      }
      const taskUpdate = updateTaskStatus(run.task_id, 'failed');
      if (!taskUpdate.ok) {
        throw new Error(taskUpdate.error);
      }
    })();
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const freeze = freezes.getFreezeByRun(runId);
  emit('review.rejected', 'run', runId, {
    task_id: run.task_id,
    reason,
    ...(freeze ? { freeze: { sha: freeze.sha, project: freeze.project, desk: freeze.desk } } : {}),
  });
  if (freeze) {
    const actor = currentActorId();
    const actorUser = actor && actor !== OWNER_USER_ID ? getUser(actor) : null;
    freezes.markRejected(runId, actor ? (actor === OWNER_USER_ID ? 'owner' : actorUser?.ok ? actorUser.data.name : actor) : null, reason);
  }

  void onRunComplete(runId, run.agent_id);

  return getRun(runId);
}

function ensurePendingReview(runId: string): void {
  const runResult = getRun(runId);
  if (!runResult.ok) {
    throw new Error(runResult.error);
  }

  if (runResult.data.review_status !== 'pending') {
    throw new Error(`Run already ${runResult.data.review_status}`);
  }
}

function runToReviewItem(run: Run): ReviewItem | null {
  const taskResult = getTask(run.task_id);
  if (!taskResult.ok) return null;

  const agentResult = getAgent(run.agent_id);
  const agentName = agentResult.ok ? agentResult.data.name : 'unknown';

  const artifacts = getRunArtifacts(run.id);

  let duration: number | null = null;
  if (run.finished_at && run.started_at) {
    const start = new Date(run.started_at + 'Z').getTime();
    const end = new Date(run.finished_at + 'Z').getTime();
    duration = Math.floor((end - start) / 1000);
  }

  const latest = getLatestCompletedReview(run.id);
  const freeze = freezes.getFreezeByRun(run.id);

  return {
    freeze: freeze ? freezes.toCard(freeze) : null,
    run,
    task: taskResult.data,
    agentName,
    artifacts,
    duration,
    latestReview: latest
      ? {
          id: latest.id,
          verdict: latest.verdict,
          issues_found: latest.issues_found,
          fix_round: latest.fix_round,
          created_at: latest.created_at,
        }
      : null,
  };
}
