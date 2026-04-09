import { listAgents, getAgent, updateAgentStatus, listRuns, updateTaskStatus, finishRun, type Agent } from './db.js';
import { getConfig } from './config.js';
import { emit } from './event-bus.js';
import { notifyAgentCrashed } from './notifications.js';
import * as sessionManager from './session-manager.js';
import * as taskDispatcher from './task-dispatcher.js';
import * as tmux from './tmux.js';
import logger from './logger.js';

interface AgentHealthState {
  lastOutputHash: string;
  lastChangeAt: number;
  consecutiveStale: number;
}

const healthStates = new Map<string, AgentHealthState>();
let monitorTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the health monitor. Runs every 30 seconds.
 */
export function startHealthMonitor(): void {
  if (monitorTimer) return;

  monitorTimer = setInterval(checkAll, 30000);
  logger.info('Health monitor started (30s interval)');
}

/**
 * Stop the health monitor.
 */
export function stopHealthMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

async function checkAll(): Promise<void> {
  const agents = listAgents();
  const config = getConfig();
  const hangTimeoutMs = config.autonomy.hang_timeout_min * 60 * 1000;

  for (const agent of agents) {
    try {
      await checkAgent(agent, hangTimeoutMs);
    } catch (e) {
      logger.error({ agentId: agent.id, error: (e as Error).message }, 'Health check error');
    }
  }
}

async function checkAgent(agent: Agent, hangTimeoutMs: number): Promise<void> {
  const config = getConfig();

  // Check if tmux session is still alive
  const alive = isSessionAlive(agent.tmux_session);

  if (!alive) {
    if (agent.mode === 'spawned' && config.autonomy.auto_restart) {
      await handleCrashedSpawnedAgent(agent);
    } else if (agent.mode === 'adopted') {
      // Can't restart adopted agents — just notify
      if (agent.status !== 'error') {
        updateAgentStatus(agent.id, 'error');
        emit('agent.crashed', 'agent', agent.id, { name: agent.name, mode: agent.mode });
        await notifyAgentCrashed(agent.name, agent.id);
        logger.warn({ agentId: agent.id, name: agent.name }, 'Adopted agent session died');
      }
    }
    return;
  }

  // Check for hang (no output change for hang_timeout_min)
  const captureResult = sessionManager.capturePane(agent.tmux_session, 20);
  if (!captureResult.ok) return;

  const outputHash = simpleHash(captureResult.data);
  const state = healthStates.get(agent.id);
  const now = Date.now();

  if (!state) {
    healthStates.set(agent.id, {
      lastOutputHash: outputHash,
      lastChangeAt: now,
      consecutiveStale: 0,
    });
    return;
  }

  if (outputHash !== state.lastOutputHash) {
    // Output changed — agent is alive
    state.lastOutputHash = outputHash;
    state.lastChangeAt = now;
    state.consecutiveStale = 0;
  } else {
    state.consecutiveStale++;

    // Only check hang if agent is supposedly working
    if (agent.status === 'working' && (now - state.lastChangeAt) > hangTimeoutMs) {
      logger.warn(
        { agentId: agent.id, name: agent.name, staleMinutes: Math.floor((now - state.lastChangeAt) / 60000) },
        'Agent appears hung',
      );

      if (agent.mode === 'spawned' && config.autonomy.auto_restart) {
        await handleHungSpawnedAgent(agent);
        state.lastChangeAt = now;
        state.consecutiveStale = 0;
      } else {
        // Adopted or other — the output-watcher handles status correction
        // for adopted agents. Just emit the event for monitoring.
        emit('agent.hung', 'agent', agent.id, {
          name: agent.name,
          stale_minutes: Math.floor((now - state.lastChangeAt) / 60000),
        });
      }
    }
  }
}

async function handleCrashedSpawnedAgent(agent: Agent): Promise<void> {
  const config = getConfig();
  logger.warn({ agentId: agent.id, name: agent.name }, 'Spawned agent crashed, auto-restarting');

  updateAgentStatus(agent.id, 'error');
  emit('agent.crashed', 'agent', agent.id, { name: agent.name, mode: 'spawned', restarting: true });
  await notifyAgentCrashed(agent.name, agent.id);

  try {
    // Re-queue any running tasks for this agent
    const recoveredRuns = reQueueRunningTasks(agent.id);

    const restartResult = sessionManager.ensureSpawnedAgentSession(agent.id);
    if (!restartResult.ok) {
      logger.error({ agentId: agent.id, error: restartResult.error }, 'Failed to restart agent');
      return;
    }

    emit('agent.restarted', 'agent', agent.id, { name: agent.name });
    logger.info({ agentId: agent.id, name: agent.name }, 'Agent restarted');

    if (recoveredRuns > 0 && config.autonomy.auto_dispatch) {
      setTimeout(() => {
        void taskDispatcher.dispatchNext();
      }, 500);
    }
  } catch (e) {
    logger.error({ agentId: agent.id, error: (e as Error).message }, 'Failed to restart agent');
  }
}

async function handleHungSpawnedAgent(agent: Agent): Promise<void> {
  logger.warn({ agentId: agent.id, name: agent.name }, 'Killing hung spawned agent');

  // Kill the tmux session (safe — no-op if already dead)
  tmux.killSession(agent.tmux_session);

  // Will be detected as crashed on next check cycle → auto-restart
  updateAgentStatus(agent.id, 'error');
}

function reQueueRunningTasks(agentId: string): number {
  const runs = listRuns({ agent_id: agentId, status: 'running' });
  for (const run of runs) {
    // Mark run as failed
    finishRun(run.id, 1);
    emit('run.failed', 'run', run.id, {
      agent_id: agentId,
      task_id: run.task_id,
      exit_code: 1,
      reason: 'agent_crash_recovery',
    });
    // Reset task to pending for re-dispatch
    updateTaskStatus(run.task_id, 'pending');
    emit('task.retrying', 'task', run.task_id, {
      agent_id: agentId,
      run_id: run.id,
      reason: 'agent_crash_recovery',
    });
    logger.info({ runId: run.id, taskId: run.task_id }, 'Re-queued task after agent crash');
  }
  return runs.length;
}

function isSessionAlive(sessionName: string): boolean {
  return tmux.hasSession(sessionName);
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const chr = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return String(hash);
}
