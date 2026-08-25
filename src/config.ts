export interface Config {
  port: number;
  host: string;
  /** Serve deterministic fixture data instead of calling Spotify. */
  mock: boolean;
  official: {
    clientId: string;
    clientSecret: string;
    /** ISO 3166-1 alpha-2 market used for catalogue + track relinking. */
    market: string;
  };
  partner: {
    /** Master switch for the undocumented play-count source. */
    enabled: boolean;
    /** Paste a `Bearer` token straight from the web player (highest priority). */
    token: string;
    /** `sp_dc` cookie from a logged-in open.spotify.com session. */
    spDc: string;
    /** Base32 TOTP secret used to sign token requests, if Spotify demands one. */
    totpSecret: string;
    totpVersion: string;
    /** Manual overrides for persisted-query hashes, e.g. `{ queryArtistOverview: "ab12..." }`. */
    persistedQueries: Record<string, string>;
  };
  cache: {
    /** Seconds a fully-built artist catalogue stays fresh. */
    artistTtl: number;
    /** Seconds a search result stays fresh. */
    searchTtl: number;
    maxEntries: number;
    /** Directory for the on-disk cache tier; empty disables it. */
    dir: string;
  };
  limits: {
    /** Parallel upstream requests per catalogue build. */
    concurrency: number;
    /** Hard ceiling on releases inspected for one artist. */
    maxReleases: number;
    requestTimeoutMs: number;
    /** Requests per minute per IP against this server's API. */
    rateLimitPerMinute: number;
  };
}

type Env = NodeJS.ProcessEnv;

function str(env: Env, name: string, fallback = ''): string {
  const raw = env[name];
  return raw === undefined || raw === '' ? fallback : raw.trim();
}

function num(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * Persisted-query hashes can be supplied per-operation as
 * `SPOTIFY_PQ_QUERYARTISTOVERVIEW=<sha256>`, which survives Spotify rotating
 * them without needing a code change.
 */
function persistedQueriesFromEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('SPOTIFY_PQ_') || !value) continue;
    out[key.slice('SPOTIFY_PQ_'.length).toLowerCase()] = value.trim();
  }
  return out;
}

export function loadConfig(env: Env = process.env): Config {
  const mock = bool(env, 'MOCK', false);
  return {
    port: num(env, 'PORT', 3000),
    host: str(env, 'HOST', '0.0.0.0'),
    mock,
    official: {
      clientId: str(env, 'SPOTIFY_CLIENT_ID'),
      clientSecret: str(env, 'SPOTIFY_CLIENT_SECRET'),
      market: str(env, 'SPOTIFY_MARKET', 'US').toUpperCase(),
    },
    partner: {
      enabled: bool(env, 'SPOTIFY_PARTNER_ENABLED', true),
      token: str(env, 'SPOTIFY_PARTNER_TOKEN'),
      spDc: str(env, 'SPOTIFY_SP_DC'),
      totpSecret: str(env, 'SPOTIFY_TOTP_SECRET'),
      totpVersion: str(env, 'SPOTIFY_TOTP_VERSION', '5'),
      persistedQueries: persistedQueriesFromEnv(env),
    },
    cache: {
      artistTtl: num(env, 'CACHE_ARTIST_TTL', 60 * 60 * 6),
      searchTtl: num(env, 'CACHE_SEARCH_TTL', 60 * 30),
      // Entries are whole catalogues — megabytes each for a large artist — so
      // this is deliberately modest. The disk tier is the durable one.
      maxEntries: num(env, 'CACHE_MAX_ENTRIES', 64),
      dir: str(env, 'CACHE_DIR', '.cache'),
    },
    limits: {
      concurrency: num(env, 'SPOTIFY_CONCURRENCY', 6),
      maxReleases: num(env, 'SPOTIFY_MAX_RELEASES', 400),
      requestTimeoutMs: num(env, 'SPOTIFY_TIMEOUT_MS', 20_000),
      rateLimitPerMinute: num(env, 'RATE_LIMIT_PER_MINUTE', 120),
    },
  };
}

export function describeConfig(config: Config): Record<string, unknown> {
  return {
    mock: config.mock,
    market: config.official.market,
    officialCredentials: Boolean(config.official.clientId && config.official.clientSecret),
    partnerEnabled: config.partner.enabled,
    partnerAuth: config.partner.token
      ? 'explicit-token'
      : config.partner.spDc
        ? 'sp_dc-cookie'
        : 'anonymous',
    totpConfigured: Boolean(config.partner.totpSecret),
    persistedQueryOverrides: Object.keys(config.partner.persistedQueries),
  };
}
