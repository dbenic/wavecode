/**
 * Claude file runner (WC2).
 *
 * A second execution path for seats with mode=file. The daemon writes
 * prompt.md + status.json, starts `claude -p` in the worktree, and
 * treats runs/<run_id>/result.txt as the source of truth when present,
 * and also reads an exact RESULT line from cli.log the way a human
 * reading the CLI would.
 *
 * After `claude -p` exits, the runner stays in phase `running`
 * ("waiting for tests") while leftover work is still in flight:
 * process-group descendants, worktree npm/vitest/node/docker/postgres
 * children (including processes that left the Claude group), or
 * cli.log / last_line saying a test suite is still running.
 * Process-group wait alone is not enough — children can reparent.
 * Agent result.txt still wins; an exact RESULT line on cli.log still
 * counts. Clean exit with no leftover work and no RESULT is incomplete
 * — never a synthesized product RESULT: FAIL. This path never
 * re-spawns `claude -p`.
 *
 * This path never uses tmux send-keys, capture-pane, or idle-close.
 * Existing adopted/spawned seats stay on the tmux runner.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  finishRun,
  getAgent,
  getRun,
  insertRun,
  listOpenRuns,
  listRuns,
  updateTaskStatus,
  type Agent,
  type Result,
  type Run,
} from './db.js';
import { emit } from './event-bus.js';
import logger from './logger.js';
import {
  appendRunResultBriefing,
  parseResultLineFromOutput,
  presentRun,
  readRunResult,
  resolveRunResultPath,
  resultPathForRun,
  settleRunResultFile,
  writeRunResult,
  type PresentedRunResult,
} from './run-result.js';

export const FILE_RUNNER_HEARTBEAT_MS = 15_000;
export const FILE_RUNNER_STALE_MS = 120_000;
/** How long to wait for leftover work after Claude `-p` exits. */
export const FILE_RUNNER_PROCESS_TREE_MS = 15 * 60 * 1000;
export const FILE_RUNNER_PROCESS_TREE_POLL_MS = 250;
export const FILE_RUNNER_MODE = 'file' as const;
/** status.json reason while leftover tests/work are still running. */
export const FILE_RUNNER_WAITING_FOR_TESTS = 'waiting for tests';

export type FileRunnerPhase = 'queued' | 'starting' | 'running' | 'done' | 'failed' | 'incomplete';

export interface FileRunStatus {
  phase: FileRunnerPhase;
  pid?: number;
  started_at: string;
  updated_at: string;
  last_line?: string;
  reason?: string;
}

export interface PresentedFileRun extends PresentedRunResult {
  phase: FileRunnerPhase | null;
  pid: number | null;
  phase_started_at: string | null;
  phase_updated_at: string | null;
  last_line: string | null;
  prompt_path: string | null;
  status_path: string | null;
  log_path: string | null;
  log: string | null;
  reason: string | null;
}

export type ExecuteFileRunFailure = Result<Run> & {
  code: 'busy' | 'unavailable' | 'start_failed';
};
export type ExecuteFileRunResult = { ok: true; data: Run } | ExecuteFileRunFailure;

const SAFE_MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,99}$/;

const CLAUDE_MD_BEGIN = '<!-- wavecode-file-runner -->';
const CLAUDE_MD_END = '<!-- /wavecode-file-runner -->';

export const FILE_RUNNER_CLAUDE_MD_RULES = [
  '## WaveCode standing rules',
  '',
  'These are standing rules only. Per-task instructions belong in the run prompt file, not here.',
  '',
  '- The last line of the run result file (`result.txt`) must be exactly `RESULT: PASS` or `RESULT: FAIL`.',
  '- Do not git push.',
  '- Write only the named files you are asked to write. Do not invent extra files.',
].join('\n');

interface LiveFileRun {
  runId: string;
  agentId: string;
  child: ChildProcess;
  heartbeat: ReturnType<typeof setInterval>;
  staleCheck: ReturnType<typeof setInterval>;
  logPath: string;
  workspace: string;
  worktreePidsAtStart: number[];
}

