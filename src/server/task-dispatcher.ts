import {
  getDb,
  listTasks,
  listRuns,
  listOpenRuns,
  hasOpenRun,
  getTask,
  getRun,
  getAgent,
  updateTaskStatus,
  updateAgentStatus,
  listAgents,
  insertAgentMessage,
  insertRun,
  finishRun,
  updateRunResultPath,
  type Task,
  type Agent,
  type Result,
  type Run,
} from './db.js';
import { getConfig } from './config.js';
import { emit } from './event-bus.js';
import { executeRun } from './runner.js';
import * as sessionManager from './session-manager.js';
import { buildBriefing } from './briefing-builder.js';
import { maybeInvokeProjectGate } from './project-gate.js';
import {
  appendRunResultBriefing,
  exitCodeForVerdict,
  resultPathForRun,
  settleRunResultFile,
} from './run-result.js';
import logger from './logger.js';

let dispatchInProgress = false;

/**
 * Called when a run completes (success or failure).
 * Handles retries, updates task status, triggers next dispatch.
 */
export async function onRunComplete(runId: string, agentId: string): Promise<void> {
  const runResult = getRun(runId);
  if (!runResult.ok) return;

  const run = runResult.data;
  const taskResult = getTask(run.task_id);
  if (!taskResult.ok) return;

  const task = taskResult.data;
  const config = getConfig();
  const seatStillBusy = listOpenRuns(agentId).some((r) => r.id !== runId);

  if (run.review_status === 'rejected') {
    if (task.status !== 'failed') updateTaskStatus(task.id, 'failed');
    if (!seatStillBusy) updateAgentStatus(agentId, 'idle');
    blockDependents(task.id);
  } else if (run.status === 'done') {
    // Success — mark task done unless reject/cancel already failed it
    if (task.status !== 'failed') {
      updateTaskStatus(task.id, 'done');
    }
    if (!seatStillBusy) {
      updateAgentStatus(agentId, 'idle');
    }

    if (task.status === 'failed') {
      blockDependents(task.id);
    } else {
    emit('task.completed', 'task', task.id, {
      agent_id: agentId,
      run_id: runId,
    });

    // Unblock dependent tasks
    unblockDependents(task.id);

    // Notify dependent tasks' agents about completion
    const agentForMsg = getAgent(agentId);
    const dependents = getDb().prepare(
      'SELECT task_id FROM task_dependencies WHERE depends_on_id = ?',
    ).all(task.id) as { task_id: string }[];

    for (const dep of dependents) {
      const depTask = getTask(dep.task_id);
      if (!depTask.ok) continue;

      const msgResult = insertAgentMessage({
        from_agent_id: agentId,
        to_agent_id: depTask.data.agent_id ?? undefined,
        workspace: agentForMsg.ok ? agentForMsg.data.workspace : undefined,
        message: `Task "${task.prompt.slice(0, 100)}" completed successfully. Result ready for dependent work.`,
        message_type: 'result',
        ref_task_id: task.id,
        ref_run_id: runId,
      });

      if (msgResult.ok) {
        emit('message.created', 'agent_message', msgResult.data.id, {
          from_agent_id: agentId,
          to_agent_id: depTask.data.agent_id,
          workspace: agentForMsg.ok ? agentForMsg.data.workspace : null,
          message_type: 'result',
        });
      }
    }

    // Extract architectural decisions from transcript (fire-and-forget)
    const agentResult = getAgent(agentId);
    if (agentResult.ok) {
      import('./decision-extractor.js')
        .then((de) => de.extractDecisions(run, agentResult.data))
        .catch((err) => logger.warn({ error: (err as Error).message }, 'Decision extraction import failed'));
      // Gated projects: invoke the referee. RESULT is the only evidence —
      // do not wait on it here (full mode can take ≥60 minutes).
      void maybeInvokeProjectGate(runId, agentResult.data).catch((err) =>
        logger.warn({ runId, error: (err as Error).message }, 'Project referee invoke failed'),
      );
    }

    // Automatic cross-model review of the finished work (fire-and-forget)
    import('./code-review.js')
      .then((cr) => cr.maybeAutoReview(runId))
      .catch((err) => logger.warn({ error: (err as Error).message }, 'Auto-review trigger failed'));
    }
  } else if (run.status === 'failed') {
    if (task.status === 'failed') {
      if (!seatStillBusy) updateAgentStatus(agentId, 'idle');
      blockDependents(task.id);
    } else {
    // Check if we should retry
    const attempts = listRuns({ task_id: task.id });
    if (attempts.length < config.autonomy.max_task_retries) {
      // Retry — create new run
      if (!seatStillBusy) updateAgentStatus(agentId, 'idle');
      emit('task.retrying', 'task', task.id, {
        attempt: attempts.length + 1,
        max: config.autonomy.max_task_retries,
      });
      // Will be picked up by next dispatch cycle
      updateTaskStatus(task.id, 'pending');
    } else {
      // Max retries exceeded — mark task failed
      updateTaskStatus(task.id, 'failed');
      if (!seatStillBusy) updateAgentStatus(agentId, 'idle');

      emit('task.failed', 'task', task.id, {
        agent_id: agentId,
        attempts: attempts.length,
      });

      // Block dependent tasks
      blockDependents(task.id);
    }
    }
  }

  // Trigger dispatch for idle agents
  if (config.autonomy.auto_dispatch) {
    // Stagger slightly to avoid CLI rate limits
    setTimeout(() => dispatchNext(), 1500);
  }
}

