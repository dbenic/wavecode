/**
 * Shared logger instance for the entire server.
 * Uses pino-pretty only in development to avoid production overhead.
 */
import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

const logger = pino(
  isDev
    ? { transport: { target: 'pino-pretty' } }
    : { level: 'info' },
);

export default logger;