const liveRuns = new Map<string, LiveFileRun>();

export interface FileRunnerTestHooks {
  spawn?: typeof spawn;
  now?: () => Date;
  heartbeatMs?: number;
  staleMs?: number;
  claudeBin?: string;
  listProcessGroupPids?: (pgid: number) => number[];
  listWorktreePids?: (workspace: string) => number[];
  processTreePollMs?: number;
  processTreeTimeoutMs?: number;
}

let testHooks: FileRunnerTestHooks = {};

export function setFileRunnerTestHooks(hooks: FileRunnerTestHooks): void {
  testHooks = hooks;
}

export function resetFileRunnerForTest(): void {
  for (const [runId] of liveRuns) {
    stopLiveRun(runId, false);
  }
  liveRuns.clear();
  testHooks = {};
}

export function isFileRunnerSeat(agent: { mode?: string | null } | null | undefined): boolean {
  return agent?.mode === FILE_RUNNER_MODE;
}

export function fileRunnerSessionName(agentName: string): string {
  return `file:${agentName}`;
}

export function runDirFor(runId: string): string {
  return path.dirname(resolveRunResultPath(runId));
}

export function promptPathFor(runId: string): string {
  return path.join(runDirFor(runId), 'prompt.md');
}

export function statusPathFor(runId: string): string {
  return path.join(runDirFor(runId), 'status.json');
}

export function cliLogPathFor(runId: string): string {
  return path.join(runDirFor(runId), 'cli.log');
}

