import {
  listAgents,
  listRuns,
  listTasks,
  finishRun,
  updateAgentStatus,
  updateAgentWorkspace,
  updateTaskStatus,
  getAgent,
  type Agent,
  type Run,
  type Task,
} from './db.js';
import { getConfig } from './config.js';
import { emit } from './event-bus.js';
import * as sessionManager from './session-manager.js';
import * as outputWatcher from './output-watcher.js';
import * as taskDispatcher from './task-dispatcher.js';
import * as tmux from './tmux.js';
import logger from './logger.js';

export interface StartupReconcileResult {
  agentsChecked: number;
  sessionsRecreated: number;
  sessionsInterrupted: number;
  adoptedMissingSessions: number;
  runsRecovered: number;
  tasksRequeued: number;
  tasksFailed: number;
  orphanRunningTasksRequeued: number;
  orphanRunningTasksFailed: number;
  agentResumeFailures: number;
}

export async function reconcileStartupState(): Promise<StartupReconcileResult> {
  const result: StartupReconcileResult = {
    agentsChecked: 0,
    sessionsRecreated: 0,
    sessionsInterrupted: 0,
    adoptedMissingSessions: 0,
    runsRecovered: 0,
    tasksRequeued: 0,
    tasksFailed: 0,
    orphanRunningTasksRequeued: 0,
    orphanRunningTasksFailed: 0,
    agentResumeFailures: 0,
  };

  const agents = listAgents();
  const runningRuns = listRuns({ status: 'running' });
  const runsByAgent = new Map<string, Run[]>();

  for (const run of runningRuns) {
    const agentRuns = runsByAgent.get(run.agent_id) ?? [];
    agentRuns.push(run);
    runsByAgent.set(run.agent_id, agentRuns);
  }

  for (const agent of agents) {
    result.agentsChecked += 1;
    const sessionAlive = tmux.hasSession(agent.tmux_session);
    const inFlightRuns = runsByAgent.get(agent.id) ?? [];

    if (agent.mode === 'spawned') {
      if (sessionAlive && inFlightRuns.length > 0) {
        const interruptResult = sessionManager.sendRawKeys(agent.id, 'C-c');
        if (interruptResult.ok) {
          result.sessionsInterrupted += 1;
        } else {
          logger.warn(
            { agentId: agent.id, error: interruptResult.error },
            'Failed to interrupt in-flight spawned agent during startup reconciliation',
          );
        }
      }

      if (inFlightRuns.length > 0) {
        recoverRunningRuns(agent, inFlightRuns, 'requeue', result);
      }

      const resumeResult = sessionManager.ensureSpawnedAgentSession(agent.id);
      if (!resumeResult.ok) {
        result.agentResumeFailures += 1;
        updateAgentStatus(agent.id, 'error');
        logger.error({ agentId: agent.id, error: resumeResult.error }, 'Failed to reconcile spawned agent');
        continue;
      }

      if (resumeResult.data.createdSession) {
        result.sessionsRecreated += 1;
      }

      backfillWorkspace(agent);
      outputWatcher.startWatching(agent.id);
      logger.info(
        { agentId: agent.id, recreated: resumeResult.data.createdSession },
        resumeResult.data.createdSession
          ? 'Recreated spawned agent session during startup reconciliation'
          : 'Resumed spawned agent during startup reconciliation',
      );
      continue;
    }

    if (inFlightRuns.length > 0) {
      recoverRunningRuns(agent, inFlightRuns, 'fail', result);
    }

    if (!sessionAlive) {
      result.adoptedMissingSessions += 1;
      outputWatcher.stopWatching(agent.id);
      if (agent.status !== 'error') {
        updateAgentStatus(agent.id, 'error');
        emit('agent.crashed', 'agent', agent.id, {
          name: agent.name,
          mode: agent.mode,
          startup_reconciled: true,
        });
      }
      logger.warn({ agentId: agent.id, name: agent.name }, 'Adopted agent session missing on startup');
      continue;
    }

    backfillWorkspace(agent);
    outputWatcher.startWatching(agent.id);
    logger.info({ agentId: agent.id, name: agent.name }, 'Resumed adopted agent during startup reconciliation');
  }

  reconcileOrphanRunningTasks(result);

  const recoveredTasks = result.tasksRequeued + result.orphanRunningTasksRequeued;
  if (recoveredTasks > 0 && getConfig().autonomy.auto_dispatch) {
    setTimeout(() => {
      void taskDispatcher.dispatchNext();
    }, 500);
  }

  return result;
}

function recoverRunningRuns(
  agent: Agent,
  runs: Run[],
  mode: 'requeue' | 'fail',
  result: StartupReconcileResult,
): void {
  for (const run of runs) {
    finishRun(run.id, 1);
    result.runsRecovered += 1;

    emit('run.failed', 'run', run.id, {
      agent_id: agent.id,
      task_id: run.task_id,
      exit_code: 1,
      startup_reconciled: true,
      reason: 'startup_recovery',
    });

    if (mode === 'requeue') {
      updateTaskStatus(run.task_id, 'pending');
      result.tasksRequeued += 1;
      emit('task.retrying', 'task', run.task_id, {
        agent_id: agent.id,
        run_id: run.id,
        startup_reconciled: true,
        reason: 'startup_recovery',
      });
      updateAgentStatus(agent.id, 'idle');
    } else {
      updateTaskStatus(run.task_id, 'failed');
      result.tasksFailed += 1;
      emit('task.failed', 'task', run.task_id, {
        agent_id: agent.id,
        run_id: run.id,
        startup_reconciled: true,
        reason: 'startup_recovery',
      });
      updateAgentStatus(agent.id, 'error');
    }
  }
}

function reconcileOrphanRunningTasks(result: StartupReconcileResult): void {
  const runningTasks = listTasks({ status: 'running' });

  for (const task of runningTasks) {
    reconcileOrphanRunningTask(task, result);
  }
}

/** If agent has no workspace, try to detect it from tmux pane current path */
function backfillWorkspace(agent: Agent): void {
  if (agent.workspace) return;
  try {
    const dir = tmux.getPaneDir(agent.tmux_session);
    if (dir && dir !== '/') {
      updateAgentWorkspace(agent.id, dir);
      logger.info({ agentId: agent.id, workspace: dir }, 'Backfilled agent workspace from tmux');
    }
  } catch { /* best effort */ }
}

function reconcileOrphanRunningTask(task: Task, result: StartupReconcileResult): void {
  const agentResult = task.agent_id ? getAgent(task.agent_id) : null;
  const recoverable = !!(
    agentResult &&
    agentResult.ok &&
    agentResult.data.mode === 'spawned'
  );

  if (recoverable) {
    updateTaskStatus(task.id, 'pending');
    result.orphanRunningTasksRequeued += 1;
    emit('task.retrying', 'task', task.id, {
      agent_id: task.agent_id,
      startup_reconciled: true,
      reason: 'orphan_running_task',
    });
  } else {
    updateTaskStatus(task.id, 'failed');
    result.orphanRunningTasksFailed += 1;
    emit('task.failed', 'task', task.id, {
      agent_id: task.agent_id,
      startup_reconciled: true,
      reason: 'orphan_running_task',
    });
  }
}