/**
 * Terminal close: persist finished_at + exit_code, then onRunComplete.
 * Used by idle-complete, reject_run, cancel, and executeRun send failure.
 *
 * Exit 0 / status=done requires a valid RESULT: PASS file. Idle, cancel,
 * reject, and missing/unparseable files finish as FAIL.
 */
export function finalizeRun(
  runId: string,
  agentId: string,
  exitCode: number,
  fallbackReason?: string,
): Result<Run> {
  const existing = getRun(runId);
  if (!existing.ok) return existing;
  const agent = getAgent(agentId);
  const resultPath = resultPathForRun(existing.data, agent.ok ? agent.data.workspace : null);
  if (!existing.data.result_path) updateRunResultPath(runId, resultPath);

  const forceFail = exitCode !== 0;
  const settled = settleRunResultFile(
    resultPath,
    fallbackReason ?? (forceFail
      ? 'Run failed without a parseable RESULT file'
      : 'Run closed without a parseable RESULT file'),
    { forceFail },
  );
  const usedExit = forceFail ? 1 : exitCodeForVerdict(settled.verdict);

  const finished = finishRun(runId, usedExit);
  if (!finished.ok) return finished;
  import('./runner.js').then((r) => r.clearRunnerRun?.(agentId, runId)).catch(() => {});
  emit(usedExit === 0 ? 'run.finished' : 'run.failed', 'run', runId, {
    agent_id: agentId,
    exit_code: usedExit,
    auto_detected: true,
    result: settled.verdict,
    result_reason: settled.reason,
  });
  void onRunComplete(runId, agentId);
  return finished;
}

/**
 * Find the next dispatchable task and assign it to an idle agent.
 * DAG-aware: only dispatches tasks whose dependencies are all 'done'.
 */
export async function dispatchNext(options: { manual?: boolean } = {}): Promise<void> {
  const config = getConfig();
  if (!options.manual && !config.autonomy.auto_dispatch) return;
  if (dispatchInProgress) return;

  dispatchInProgress = true;

  try {
    await dispatchNextInner();
  } finally {
    dispatchInProgress = false;
  }
}

async function dispatchNextInner(): Promise<void> {
  const config = getConfig();

  const idleAgents = listAgents().filter(
    (a) => a.status === 'idle' && !hasOpenRun(a.id),
  );

  if (idleAgents.length === 0) return;

  const dispatchableTasks = getDispatchableTasks();
  if (dispatchableTasks.length === 0) {
    // Check if all tasks are done — emit queue.empty
    const allTasks = listTasks();
    const pending = allTasks.filter((t) => ['pending', 'running', 'blocked'].includes(t.status));
    if (pending.length === 0 && allTasks.length > 0) {
      emit('queue.empty', 'system', 'dispatcher', {});
    }
    return;
  }

  // Match tasks to agents with staggered dispatch
  let delay = 0;
  for (const agent of idleAgents) {
    const task = findTaskForAgent(dispatchableTasks, agent);
    if (!task) continue;

    if (!claimTaskForDispatch(task.id)) {
      continue;
    }

    // Remove from dispatchable list
    const idx = dispatchableTasks.indexOf(task);
    if (idx >= 0) dispatchableTasks.splice(idx, 1);

    updateAgentStatus(agent.id, 'working');

    emit('task.dispatched', 'task', task.id, {
      agent_id: agent.id,
      agent_name: agent.name,
    });

    // Stagger dispatch
    setTimeout(() => {
      void dispatchTaskToAgent(task, agent);
    }, delay);
    delay += 1500; // 1.5s between dispatches to avoid rate limits
  }
}