export function readFileRunStatus(runId: string): FileRunStatus | null {
  try {
    const raw = fs.readFileSync(statusPathFor(runId), 'utf8');
    const parsed = JSON.parse(raw) as FileRunStatus;
    if (!parsed || typeof parsed.phase !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readCliLog(runId: string, maxBytes = 64_000): string | null {
  const logPath = cliLogPathFor(runId);
  try {
    const stat = fs.statSync(logPath);
    if (stat.size <= 0) return '';
    const fd = fs.openSync(logPath, 'r');
    try {
      const readLen = Math.min(stat.size, maxBytes);
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, Math.max(0, stat.size - readLen));
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function presentFileRun<T extends { id: string; result_path?: string | null }>(
  run: T,
  opts: { includeLog?: boolean } = {},
): T & PresentedFileRun {
  const presented = presentRun(run);
  const status = readFileRunStatus(run.id);
  const promptPath = promptPathFor(run.id);
  const statusFile = statusPathFor(run.id);
  const logPath = cliLogPathFor(run.id);
  return {
    ...presented,
    phase: status?.phase ?? null,
    pid: status?.pid ?? null,
    phase_started_at: status?.started_at ?? null,
    phase_updated_at: status?.updated_at ?? null,
    last_line: status?.last_line ?? null,
    prompt_path: fs.existsSync(promptPath) ? promptPath : null,
    status_path: fs.existsSync(statusFile) ? statusFile : null,
    log_path: fs.existsSync(logPath) ? logPath : null,
    log: opts.includeLog ? readCliLog(run.id) : null,
    reason: status?.reason ?? presented.result_reason ?? null,
  };
}

export function writeFileRunStatus(
  runId: string,
  patch: Partial<FileRunStatus> & { phase: FileRunnerPhase },
  meta?: { taskId?: string; agentId?: string; emitPhase?: boolean },
): FileRunStatus {
  const prev = readFileRunStatus(runId);
  const now = (testHooks.now ?? (() => new Date()))().toISOString();
  const next: FileRunStatus = {
    phase: patch.phase,
    started_at: patch.started_at ?? prev?.started_at ?? now,
    updated_at: now,
  };
  const pid = patch.pid !== undefined ? patch.pid : prev?.pid;
  if (pid !== undefined) next.pid = pid;
  const lastLine = patch.last_line !== undefined ? patch.last_line : prev?.last_line;
  if (lastLine !== undefined) next.last_line = lastLine;
  const reason = patch.reason !== undefined ? patch.reason : prev?.reason;
  if (reason !== undefined) next.reason = reason;

  const statusFile = statusPathFor(runId);
  fs.mkdirSync(path.dirname(statusFile), { recursive: true });
  fs.writeFileSync(statusFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  if (meta?.emitPhase !== false && next.phase !== prev?.phase) {
    emit('run.phase', 'run', runId, {
      phase: next.phase,
      task_id: meta?.taskId ?? null,
      agent_id: meta?.agentId ?? null,
      pid: next.pid ?? null,
      last_line: next.last_line ?? null,
      reason: next.reason ?? null,
    });
  }
  return next;
}

export function ensureClaudeMd(workspace: string): { path: string; created: boolean; updated: boolean } {
  const filePath = path.join(workspace, 'CLAUDE.md');
  const block = `${CLAUDE_MD_BEGIN}\n${FILE_RUNNER_CLAUDE_MD_RULES}\n${CLAUDE_MD_END}\n`;
  fs.mkdirSync(workspace, { recursive: true });

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, block, 'utf8');
    return { path: filePath, created: true, updated: true };
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  if (existing.includes(CLAUDE_MD_BEGIN) && existing.includes(CLAUDE_MD_END)) {
    const updated = existing.replace(
      new RegExp(`${escapeRegExp(CLAUDE_MD_BEGIN)}[\\s\\S]*?${escapeRegExp(CLAUDE_MD_END)}\\n?`),
      block,
    );
    if (updated !== existing) {
      fs.writeFileSync(filePath, updated, 'utf8');
      return { path: filePath, created: false, updated: true };
    }
    return { path: filePath, created: false, updated: false };
  }

  const prefix = existing.endsWith('\n') || existing.length === 0 ? existing : `${existing}\n`;
  fs.writeFileSync(filePath, `${prefix}\n${block}`, 'utf8');
  return { path: filePath, created: false, updated: true };
}

export function buildClaudePrintArgs(opts: {
  model?: string | null;
  prompt: string;
}): string[] {
  const args = ['-p', '--dangerously-skip-permissions'];
  if (opts.model && SAFE_MODEL_PATTERN.test(opts.model)) {
    args.push('--model', opts.model);
  }
  args.push(opts.prompt);
  return args;
}

/**
 * Start a file-runner run. Writes prompt.md + status.json, starts
 * `claude -p` in the agent worktree, waits for leftover work (process
 * group, worktree children, or an in-flight last_line), then reads
 * result.txt (wins) or an exact RESULT line from cli.log.
 */
export async function executeFileRun(
  agentId: string,
  taskId: string,
  prompt: string,
): Promise<ExecuteFileRunResult> {
  const agentResult = getAgent(agentId);
  if (!agentResult.ok) {
    return { ok: false, error: agentResult.error, code: 'unavailable' };
  }
  const agent = agentResult.data;
  if (!isFileRunnerSeat(agent)) {
    return { ok: false, error: `Agent ${agentId} is not a file-runner seat`, code: 'unavailable' };
  }
  if (!agent.workspace) {
    return { ok: false, error: 'File-runner seat requires a workspace', code: 'unavailable' };
  }

  const open = listOpenRuns(agentId);
  if (open.length > 0) {
    return {
      ok: false,
      error: `Agent already has an open run (${open[0].id})`,
      code: 'busy',
    };
  }

  const existingRuns = listRuns({ task_id: taskId });
  const attempt = existingRuns.length + 1;
  const runResult = insertRun({ task_id: taskId, agent_id: agentId, attempt });
  if (!runResult.ok) {
    return { ok: false, error: runResult.error, code: 'unavailable' };
  }

  const run = runResult.data;
  const resultPath = resultPathForRun(run, agent.workspace);
  const briefedPrompt = appendRunResultBriefing(prompt, resultPath);
  const startedAt = isoNow();

  try {
    writePromptFile(run.id, briefedPrompt);
    writeFileRunStatus(run.id, { phase: 'queued', started_at: startedAt }, { taskId, agentId });
    ensureClaudeMd(agent.workspace);
    updateTaskStatus(taskId, 'running');

    emit('run.started', 'run', run.id, {
      task_id: taskId,
      agent_id: agentId,
      attempt,
      runner: FILE_RUNNER_MODE,
      prompt: prompt.substring(0, 500),
    });

    writeFileRunStatus(run.id, { phase: 'starting', started_at: startedAt }, { taskId, agentId });
    startClaudeProcess(run, agent, briefedPrompt);
    return { ok: true, data: run };
  } catch (e) {
    const reason = (e as Error).message || 'Failed to start file runner';
    failFileRun(run.id, agentId, taskId, reason);
    return { ok: false, error: reason, code: 'start_failed' };
  }
}

export function stopFileRunsForAgent(agentId: string, reason = 'File-runner seat stopped'): void {
  for (const [runId, live] of liveRuns) {
    if (live.agentId !== agentId) continue;
    killLiveProcess(live);
    failFileRun(runId, agentId, '', reason, { skipIfFinished: true });
  }
}

export function stopFileRun(runId: string): boolean {
  const live = liveRuns.get(runId);
  if (!live) return false;
  killLiveProcess(live);
  return true;
}

export function hasLiveFileRun(runId: string): boolean {
  return liveRuns.has(runId);
}

export function checkFileRunStale(runId: string, now = testHooks.now ? testHooks.now() : new Date()): boolean {
  const live = liveRuns.get(runId);
  if (!live) return false;
  const status = readFileRunStatus(runId);
  if (!status || (status.phase !== 'starting' && status.phase !== 'running')) {
    return false;
  }
  const staleMs = testHooks.staleMs ?? FILE_RUNNER_STALE_MS;
  const updated = Date.parse(status.updated_at);
  if (!Number.isFinite(updated) || now.getTime() - updated <= staleMs) {
    return false;
  }
  const reason = `Stale file-runner heartbeat (>${Math.round(staleMs / 1000)}s)`;
  killLiveProcess(live);
  failFileRun(runId, live.agentId, '', reason);
  return true;
}

function startClaudeProcess(run: Run, agent: Agent, prompt: string): void {
  if (!agent.workspace) {
    throw new Error('File-runner seat requires a workspace');
  }

  const spawnFn = testHooks.spawn ?? spawn;
  const args = buildClaudePrintArgs({ model: agent.model, prompt });
  const logPath = cliLogPathFor(run.id);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, '', 'utf8');

  const child = spawnFn(testHooks.claudeBin ?? 'claude', args, {
    cwd: agent.workspace,
    env: buildClaudeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Own process group so background children (`npm test &`) stay
    // waitable after `claude -p` exits. Interactive CLI would have
    // stayed open for the same tree.
    detached: true,
  });

  writeFileRunStatus(run.id, {
    phase: 'running',
    pid: child.pid,
    started_at: readFileRunStatus(run.id)?.started_at,
  }, { taskId: run.task_id, agentId: agent.id });

  logger.info(
    { runId: run.id, agentId: agent.id, pid: child.pid, workspace: agent.workspace, model: agent.model },
    'Started Claude file runner',
  );

  attachLogStream(child, logPath, run.id, agent.id, run.task_id);

  const heartbeatMs = testHooks.heartbeatMs ?? FILE_RUNNER_HEARTBEAT_MS;
  const staleMs = testHooks.staleMs ?? FILE_RUNNER_STALE_MS;
  const heartbeat = setInterval(() => heartbeatLiveRun(run.id), heartbeatMs);
  const staleCheck = setInterval(() => checkFileRunStale(run.id), Math.min(heartbeatMs, staleMs));
  const excludeStarted = liveExcludePids(child.pid);
  const worktreePidsAtStart = listWorktreePidsViaHook(agent.workspace)
    .filter((pid) => !excludeStarted.has(pid));

  liveRuns.set(run.id, {
    runId: run.id,
    agentId: agent.id,
    child,
    heartbeat,
    staleCheck,
    logPath,
    workspace: agent.workspace,
    worktreePidsAtStart,
  });

  child.on('error', (err) => {
    failFileRun(run.id, agent.id, run.task_id, `Failed to spawn claude: ${err.message}`);
  });

  child.on('exit', (code, signal) => {
    void onClaudeExit(run, agent, code, signal);
  });
}

function attachLogStream(
  child: ChildProcess,
  logPath: string,
  runId: string,
  agentId: string,
  taskId: string,
): void {
  const onChunk = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    try {
      fs.appendFileSync(logPath, text);
    } catch {
      // Log file may have been removed during cleanup.
    }
    const last = lastNonEmptyLine(text);
    if (!last) return;
    const prev = readFileRunStatus(runId);
    if (!prev || (prev.phase !== 'starting' && prev.phase !== 'running')) return;
    writeFileRunStatus(runId, {
      phase: prev.phase,
      last_line: last,
      pid: prev.pid,
      started_at: prev.started_at,
    }, { taskId, agentId, emitPhase: false });
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
}

function heartbeatLiveRun(runId: string): void {
  const live = liveRuns.get(runId);
  if (!live) return;
  const prev = readFileRunStatus(runId);
  if (!prev || (prev.phase !== 'starting' && prev.phase !== 'running')) return;
  writeFileRunStatus(runId, {
    phase: prev.phase,
    pid: live.child.pid ?? prev.pid,
    last_line: prev.last_line ?? lastLogLine(runId),
    started_at: prev.started_at,
    reason: prev.reason,
  }, { emitPhase: false });
}

async function onClaudeExit(
  run: Run,
  agent: Agent,
  code: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  const resultPath = resultPathForRun(run, agent.workspace);
  const live = liveRuns.get(run.id);
  const waitOpts = leftoverWaitOpts(run, agent, resultPath, live);

  if (!hasParseableFileRunResult(run.id, resultPath)) {
    const leftover = detectLeftoverFileRunWork(waitOpts);
    if (leftover.pids.length > 0 || leftover.inFlight) {
      const prev = readFileRunStatus(run.id);
      if (prev && (prev.phase === 'starting' || prev.phase === 'running')) {
        writeFileRunStatus(run.id, {
          phase: prev.phase,
          reason: FILE_RUNNER_WAITING_FOR_TESTS,
          last_line: prev.last_line,
          pid: prev.pid,
          started_at: prev.started_at,
        }, { taskId: run.task_id, agentId: agent.id, emitPhase: false });
      }
      await waitForLeftoverWork(waitOpts);
    }
  }

  if (!liveRuns.has(run.id)) return;

  stopLiveRun(run.id, true);
  settleFileRunAfterClaude(run, agent, code, signal);
}

function leftoverWaitOpts(
  run: Run,
  agent: Agent,
  resultPath: string,
  live: LiveFileRun | undefined,
): LeftoverWorkWaitOpts {
  return {
    pgid: live?.child.pid ?? null,
    workspace: agent.workspace,
    excludePids: [...liveExcludePids(live?.child.pid)],
    snapshotPids: live?.worktreePidsAtStart ?? [],
    shouldStop: () => !liveRuns.has(run.id) || hasParseableFileRunResult(run.id, resultPath),
    isInFlight: () => hasInFlightWorkSignal(run.id),
  };
}

function hasParseableFileRunResult(runId: string, resultPath: string): boolean {
  return Boolean(readRunResult(resultPath) || parseResultLineFromOutput(readCliLog(runId) ?? ''));
}

function hasInFlightWorkSignal(runId: string): boolean {
  const status = readFileRunStatus(runId);
  if (looksLikeInFlightWork(status?.last_line)) return true;
  return looksLikeInFlightWork(lastLogLine(runId));
}

function settleFileRunAfterClaude(
  run: Run,
  agent: Agent,
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  const resultPath = resultPathForRun(run, agent.workspace);
  const fromFile = readRunResult(resultPath);
  if (fromFile) {
    completeFileRun(
      run,
      agent,
      fromFile.verdict === 'PASS' ? 'done' : 'failed',
      fromFile.reason || (fromFile.verdict === 'PASS' ? 'Completed' : 'Claude wrote RESULT: FAIL'),
    );
    return;
  }

  const fromLog = parseResultLineFromOutput(readCliLog(run.id) ?? '');
  if (fromLog) {
    writeRunResult(
      resultPath,
      fromLog.verdict,
      fromLog.reason || (fromLog.verdict === 'PASS' ? 'Completed' : 'Claude wrote RESULT: FAIL'),
    );
    completeFileRun(
      run,
      agent,
      fromLog.verdict === 'PASS' ? 'done' : 'failed',
      fromLog.reason || (fromLog.verdict === 'PASS' ? 'Completed' : 'Claude wrote RESULT: FAIL'),
    );
    return;
  }

  const reason = signal
    ? `Claude exited on ${signal} without a parseable RESULT`
    : `Claude exited (${code ?? 'unknown'}) without a parseable RESULT`;
  completeFileRun(run, agent, 'incomplete', reason);
}

function completeFileRun(
  run: Run,
  agent: Agent,
  phase: 'done' | 'failed' | 'incomplete',
  reason: string,
): void {
  const resultPath = resultPathForRun(run, agent.workspace);
  const parsed = readRunResult(resultPath);
  const usedPhase: FileRunnerPhase = parsed?.verdict === 'PASS'
    ? 'done'
    : parsed?.verdict === 'FAIL'
      ? 'failed'
      : 'incomplete';
  void phase;
  const usedReason = parsed?.reason || reason;
  writeFileRunStatus(run.id, {
    phase: usedPhase,
    reason: usedReason,
    last_line: lastLogLine(run.id),
    started_at: readFileRunStatus(run.id)?.started_at,
  }, { taskId: run.task_id, agentId: agent.id });

  const exitCode = usedPhase === 'done' ? 0 : 1;
  finishRun(run.id, exitCode);
  emit(usedPhase === 'done' ? 'run.finished' : 'run.failed', 'run', run.id, {
    agent_id: agent.id,
    task_id: run.task_id,
    exit_code: exitCode,
    runner: FILE_RUNNER_MODE,
    result: parsed?.verdict ?? null,
    result_reason: usedReason,
    phase: usedPhase,
  });
  void import('./task-dispatcher.js')
    .then((td) => td.onRunComplete(run.id, agent.id))
    .catch((err) => {
      logger.warn({ runId: run.id, error: (err as Error).message }, 'onRunComplete failed after file run');
    });
}

function failFileRun(
  runId: string,
  agentId: string,
  taskId: string,
  reason: string,
  opts: { skipIfFinished?: boolean } = {},
): void {
  stopLiveRun(runId, true);
  const existing = getRun(runId);
  if (opts.skipIfFinished && existing.ok && existing.data.status !== 'running') {
    return;
  }

  const agent = getAgent(agentId);
  const resultPath = resultPathForRun(
    existing.ok ? existing.data : { id: runId, result_path: null },
    agent.ok ? agent.data.workspace : null,
  );
  settleRunResultFile(resultPath, reason, { forceFail: true });
  writeFileRunStatus(runId, {
    phase: 'failed',
    reason,
    last_line: lastLogLine(runId),
    started_at: readFileRunStatus(runId)?.started_at,
  }, { taskId: taskId || (existing.ok ? existing.data.task_id : undefined), agentId });

  finishRun(runId, 1);
  emit('run.failed', 'run', runId, {
    agent_id: agentId,
    task_id: taskId || (existing.ok ? existing.data.task_id : null),
    exit_code: 1,
    runner: FILE_RUNNER_MODE,
    result: 'FAIL',
    result_reason: reason,
    phase: 'failed',
  });
  import('./task-dispatcher.js').then((td) => td.onRunComplete(runId, agentId)).catch(() => {});
}

function writePromptFile(runId: string, prompt: string): void {
  const promptPath = promptPathFor(runId);
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.writeFileSync(promptPath, prompt.endsWith('\n') ? prompt : `${prompt}\n`, 'utf8');
}

function buildClaudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Use the CLI subscription on PATH. Never inject WaveCode's LLM API key.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function lastLogLine(runId: string): string | undefined {
  const log = readCliLog(runId, 8_000);
  if (!log) return undefined;
  return lastNonEmptyLine(log);
}

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed) return trimmed.slice(0, 240);
  }
  return undefined;
}

