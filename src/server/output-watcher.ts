import { getAgent, updateAgentStatus, listRuns, listTasks, finishRun, updateTaskStatus, type Agent } from './db.js';
import { capturePane, sendRawKeys } from './session-manager.js';
import { emit } from './event-bus.js';
import * as taskDispatcher from './task-dispatcher.js';
import { verifyTaskCompletion } from './task-verifier.js';
import { onAuthorAgentIdle } from './code-review.js';
import { projectRequiresReferee } from './project-gate.js';
import { clearRunnerRun } from './runner.js';
import logger from './logger.js';

/** Cooldown between unattended Claude first-run dialog dismissals. */
export const CLAUDE_BYPASS_DIALOG_COOLDOWN_MS = 8000;
const lastDialogDismissAt = new Map<string, number>();

export function resetFirstRunDialogStateForTest(): void {
  lastDialogDismissAt.clear();
}

/**
 * Claude Code's first-run "Bypass Permissions" confirmation.
 * The accept action is the second radio row ("Yes, I accept").
 */
export function isClaudeBypassAcceptDialog(output: string): boolean {
  if (!/Yes,\s*I accept/i.test(output)) return false;
  if (/Bypass Permissions/i.test(output)) return true;
  return /Do you want to proceed/i.test(output) && /bypass/i.test(output);
}

/**
 * Dismiss the Claude first-run accept dialog with Down then Enter.
 * Returns true when keys were sent (or attempted). Cooldown is ~8s.
 */
export function maybeDismissFirstRunDialog(
  agentId: string,
  output: string,
  now = Date.now(),
): boolean {
  if (!isClaudeBypassAcceptDialog(output)) return false;

  const last = lastDialogDismissAt.get(agentId) ?? 0;
  if (now - last < CLAUDE_BYPASS_DIALOG_COOLDOWN_MS) return false;

  lastDialogDismissAt.set(agentId, now);

  const down = sendRawKeys(agentId, 'Down');
  const enter = sendRawKeys(agentId, 'Enter');
  if (!down.ok) {
    logger.warn({ agentId, error: down.error }, 'Failed to dismiss Claude first-run dialog');
  } else if (!enter.ok) {
    logger.warn({ agentId, error: enter.error }, 'Failed to dismiss Claude first-run dialog');
  } else {
    logger.info({ agentId }, 'Dismissed Claude Bypass Permissions dialog');
  }
  return true;
}

/** Fire-and-forget: continue any pending fix-review loop for this agent. */
function notifyReviewLoopAgentIdle(agentId: string): void {
  onAuthorAgentIdle(agentId).catch((err) =>
    logger.debug({ error: (err as Error).message }, 'Review-loop idle hook failed'),
  );
}

interface WatcherState {
  timer: ReturnType<typeof setInterval>;
  previousOutput: string;
  lastOutputLine: string;
  outputVersion: number;
  tickInProgress: boolean; // Guard against overlapping ticks
  /**
   * Counts consecutive ticks where the output-detected status is 'idle'
   * but the DB says 'working'. We wait a few ticks before overriding
   * to give just-dispatched tasks time to start (send-keys latency).
   */
  idleOverrideCounter: number;
}

/** How many consecutive idle detections before we override DB 'working' -> 'idle'.
 *  Each tick is ~2s, so 4 ticks ~= 8 seconds - enough for send-keys to be received. */
export const IDLE_OVERRIDE_THRESHOLD = 4;

const watchers = new Map<string, WatcherState>();

export function startWatching(agentId: string): void {
  if (watchers.has(agentId)) return;

  const state: WatcherState = {
    timer: setInterval(() => tick(agentId), 2000),
    previousOutput: '',
    lastOutputLine: '',
    outputVersion: 0,
    tickInProgress: false,
    idleOverrideCounter: 0,
  };

  watchers.set(agentId, state);
}

export function stopWatching(agentId: string): void {
  const state = watchers.get(agentId);
  if (state) {
    clearInterval(state.timer);
    watchers.delete(agentId);
  }
}

export function stopAll(): void {
  for (const [id] of watchers) {
    stopWatching(id);
  }
}

export function getLastOutputLine(agentId: string): string {
  return watchers.get(agentId)?.lastOutputLine ?? '';
}

