import type { Config } from './config.js';
import { Cache } from './util/cache.js';
import { createLogger } from './util/logger.js';
import { buildMockCatalog, mockSearch } from './mock/fixtures.js';
import {
  CatalogService,
  DEFAULT_CATALOG_OPTIONS,
  computeStats,
  groupDuplicateTracks,
  type CatalogOptions,
} from './spotify/catalog.js';
import { OfficialClient, SubscriptionRequiredError } from './spotify/official.js';
import { PartnerClient } from './spotify/partner.js';
import { PartnerCatalogService } from './spotify/partnerCatalog.js';
import type { ArtistCatalog, ArtistSummary, ProgressReporter } from './spotify/types.js';

const log = createLogger('service');

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

const catalogKey = (artistId: string, options: CatalogOptions, source: string): string =>
  `catalog:${source}:${artistId}:${options.includeAppearsOn ? 1 : 0}`;

/**
 * Application-level facade over the two Spotify sources, with caching and an
 * offline mock mode. Routes talk to this and never to the clients directly.
 */
export class ArtistService {
  private readonly official: OfficialClient;
  private readonly partner: PartnerClient;
  private readonly catalog: CatalogService;
  private readonly partnerCatalog: PartnerCatalogService;
  private readonly cache: Cache;

  constructor(private readonly config: Config) {
    this.official = new OfficialClient(config);
    this.partner = new PartnerClient(config);
    this.catalog = new CatalogService(config, this.official, this.partner);
    this.partnerCatalog = new PartnerCatalogService(config, this.partner);
    this.cache = new Cache(config.cache);
  }

  /**
   * Set once the documented API has told us the app owner lacks Premium.
   * That verdict does not change within a process lifetime, so there is no
   * point re-asking on every request.
   */
  private officialBlocked = false;

  /**
   * Which backend serves this request.
   *
   * `auto` prefers the documented API, but only while it can actually answer.
   * Spotify requires Premium on the app owner for any Web API access, so
   * having credentials is no guarantee they work — and a user in that
   * position should get a working site, not a dead one.
   */
  get activeSource(): 'official' | 'partner' {
    if (this.config.source !== 'auto') return this.config.source;
    if (this.officialBlocked) return 'partner';
    return this.official.configured ? 'official' : 'partner';
  }

  /**
   * Run `attempt` against the chosen source; if the documented API refuses on
   * subscription grounds and we are in `auto`, switch to the web player and
   * retry rather than failing the request.
   */
  private async withFallback<T>(
    attempt: (source: 'official' | 'partner') => Promise<T>,
  ): Promise<T> {
    const source = this.activeSource;
    try {
      return await attempt(source);
    } catch (error) {
      const canFallBack =
        error instanceof SubscriptionRequiredError &&
        this.config.source === 'auto' &&
        source === 'official' &&
        this.partner.enabled;

      if (!canFallBack) throw error;

      this.officialBlocked = true;
      log.warn(
        'Web API refused: the app owner has no active Premium subscription. ' +
          'Falling back to the web-player source for the rest of this process.',
      );
      return attempt('partner');
    }
  }

  get mock(): boolean {
    return this.config.mock;
  }

  private assertConfigured(): void {
    if (this.config.mock) return;
    if (this.activeSource === 'partner') {
      if (!this.partner.enabled) {
        throw new ConfigurationError(
          'No catalogue source available: there are no Web API credentials and the ' +
            'web-player source is disabled (SPOTIFY_PARTNER_ENABLED=0).',
        );
      }
      return;
    }
    if (!this.official.configured) {
      throw new ConfigurationError(
        'Spotify credentials are not configured. Set SPOTIFY_CLIENT_ID and ' +
          'SPOTIFY_CLIENT_SECRET, set SPOTIFY_SOURCE=partner to run without them, ' +
          'or use MOCK=1 for sample data.',
      );
    }
  }

