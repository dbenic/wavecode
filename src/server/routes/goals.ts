import type { Hono } from 'hono';
import type { NodeAppEnv } from '../auth.js';
import { getGoalWithRollup, listGoalsWithRollup, listTasks } from '../db.js';
import { decomposeGoal, previewGoalPlan } from '../goal-orchestrator.js';
import { getDependencies, getDependents } from '../task-dispatcher.js';
import logger from '../logger.js';

export function registerGoalRoutes(app: Hono<NodeAppEnv>): void {
  app.get('/api/goals', (c) => {
    return c.json(listGoalsWithRollup());
  });

  app.get('/api/goals/:id', (c) => {
    const result = getGoalWithRollup(c.req.param('id'));
    if (!result.ok) return c.json({ error: result.error }, 404);

    const tasks = listTasks({ goal_id: result.data.id }).map((task) => ({
      ...task,
      dependencies: getDependencies(task.id),
      dependents: getDependents(task.id),
    }));

    return c.json({
      ...result.data,
      tasks,
    });
  });

  // Preview goal decomposition without creating tasks
  app.post('/api/goals/preview', async (c) => {
    const body = await c.req.json<{ goal?: string }>();

    if (!body.goal || typeof body.goal !== 'string' || body.goal.trim().length === 0) {
      return c.json({ error: 'Missing or empty "goal" field' }, 400);
    }

    const result = await previewGoalPlan(body.goal.trim());
    if (!result.ok) {
      logger.warn({ error: result.error }, 'Goal preview failed');
      return c.json({ error: result.error }, 500);
    }

    return c.json({ tasks: result.data.tasks });
  });

  // Persist a goal, decompose it, and create child tasks
  app.post('/api/goals', async (c) => {
    const body = await c.req.json<{
      goal?: string;
      title?: string;
      workspace?: string;
      external_id?: string;
    }>();

    if (!body.goal || typeof body.goal !== 'string' || body.goal.trim().length === 0) {
      return c.json({ error: 'Missing or empty "goal" field' }, 400);
    }

    const result = await decomposeGoal(body.goal.trim(), {
      title: typeof body.title === 'string' ? body.title : undefined,
      workspace: typeof body.workspace === 'string' ? body.workspace.trim() || null : undefined,
      external_id: typeof body.external_id === 'string' ? body.external_id.trim() || null : undefined,
    });
    if (!result.ok) {
      logger.warn({ error: result.error }, 'Goal decomposition failed');
      return c.json({ error: result.error }, 500);
    }

    return c.json(result.data, 201);
  });
}
