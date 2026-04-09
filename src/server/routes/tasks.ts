import type { Hono } from 'hono';
import {
  getAgent,
  getDb,
  insertTask,
  getTask,
  listTasks,
  updateTaskStatus,
  listRuns,
} from '../db.js';
import { getConfig } from '../config.js';
import { emit } from '../event-bus.js';
import * as taskDispatcher from '../task-dispatcher.js';
import * as validate from '../validate.js';
import logger from '../logger.js';
import type { NodeAppEnv } from '../auth.js';

function normalizeDependencyIds(dependsOn?: string[]): string[] {
  if (!dependsOn) return [];
  return [...new Set(dependsOn.map((depId) => depId.trim()).filter(Boolean))];
}

function canRetryTask(status: string): boolean {
  return ['failed', 'done', 'blocked'].includes(status);
}

function canCancelTask(status: string): boolean {
  return ['pending', 'blocked'].includes(status);
}

export function registerTaskRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/tasks', (c) => {
    const status = c.req.query('status');
    const agentId = c.req.query('agent_id');
    const tasks = listTasks({ status: status || undefined, agent_id: agentId || undefined });

    return c.json(tasks.map((task) => ({
      ...task,
      dependencies: taskDispatcher.getDependencies(task.id),
      dependents: taskDispatcher.getDependents(task.id),
    })));
  });

  app.get('/api/tasks/:id', (c) => {
    const result = getTask(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 404);

    const task = result.data;
    return c.json({
      ...task,
      dependencies: taskDispatcher.getDependencies(task.id),
      dependents: taskDispatcher.getDependents(task.id),
      runs: listRuns({ task_id: task.id }),
    });
  });

  app.post('/api/tasks', async (c) => {
    const body = await c.req.json<{
      prompt: string;
      agent_id?: string;
      priority?: number;
      depends_on?: string[];
    }>();

    const taskValidation = validate.validateTaskBody(body);
    if (taskValidation) return c.json({ error: taskValidation }, 400);

    const dependencyIds = normalizeDependencyIds(body.depends_on);

    if (body.agent_id) {
      const agentResult = getAgent(body.agent_id);
      if (!agentResult.ok) return c.json({ error: agentResult.error }, 400);
    }

    for (const depId of dependencyIds) {
      const dependencyResult = getTask(depId);
      if (!dependencyResult.ok) {
        return c.json({ error: `Dependency task not found: ${depId}` }, 400);
      }
    }

    let task;
    try {
      task = getDb().transaction(() => {
        const result = insertTask({
          prompt: body.prompt,
          agent_id: body.agent_id,
          priority: body.priority,
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
    });

    logger.info({ taskId: task.id }, 'Task created');

    if (getConfig().autonomy.auto_dispatch) {
      setTimeout(() => taskDispatcher.dispatchNext(), 500);
    }

    return c.json({
      ...task,
      dependencies: dependencyIds,
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
      return c.json({ error: 'Only pending or blocked tasks can be cancelled' }, 400);
    }

    updateTaskStatus(taskId, 'failed');
    emit('task.failed', 'task', taskId, { reason: 'cancelled' });
    logger.info({ taskId }, 'Task cancelled');
    return c.json({ ok: true });
  });

  app.get('/api/tasks/:id/runs', (c) => {
    return c.json(listRuns({ task_id: c.req.param('id') }));
  });

  app.post('/api/dispatch', async (c) => {
    await taskDispatcher.dispatchNext({ manual: true });
    return c.json({ ok: true });
  });
}
