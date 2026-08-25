import { readFileSync } from 'node:fs';
import { createApp } from './server/app.js';
import { describeConfig, loadConfig } from './config.js';
import { createLogger } from './util/logger.js';

const log = createLogger('boot');

/**
 * Minimal .env reader. Node's own --env-file works, but loading it here means
 * `npm start` behaves the same on every Node version and on hosts that set
 * the command line for you.
 */
function loadEnvFile(path = '.env'): void {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return;
  }

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment variables win over the file.
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const config = loadConfig();
const app = createApp(config);

const server = app.listen(config.port, config.host, () => {
  log.info(`listening on http://${config.host}:${config.port}`);
  log.info('configuration', describeConfig(config));
  if (config.mock) log.warn('MOCK=1 — serving generated sample data, not live Spotify data');
  else if (!config.official.clientId) {
    log.warn('no Spotify credentials found; set SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET or MOCK=1');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    log.info(`${signal} received, shutting down`);
    server.close(() => process.exit(0));
    // Don't let a hung keep-alive connection block the exit.
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
