import { getRequestListener } from '@hono/node-server';
import { createServer } from 'node:http';
import { initDb } from './db.js';
import { loadConfig, getConfig } from './config.js';
import logger from './logger.js';
import { app } from './app.js';
import { bootstrapApplication, shutdownApplication } from './bootstrap.js';
import type { NodeAppEnv } from './auth.js';

loadConfig();
initDb();

const config = getConfig();
const bootstrapResult = await bootstrapApplication();

logger.info(
  {
    port: config.server.port,
    agents: bootstrapResult.agentCount,
    startupReconciliation: bootstrapResult.startupReconciliation,
  },
  'WaveCode server starting',
);

const server = createServer(
  getRequestListener((request, bindings) => app.fetch(request, bindings as NodeAppEnv['Bindings']), {
    hostname: config.server.host,
  }),
);

server.listen(config.server.port, config.server.host);

logger.info(`WaveCode running at http://${config.server.host}:${config.server.port}`);

function shutdown(): void {
  logger.info('Shutting down...');
  shutdownApplication();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
