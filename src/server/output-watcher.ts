import { getAgent, updateAgentStatus, listRuns, listTasks, updateTaskStatus, type Agent } from './db.js';
import { getConfig } from './config.js';
import { capturePane, sendRawKeys } from './session-manager.js';
import { emit } from './event-bus.js';
import * as taskDispatcher from './task-dispatcher.js';
import { verifyTaskCompletion } from './task-verifier.js';
import { onAuthorAgentIdle } from './code-review.js';
import { projectRequiresReferee } from './project-gate.js';
import * as runner from './runner.js';
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
  /** Epoch ms of the last pane that detected working (for dispatch grace). */
  lastWorkingAt: number | null;
}

/** How many consecutive idle detections before we override DB 'working' -> 'idle'.
 *  Each tick is ~2s, so 4 ticks ~= 8 seconds - enough for send-keys to be received. */
export const IDLE_OVERRIDE_THRESHOLD = 4;

/**
 * Do not idle-finalize a just-dispatched run that never showed working
 * (Codex status bar / ›, Claude splash). Those seats only report working
 * after Working/Thinking/Applying or a live action-verb line.
 * After this grace, idle + missing result is still FAIL.
 * Once the pane has shown working, a later idle close is allowed.
 */
export const IDLE_CLOSE_GRACE_MS = 60_000;

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
    lastWorkingAt: null,
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
  if (detectedStatus === 'working') {
    state.lastWorkingAt = Date.now();
  }

  // Detect permission mode from output
  const permMode = detectPermissionMode(output);

  // Compare against the actual DB status rather than a cached previous value.
  const dbStatus = agent.status;

  let closeAllIfIdle = false;

  if (detectedStatus === dbStatus) {
    state.idleOverrideCounter = 0;
    // Already idle with a stuck running run (Grok RESULT + echo|nc, no
    // working→idle edge). Sweep on this tick — no daemon restart needed.
    closeAllIfIdle = detectedStatus === 'idle';

    if (outputChanged) {
      emit('agent.output_updated', 'agent', agentId, {
        lastOutputLine: state.lastOutputLine,
        permissionMode: permMode,
        outputVersion: state.outputVersion,
        outputUpdatedAt: new Date().toISOString(),
      });
    }
  } else if (detectedStatus === 'idle' && (dbStatus === 'working' || dbStatus === 'error')) {
    // The first idle-looking capture (including the working→idle pane
    // change) starts the counter. Further output changes while we are
    // already counting mean the agent is still generating.
    const stillStreaming = outputChanged && state.idleOverrideCounter > 0;
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
        if (hasProtectedYoungRun(agentId, state)) {
          // Codex/Claude splash looks idle until work starts. Hold the
          // override so a just-dispatched run is not failed in ~8s.
          logger.debug(
            { agentId, name: agent.name },
            'Holding idle override — open run still in dispatch grace',
          );
        } else {
          logger.info(
            { agentId, name: agent.name, mode: agent.mode, after: `${state.idleOverrideCounter * 2}s` },
            'Output shows idle but DB says working/error - correcting to idle',
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
          closeAllIfIdle = true;
          notifyReviewLoopAgentIdle(agentId);
        }
      }
    }
  } else if (detectedStatus !== dbStatus) {
    state.idleOverrideCounter = 0;
    updateAgentStatus(agentId, detectedStatus);

    const wasWorking = dbStatus === 'working' || dbStatus === 'error';

    emit('agent.status_changed', 'agent', agentId, {
      status: detectedStatus,
      lastOutputLine: state.lastOutputLine,
      permissionMode: permMode,
      outputVersion: state.outputVersion,
      outputUpdatedAt: new Date().toISOString(),
    });

    if (wasWorking && detectedStatus === 'idle') {
      closeAllIfIdle = true;
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

  closeFinishedRuns(agentId, output, detectedStatus, { closeAllIfIdle });
  // Idle-close may have stamped FAIL before the agent wrote result.txt.
  taskDispatcher.pollLatePassWatches?.();
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
  //   Action-verb status line while running: "✻ Brewing... (45s)"
  //   "● Bash(...)" / "● Read(...)" etc. with "Creating..." / "Initializing..."
  //
  // IDLE signals:
  //   Status bar (shift+tab / ⏵⏵) without "esc to interrupt"
  //   Marketing splash sparkle (✻/✶) and "Try refactor …" tips are NOT work
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

    // Idle / splash footer. Do not scan last5 for ✻/✶ or tip verbs —
    // the welcome sparkle and "Try refactor db.ts" are not work.
    return 'idle';
  }

  if (/^❯\s*$/.test(lastLine)) return 'idle';

  // Claude is running but the footer bar is not the last captured line.
  if (isClaudeWorkingVerbLine(lastLine) || isClaudeWorkingVerbLine(secondLast)) {
    return 'working';
  }

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
  // Grok (and similar TUIs) show "Responding…" / "Thinking" / "Worked for"
  // and an interrupt affordance while generating.
  if (hasGrokLikeWorkingIndicator(last10)) return 'working';

  // Configured idle_pattern (wired so it is not unread dead config).
  const idlePattern = runtimeIdlePattern(runtime);
  if (idlePattern) {
    try {
      if (new RegExp(idlePattern).test(lastLine)) return 'idle';
    } catch {
      // Invalid pattern — fall through
    }
  }

  // ============ ERROR ============
  if (last10.includes('FATAL') || last10.includes('panic:')) return 'error';

  return 'idle';
}