  async search(query: string, limit = 20): Promise<ArtistSummary[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    if (this.config.mock) return mockSearch(trimmed).slice(0, limit);

    this.assertConfigured();
    return this.withFallback((source) =>
      this.cache.wrap(
      `search:${source}:${trimmed.toLowerCase()}:${limit}`,
      this.config.cache.searchTtl,
      async () => {
        if (source === 'partner') {
          const artists = await this.partner.searchArtists(trimmed, limit);
          return artists.map((artist) => ({
            id: artist.id,
            name: artist.name,
            url: `https://open.spotify.com/artist/${artist.id}`,
            image: artist.image,
            followers: artist.followers,
            // Popularity has no web-player equivalent.
            popularity: null,
            genres: [],
          }));
        }
        return this.official.searchArtists(trimmed, limit);
      },
      ),
    );
  }

  /**
   * Full catalogue for an artist. Grouping is applied *after* the cache so
   * toggling it in the UI is instant and doesn't re-hit Spotify.
   */
  async getCatalog(
    artistId: string,
    options: Partial<CatalogOptions> = {},
    onProgress: ProgressReporter = () => {},
    forceRefresh = false,
  ): Promise<ArtistCatalog> {
    const resolved: CatalogOptions = { ...DEFAULT_CATALOG_OPTIONS, ...options };
    const key = catalogKey(artistId, resolved, this.activeSource);
    // Must clear both tiers, otherwise the rebuild below reads the stale
    // catalogue straight back off disk.
    if (forceRefresh) await this.cache.invalidate(key);

    // Cache the ungrouped catalogue; grouping is a cheap view transform.
    const base = await this.withFallback((source) =>
      this.buildBase(artistId, resolved, onProgress, forceRefresh, catalogKey(artistId, resolved, source), source),
    );
    return this.applyGrouping(base, resolved);
  }

  private async buildBase(
    artistId: string,
    options: CatalogOptions,
    onProgress: ProgressReporter,
    forceRefresh: boolean,
    key: string,
    source: 'official' | 'partner',
  ): Promise<ArtistCatalog> {
    if (this.config.mock) {
      const mock = buildMockCatalog(artistId);
      if (!mock) throw new NotFoundError(`Unknown artist: ${artistId}`);
      // Emit progress even though it is instant, so the SSE contract is the
      // same on every path: at least one progress frame, then the catalogue.
      onProgress({ phase: 'done', message: 'Loaded sample data', completed: 1, total: 1 });
      return mock;
    }

    this.assertConfigured();

    if (!forceRefresh) {
      const cached = await this.cache.get<ArtistCatalog>(key);
      if (cached) {
        log.debug(`catalogue cache hit for ${artistId}`);
        onProgress({ phase: 'done', message: 'Loaded from cache', completed: 1, total: 1 });
        return cached;
      }
    }

    return this.cache.wrap(key, this.config.cache.artistTtl, () =>
      // Store ungrouped so both views come from one build.
      source === 'partner'
        ? this.partnerCatalog.build(artistId, onProgress)
        : this.catalog.build(artistId, { ...options, groupDuplicates: false }, onProgress),
    );
  }

  private applyGrouping(base: ArtistCatalog, options: CatalogOptions): ArtistCatalog {
    if (!options.groupDuplicates) return base;
    const tracks = groupDuplicateTracks(base.tracks).sort(
      (a, b) => (b.playCount ?? -1) - (a.playCount ?? -1) || a.name.localeCompare(b.name),
    );
    return { ...base, tracks, stats: computeStats(tracks, base.releases) };
  }

  status(): Record<string, unknown> {
    return {
      mock: this.config.mock,
      activeSource: this.config.mock ? 'mock' : this.activeSource,
      officialConfigured: this.official.configured,
      /** True once the Web API refused for lack of a Premium subscription. */
      officialBlocked: this.officialBlocked,
      partner: this.partner.status,
      cacheEntries: this.cache.size,
    };
  }
}
