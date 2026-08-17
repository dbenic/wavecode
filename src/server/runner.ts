import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { finishRun, insertRun, updateTaskStatus, getAgent, getRun, listOpenRuns, type Run, type Result } from './db.js';
import { emit } from './event-bus.js';
import { getTranscriptsRoot } from './runtime-launcher.js';
import {
  appendRunResultBriefing,
  exitCodeForVerdict,
  resultPathForRun,
  settleRunResultFile,
} from './run-result.js';
import * as tmux from './tmux.js';

interface RunnerInstance {
  socketPath: string;
  server: net.Server;
  agentId: string;
  currentRunId: string | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  transcriptStream: fs.WriteStream | null;
}

const runners = new Map<string, RunnerInstance>();

function getTranscriptDir(): string {
  const dir = getTranscriptsRoot();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function startRunner(
  agentId: string,
  tmuxSession: string,
  runtime: string,
): RunnerInstance {
  if (runners.has(agentId)) {
    return runners.get(agentId)!;
  }

  const socketPath = `/tmp/wavecode-runner-${agentId}.sock`;

  // Clean up stale socket
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  const server = net.createServer((connection) => {
    let buffer = '';
    connection.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) handleRunnerEvent(agentId, line.trim());
      }
    });
  });

  server.listen(socketPath);

  const instance: RunnerInstance = {
    socketPath,
    server,
    agentId,
    currentRunId: null,
    heartbeatTimer: null,
    transcriptStream: null,
  };

  runners.set(agentId, instance);
  return instance;
}

export function stopRunner(agentId: string): void {
  const instance = runners.get(agentId);
  if (!instance) return;

  if (instance.heartbeatTimer) clearInterval(instance.heartbeatTimer);
  if (instance.transcriptStream) instance.transcriptStream.end();
  instance.server.close();

  if (fs.existsSync(instance.socketPath)) {
    fs.unlinkSync(instance.socketPath);
  }

  runners.delete(agentId);
}

export function getRunner(agentId: string): RunnerInstance | undefined {
  return runners.get(agentId);
}

/**
 * Drop in-memory runner state for the current run (heartbeat + transcript).
 * When `runId` is passed, only clear if it is the in-memory current run —
 * an older finished run must not wipe a later task's currentRunId.
 */
export function clearRunnerRun(agentId: string, runId?: string): void {
  const instance = runners.get(agentId);
  if (!instance) return;
  if (runId != null && instance.currentRunId != null && instance.currentRunId !== runId) {
    return;
  }
  cleanupRunnerInstance(instance);
}

function cleanupRunnerInstance(instance: RunnerInstance): void {
  if (instance.heartbeatTimer) {
    clearInterval(instance.heartbeatTimer);
    instance.heartbeatTimer = null;
  }
  if (instance.transcriptStream) {
    instance.transcriptStream.end();
    instance.transcriptStream = null;
  }
  instance.currentRunId = null;
}

export type ExecuteRunFailure = Result<Run> & { code: 'busy' | 'unavailable' | 'send_failed' };
export type ExecuteRunResult = { ok: true; data: Run } | ExecuteRunFailure;

/**
 * Start a run on a spawned seat. Interactive TUIs (Grok/Claude/Codex/Aider)
 * get the prompt via send-keys — never an echo|nc shell script. Close is
 * stable-idle via the output watcher, same as adopted.
 * Refuses if the agent already has a run with finished_at null.
 */
export async function executeRun(
  agentId: string,
  taskId: string,
  prompt: string,
): Promise<ExecuteRunResult> {
  const agentResult = getAgent(agentId);
  if (!agentResult.ok) {
    return { ok: false, error: agentResult.error, code: 'unavailable' };
  }

  const open = listOpenRuns(agentId);
  if (open.length > 0) {
    return {
      ok: false,
      error: `Agent already has an open run (${open[0].id})`,
      code: 'busy',
    };
  }

  const agent = agentResult.data;
  const instance = runners.get(agentId);

  const { listRuns } = await import('./db.js');
  const existingRuns = listRuns({ task_id: taskId });
  const attempt = existingRuns.length + 1;

  const runResult = insertRun({ task_id: taskId, agent_id: agentId, attempt });
  if (!runResult.ok) {
    return { ok: false, error: runResult.error, code: 'unavailable' };
  }

  const run = runResult.data;
  if (instance) {
    instance.currentRunId = run.id;
    const transcriptDir = getTranscriptDir();
    const transcriptPath = path.join(transcriptDir, `run_${run.id}.log`);
    instance.transcriptStream = fs.createWriteStream(transcriptPath, { flags: 'a' });
  }

  updateTaskStatus(taskId, 'running');

  emit('run.started', 'run', run.id, {
    task_id: taskId,
    agent_id: agentId,
    attempt,
    prompt: prompt.substring(0, 500),
  });

  const briefedPrompt = run.result_path
    ? appendRunResultBriefing(prompt, run.result_path)
    : prompt;

  try {
    tmux.sendTextAndEnter(agent.tmux_session, briefedPrompt);
  } catch (e) {
    const { finalizeRun } = await import('./task-dispatcher.js');
    finalizeRun(run.id, agentId, 1, 'Failed to send prompt to agent');
    emit('run.failed', 'run', run.id, {
      error: (e as Error).message,
    });
    return { ok: false, error: (e as Error).message, code: 'send_failed' };
  }

  if (instance) {
    instance.heartbeatTimer = setInterval(() => {
      emit('heartbeat', 'run', run.id, {
        agent_id: agentId,
        timestamp: new Date().toISOString(),
      });
    }, 30000);
  }

  return { ok: true, data: run };
}

