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
   * Which backend serves this request.
   *
   * `auto` prefers the documented API but falls back to the web player when
   * there are no credentials — Spotify requires Premium on the app owner for
   * Web API access, so running without credentials is a normal case, not an
   * error.
   */
  get activeSource(): 'official' | 'partner' {
    if (this.config.source !== 'auto') return this.config.source;
    return this.official.configured ? 'official' : 'partner';
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
    const source = this.activeSource;
    return this.cache.wrap(
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
      this.activeSource === 'partner'
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
      partner: this.partner.status,
      cacheEntries: this.cache.size,
    };
  }
}
