import { loadConfig } from './config.js';
import { openDatabase } from './db/index.js';
import { buildApp } from './app.js';
import { createLogger } from './logging.js';

const config = loadConfig();
// stdout (pretty in dev) + in-memory ring buffer + rotating logs/media-tron.log; see logging.ts.
const { log } = createLogger(config);

const db = openDatabase(config.dbPath);
const app = await buildApp(config, db, log);

const shutdown = async (signal: string) => {
  log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
log.info({ config: config.configDir, docker: config.isDocker }, 'Media-Tron online');
