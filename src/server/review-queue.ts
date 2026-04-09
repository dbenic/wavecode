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
import { dispatchNext } from './task-dispatcher.js';

export interface ReviewItem {
  run: Run;
  task: Task;
  agentName: string;
  artifacts: Artifact[];
  duration: number | null;
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
 */
export function promote(runId: string): Result<Run> {
  const runResult = getRun(runId);
  if (!runResult.ok) return runResult;

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
  });

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

  return {
    run,
    task: taskResult.data,
    agentName,
    artifacts,
    duration,
  };
}
