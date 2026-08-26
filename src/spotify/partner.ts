import type { Config } from '../config.js';
import { HttpError, request, requestJson } from '../util/http.js';
import { createLogger } from '../util/logger.js';
import { mapWithConcurrency } from '../util/limit.js';
import { discoverPersistedQueries } from './persistedQueries.js';
import { generateTotp } from './totp.js';
import {
  extractAlbums,
  extractArtists,
  extractTracks,
  type PartnerAlbum,
  type PartnerArtist,
  type PartnerTrack,
} from './partnerEntities.js';

const log = createLogger('partner');

const PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v1/query';
const TOKEN_URL = 'https://open.spotify.com/api/token';
const LEGACY_TOKEN_URL = 'https://open.spotify.com/get_access_token';
const WEB_PLAYER_URL = 'https://open.spotify.com/';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/122.0.0.0 Safari/537.36';

/**
 * Operations we need, each with fallback spellings.
 *
 * Spotify renames these between player releases (`searchDesktop` became
 * `searchArtists`, discography queries have several variants), so each entry
 * is a candidate list: the first name with a resolvable persisted-query hash
 * wins. Any can be pinned with SPOTIFY_OP_<KEY>.
 */
export const OPERATION_CANDIDATES = {
  artistOverview: ['queryArtistOverview', 'queryArtistOverviewV2', 'getArtistOverview'],
  album: ['getAlbum', 'queryAlbumTracks', 'getAlbumTracks'],
  search: ['searchSuggestions', 'searchArtists', 'searchDesktop', 'searchQuery'],
  discography: [
    'queryArtistDiscographyAll',
    'queryArtistDiscographyOverview',
    'queryArtistAlbums',
  ],
} as const;

export type OperationKey = keyof typeof OPERATION_CANDIDATES;

/** Flat list of every operation name we might need, for discovery. */
const ALL_OPERATION_NAMES: string[] = Object.values(OPERATION_CANDIDATES).flat();

export interface PartnerToken {
  accessToken: string;
  expiresAtMs: number;
  anonymous: boolean;
}

export interface PlayCountResult {
  /** Track id -> stream count. */
  counts: Map<string, number>;
  /** Albums that could not be read at all. */
  failedAlbums: string[];
}

export interface ArtistOverview {
  monthlyListeners: number | null;
  verified: boolean | null;
  biography: string | null;
  topCity: string | null;
  /** Track id -> stream count for the artist's top tracks. */
  topTrackCounts: Map<string, number>;
}

interface TokenResponse {
  accessToken?: string;
  access_token?: string;
  accessTokenExpirationTimestampMs?: number;
  expires_in?: number;
  isAnonymous?: boolean;
}

/** Lower-case every key so env overrides and camelCase names meet. */
function normaliseHashKeys(source: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value) out[key.toLowerCase()] = value;
  }
  return out;
}

const trackIdFromUri = (uri: string): string | null => {
  const match = /^spotify:track:([A-Za-z0-9]+)$/.exec(uri);
  return match?.[1] ?? null;
};

function toCount(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value >= 0 ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^-?\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    // Spotify uses -1 for "hidden", and 0 for tracks that genuinely have none.
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

/**
 * Walk a GraphQL response looking for `{ uri: "spotify:track:…", playcount }`
 * objects.
 *
 * The response *schema* shifts between web-player releases (`tracks` became
 * `tracksV2`, items gained an extra `track` wrapper, and so on). Pinning exact
 * paths means breaking on every release; a structural scan for the pair we
 * actually care about survives all of it.
 */
export function extractPlayCounts(payload: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  const seen = new Set<unknown>();

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    const record = node as Record<string, unknown>;
    const uri = record.uri;
    if (typeof uri === 'string') {
      const id = trackIdFromUri(uri);
      if (id) {
        const raw = record.playcount ?? record.playCount ?? record.playCountValue;
        const count = toCount(raw);
        // Keep the highest reading: the same track can appear under several
        // nodes, and a stale/limited one sometimes reports 0.
        if (count !== null && count >= (counts.get(id) ?? 0)) counts.set(id, count);
      }
    }

    for (const value of Object.values(record)) visit(value);
  };

  visit(payload);
  return counts;
}

