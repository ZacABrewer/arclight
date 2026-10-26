import { loadConfig } from './config.js';
import { migrateLegacyDbFile, openDatabase } from './db/index.js';
import { buildApp } from './app.js';
import { createLogger } from './logging.js';

const config = loadConfig();
// stdout (pretty in dev) + in-memory ring buffer + rotating logs/arclight.log; see logging.ts.
const { log } = createLogger(config);

const movedDb = migrateLegacyDbFile(config.dbPath);
if (movedDb) log.info({ from: movedDb, to: config.dbPath }, 'renamed pre-Arclight database file');
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
log.info({ config: config.configDir, docker: config.isDocker }, 'Arclight online');