export function getOutputVersion(agentId: string): number {
  return watchers.get(agentId)?.outputVersion ?? 0;
}

export function isWatching(agentId: string): boolean {
  return watchers.has(agentId);
}

/** Drive one watcher tick without waiting on the interval. Tests only. */
export function tickForTest(agentId: string): void {
  tick(agentId);
}

function tick(agentId: string): void {
  const state = watchers.get(agentId);
  if (!state) return;

  // Guard against overlapping ticks (capture-pane can be slow)
  if (state.tickInProgress) return;
  state.tickInProgress = true;

  try {
    tickInner(agentId, state);
  } catch {
    // Swallow errors to prevent watcher from dying
  } finally {
    state.tickInProgress = false;
  }
}

function tickInner(agentId: string, state: WatcherState): void {
  const agentResult = getAgent(agentId);
  if (!agentResult.ok) {
    stopWatching(agentId);
    return;
  }

  const agent = agentResult.data;
  const captureResult = capturePane(agent.tmux_session);
  if (!captureResult.ok) return;

  const output = captureResult.data;
  maybeDismissFirstRunDialog(agentId, output);
  const outputChanged = output !== state.previousOutput;
  state.previousOutput = output;

  // Track last non-empty line for dashboard preview (only when output changes)
  if (outputChanged) {
    state.outputVersion += 1;
    const lines = output.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length > 0) {
      state.lastOutputLine = lines[lines.length - 1];
    }
  }

  // Detect status from output patterns
  const detectedStatus = detectStatus(output, agent.runtime);

  // Detect permission mode from output
  const permMode = detectPermissionMode(output);

  // Compare against the actual DB status rather than a cached previous value.
  const dbStatus = agent.status;

  if (detectedStatus === dbStatus) {
    state.idleOverrideCounter = 0;

    if (outputChanged) {
      emit('agent.output_updated', 'agent', agentId, {
        lastOutputLine: state.lastOutputLine,
        permissionMode: permMode,
        outputVersion: state.outputVersion,
        outputUpdatedAt: new Date().toISOString(),
      });
    }
  } else if (detectedStatus === 'idle' && dbStatus === 'working') {
    // Pane still changing means the agent is generating even if status
    // patterns missed a working indicator. Do not count those ticks.
    // First capture (outputVersion === 1) is the baseline, not streaming.
    const stillStreaming = outputChanged && state.outputVersion > 1;
    if (stillStreaming) {
      state.idleOverrideCounter = 0;
      emit('agent.output_updated', 'agent', agentId, {
        lastOutputLine: state.lastOutputLine,
        permissionMode: permMode,
        outputVersion: state.outputVersion,
        outputUpdatedAt: new Date().toISOString(),
      });
    } else {
      state.idleOverrideCounter++;

      if (state.idleOverrideCounter >= IDLE_OVERRIDE_THRESHOLD) {
        logger.info(
          { agentId, name: agent.name, mode: agent.mode, after: `${state.idleOverrideCounter * 2}s` },
          'Output shows idle but DB says working - correcting to idle',
        );
        updateAgentStatus(agentId, 'idle');
        state.idleOverrideCounter = 0;

        emit('agent.status_changed', 'agent', agentId, {
          status: 'idle',
          lastOutputLine: state.lastOutputLine,
          permissionMode: permMode,
          outputVersion: state.outputVersion,
          outputUpdatedAt: new Date().toISOString(),
          autoCorrect: true,
        });

        // Adopted and spawned both auto-close stuck runs. Spawned TUI seats
        // (Grok/Claude/Codex chat) never emit runner-socket run.finished.
        completeRunningRuns(agentId);
        notifyReviewLoopAgentIdle(agentId);
      }
    }
  } else if (detectedStatus !== dbStatus && dbStatus !== 'error') {
    state.idleOverrideCounter = 0;
    updateAgentStatus(agentId, detectedStatus);

    const wasWorking = dbStatus === 'working';

    emit('agent.status_changed', 'agent', agentId, {
      status: detectedStatus,
      lastOutputLine: state.lastOutputLine,
      permissionMode: permMode,
      outputVersion: state.outputVersion,
      outputUpdatedAt: new Date().toISOString(),
    });

    if (wasWorking && detectedStatus === 'idle') {
      completeRunningRuns(agentId);
      notifyReviewLoopAgentIdle(agentId);
    }
  } else if (outputChanged) {
    emit('agent.output_updated', 'agent', agentId, {
      lastOutputLine: state.lastOutputLine,
      permissionMode: permMode,
      outputVersion: state.outputVersion,
      outputUpdatedAt: new Date().toISOString(),
    });
  }
}