/**
 * Dispatch a specific task to a specific agent.
 */
async function dispatchTaskToAgent(task: Task, agent: Agent): Promise<void> {
  // Build context briefing from sibling agents, recent changes, decisions
  let prompt = task.prompt;
  try {
    const briefing = buildBriefing(agent, task);
    if (briefing) {
      prompt = `${briefing}\n\n---\n## YOUR TASK\n${task.prompt}`;
      logger.info({ agentId: agent.id, taskId: task.id }, 'Prepended context briefing to task prompt');
    }
  } catch (err) {
    logger.warn({ error: (err as Error).message }, 'Failed to build briefing, dispatching without');
  }

  const open = listOpenRuns(agent.id);
  if (open.length > 0) {
    logger.warn(
      { agentId: agent.id, openRunId: open[0].id, taskId: task.id },
      'Refusing dispatch — agent already has an open run',
    );
    const current = getTask(task.id);
    if (current.ok && current.data.status === 'running' && current.data.id !== open[0].task_id) {
      updateTaskStatus(task.id, 'pending');
    }
    return;
  }

  if (agent.mode === 'spawned') {
    const run = await executeRun(agent.id, task.id, prompt);
    if (!run.ok) {
      if (run.code === 'busy') {
        const current = getTask(task.id);
        if (current.ok && current.data.status === 'running') {
          updateTaskStatus(task.id, 'pending');
        }
        return;
      }
      const current = getTask(task.id);
      if (current.ok && current.data.status === 'running') {
        updateTaskStatus(task.id, 'failed');
      }
      updateAgentStatus(agent.id, 'error');
      emit('task.failed', 'task', task.id, {
        agent_id: agent.id,
        error: run.error,
      });
    }
  } else {
    // Insert the run first so the result-file path is known, then send the
    // prompt + briefing. Same insertRun path as spawned — no echo|nc.
    const existingRuns = listRuns({ task_id: task.id });
    const runResult = insertRun({
      task_id: task.id,
      agent_id: agent.id,
      attempt: existingRuns.length + 1,
    });
    if (runResult.ok) {
      emit('run.started', 'run', runResult.data.id, {
        task_id: task.id,
        agent_id: agent.id,
        mode: 'adopted',
      });
      logger.info(
        { runId: runResult.data.id, taskId: task.id, agentId: agent.id },
        'Created run record for adopted agent dispatch',
      );
      if (runResult.data.result_path) {
        prompt = appendRunResultBriefing(prompt, runResult.data.result_path);
      }
    }

    const sendResult = sessionManager.sendKeys(agent.id, prompt);
    if (!sendResult.ok) {
      if (runResult.ok) {
        finalizeRun(runResult.data.id, agent.id, 1, 'Failed to send prompt to agent');
      }
      updateTaskStatus(task.id, 'failed');
      updateAgentStatus(agent.id, 'error');
      emit('task.failed', 'task', task.id, {
        error: sendResult.error,
      });
    }
  }
}

function claimTaskForDispatch(taskId: string): boolean {
  const result = getDb().prepare(
    `UPDATE tasks SET status = 'running' WHERE id = ? AND status = 'pending'`,
  ).run(taskId);

  return result.changes > 0;
}

/**
 * Get tasks that are ready to dispatch:
 * - Status is 'pending'
 * - All dependencies are 'done'
 * - Sorted by priority (desc), then created_at (asc)
 */
function getDispatchableTasks(): Task[] {
  const db = getDb();
  const tasks = listTasks({ status: 'pending' });

  return tasks.filter((task) => {
    // Check all dependencies are done
    const deps = db.prepare(
      'SELECT depends_on_id FROM task_dependencies WHERE task_id = ?',
    ).all(task.id) as { depends_on_id: string }[];

    if (deps.length === 0) return true;

    return deps.every((dep) => isDependencySatisfied(dep.depends_on_id));
  });
}

