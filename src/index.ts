import { env } from './core/config/env.js';
import { buildApp } from './app.js';
import { pool } from './core/db/client.js';
import { logger } from './core/logger/logger.js';

const app = buildApp();

const server = app.listen(env.PORT, () => {
  logger.info(`🚀 Server running on http://localhost:${env.PORT} [${env.NODE_ENV}]`);
});

async function shutdown(signal: string): Promise<void> {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(async () => {
    await pool.end();
    logger.info('Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