export function detectPermissionMode(output: string): string {
  if (output.includes("don't ask") || output.includes('dontAsk')) return 'auto';
  if (output.includes('bypass permissions') || output.includes('Bypass Permissions') || output.includes('dangerously-skip')) return 'bypass';
  if (output.includes('accept edits')) return 'accept-edits';
  if (output.includes('Do you want to proceed') || output.includes('Enter to confirm')) return 'ask';
  return 'unknown';
}

export function detectStatus(output: string, runtime: string): Agent['status'] {
  const allLines = output.split('\n');
  const nonEmpty = allLines.filter((l) => l.trim().length > 0);

  // Get the last few non-empty lines for pattern matching
  const lastLine = nonEmpty.length > 0 ? nonEmpty[nonEmpty.length - 1].trim() : '';
  const secondLast = nonEmpty.length > 1 ? nonEmpty[nonEmpty.length - 2].trim() : '';
  const last10 = nonEmpty.slice(-10).join('\n');
  const last5 = nonEmpty.slice(-5).join('\n');

  // ============ CLAUDE CODE ============
  // The status bar is always the last line. Key patterns:
  //
  // WORKING signals:
  //   "esc to interrupt" in status bar -> actively processing
  //   "✻" (sparkle) -> thinking/creating
  //   "✶" (star) -> creating
  //   Action verbs: Scurrying, Brewing, Churning, Cooking, etc.
  //   "● Bash(...)" / "● Read(...)" etc. with "Creating..." / "Initializing..."
  //
  // IDLE signals:
  //   Status bar without "esc to interrupt"
  //   "Brewed for / Churned for" etc. -> just finished
  //   "Context left until auto-compact" -> info display, at prompt
  //   File counts like "9 files +0 -0"
  //   Empty ❯ prompt

  if (lastLine.includes('⏵⏵') || lastLine.includes('shift+tab')) {
    if (lastLine.includes('esc to interrupt')) {
      if (lastLine.includes('ctrl+t') || lastLine.includes('hide tasks')) {
        const promptLine = nonEmpty.slice(-6).find((l) => /^❯\s*$/.test(l.trim()));
        if (promptLine) return 'idle';
      }
      return 'working';
    }

    const finishedPhrases = [
      'Brewed for', 'Churned for', 'Cooked for', 'Crunched for',
      'Scurried for', 'Simmered for', 'Improvised for', 'Composed for',
      'Crafted for', 'Sautéed for', 'Sauteed for',
    ];
    for (const phrase of finishedPhrases) {
      if (last10.includes(phrase)) return 'idle';
    }

    if (last5.includes('✻') || last5.includes('✶')) return 'working';

    const workingVerbs = [
      'Scurrying', 'Brewing', 'Churning', 'Cooking', 'Crunching',
      'Simmering', 'Improvising', 'Composing', 'Crafting', 'Creating',
      'Initializing', 'Exploring', 'Searching', 'Analyzing',
      'Contemplating', 'Sautéing',
    ];
    for (const verb of workingVerbs) {
      if (last5.includes(verb)) return 'working';
    }

    return 'idle';
  }

  if (/^❯\s*$/.test(lastLine)) return 'idle';

  // ============ CODEX CLI ============
  // Status bar: "gpt-X.X xhigh · NN% left · ~/path"
  // Working: "◦ Working (Xs • esc to interrupt)" or "Thinking"
  // Idle: "›" prompt or status bar without working indicator
  // Approval: "Press enter to confirm or esc to cancel"

  if (/gpt-[\d.]/.test(lastLine) || /gpt-[\d.]/.test(secondLast)) {
    if (last10.includes('Working') && last10.includes('esc to interrupt')) return 'working';
    if (last10.includes('◦ Working')) return 'working';
    if (last10.includes('Thinking')) return 'working';
    if (last10.includes('Applying')) return 'working';
    return 'idle';
  }

  if (/^›/.test(lastLine) || /^›/.test(secondLast)) {
    if (last10.includes('Working') && last10.includes('esc to interrupt')) return 'working';
    return 'idle';
  }

  if (last5.includes('Press enter to confirm') || last5.includes('esc to cancel')) return 'idle';
  if (last5.includes('Enter to confirm')) return 'idle';

  // ============ AIDER / GROK IDLE PROMPT ============
  // Grok's configured idle_pattern is `^>\s*$`. A prompt on the last line
  // means generation already finished — even if "Responding" is still in view.
  if (/^>\s*$/.test(lastLine)) return 'idle';

  // ============ SHELL PROMPT ============
  if (/\$\s*$/.test(lastLine)) return 'idle';

  // ============ RUNNER SOCKET (spawned mode) ============
  if (lastLine.includes('wavecode-runner-') && lastLine.includes('.sock')) return 'idle';

  // ============ GROK / GENERIC TUI WORKING ============
  // Grok (and similar TUIs) show "Responding…" / "Thinking" while generating.
  // Without these, panes fall through to idle and flip the agent without
  // closing the run — or worse, close it while still streaming.
  if (hasGrokLikeWorkingIndicator(last5)) return 'working';

  // ============ ERROR ============
  if (last10.includes('FATAL') || last10.includes('panic:')) return 'error';

  return 'idle';
}

