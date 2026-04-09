import type { Hono } from 'hono';
import type { NodeAppEnv } from '../auth.js';
import { decomposeGoal, previewGoalPlan } from '../goal-orchestrator.js';
import logger from '../logger.js';

export function registerGoalRoutes(app: Hono<NodeAppEnv>): void {
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

  // Decompose goal and create all tasks
  app.post('/api/goals', async (c) => {
    const body = await c.req.json<{ goal?: string }>();

    if (!body.goal || typeof body.goal !== 'string' || body.goal.trim().length === 0) {
      return c.json({ error: 'Missing or empty "goal" field' }, 400);
    }

    const result = await decomposeGoal(body.goal.trim());
    if (!result.ok) {
      logger.warn({ error: result.error }, 'Goal decomposition failed');
      return c.json({ error: result.error }, 500);
    }

    return c.json(result.data, 201);
  });
}
