import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import logger from './logger.js';
import { createAuthMiddleware, type NodeAppEnv } from './auth.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerCollaborationRoutes } from './routes/collaboration.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerReviewRoutes } from './routes/reviews.js';
import { registerArtifactRoutes } from './routes/artifacts.js';
import { registerPushRoutes } from './routes/push.js';
import { registerDocsRoutes } from './routes/docs.js';
import { registerGuideRoutes } from './routes/guides.js';
import { registerTemplateRoutes } from './routes/templates.js';
import { registerSpecsRoutes } from './routes/specs.js';
import { registerDecisionRoutes } from './routes/decisions.js';
import { registerGoalRoutes } from './routes/goals.js';
import { registerMessageRoutes } from './routes/messages.js';

export function createApp(): Hono<NodeAppEnv> {
  const app = new Hono<NodeAppEnv>();

  app.use('/api/*', cors());

  app.use('/api/*', createAuthMiddleware());

  app.onError((err, c) => {
    if (err.message?.includes('Unexpected') || err.message?.includes('JSON')) {
      return c.json({ error: 'Malformed request body' }, 400);
    }
    logger.error(
      {
        error: err.message,
        code: (err as NodeJS.ErrnoException).code,
        stack: err.stack,
        path: c.req.path,
        method: c.req.method,
      },
      'Unhandled error',
    );
    return c.json({ error: 'Internal server error' }, 500);
  });

  registerSystemRoutes(app);
  registerAgentRoutes(app);
  registerCollaborationRoutes(app);
  registerTaskRoutes(app);
  registerReviewRoutes(app);
  registerArtifactRoutes(app);
  registerPushRoutes(app);
  registerDocsRoutes(app);
  registerGuideRoutes(app);
  registerTemplateRoutes(app);
  registerSpecsRoutes(app);
  registerDecisionRoutes(app);
  registerGoalRoutes(app);
  registerMessageRoutes(app);

  app.use('/*', serveStatic({ root: './src/ui/dist' }));
  app.get('/*', serveStatic({ root: './src/ui/dist', path: 'index.html' }));

  return app;
}

export const app = createApp();