/** True when recent pane lines show a Grok-like generation indicator. */
export function hasGrokLikeWorkingIndicator(text: string): boolean {
  return /(?:^|\n)\s*(?:[*✦✧✶✻◦●]\s*)?(Responding|Thinking)\b/i.test(text);
}

/**
 * When an agent transitions from working -> idle, auto-complete any
 * running runs via onRunComplete (referee / wavepulse-gate still run).
 * Spawned TUI seats never get run.finished from the Unix-socket runner,
 * so they use this same path as adopted agents.
 */
function completeRunningRuns(agentId: string): void {
  const runs = listRuns({ agent_id: agentId, status: 'running' });
  const completedTaskIds = new Set<string>();
  const agentResult = getAgent(agentId);

  for (const run of runs) {
    finishRun(run.id, 0);
    completedTaskIds.add(run.task_id);
    clearRunnerRun(agentId);
    emit('run.finished', 'run', run.id, {
      agent_id: agentId,
      exit_code: 0,
      auto_detected: true,
    });
    void taskDispatcher.onRunComplete(run.id, agentId);
    logger.info(
      { agentId, runId: run.id, taskId: run.task_id },
      'Auto-completed run (working -> idle)',
    );
  }

  const runningTasks = listTasks({ status: 'running', agent_id: agentId });
  const noRunCompletedIds = new Set<string>();
  const skipNoRunComplete = agentResult.ok && agentResult.data.mode === 'spawned';
  for (const task of runningTasks) {
    if (completedTaskIds.has(task.id)) continue;
    // Spawned tasks are created with a run via executeRun. Do not mark
    // them done without onRunComplete (skips referee / wavepulse-gate).
    if (skipNoRunComplete) continue;
    updateTaskStatus(task.id, 'done');
    noRunCompletedIds.add(task.id);
    emit('task.completed', 'task', task.id, {
      agent_id: agentId,
      auto_detected: true,
      no_run_record: true,
    });
    logger.info(
      { agentId, taskId: task.id },
      'Auto-completed task without run record (working -> idle)',
    );
  }

  for (const taskId of noRunCompletedIds) {
    taskDispatcher.unblockDependentsPublic(taskId);
  }

  if (runs.length > 0 || noRunCompletedIds.size > 0) {
    setTimeout(() => taskDispatcher.dispatchNext(), 1500);
  }

  if (agentResult.ok && projectRequiresReferee(agentResult.data.workspace)) {
    return;
  }

  const allCompletedTaskIds = [...completedTaskIds, ...noRunCompletedIds];
  for (const taskId of allCompletedTaskIds) {
    verifyTaskCompletion(taskId, agentId).catch((err) =>
      logger.debug({ error: (err as Error).message }, 'Task verification fire-and-forget failed'),
    );
  }
}
