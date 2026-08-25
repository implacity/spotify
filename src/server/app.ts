import express, { type NextFunction, type Request, type Response } from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';
import { describeConfig } from '../config.js';
import { ArtistService, ConfigurationError, NotFoundError } from '../service.js';
import { createLogger } from '../util/logger.js';
import type { BuildProgress } from '../spotify/types.js';

const log = createLogger('server');

const here = dirname(fileURLToPath(import.meta.url));
// `dist/server/app.js` and `src/server/app.ts` are both two levels deep.
const PUBLIC_DIR = join(here, '..', '..', 'public');

const SPOTIFY_ID = /^[A-Za-z0-9]{16,32}$/;

/** Fixed-window per-IP limiter — enough to stop one client burning the quota. */
function rateLimiter(perMinute: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (perMinute <= 0) return next();
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(key);

    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + 60_000 });
      // Opportunistic sweep so the map cannot grow without bound.
      if (hits.size > 10_000) {
        for (const [ip, value] of hits) if (value.resetAt <= now) hits.delete(ip);
      }
      return next();
    }

    entry.count += 1;
    if (entry.count > perMinute) {
      res.setHeader('retry-after', Math.ceil((entry.resetAt - now) / 1000));
      res.status(429).json({ error: 'Too many requests. Slow down and try again shortly.' });
      return;
    }
    next();
  };
}

function boolParam(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

export function createApp(config: Config, service = new ArtistService(config)): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const api = express.Router();
  api.use(rateLimiter(config.limits.rateLimitPerMinute));

  api.get('/health', (_req, res) => {
    res.json({ status: 'ok', config: describeConfig(config), service: service.status() });
  });

  api.get('/search', async (req, res, next) => {
    try {
      const query = String(req.query.q ?? '').trim();
      if (!query) {
        res.json({ query: '', artists: [] });
        return;
      }
      const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20) || 20));
      const artists = await service.search(query, limit);
      res.set('cache-control', 'public, max-age=300');
      res.json({ query, artists });
    } catch (error) {
      next(error);
    }
  });

  api.get('/artist/:id', async (req, res, next) => {
    const { id } = req.params;
    if (!SPOTIFY_ID.test(id)) {
      res.status(400).json({ error: 'Invalid artist id.' });
      return;
    }

    const options = {
      includeAppearsOn: boolParam(req.query.appearsOn, true),
      groupDuplicates: boolParam(req.query.group, true),
    };
    const refresh = boolParam(req.query.refresh, false);
    // EventSource sets the Accept header itself; the query flag is a fallback
    // for clients (and proxies) that rewrite it.
    const wantsStream =
      String(req.headers.accept ?? '').includes('text/event-stream') ||
      boolParam(req.query.stream, false);

    try {
      if (!wantsStream) {
        const catalog = await service.getCatalog(id, options, () => {}, refresh);
        res.set('cache-control', 'public, max-age=600');
        res.json(catalog);
        return;
      }

      // Streaming build: a full catalogue can take 10-60s, so report progress
      // instead of leaving the page on a spinner.
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });

      let closed = false;
      req.on('close', () => {
        closed = true;
      });

      const send = (event: string, data: unknown): void => {
        if (closed) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Comment frame defeats proxies that buffer until first bytes.
      res.write(': connected\n\n');
      const heartbeat = setInterval(() => {
        if (!closed) res.write(': ping\n\n');
      }, 15_000);

      try {
        const catalog = await service.getCatalog(
          id,
          options,
          (progress: BuildProgress) => send('progress', progress),
          refresh,
        );
        send('catalog', catalog);
      } catch (error) {
        send('failed', { error: toMessage(error) });
      } finally {
        clearInterval(heartbeat);
        if (!closed) res.end();
      }
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', api);

  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      maxAge: '1h',
      setHeaders: (res, path) => {
        if (path.endsWith('.html')) res.setHeader('cache-control', 'no-cache');
      },
    }),
  );

  // Client-side routes fall through to the SPA shell.
  app.get(/^\/(artist\/.*)?$/, (_req, res) => {
    res.sendFile(join(PUBLIC_DIR, 'index.html'));
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status =
      error instanceof NotFoundError ? 404 : error instanceof ConfigurationError ? 503 : 500;
    if (status === 500) log.error('unhandled error', error);
    res.status(status).json({ error: toMessage(error) });
  });

  return app;
}

function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Unexpected error';
}
