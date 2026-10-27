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
import { registerDeliveryRoutes } from './routes/deliveries.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerUserRoutes } from './routes/users.js';
import { registerThreadRoutes } from './routes/thread.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerSeatRoutes } from './routes/seat.js';
import { registerRoomRoutes } from './routes/rooms.js';
import { registerFileRoutes } from './routes/files.js';
import { registerPeerRoutes } from './routes/peers.js';
import { registerReleaseRoutes } from './routes/releases.js';
import { registerLaneRoutes } from './routes/lanes.js';
import { registerOverviewRoutes } from './routes/overview.js';
import { registerDeskRoutes } from './routes/desk.js';
import { registerDiagramRoutes } from './routes/diagrams.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerTestPortalRoutes } from './routes/test-portal.js';
import { registerGateStatusRoutes } from './routes/gate-status.js';
import { registerQueueRoutes } from './routes/queue.js';
import { registerOpsLaneRoutes } from './routes/ops-lanes.js';
import { registerOpsJobRoutes } from './routes/ops-jobs.js';
import { registerMcpHttpRoutes } from '../mcp/http.js';
import './lane-pipeline.js';

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
  registerDeliveryRoutes(app);
  registerMessageRoutes(app);
  registerHealthRoutes(app);
  registerTestPortalRoutes(app);
  registerGateStatusRoutes(app);
  registerQueueRoutes(app);
  registerOpsLaneRoutes(app);
  registerOpsJobRoutes(app);
  registerUserRoutes(app);
  registerThreadRoutes(app);
  registerProfileRoutes(app);
  registerSeatRoutes(app);
  registerRoomRoutes(app);
  registerFileRoutes(app);
  registerPeerRoutes(app);
  registerReleaseRoutes(app);
  registerLaneRoutes(app);
  registerOverviewRoutes(app);
  registerDeskRoutes(app);
  registerDiagramRoutes(app);
  registerMcpHttpRoutes(app);

  // Static files and the index fallback never await tmux, git, or the watcher.
  // They are registered after /api and are not behind the API auth middleware.
  app.use('/*', serveStatic({ root: './src/ui/dist' }));
  app.get('/*', serveStatic({ root: './src/ui/dist', path: 'index.html' }));

  return app;
}

export const app = createApp();