function handleRunnerEvent(agentId: string, line: string): void {
  const instance = runners.get(agentId);
  if (!instance) return;

  // Write to transcript
  if (instance.transcriptStream) {
    instance.transcriptStream.write(`[${new Date().toISOString()}] ${line}\n`);
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line);
  } catch {
    return; // Not valid JSON, skip
  }

  const type = event.type as string;
  const runId = (event.run_id as string) ?? instance.currentRunId;

  // Guard: skip events without a valid runId to prevent null dereference
  if (!runId) return;

  switch (type) {
    case 'run.started':
      emit('run.started', 'run', runId, {
        agent_id: agentId,
        task_id: event.task_id,
      });
      break;

    case 'heartbeat':
      emit('heartbeat', 'run', runId, {
        agent_id: agentId,
        last_output_line: event.last_output_line,
      });
      break;

    case 'run.finished': {
      const existing = getRun(runId);
      if (existing.ok && existing.data.status !== 'running') {
        if (instance.currentRunId === runId) cleanupRunnerInstance(instance);
        break;
      }
      const requested = (event.exit_code as number) ?? 0;
      const agent = getAgent(agentId);
      const resultPath = resultPathForRun(
        existing.ok ? existing.data : { id: runId, result_path: null },
        agent.ok ? agent.data.workspace : null,
      );
      const settled = settleRunResultFile(
        resultPath,
        requested === 0
          ? 'Runner finished without a parseable RESULT file'
          : 'Runner reported failure without a parseable RESULT file',
        { forceFail: requested !== 0 },
      );
      const exitCode = requested !== 0 ? 1 : exitCodeForVerdict(settled.verdict);
      finishRun(runId, exitCode);
      // Persist changed files list on the run record
      if (event.changed_files && Array.isArray(event.changed_files)) {
        import('./db.js').then(({ updateRunChangedFiles }) => {
          updateRunChangedFiles(runId, event.changed_files as string[]);
        }).catch(() => { /* best-effort */ });
      }
      import('./task-dispatcher.js').then((td) => td.onRunComplete(runId, agentId));
      if (instance.currentRunId === runId) cleanupRunnerInstance(instance);

      emit('run.finished', 'run', runId, {
        agent_id: agentId,
        exit_code: exitCode,
        changed_files: event.changed_files ?? [],
      });
      break;
    }

    case 'run.failed': {
      const existing = getRun(runId);
      if (existing.ok && existing.data.status !== 'running') {
        if (instance.currentRunId === runId) cleanupRunnerInstance(instance);
        break;
      }
      const agent = getAgent(agentId);
      const resultPath = resultPathForRun(
        existing.ok ? existing.data : { id: runId, result_path: null },
        agent.ok ? agent.data.workspace : null,
      );
      settleRunResultFile(resultPath, String(event.error_message ?? event.error ?? 'Runner reported run.failed'), {
        forceFail: true,
      });
      const exitCode = (event.exit_code as number) ?? 1;
      finishRun(runId, exitCode === 0 ? 1 : exitCode);
      import('./task-dispatcher.js').then((td) => td.onRunComplete(runId, agentId));
      if (instance.currentRunId === runId) cleanupRunnerInstance(instance);

      emit('run.failed', 'run', runId, {
        agent_id: agentId,
        exit_code: exitCode,
        error: event.error_message ?? event.error,
      });
      break;
    }

    case 'artifact.created':
      emit('artifact.created', 'artifact', event.artifact_id as string, {
        filename: event.filename,
        run_id: runId,
        agent_id: agentId,
      });
      break;
  }
}