const LEFTOVER_COMMS = new Set([
  'node',
  'nodejs',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
  'vitest',
  'jest',
  'mocha',
  'tsx',
  'ts-node',
  'esbuild',
  'vite',
  'playwright',
  'cypress',
  'python',
  'python3',
  'pytest',
  'go',
  'docker',
  'com.docker.cli',
  'docker-compose',
  'compose',
  'postgres',
  'postgresql',
  'psql',
]);

export interface LeftoverFileRunWork {
  pids: number[];
  inFlight: boolean;
}

export interface LeftoverWorkWaitOpts {
  pgid?: number | null;
  workspace?: string | null;
  excludePids?: number[];
  snapshotPids?: number[];
  shouldStop?: () => boolean;
  isInFlight?: () => boolean;
  listGroupPids?: (pgid: number) => number[];
  listWorktree?: (workspace: string) => number[];
  pollMs?: number;
  timeoutMs?: number;
}

const EXACT_RESULT_LINE = /^RESULT: (PASS|FAIL)$/;

/**
 * last_line / cli.log saying a test suite is still running. Frozen after
 * `claude -p` exits, so this is a wait signal, not a completion signal.
 */
export function looksLikeInFlightWork(text: string | null | undefined): boolean {
  if (!text) return false;
  const line = text.trim();
  if (!line || EXACT_RESULT_LINE.test(line)) return false;
  const mentionsWork = /\b(tests?|suite|vitest|jest|mocha|playwright|cypress|integration)\b/i.test(line);
  const mentionsActive = /\b(running|in progress|still running|waiting for|I'll pick up|as soon as)\b/i.test(line);
  return mentionsWork && mentionsActive;
}

export function listProcessGroupPids(pgid: number): number[] {
  if (!Number.isInteger(pgid) || pgid <= 0) return [];
  const fromProc = listProcessGroupFromProc(pgid);
  if (fromProc !== null) return fromProc;
  return listProcessGroupFromPs(pgid);
}

export function listWorktreePids(workspace: string): number[] {
  if (!workspace) return [];
  const fromProc = listWorktreeFromProc(workspace);
  if (fromProc !== null) return fromProc;
  return [];
}

function listProcessGroupFromProc(pgid: number): number[] | null {
  try {
    const entries = fs.readdirSync('/proc');
    const pids: number[] = [];
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const stat = fs.readFileSync(path.join('/proc', name, 'stat'), 'utf8');
        const closeParen = stat.lastIndexOf(')');
        if (closeParen < 0) continue;
        const rest = stat.slice(closeParen + 2).split(' ');
        const pgrp = Number(rest[2]);
        if (pgrp === pgid) pids.push(Number(name));
      } catch {
        // Process vanished between readdir and read.
      }
    }
    return pids;
  } catch {
    return null;
  }
}