const CLAUDE_WORKING_VERBS = [
  'Scurrying', 'Brewing', 'Churning', 'Cooking', 'Crunching',
  'Simmering', 'Improvising', 'Composing', 'Crafting', 'Creating',
  'Initializing', 'Exploring', 'Searching', 'Analyzing',
  'Contemplating', 'Sautéing',
];

/** True for a live Claude status line ("Brewing... (45s)"), not splash tips. */
export function isClaudeWorkingVerbLine(line: string): boolean {
  for (const verb of CLAUDE_WORKING_VERBS) {
    if (line.includes(verb) && (/\.\.\.|…|\(\d/.test(line))) return true;
  }
  return false;
}

/** True when recent pane lines show a Grok-like generation indicator. */
export function hasGrokLikeWorkingIndicator(text: string): boolean {
  if (/(?:^|\n)\s*(?:[*✦✧✶✻◦●]\s*)?(Responding|Thinking|Worked[ -]for)\b/i.test(text)) {
    return true;
  }
  return /esc to interrupt|(?:ctrl\+c|⌘c) to interrupt|\bto interrupt\b/i.test(text);
}

function runtimeIdlePattern(runtime: string): string | null {
  try {
    return getConfig().runtimes[runtime]?.idle_pattern ?? null;
  } catch {
    return null;
  }
}

const RUN_ID_IN_PANE = /"run_id"\s*:\s*"(01[0-9A-HJKMNP-TV-Z]{24})"/g;

const SQLITE_UTC_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Parse runs.started_at (SQLite datetime('now') or ISO) to epoch ms. */
export function parseRunStartedAtMs(startedAt: string): number | null {
  const raw = startedAt.trim();
  if (!raw) return null;
  const iso = SQLITE_UTC_DATETIME.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** True when the run is still inside the post-dispatch idle-close grace. */
export function isWithinIdleCloseGrace(startedAt: string, now = Date.now()): boolean {
  const start = parseRunStartedAtMs(startedAt);
  if (start === null) return false;
  return now - start < IDLE_CLOSE_GRACE_MS;
}

/** True when the pane has shown working at or after this run's started_at. */
export function runShowedWorkingAfterStart(
  startedAt: string,
  lastWorkingAt: number | null,
): boolean {
  if (lastWorkingAt == null) return false;
  const start = parseRunStartedAtMs(startedAt);
  if (start === null) return true;
  return lastWorkingAt >= start;
}

function shouldHoldIdleFinalize(
  startedAt: string,
  lastWorkingAt: number | null,
  now = Date.now(),
): boolean {
  return isWithinIdleCloseGrace(startedAt, now)
    && !runShowedWorkingAfterStart(startedAt, lastWorkingAt);
}

function hasProtectedYoungRun(agentId: string, state: WatcherState, now = Date.now()): boolean {
  return listRuns({ agent_id: agentId, status: 'running' }).some((run) =>
    shouldHoldIdleFinalize(run.started_at, state.lastWorkingAt, now),
  );
}

function isRunnerScriptLine(line: string): boolean {
  return line.includes('nc -U') && (line.includes('wavecode-runner-') || line.includes('"run_id"'));
}

/** Last index of a real RESULT verdict line (not text inside the echo|nc script). */
export function lastFinishedResultIndex(output: string): number {
  let last = -1;
  let offset = 0;
  for (const line of output.split('\n')) {
    if (!isRunnerScriptLine(line) && /^\s*RESULT:\s*\S+/i.test(line)) {
      last = offset;
    }
    offset += line.length + 1;
  }
  return last;
}

/** run_ids from echo|nc runner scripts that appear before a RESULT line. */
export function extractFinishedRunIdsFromPane(output: string): string[] {
  const resultIdx = lastFinishedResultIndex(output);
  if (resultIdx < 0) return [];
  const ids: string[] = [];
  const re = new RegExp(RUN_ID_IN_PANE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(output)) !== null) {
    if (match.index < resultIdx) ids.push(match[1]);
  }
  return [...new Set(ids)];
}

/**
 * Close the correct stuck run(s):
 * - pane-named run_id whose echo|nc is followed by RESULT (Grok live dump)
 * - older running runs when a newer run exists (Codex moved on)
 * - all running runs only when the agent is stably idle
 *
 * Never keyed off runner.currentRunId alone. Closing goes through
 * onRunComplete (referee / wavepulse-gate unchanged).
 */
function closeFinishedRuns(
  agentId: string,
  output: string,
  detectedStatus: Agent['status'],
  opts: { closeAllIfIdle: boolean },
): void {
  const running = listRuns({ agent_id: agentId, status: 'running' });
  if (running.length === 0 && !opts.closeAllIfIdle) return;

  const selected = new Map<string, (typeof running)[number]>();
  const newestId = running[0]?.id;
  const paneFinishedIds = new Set(extractFinishedRunIdsFromPane(output));

  for (const run of running) {
    if (newestId && run.id !== newestId) {
      selected.set(run.id, run);
    }
    // RESULT after this run's echo|nc means *this* run finished. Do not
    // close the newest run while the pane still shows generation.
    if (paneFinishedIds.has(run.id) && !(run.id === newestId && detectedStatus === 'working')) {
      selected.set(run.id, run);
    }
  }

  if (opts.closeAllIfIdle && detectedStatus !== 'working') {
    const lastWorkingAt = watchers.get(agentId)?.lastWorkingAt ?? null;
    for (const run of running) {
      // Too young and never showed working after dispatch — do not FAIL yet.
      if (shouldHoldIdleFinalize(run.started_at, lastWorkingAt)) continue;
      selected.set(run.id, run);
    }
  }

  const completedTaskIds = new Set<string>();
  for (const run of selected.values()) {
    finishOneStuckRun(agentId, run);
    completedTaskIds.add(run.task_id);
  }

  const agentResult = getAgent(agentId);
  const runningTasks = listTasks({ status: 'running', agent_id: agentId });
  const noRunCompletedIds = new Set<string>();
  const skipNoRunComplete = agentResult.ok && agentResult.data.mode === 'spawned';
  if (opts.closeAllIfIdle && detectedStatus !== 'working') {
    for (const task of runningTasks) {
      if (completedTaskIds.has(task.id)) continue;
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
  }

  for (const taskId of noRunCompletedIds) {
    taskDispatcher.unblockDependentsPublic(taskId);
  }

  if (selected.size > 0 || noRunCompletedIds.size > 0) {
    setTimeout(() => taskDispatcher.dispatchNext(), 1500);
  }

  if (agentResult.ok && projectRequiresReferee(agentResult.data.workspace)) {
    return;
  }

  for (const taskId of [...completedTaskIds, ...noRunCompletedIds]) {
    verifyTaskCompletion(taskId, agentId).catch((err) =>
      logger.debug({ error: (err as Error).message }, 'Task verification fire-and-forget failed'),
    );
  }
}

function finishOneStuckRun(agentId: string, run: { id: string; task_id: string }): void {
  // Idle-close must not imply PASS. finalizeRun writes FAIL unless the
  // agent already left a parseable RESULT: PASS file. A later PASS file
  // is reconciled by pollLatePassWatches — never from this pane text.
  taskDispatcher.finalizeRun(
    run.id,
    agentId,
    0,
    'Idle close without a parseable RESULT file',
  );
  logger.info(
    { agentId, runId: run.id, taskId: run.task_id },
    'Auto-closed run (working -> idle); verdict from result file only',
  );
}
