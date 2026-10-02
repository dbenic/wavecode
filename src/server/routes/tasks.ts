import type { Hono } from 'hono';
import {
  getAgent,
  getDb,
  getTaskByNum,
  getRoom,
  resolveAgent,
  insertTask,
  getTask,
  getRun,
  listTasks,
  updateTaskStatus,
  listRuns,
  findGoal,
} from '../db.js';
import { getConfig } from '../config.js';
import { emit } from '../event-bus.js';
import * as taskDispatcher from '../task-dispatcher.js';
import * as validate from '../validate.js';
import { presentFileRun, readCliLog } from '../file-runner.js';
import logger from '../logger.js';
import { getActingUser, type NodeAppEnv } from '../auth.js';
import * as leases from '../leases.js';
import { isTemplateKind, resolveTaskRoom, TEMPLATE_KINDS } from '../rooms.js';

function presentTaskRun(run: { id: string; result_path?: string | null }) {
  return presentFileRun(run);
}

function normalizeDependencyIds(dependsOn?: string[]): string[] {
  if (!dependsOn) return [];
  return [...new Set(dependsOn.map((depId) => depId.trim()).filter(Boolean))];
}

function canRetryTask(status: string): boolean {
  return ['failed', 'done', 'blocked'].includes(status);
}

function canCancelTask(status: string): boolean {
  return ['pending', 'blocked', 'running'].includes(status);
}

