/**
 * CLI task creation. The daemon owns runners, sockets, and SSE — this
 * module POSTs `/api/tasks` (same as MCP `create_task`) and never calls
 * `dispatchNext()` / `executeRun()` in-process.
 *
 * If the daemon is unreachable, the task is inserted locally as pending
 * and the operator is told a run starts only after the daemon + dispatch.
 */

import { WaveCodeApiError, WaveCodeClient } from '../mcp/client.js';
import { insertTask } from '../server/db.js';
import { addDependency } from '../server/task-dispatcher.js';
import { resolveDaemonConnection } from './daemon-connection.js';

export { resolveDaemonConnection };

export const DAEMON_DOWN_HINT =
  'Daemon is not reachable. Task saved locally as pending. A run starts only after the daemon is up and POST /api/dispatch (or auto_dispatch) picks it up.';

export interface QueueTaskInput {
  prompt: string;
  agentId?: string;
  priority?: number;
  dependsOn?: string[];
}

export interface QueuedTask {
  id: string;
  prompt: string;
  agent_id: string | null;
  priority: number;
  status: string;
  dependencies?: string[];
  via: 'http' | 'local-insert';
}

export type QueueTaskResult =
  | { ok: true; data: QueuedTask; hint?: string }
  | { ok: false; error: string };

export interface QueueTaskDeps {
  fetchImpl?: typeof fetch;
  insertTaskFn?: typeof insertTask;
  addDependencyFn?: typeof addDependency;
  resolveConnection?: () => { url: string; token: string | null };
}

export async function queueTask(
  input: QueueTaskInput,
  deps: QueueTaskDeps = {},
): Promise<QueueTaskResult> {
  const insert = deps.insertTaskFn ?? insertTask;
  const addDep = deps.addDependencyFn ?? addDependency;
  const conn = (deps.resolveConnection ?? resolveDaemonConnection)();

  const body = {
    prompt: input.prompt,
    agent_id: input.agentId,
    priority: input.priority,
    depends_on: input.dependsOn,
  };

  try {
    const client = new WaveCodeClient({
      baseUrl: conn.url,
      token: conn.token,
      fetchImpl: deps.fetchImpl,
    });
    const created = await client.post<{
      id: string;
      prompt: string;
      agent_id: string | null;
      priority: number;
      status: string;
      dependencies?: string[];
    }>('/tasks', body);

    return {
      ok: true,
      data: {
        id: created.id,
        prompt: created.prompt,
        agent_id: created.agent_id,
        priority: created.priority,
        status: created.status,
        dependencies: created.dependencies,
        via: 'http',
      },
    };
  } catch (err) {
    if (err instanceof WaveCodeApiError) {
      return { ok: false, error: err.message };
    }

    const local = insert({
      prompt: input.prompt,
      agent_id: input.agentId,
      priority: input.priority,
    });
    if (!local.ok) return local;

    if (input.dependsOn) {
      for (const depId of input.dependsOn) {
        addDep(local.data.id, depId);
      }
    }

    return {
      ok: true,
      data: {
        id: local.data.id,
        prompt: local.data.prompt,
        agent_id: local.data.agent_id,
        priority: local.data.priority,
        status: local.data.status,
        via: 'local-insert',
      },
      hint: DAEMON_DOWN_HINT,
    };
  }
}