/**
 * A dependency is satisfied when its task is 'done' — and, when
 * review.gate_dependents_on_approval is on, its latest finished run has
 * additionally been approved in the review queue.
 */
function isDependencySatisfied(depTaskId: string): boolean {
  const depTask = getTask(depTaskId);
  if (!depTask.ok || depTask.data.status !== 'done') return false;

  if (!getConfig().review.gate_dependents_on_approval) return true;

  const doneRuns = listRuns({ task_id: depTaskId })
    .filter((r) => r.status === 'done')
    .sort((a, b) => (a.started_at < b.started_at ? 1 : -1));

  return doneRuns.length > 0 && doneRuns[0].review_status === 'approved';
}

/**
 * Find the best task for a given agent.
 * Prefers tasks assigned to this agent, then unassigned tasks.
 */
function findTaskForAgent(tasks: Task[], agent: Agent): Task | null {
  // First: tasks explicitly assigned to this agent
  const assigned = tasks.find((t) => t.agent_id === agent.id);
  if (assigned) return assigned;

  // Second: unassigned tasks (agent_id IS NULL)
  const unassigned = tasks.find((t) => t.agent_id === null);
  if (unassigned) return unassigned;

  return null;
}

/**
 * Mark dependent tasks as blocked when a task fails.
 */
function blockDependents(taskId: string): void {
  const db = getDb();
  const dependents = db.prepare(
    'SELECT task_id FROM task_dependencies WHERE depends_on_id = ?',
  ).all(taskId) as { task_id: string }[];

  for (const dep of dependents) {
    const task = getTask(dep.task_id);
    if (task.ok && task.data.status === 'pending') {
      updateTaskStatus(dep.task_id, 'blocked');
      emit('task.blocked', 'task', dep.task_id, {
        blocked_by: taskId,
      });
      // Recursively block
      blockDependents(dep.task_id);
    }
  }
}

/**
 * Public wrapper for unblocking dependents — used by output-watcher
 * when it auto-completes tasks for adopted agents.
 */
export function unblockDependentsPublic(completedTaskId: string): void {
  unblockDependents(completedTaskId);
}

/**
 * Check if blocked tasks can be unblocked after a dependency completes.
 */
function unblockDependents(completedTaskId: string): void {
  const db = getDb();
  const dependents = db.prepare(
    'SELECT task_id FROM task_dependencies WHERE depends_on_id = ?',
  ).all(completedTaskId) as { task_id: string }[];

  for (const dep of dependents) {
    const task = getTask(dep.task_id);
    if (!task.ok || task.data.status !== 'blocked') continue;

    // Check if ALL dependencies are now done
    const allDeps = db.prepare(
      'SELECT depends_on_id FROM task_dependencies WHERE task_id = ?',
    ).all(dep.task_id) as { depends_on_id: string }[];

    const allDone = allDeps.every((d) => isDependencySatisfied(d.depends_on_id));

    if (allDone) {
      updateTaskStatus(dep.task_id, 'pending');
      emit('task.unblocked', 'task', dep.task_id, {});
    }
  }
}

/**
 * Add a dependency between tasks.
 */
export function addDependency(taskId: string, dependsOnId: string): boolean {
  const db = getDb();
  try {
    db.prepare(
      'INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)',
    ).run(taskId, dependsOnId);
    return true;
  } catch {
    return false;
  }
}

export function resetDispatcherForTest(): void {
  dispatchInProgress = false;
}

/**
 * Get dependencies for a task.
 */
export function getDependencies(taskId: string): string[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT depends_on_id FROM task_dependencies WHERE task_id = ?',
  ).all(taskId) as { depends_on_id: string }[];
  return rows.map((r) => r.depends_on_id);
}

/**
 * Get tasks that depend on a given task.
 */
export function getDependents(taskId: string): string[] {
  const db = getDb();
  const rows = db.prepare(
    'SELECT task_id FROM task_dependencies WHERE depends_on_id = ?',
  ).all(taskId) as { task_id: string }[];
  return rows.map((r) => r.task_id);
}
