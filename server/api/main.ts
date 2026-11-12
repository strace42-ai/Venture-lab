import { loadConfig } from '../config';
import { createPool } from '../db/pool';
import { buildApp } from './app';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = await buildApp({ pool, allowedOrigins: config.allowedOrigins, logger: true });

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ host: config.host, port: config.port });
app.log.info(`Venture Lab local API on http://${config.host}:${config.port} (read-only, local-only)`);