export function registerTaskRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/tasks', (c) => {
    const status = c.req.query('status');
    const agentId = c.req.query('agent_id');
    const tasks = listTasks({ status: status || undefined, agent_id: agentId || undefined });

    return c.json(tasks.map((task) => {
      const latest = listRuns({ task_id: task.id })[0];
      const presented = latest ? presentTaskRun(latest) : null;
      return {
        ...task,
        dependencies: taskDispatcher.getDependencies(task.id),
        dependents: taskDispatcher.getDependents(task.id),
        run_phase: presented?.phase ?? null,
        result: presented?.result ?? null,
        result_reason: presented?.result_reason ?? null,
        latest_run: presented,
      };
    }));
  });

  app.get('/api/tasks/:id', (c) => {
    const result = getTask(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 404);

    const task = result.data;
    return c.json({
      ...task,
      dependencies: taskDispatcher.getDependencies(task.id),
      dependents: taskDispatcher.getDependents(task.id),
      runs: listRuns({ task_id: task.id }).map(presentTaskRun),
    });
  });

  app.post('/api/tasks', async (c) => {
    const body = await c.req.json<{
      prompt: string;
      agent_id?: string;
      priority?: number;
      depends_on?: string[];
      goal_id?: string;
      hold?: boolean;
      /** Project room (spec §5e); default: the agent's workspace room, else your default room. */
      room?: string;
      /** Dispatch template: build (default) | review | verify | spec. */
      template?: string;
    }>();

    const taskValidation = validate.validateTaskBody(body);
    if (taskValidation) return c.json({ error: taskValidation }, 400);

    const dependencyIds = normalizeDependencyIds(body.depends_on);

    let resolvedAgentId: string | undefined;
    let resolvedAgent: import('../db.js').Agent | null = null;
    let waitingFor: string | null = null;
    if (body.agent_id) {
      // alias → name → id (spec §5c), same as every agent route.
      // Resolve to the existing seat; never spawn a new one here.
      const agentResult = resolveAgent(body.agent_id);
      if (agentResult.ok) resolvedAgent = agentResult.data;
      if (!agentResult.ok) return c.json({ error: agentResult.error }, 400);
      // Queuing for an agent someone else owns is allowed (spec §6): the
      // dispatcher never runs it there until the lease ends and emits
      // task.waiting_for_agent meanwhile. Tell the caller up front.
      const access = leases.checkAgentAccess(agentResult.data, getActingUser(c));
      if (!access.ok) waitingFor = leases.userName(agentResult.data.owner_id!);
      resolvedAgentId = agentResult.data.id;
    }

    let resolvedGoalId: string | null = null;
    if (body.goal_id?.trim()) {
      const goalResult = findGoal(body.goal_id.trim());
      if (!goalResult.ok) {
        return c.json({ error: `Goal not found: ${body.goal_id}` }, 400);
      }
      resolvedGoalId = goalResult.data.id;
    }

    // `#12` / `12` refer to task numbers (spec §5c); anything else is a task id
    if (body.template !== undefined && !isTemplateKind(body.template)) {
      return c.json({ error: `template must be one of: ${TEMPLATE_KINDS.join(', ')}` }, 400);
    }
    if (body.room !== undefined && (typeof body.room !== 'string' || !getRoom(body.room).ok)) {
      return c.json({ error: `Room not found: ${String(body.room)}` }, 400);
    }
    // Spec §5e: explicit room, else the agent's workspace room, else the creator's default room
    let taskRoom: string | null = body.room ?? null;
    if (!taskRoom) {
      try {
        taskRoom = resolveTaskRoom({ agent: resolvedAgent, creatorId: getActingUser(c).id })?.project ?? null;
      } catch {
        taskRoom = null; // resolved again at dispatch
      }
    }

    for (let i = 0; i < dependencyIds.length; i++) {
      const depRef = dependencyIds[i];
      const num = /^#?(\d+)$/.exec(depRef);
      const dependencyResult = num ? getTaskByNum(Number(num[1])) : getTask(depRef);
      if (!dependencyResult.ok) {
        return c.json({ error: `Dependency task not found: ${depRef}` }, 400);
      }
      dependencyIds[i] = dependencyResult.data.id;
    }

    let task;
    try {
      task = getDb().transaction(() => {
        const result = insertTask({
          prompt: body.prompt,
          agent_id: resolvedAgentId,
          priority: body.priority,
          goal_id: resolvedGoalId,
          ...(taskRoom ? { room: taskRoom } : {}),
          ...(body.template ? { template: body.template } : {}),
        });
        if (!result.ok) {
          throw new Error(result.error);
        }

        for (const depId of dependencyIds) {
          if (!taskDispatcher.addDependency(result.data.id, depId)) {
            throw new Error(`Failed to add dependency: ${depId}`);
          }
        }

        return result.data;
      })();
    } catch (err) {
      return c.json({ error: `Failed to create task: ${(err as Error).message}` }, 500);
    }

    emit('task.created', 'task', task.id, {
      prompt: task.prompt.substring(0, 200),
      agent_id: task.agent_id,
      priority: task.priority,
      goal_id: task.goal_id,
      created_by: task.created_by ?? null,
    });

    logger.info({ taskId: task.id, goalId: task.goal_id }, 'Task created');

    // hold:true skips auto-dispatch. Persist-only goals create no tasks;
    // if auto_dispatch is on and this task is unassigned, an idle agent may pick it up.
    if (getConfig().autonomy.auto_dispatch && body.hold !== true) {
      setTimeout(() => taskDispatcher.dispatchNext(), 500);
    }

    return c.json({
      ...task,
      dependencies: dependencyIds,
      ...(waitingFor ? { waiting_for_agent: { owner: waitingFor } } : {}),
    }, 201);
  });

  app.post('/api/tasks/:id/retry', (c) => {
    const taskId = c.req.param('id');
    const result = getTask(taskId);
    if (!result.ok) return c.json({ error: result.error }, 404);

    if (!canRetryTask(result.data.status)) {
      return c.json({
        error: result.data.status === 'running'
          ? 'Cannot retry a running task'
          : 'Cannot retry a pending task',
      }, 400);
    }

    updateTaskStatus(taskId, 'pending');
    emit('task.retrying', 'task', taskId, {});
    setTimeout(() => taskDispatcher.dispatchNext(), 500);

    return c.json({ ok: true });
  });

  app.put('/api/tasks/:id', async (c) => {
    const taskId = c.req.param('id');
    const result = getTask(taskId);
    if (!result.ok) return c.json({ error: result.error }, 404);

    if (result.data.status === 'running') {
      return c.json({ error: 'Cannot edit a running task' }, 400);
    }

    const body = await c.req.json<{
      prompt?: string;
      agent_id?: string | null;
      priority?: number;
    }>();

    const db = await import('../db.js');
    const updates: string[] = [];
    const params: unknown[] = [];

    if (body.prompt !== undefined && body.prompt.trim()) {
      updates.push('prompt = ?');
      params.push(body.prompt.trim());
    }
    if (body.agent_id !== undefined) {
      updates.push('agent_id = ?');
      params.push(body.agent_id || null);
    }
    if (body.priority !== undefined) {
      updates.push('priority = ?');
      params.push(body.priority);
    }

    if (updates.length === 0) {
      return c.json({ error: 'No fields to update' }, 400);
    }

    params.push(taskId);
    db.getDb().prepare(
      `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`
    ).run(...params);

    emit('task.updated', 'task', taskId, {});
    logger.info({ taskId }, 'Task updated');
    const updated = getTask(taskId);
    return c.json(updated.ok ? updated.data : { error: 'Update failed' });
  });

  app.delete('/api/tasks/:id', (c) => {
    const taskId = c.req.param('id');
    const result = getTask(taskId);
    if (!result.ok) return c.json({ error: result.error }, 404);

    if (!canCancelTask(result.data.status)) {
      return c.json({ error: 'Only pending, blocked, or running tasks can be cancelled' }, 400);
    }

    const openRuns = listRuns({ task_id: taskId, status: 'running' });
    for (const run of openRuns) {
      taskDispatcher.finalizeRun(run.id, run.agent_id, 1, 'Task cancelled');
    }

    updateTaskStatus(taskId, 'failed');
    emit('task.failed', 'task', taskId, { reason: 'cancelled' });
    logger.info({ taskId }, 'Task cancelled');
    return c.json({ ok: true });
  });

  app.get('/api/tasks/:id/runs', (c) => {
    return c.json(listRuns({ task_id: c.req.param('id') }).map(presentTaskRun));
  });

  app.get('/api/runs/:id/log', (c) => {
    const result = getRun(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 404);
    const presented = presentFileRun(result.data, { includeLog: true });
    return c.json({
      run_id: result.data.id,
      path: presented.log_path,
      log: presented.log ?? readCliLog(result.data.id),
    });
  });

  app.get('/api/runs/:id', (c) => {
    const result = getRun(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 404);
    return c.json(presentFileRun(result.data, { includeLog: true }));
  });

  app.post('/api/dispatch', async (c) => {
    await taskDispatcher.dispatchNext({ manual: true });
    return c.json({ ok: true });
  });
}
