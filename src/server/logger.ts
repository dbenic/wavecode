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

let rejectionLoggerInstalled = false;

/** Last-resort log so a stray rejection cannot terminate the daemon. */
export function installUnhandledRejectionLogger(): void {
  if (rejectionLoggerInstalled) return;
  rejectionLoggerInstalled = true;
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error({ err: error }, 'Unhandled promise rejection');
  });
}
