import {
  getDb,
  getRun,
  getTask,
  listReviewableRuns,
  updateRunReviewStatus,
  updateTaskStatus,
  getRunArtifacts,
  getAgent,
  type Run,
  type Task,
  type Artifact,
  type Result,
} from './db.js';
import { emit } from './event-bus.js';
import { getConfig } from './config.js';
import { dispatchNext, unblockDependentsPublic } from './task-dispatcher.js';
import { getLatestCompletedReview, type CodeReview } from './code-review.js';
import { evaluateRefereeForPromote } from './project-gate.js';
import logger from './logger.js';

export interface ReviewItem {
  run: Run;
  task: Task;
  agentName: string;
  artifacts: Artifact[];
  duration: number | null;
  /** Latest completed AI review, so the queue UI can show the verdict inline */
  latestReview: Pick<CodeReview, 'id' | 'verdict' | 'issues_found' | 'fix_round' | 'created_at'> | null;
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
  const referee = evaluateRefereeForPromote(
    runId,
    author.ok ? author.data.workspace : null,
  );
  if (!referee.ok) return referee;

  const gated = config.review.require_pass_to_promote || config.review.auto_review;
  const latestReview = getLatestCompletedReview(runId);
  const overrideReason = opts.overrideReason?.trim() || null;

  if (gated && latestReview?.verdict !== 'pass' && !overrideReason) {
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

  emit('review.promoted', 'run', runId, {
    task_id: runResult.data.task_id,
    verdict: latestReview?.verdict ?? null,
    override_reason: overrideReason,
  });

  if (overrideReason) {
    logger.warn({ runId, overrideReason }, 'Run promoted with verdict override');
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
export function reject(runId: string): Result<Run> {
  const runResult = getRun(runId);
  if (!runResult.ok) return runResult;

  const run = runResult.data;

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

  emit('review.rejected', 'run', runId, {
    task_id: run.task_id,
  });

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

  return {
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
