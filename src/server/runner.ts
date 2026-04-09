import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { finishRun, insertRun, updateTaskStatus, getAgent, type Run } from './db.js';
import { emit } from './event-bus.js';
import { getConfig } from './config.js';
import { getTranscriptsRoot } from './runtime-launcher.js';
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

export async function executeRun(
  agentId: string,
  taskId: string,
  prompt: string,
): Promise<Run | null> {
  const instance = runners.get(agentId);
  const agentResult = getAgent(agentId);
  if (!instance || !agentResult.ok) return null;

  const agent = agentResult.data;
  const config = getConfig();
  const runtimeConfig = config.runtimes[agent.runtime];
  if (!runtimeConfig) return null;

  // Count existing runs for this task to determine attempt number
  const { listRuns } = await import('./db.js');
  const existingRuns = listRuns({ task_id: taskId });
  const attempt = existingRuns.length + 1;

  // Create run record
  const runResult = insertRun({ task_id: taskId, agent_id: agentId, attempt });
  if (!runResult.ok) return null;

  const run = runResult.data;
  instance.currentRunId = run.id;

  // Set up transcript
  const transcriptDir = getTranscriptDir();
  const transcriptPath = path.join(transcriptDir, `run_${run.id}.log`);
  instance.transcriptStream = fs.createWriteStream(transcriptPath, { flags: 'a' });

  // Update task status
  updateTaskStatus(taskId, 'running');

  // Emit run.started event
  emit('run.started', 'run', run.id, {
    task_id: taskId,
    agent_id: agentId,
    attempt,
    prompt: prompt.substring(0, 500),
  });

  // Build the command that will run inside tmux and emit events
  // The runner script sends ndjson events to our Unix socket
  const runnerScript = buildRunnerScript(
    runtimeConfig.command,
    prompt,
    instance.socketPath,
    run.id,
    taskId,
    agentId,
  );

  // Send the runner script to the tmux session
  try {
    tmux.sendTextAndEnter(agent.tmux_session, runnerScript);
  } catch (e) {
    // Failed to send to tmux
    finishRun(run.id, 1);
    updateTaskStatus(taskId, 'failed');
    emit('run.failed', 'run', run.id, {
      error: (e as Error).message,
    });
    return null;
  }

  // Start heartbeat monitoring
  instance.heartbeatTimer = setInterval(() => {
    emit('heartbeat', 'run', run.id, {
      agent_id: agentId,
      timestamp: new Date().toISOString(),
    });
  }, 30000);

  return run;
}

function buildRunnerScript(
  command: string,
  prompt: string,
  socketPath: string,
  runId: string,
  taskId: string,
  agentId: string,
): string {
  // Escape the prompt for shell embedding
  const escapedPrompt = prompt.replace(/'/g, "'\\''");

  // Build a shell one-liner that:
  // 1. Sends run.started event
  // 2. Pipes prompt to the CLI command
  // 3. Captures exit code
  // 4. Sends run.finished or run.failed event
  return [
    `echo '{"type":"run.started","run_id":"${runId}","task_id":"${taskId}","agent_id":"${agentId}"}' | nc -U '${socketPath}' 2>/dev/null;`,
    `echo '${escapedPrompt}' | ${command};`,
    `_EC=$?;`,
    `if [ $_EC -eq 0 ]; then`,
    `  echo '{"type":"run.finished","run_id":"${runId}","exit_code":0}' | nc -U '${socketPath}' 2>/dev/null;`,
    `else`,
    `  echo '{"type":"run.failed","run_id":"${runId}","exit_code":'$_EC'}' | nc -U '${socketPath}' 2>/dev/null;`,
    `fi`,
  ].join(' ');
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
      const exitCode = (event.exit_code as number) ?? 0;
      finishRun(runId, exitCode);
      // Persist changed files list on the run record
      if (event.changed_files && Array.isArray(event.changed_files)) {
        import('./db.js').then(({ updateRunChangedFiles }) => {
          updateRunChangedFiles(runId, event.changed_files as string[]);
        }).catch(() => { /* best-effort */ });
      }
      import('./task-dispatcher.js').then((td) => td.onRunComplete(runId, agentId));
      if (instance.heartbeatTimer) {
        clearInterval(instance.heartbeatTimer);
        instance.heartbeatTimer = null;
      }
      if (instance.transcriptStream) {
        instance.transcriptStream.end();
        instance.transcriptStream = null;
      }
      instance.currentRunId = null;

      emit('run.finished', 'run', runId, {
        agent_id: agentId,
        exit_code: exitCode,
        changed_files: event.changed_files ?? [],
      });
      break;
    }

    case 'run.failed': {
      const exitCode = (event.exit_code as number) ?? 1;
      finishRun(runId, exitCode);
      import('./task-dispatcher.js').then((td) => td.onRunComplete(runId, agentId));
      if (instance.heartbeatTimer) {
        clearInterval(instance.heartbeatTimer);
        instance.heartbeatTimer = null;
      }
      if (instance.transcriptStream) {
        instance.transcriptStream.end();
        instance.transcriptStream = null;
      }
      instance.currentRunId = null;

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