/** Find the first value for `key` anywhere in the response tree. */
export function findValue(payload: unknown, key: string): unknown {
  const seen = new Set<unknown>();
  const stack: unknown[] = [payload];

  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);

    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }

    const record = node as Record<string, unknown>;
    if (key in record && record[key] !== null && record[key] !== undefined) return record[key];
    stack.push(...Object.values(record));
  }

  return undefined;
}

/**
 * Variables for a search operation.
 *
 * Persisted queries validate their variables against the stored document, so
 * an undeclared extra is rejected rather than ignored. Each operation
 * therefore gets the exact set the web player sends for it; the fallback is a
 * best guess for a spelling we have not seen.
 *
 * The `searchSuggestions` shape below is copied from a live request.
 */
export function searchVariables(
  operation: string,
  query: string,
  limit: number,
): Record<string, unknown> {
  switch (operation) {
    case 'searchSuggestions':
      return {
        query,
        limit,
        numberOfTopResults: limit,
        offset: 0,
        includeAuthors: true,
        includeAlbumPreReleases: false,
        includeEpisodeContentRatingsV2: true,
      };
    case 'searchDesktop':
    case 'searchQuery':
      return {
        searchTerm: query,
        offset: 0,
        limit,
        numberOfTopResults: limit,
        includeAudiobooks: true,
      };
    case 'searchArtists':
      return { searchTerm: query, offset: 0, limit, numberOfTopResults: limit };
    default:
      // Unknown spelling: send the two most common term keys and hope one of
      // them is what the document declares.
      return { query, searchTerm: query, offset: 0, limit, numberOfTopResults: limit };
  }
}

export class PartnerUnavailableError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PartnerUnavailableError';
  }
}

/**
 * Client for the private GraphQL API behind open.spotify.com.
 *
 * This is the only source of real per-track stream counts — the documented
 * Web API has never exposed them. It is undocumented and unsupported: auth,
 * query hashes and response shapes all change without notice, so every call
 * here is written to degrade to "no play counts" rather than take the page
 * down with it.
 */
export class PartnerClient {
  private token: PartnerToken | null = null;
  private tokenRefresh: Promise<PartnerToken> | null = null;
  private hashes: Record<string, string> = {};
  private hashDiscovery: Promise<Record<string, string>> | null = null;
  private lastFailure: string | null = null;

  constructor(private readonly config: Config) {
    this.hashes = normaliseHashKeys(config.partner.persistedQueries);
  }

  /**
   * Hashes are looked up case-insensitively.
   *
   * Overrides arrive as env vars (`SPOTIFY_PQ_GETALBUM`) which are uppercase
   * by convention, while operation names are camelCase (`getAlbum`). Keying
   * both on lower case is what makes the documented override actually apply.
   */
  private storedHash(operation: string): string | undefined {
    return this.hashes[operation.toLowerCase()];
  }

  get enabled(): boolean {
    return this.config.partner.enabled;
  }

  get status(): Record<string, unknown> {
    return {
      enabled: this.enabled,
      hasToken: Boolean(this.token && this.token.expiresAtMs > Date.now()),
      anonymous: this.token?.anonymous ?? null,
      knownOperations: Object.keys(this.hashes),
      lastFailure: this.lastFailure,
    };
  }

  private baseHeaders(): Record<string, string> {
    return {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      'accept-language': 'en',
      origin: 'https://open.spotify.com',
      referer: WEB_PLAYER_URL,
      'app-platform': 'WebPlayer',
      'spotify-app-version': '1.2.divine',
    };
  }

  /** TOTP query params, when a secret has been configured. */
  private totpParams(): Record<string, string> {
    const { totpSecret, totpVersion } = this.config.partner;
    if (!totpSecret) return {};
    const nowMs = Date.now();
    const code = generateTotp(totpSecret, { timestampMs: nowMs });
    return {
      totp: code,
      totpServer: code,
      totpVer: totpVersion,
      sTime: String(Math.floor(nowMs / 1000)),
      cTime: String(nowMs),
    };
  }