function listProcessGroupFromPs(pgid: number): number[] {
  try {
    const out = execFileSync('ps', ['-o', 'pid=', '-g', String(pgid)], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return out
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function listWorktreeFromProc(workspace: string): number[] | null {
  try {
    const realWorkspace = realExistingPath(workspace);
    if (!realWorkspace) return [];
    const entries = fs.readdirSync('/proc');
    const pids: number[] = [];
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number(name);
      if (pid === process.pid) continue;
      try {
        const cwd = fs.readlinkSync(path.join('/proc', name, 'cwd'));
        if (!isPathInside(cwd, realWorkspace)) continue;
        const comm = fs.readFileSync(path.join('/proc', name, 'comm'), 'utf8').trim();
        let cmdline = '';
        try {
          cmdline = fs.readFileSync(path.join('/proc', name, 'cmdline'), 'utf8').replace(/\0/g, ' ');
        } catch {
          // cmdline can vanish between reads.
        }
        if (leftoverCommLooksLikeWork(comm, cmdline)) pids.push(pid);
      } catch {
        // Process vanished or cwd is unreadable.
      }
    }
    return pids;
  } catch {
    return null;
  }
}

function leftoverCommLooksLikeWork(comm: string, cmdline: string): boolean {
  const base = path.basename(comm).replace(/:$/, '').toLowerCase();
  if (LEFTOVER_COMMS.has(base)) return true;
  if (base.startsWith('python')) return true;
  return /\b(vitest|jest|mocha|pytest|playwright|cypress|npm test|docker-compose|postgres)\b/i.test(cmdline);
}

function realExistingPath(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    try {
      return path.resolve(value);
    } catch {
      return null;
    }
  }
}

function isPathInside(cwd: string, workspace: string): boolean {
  const realCwd = realExistingPath(cwd) ?? path.resolve(cwd);
  return realCwd === workspace || realCwd.startsWith(`${workspace}${path.sep}`);
}

function listWorktreePidsViaHook(workspace: string): number[] {
  const list = testHooks.listWorktreePids ?? listWorktreePids;
  return list(workspace);
}

function liveExcludePids(pgid?: number | null): Set<number> {
  const exclude = new Set<number>([process.pid]);
  if (typeof pgid === 'number' && pgid > 0) exclude.add(pgid);
  return exclude;
}

export function detectLeftoverFileRunWork(opts: LeftoverWorkWaitOpts = {}): LeftoverFileRunWork {
  const exclude = new Set(opts.excludePids ?? []);
  const snapshot = new Set(opts.snapshotPids ?? []);
  const listGroup = opts.listGroupPids ?? testHooks.listProcessGroupPids ?? listProcessGroupPids;
  const listWorktree = opts.listWorktree ?? testHooks.listWorktreePids ?? listWorktreePids;
  const pids = new Set<number>();

  if (typeof opts.pgid === 'number' && opts.pgid > 0) {
    for (const pid of listGroup(opts.pgid)) {
      if (!exclude.has(pid)) pids.add(pid);
    }
  }
  if (opts.workspace) {
    for (const pid of listWorktree(opts.workspace)) {
      if (!exclude.has(pid) && !snapshot.has(pid)) pids.add(pid);
    }
  }

  return {
    pids: [...pids],
    inFlight: Boolean(opts.isInFlight?.()),
  };
}

export async function waitForLeftoverWork(opts: LeftoverWorkWaitOpts = {}): Promise<void> {
  const pollMs = opts.pollMs ?? testHooks.processTreePollMs ?? FILE_RUNNER_PROCESS_TREE_POLL_MS;
  const timeoutMs = opts.timeoutMs ?? testHooks.processTreeTimeoutMs ?? FILE_RUNNER_PROCESS_TREE_MS;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (opts.shouldStop?.()) return;
    const leftover = detectLeftoverFileRunWork(opts);
    if (leftover.pids.length === 0 && !leftover.inFlight) return;
    await delay(pollMs);
  }
}

export async function waitForProcessGroup(
  pgid: number,
  opts: {
    excludePids?: number[];
    shouldStop?: () => boolean;
    listPids?: (pgid: number) => number[];
    pollMs?: number;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  await waitForLeftoverWork({
    pgid,
    excludePids: opts.excludePids,
    shouldStop: opts.shouldStop,
    listGroupPids: opts.listPids,
    pollMs: opts.pollMs,
    timeoutMs: opts.timeoutMs,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killLiveProcess(live: LiveFileRun): void {
  try {
    if (live.child.exitCode === null && !live.child.killed) {
      live.child.kill('SIGTERM');
    }
  } catch {
    // Process may already be gone.
  }
}

function stopLiveRun(runId: string, _endLog: boolean): void {
  const live = liveRuns.get(runId);
  if (!live) return;
  clearInterval(live.heartbeat);
  clearInterval(live.staleCheck);
  live.child.stdout?.removeAllListeners('data');
  live.child.stderr?.removeAllListeners('data');
  liveRuns.delete(runId);
}

function isoNow(): string {
  return (testHooks.now ?? (() => new Date()))().toISOString();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
