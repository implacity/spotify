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
import { OfficialClient } from './spotify/official.js';
import { PartnerClient } from './spotify/partner.js';
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

const catalogKey = (artistId: string, options: CatalogOptions): string =>
  `catalog:${artistId}:${options.includeAppearsOn ? 1 : 0}`;

/**
 * Application-level facade over the two Spotify sources, with caching and an
 * offline mock mode. Routes talk to this and never to the clients directly.
 */
export class ArtistService {
  private readonly official: OfficialClient;
  private readonly partner: PartnerClient;
  private readonly catalog: CatalogService;
  private readonly cache: Cache;

  constructor(private readonly config: Config) {
    this.official = new OfficialClient(config);
    this.partner = new PartnerClient(config);
    this.catalog = new CatalogService(config, this.official, this.partner);
    this.cache = new Cache(config.cache);
  }

  get mock(): boolean {
    return this.config.mock;
  }

  private assertConfigured(): void {
    if (this.config.mock) return;
    if (!this.official.configured) {
      throw new ConfigurationError(
        'Spotify credentials are not configured. Set SPOTIFY_CLIENT_ID and ' +
          'SPOTIFY_CLIENT_SECRET, or run with MOCK=1 to use sample data.',
      );
    }
  }

  async search(query: string, limit = 20): Promise<ArtistSummary[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    if (this.config.mock) return mockSearch(trimmed).slice(0, limit);

    this.assertConfigured();
    return this.cache.wrap(
      `search:${trimmed.toLowerCase()}:${limit}`,
      this.config.cache.searchTtl,
      () => this.official.searchArtists(trimmed, limit),
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
    const key = catalogKey(artistId, resolved);
    if (forceRefresh) this.cache.delete(key);

    // Cache the ungrouped catalogue; grouping is a cheap view transform.
    const base = await this.buildBase(artistId, resolved, onProgress, forceRefresh, key);
    return this.applyGrouping(base, resolved);
  }

  private async buildBase(
    artistId: string,
    options: CatalogOptions,
    onProgress: ProgressReporter,
    forceRefresh: boolean,
    key: string,
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
      this.catalog.build(artistId, { ...options, groupDuplicates: false }, onProgress),
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
      officialConfigured: this.official.configured,
      partner: this.partner.status,
      cacheEntries: this.cache.size,
    };
  }
}