  private async fetchTokenFrom(url: string): Promise<PartnerToken | null> {
    const target = new URL(url);
    target.searchParams.set('reason', 'transport');
    target.searchParams.set('productType', 'web_player');
    for (const [key, value] of Object.entries(this.totpParams())) {
      target.searchParams.set(key, value);
    }

    const headers: Record<string, string> = this.baseHeaders();
    if (this.config.partner.spDc) headers.cookie = `sp_dc=${this.config.partner.spDc}`;

    const payload = await requestJson<TokenResponse>(target.toString(), {
      headers,
      timeoutMs: this.config.limits.requestTimeoutMs,
      retries: 2,
    });

    const accessToken = payload.accessToken ?? payload.access_token;
    if (!accessToken) return null;

    const expiresAtMs =
      payload.accessTokenExpirationTimestampMs ??
      (payload.expires_in ? Date.now() + payload.expires_in * 1000 : Date.now() + 55 * 60 * 1000);

    return { accessToken, expiresAtMs, anonymous: payload.isAnonymous ?? true };
  }

  /** Last resort: the player embeds a session token in its own HTML. */
  private async scrapeTokenFromPlayer(): Promise<PartnerToken | null> {
    const headers: Record<string, string> = {
      ...this.baseHeaders(),
      accept: 'text/html',
    };
    if (this.config.partner.spDc) headers.cookie = `sp_dc=${this.config.partner.spDc}`;

    const html = await request(WEB_PLAYER_URL, {
      headers,
      timeoutMs: this.config.limits.requestTimeoutMs,
      retries: 2,
    }).then((response) => response.text());

    const match =
      /"accessToken"\s*:\s*"([^"]+)"/.exec(html) ?? /accessToken["']?\s*[:=]\s*["']([^"']+)/.exec(html);
    if (!match?.[1]) return null;

    const expiry = /"accessTokenExpirationTimestampMs"\s*:\s*(\d+)/.exec(html);
    return {
      accessToken: match[1],
      expiresAtMs: expiry?.[1] ? Number(expiry[1]) : Date.now() + 30 * 60 * 1000,
      anonymous: !this.config.partner.spDc,
    };
  }

  /**
   * Token strategies, most reliable first. An explicitly supplied token always
   * wins; otherwise we ask the player's token endpoint (with the `sp_dc`
   * cookie if one is configured) and finally fall back to reading the token
   * out of the player HTML.
   */
  private async acquireToken(): Promise<PartnerToken> {
    if (this.config.partner.token) {
      return {
        accessToken: this.config.partner.token,
        // Trust an operator-supplied token for an hour; they can rotate it.
        expiresAtMs: Date.now() + 60 * 60 * 1000,
        anonymous: false,
      };
    }

    const strategies: Array<[string, () => Promise<PartnerToken | null>]> = [
      ['api/token', () => this.fetchTokenFrom(TOKEN_URL)],
      ['get_access_token', () => this.fetchTokenFrom(LEGACY_TOKEN_URL)],
      ['player-html', () => this.scrapeTokenFromPlayer()],
    ];

    const failures: string[] = [];
    for (const [name, strategy] of strategies) {
      try {
        const token = await strategy();
        if (token?.accessToken) {
          log.info(`partner token acquired via ${name} (anonymous=${token.anonymous})`);
          return token;
        }
        failures.push(`${name}: empty response`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${name}: ${message}`);
        log.debug(`token strategy ${name} failed`, message);
      }
    }

    throw new PartnerUnavailableError(
      `could not obtain a web-player token (${failures.join('; ')}). ` +
        'Set SPOTIFY_PARTNER_TOKEN or SPOTIFY_SP_DC to supply one explicitly.',
    );
  }

  private async accessToken(): Promise<string> {
    // Refresh a minute early so a long catalogue build never straddles expiry.
    if (this.token && this.token.expiresAtMs - 60_000 > Date.now()) return this.token.accessToken;
    if (this.tokenRefresh) return (await this.tokenRefresh).accessToken;

    this.tokenRefresh = this.acquireToken();
    try {
      this.token = await this.tokenRefresh;
      return this.token.accessToken;
    } finally {
      this.tokenRefresh = null;
    }
  }

  /**
   * Resolve a candidate list to the first operation name we have a hash for,
   * so a Spotify rename falls through to the next spelling instead of failing.
   */
  private async resolveOperation(key: OperationKey): Promise<string> {
    const pinned = this.config.partner.operations[key];
    const candidates = pinned ? [pinned, ...OPERATION_CANDIDATES[key]] : [...OPERATION_CANDIDATES[key]];

    for (const name of candidates) {
      if (this.storedHash(name)) return name;
    }

    await this.discoverHashes();
    for (const name of candidates) {
      if (this.storedHash(name)) return name;
    }

    throw new PartnerUnavailableError(
      `no persisted-query hash for any of: ${candidates.join(', ')}. Pin one with ` +
        `SPOTIFY_PQ_${candidates[0]!.toUpperCase()}=<sha256>, copied from a pathfinder ` +
        'request in your browser devtools.',
    );
  }

  private async discoverHashes(): Promise<void> {
    if (!this.hashDiscovery) {
      this.hashDiscovery = discoverPersistedQueries({
        timeoutMs: this.config.limits.requestTimeoutMs,
        concurrency: this.config.limits.concurrency,
        wanted: ALL_OPERATION_NAMES,
        userAgent: USER_AGENT,
      }).catch((error) => {
        log.warn('persisted-query discovery failed', (error as Error).message);
        return {} as Record<string, string>;
      });
    }
    const discovered = await this.hashDiscovery;
    // Configured hashes stay authoritative; discovery only fills the gaps.
    this.hashes = {
      ...normaliseHashKeys(discovered),
      ...this.hashes,
      ...normaliseHashKeys(this.config.partner.persistedQueries),
    };
  }

  private async hashFor(operation: string): Promise<string> {
    const known = this.storedHash(operation);
    if (known) return known;

    await this.discoverHashes();
    const hash = this.storedHash(operation);
    if (!hash) {
      throw new PartnerUnavailableError(
        `no persisted-query hash for "${operation}". Supply one with ` +
          `SPOTIFY_PQ_${operation.toUpperCase()}=<sha256> (copy it from a pathfinder ` +
          'request in your browser devtools).',
      );
    }
    return hash;
  }

  private async query<T = unknown>(
    operation: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const run = async (): Promise<T> => {
      const url = new URL(PATHFINDER_URL);
      url.searchParams.set('operationName', operation);
      url.searchParams.set('variables', JSON.stringify(variables));
      url.searchParams.set(
        'extensions',
        JSON.stringify({
          persistedQuery: { version: 1, sha256Hash: await this.hashFor(operation) },
        }),
      );

      return requestJson<T>(url.toString(), {
        headers: {
          ...this.baseHeaders(),
          authorization: `Bearer ${await this.accessToken()}`,
        },
        timeoutMs: this.config.limits.requestTimeoutMs,
        retries: 3,
      });
    };

    try {
      return await run();
    } catch (error) {
      if (error instanceof HttpError && error.isAuth) {
        // Token expired or was rejected: drop it and try once more.
        this.token = null;
        return run();
      }
      if (error instanceof HttpError && error.status === 400) {
        // A rotated hash reads as a bad request; re-discover and retry once.
        log.warn(`pathfinder rejected ${operation}; re-discovering persisted queries`);
        delete this.hashes[operation.toLowerCase()];
        this.hashDiscovery = null;
        return run();
      }
      throw error;
    }
  }

  /** Artist-level extras the public API does not expose (monthly listeners). */
  async getArtistOverview(artistId: string): Promise<ArtistOverview> {
    const payload = await this.query(await this.resolveOperation('artistOverview'), {
      uri: `spotify:artist:${artistId}`,
      locale: '',
      includePrerelease: false,
    });

    const monthly = findValue(payload, 'monthlyListeners');
    const verified = findValue(payload, 'verified');
    const biography = findValue(payload, 'biography');
    const topCity = findValue(payload, 'city');

    return {
      monthlyListeners: toCount(monthly),
      verified: typeof verified === 'boolean' ? verified : null,
      biography:
        typeof biography === 'string'
          ? biography
          : typeof (biography as { text?: string })?.text === 'string'
            ? (biography as { text: string }).text
            : null,
      topCity: typeof topCity === 'string' ? topCity : null,
      topTrackCounts: extractPlayCounts(payload),
    };
  }

  /**
   * Artist search, so the site works with no developer credentials at all.
   * The web player's own search backs this.
   */
  async searchArtists(query: string, limit = 20): Promise<PartnerArtist[]> {
    const operation = await this.resolveOperation('search');
    const payload = await this.query(operation, searchVariables(operation, query, limit));
    return extractArtists(payload).slice(0, limit);
  }

  /** Every release credited to an artist. */
  async getDiscography(artistId: string, maxReleases: number): Promise<PartnerAlbum[]> {
    const operation = await this.resolveOperation('discography');
    const pageSize = 100;
    const albums = new Map<string, PartnerAlbum>();

    for (let offset = 0; offset < maxReleases; offset += pageSize) {
      const payload = await this.query(operation, {
        uri: `spotify:artist:${artistId}`,
        offset,
        limit: pageSize,
        order: 'DATE_DESC',
      });

      const page = extractAlbums(payload);
      for (const album of page) if (!albums.has(album.id)) albums.set(album.id, album);
      // A short page means the discography is exhausted.
      if (page.length < pageSize) break;
    }

    return [...albums.values()].slice(0, maxReleases);
  }

  /** Full track listings for one album, play counts included. */
  async getAlbumTracks(albumId: string, totalTracks: number): Promise<PartnerTrack[]> {
    const operation = await this.resolveOperation('album');
    const pageSize = 300;
    const pages = Math.max(1, Math.ceil(Math.max(totalTracks, 1) / pageSize));
    const tracks = new Map<string, PartnerTrack>();

    for (let page = 0; page < pages; page += 1) {
      const payload = await this.query(operation, {
        uri: `spotify:album:${albumId}`,
        locale: '',
        offset: page * pageSize,
        limit: pageSize,
      });
      for (const track of extractTracks(payload)) {
        const existing = tracks.get(track.id);
        // Keep whichever reading actually carries a play count.
        if (!existing || (existing.playCount === null && track.playCount !== null)) {
          tracks.set(track.id, track);
        }
      }
    }

    return [...tracks.values()];
  }

  /** Artist profile without the documented API. */
  async getArtistProfile(artistId: string): Promise<PartnerArtist | null> {
    const payload = await this.query(await this.resolveOperation('artistOverview'), {
      uri: `spotify:artist:${artistId}`,
      locale: '',
      includePrerelease: false,
    });
    return extractArtists(payload).find((artist) => artist.id === artistId) ?? null;
  }

  /** Play counts for every track on one album. */
  async getAlbumPlayCounts(albumId: string, totalTracks: number): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const pageSize = 300;
    const pages = Math.max(1, Math.ceil(Math.max(totalTracks, 1) / pageSize));

    for (let page = 0; page < pages; page += 1) {
      const payload = await this.query(await this.resolveOperation('album'), {
        uri: `spotify:album:${albumId}`,
        locale: '',
        offset: page * pageSize,
        limit: pageSize,
      });
      for (const [id, count] of extractPlayCounts(payload)) counts.set(id, count);
    }

    return counts;
  }

  /**
   * Play counts across many albums. Individual album failures are collected
   * rather than thrown: a catalogue that is 95% covered still beats an error
   * page.
   */
  async getPlayCounts(
    albums: ReadonlyArray<{ id: string; totalTracks: number }>,
    onProgress?: (completed: number, total: number) => void,
  ): Promise<PlayCountResult> {
    if (!this.enabled) throw new PartnerUnavailableError('partner API disabled by configuration');

    // Fail fast on auth so the caller can report one clear warning instead of
    // one per album.
    await this.accessToken();

    const counts = new Map<string, number>();
    const failedAlbums: string[] = [];
    let completed = 0;

    await mapWithConcurrency(albums, this.config.limits.concurrency, async (album) => {
      try {
        for (const [id, count] of await this.getAlbumPlayCounts(album.id, album.totalTracks)) {
          if (count >= (counts.get(id) ?? -1)) counts.set(id, count);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.lastFailure = message;
        failedAlbums.push(album.id);
        log.debug(`play counts unavailable for album ${album.id}`, message);
      } finally {
        completed += 1;
        onProgress?.(completed, albums.length);
      }
    });

    return { counts, failedAlbums };
  }
}
