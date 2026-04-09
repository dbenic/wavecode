import {
  getDb,
  listTasks,
  listRuns,
  getTask,
  getRun,
  getAgent,
  updateTaskStatus,
  updateAgentStatus,
  listAgents,
  insertAgentMessage,
  insertRun,
  type Task,
  type Agent,
} from './db.js';
import { getConfig } from './config.js';
import { emit } from './event-bus.js';
import { executeRun } from './runner.js';
import * as sessionManager from './session-manager.js';
import { buildBriefing } from './briefing-builder.js';
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

  if (run.status === 'done') {
    // Success — mark task done
    updateTaskStatus(task.id, 'done');
    updateAgentStatus(agentId, 'idle');

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
    }
  } else if (run.status === 'failed') {
    // Check if we should retry
    const attempts = listRuns({ task_id: task.id });
    if (attempts.length < config.autonomy.max_task_retries) {
      // Retry — create new run
      updateAgentStatus(agentId, 'idle');
      emit('task.retrying', 'task', task.id, {
        attempt: attempts.length + 1,
        max: config.autonomy.max_task_retries,
      });
      // Will be picked up by next dispatch cycle
      updateTaskStatus(task.id, 'pending');
    } else {
      // Max retries exceeded — mark task failed
      updateTaskStatus(task.id, 'failed');
      updateAgentStatus(agentId, 'idle');

      emit('task.failed', 'task', task.id, {
        agent_id: agentId,
        attempts: attempts.length,
      });

      // Block dependent tasks
      blockDependents(task.id);
    }
  }

  // Trigger dispatch for idle agents
  if (config.autonomy.auto_dispatch) {
    // Stagger slightly to avoid CLI rate limits
    setTimeout(() => dispatchNext(), 1500);
  }
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
    (a) => a.status === 'idle',
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

  if (agent.mode === 'spawned') {
    // Use runner for spawned agents
    const run = await executeRun(agent.id, task.id, prompt);
    if (!run) {
      const current = getTask(task.id);
      if (current.ok && current.data.status === 'running') {
        updateTaskStatus(task.id, 'failed');
      }
      updateAgentStatus(agent.id, 'error');
      emit('task.failed', 'task', task.id, {
        agent_id: agent.id,
        error: 'Failed to start task run',
      });
    }
  } else {
    // For adopted agents, inject via send-keys
    const sendResult = sessionManager.sendKeys(agent.id, prompt);
    if (!sendResult.ok) {
      updateTaskStatus(task.id, 'failed');
      updateAgentStatus(agent.id, 'error');
      emit('task.failed', 'task', task.id, {
        error: sendResult.error,
      });
    } else {
      // Create a run record so the output watcher can auto-complete the task
      // when it detects the agent going from working → idle.
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
      }
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

    return deps.every((dep) => {
      const depTask = getTask(dep.depends_on_id);
      return depTask.ok && depTask.data.status === 'done';
    });
  });
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

    const allDone = allDeps.every((d) => {
      const t = getTask(d.depends_on_id);
      return t.ok && t.data.status === 'done';
    });

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
