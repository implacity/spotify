import { request } from '../util/http.js';
import { createLogger } from '../util/logger.js';
import { mapWithConcurrency } from '../util/limit.js';

const log = createLogger('persisted-queries');

const WEB_PLAYER_URL = 'https://open.spotify.com/';
const HASH = '[0-9a-f]{64}';
const OPERATION = '[A-Za-z][A-Za-z0-9_]{2,60}';

/**
 * Spotify's pathfinder endpoint only accepts *persisted* queries: you send an
 * operation name plus the sha256 hash of its query document, never the
 * document itself. Those hashes change with every web-player release, so
 * hard-coding them guarantees breakage. Instead we read them from the
 * player's own JS bundles and cache the result.
 *
 * Bundles have used several shapes over the years, so each pattern below
 * targets a different one; whichever matches wins.
 */
const PATTERNS: RegExp[] = [
  // {name:"queryArtistOverview",operationKind:"query",...,value:"<hash>"}
  new RegExp(`name\\s*:\\s*"(${OPERATION})"[^}]{0,200}?"(${HASH})"`, 'g'),
  // {"<hash>","queryArtistOverview"} — hash first
  new RegExp(`"(${HASH})"[^}]{0,200}?name\\s*:\\s*"(${OPERATION})"`, 'g'),
  // sha256Hash:"<hash>" paired with an adjacent operationName
  new RegExp(`operationName\\s*:\\s*"(${OPERATION})"[^}]{0,200}?sha256Hash\\s*:\\s*"(${HASH})"`, 'g'),
  new RegExp(`sha256Hash\\s*:\\s*"(${HASH})"[^}]{0,200}?operationName\\s*:\\s*"(${OPERATION})"`, 'g'),
];

const isHash = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);

/** Pull every `operationName -> sha256Hash` pair out of a JS bundle. */
export function extractPersistedQueries(source: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const [, first, second] = match;
      if (!first || !second) continue;
      const name = isHash(first) ? second : first;
      const hash = isHash(first) ? first : second;
      if (!isHash(hash) || isHash(name)) continue;
      // Earliest match wins: later bundles may redefine unrelated symbols.
      if (!out[name]) out[name] = hash;
    }
  }

  return out;
}

/** Absolute URLs of the JS bundles referenced by the web player's HTML. */
export function extractBundleUrls(html: string): string[] {
  const urls = new Set<string>();
  const patterns = [
    /<script[^>]+src="([^"]+\.js)"/g,
    /<link[^>]+href="([^"]+\.js)"[^>]*>/g,
    /"(https:\/\/open-web-player\.spotifycdn\.com\/[^"]+\.js)"/g,
    /"(https:\/\/open\.spotifycdn\.com\/cdn\/build\/[^"]+\.js)"/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      const href = match[1];
      if (!href) continue;
      try {
        urls.add(new URL(href, WEB_PLAYER_URL).toString());
      } catch {
        // Malformed src attribute; skip it.
      }
    }
  }

  return [...urls];
}

export interface DiscoveryOptions {
  timeoutMs: number;
  concurrency: number;
  /** Stop early once these operations have been resolved. */
  wanted?: string[];
  userAgent: string;
}

/**
 * Fetch the web player and read its bundles for persisted-query hashes.
 * Returns an empty map if the player is unreachable — callers fall back to
 * whatever hashes were configured explicitly.
 */
export async function discoverPersistedQueries(
  options: DiscoveryOptions,
): Promise<Record<string, string>> {
  const headers = { 'user-agent': options.userAgent, accept: 'text/html,application/javascript' };

  const html = await request(WEB_PLAYER_URL, {
    headers,
    timeoutMs: options.timeoutMs,
    retries: 2,
  }).then((response) => response.text());

  const bundles = extractBundleUrls(html);
  // Logged at info: when discovery fails this is the first thing worth
  // knowing, and asking for a log-level change first wastes a round trip.
  log.info(`web player returned ${html.length} bytes, ${bundles.length} script bundles`);

  // The player's own HTML sometimes inlines the manifest.
  const discovered: Record<string, string> = extractPersistedQueries(html);

  // Bundles that mention these tokens are the ones carrying the query manifest.
  const ranked = bundles.sort((a, b) => {
    const score = (url: string): number =>
      /(xpui|vendor~|web-player|pathfinder|graphql)/i.test(url) ? 0 : 1;
    return score(a) - score(b);
  });

  await mapWithConcurrency(ranked.slice(0, 40), options.concurrency, async (url) => {
    const wanted = options.wanted ?? [];
    if (wanted.length > 0 && wanted.every((name) => discovered[name])) return;
    try {
      const source = await request(url, { headers, timeoutMs: options.timeoutMs, retries: 1 }).then(
        (response) => response.text(),
      );
      for (const [name, hash] of Object.entries(extractPersistedQueries(source))) {
        if (!discovered[name]) discovered[name] = hash;
      }
    } catch (error) {
      log.debug(`bundle unreadable: ${url}`, (error as Error).message);
    }
  });

  const names = Object.keys(discovered);
  log.info(`discovered ${names.length} persisted queries`);
  if (names.length === 0) {
    log.warn(
      'no persisted queries found in the web player. Pin them by hand with ' +
        'SPOTIFY_PQ_<OPERATION>=<sha256> — see the README.',
    );
  } else {
    log.debug(`operations: ${names.slice(0, 40).join(', ')}`);
  }
  return discovered;
}
