import type { Config } from '../config.js';
import { createLogger } from '../util/logger.js';
import { displayTitle, trackDedupeKey } from '../util/normalize.js';
import type { AlbumWithTracks, OfficialClient, RawTrack } from './official.js';
import { PartnerClient, PartnerUnavailableError } from './partner.js';
import type {
  ArtistCatalog,
  ArtistDetail,
  CatalogStats,
  CatalogWarning,
  ProgressReporter,
  ReleaseRef,
  TrackRow,
} from './types.js';

const log = createLogger('catalog');

export interface CatalogOptions {
  /** Include releases where the artist is only a guest. */
  includeAppearsOn: boolean;
  /** Merge the same recording across singles/albums/reissues into one row. */
  groupDuplicates: boolean;
}

export const DEFAULT_CATALOG_OPTIONS: CatalogOptions = {
  includeAppearsOn: true,
  groupDuplicates: true,
};

/** Was this artist actually credited on the track? */
function creditsArtist(track: RawTrack, album: AlbumWithTracks, artistId: string): boolean {
  if (track.artists?.some((artist) => artist.id === artistId)) return true;
  // Album-level credit covers releases whose track objects omit artists.
  return album.artists.some((artist) => artist.id === artistId);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2) : (sorted[mid] ?? null);
}

/**
 * Pick the row that best represents a group of duplicate recordings.
 *
 * Preference order: the one with real play counts, then the highest count,
 * then the earliest release — an original album beats a later compilation.
 */
function preferRow(current: TrackRow, candidate: TrackRow): TrackRow {
  const currentCount = current.playCount ?? -1;
  const candidateCount = candidate.playCount ?? -1;
  if (candidateCount !== currentCount) return candidateCount > currentCount ? candidate : current;

  const rank = (row: TrackRow): number =>
    row.album.type === 'album' ? 0 : row.album.type === 'single' ? 1 : row.album.type === 'compilation' ? 2 : 3;
  const rankDelta = rank(candidate) - rank(current);
  if (rankDelta !== 0) return rankDelta < 0 ? candidate : current;

  if (candidate.album.releaseDate && current.album.releaseDate) {
    return candidate.album.releaseDate < current.album.releaseDate ? candidate : current;
  }
  return current;
}

/**
 * Collapse duplicate recordings into one row per song.
 *
 * Play counts are *not* summed. The same recording on a single and on the
 * album are two catalogue entries for one song, and adding them would
 * overstate it; the winning row keeps its own count and records how many
 * other releases carry it.
 */
export function groupDuplicateTracks(rows: TrackRow[]): TrackRow[] {
  const groups = new Map<string, TrackRow>();

  for (const row of rows) {
    const key = row.groupKey || trackDedupeKey(row.name, row.artists[0]?.name ?? '');
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...row, duplicateCount: 0, duplicateIds: [] });
      continue;
    }

    const winner = preferRow(existing, row);
    const loser = winner === existing ? row : existing;
    groups.set(key, {
      ...winner,
      duplicateCount: existing.duplicateCount + 1,
      duplicateIds: [...existing.duplicateIds, loser.id],
    });
  }

  return [...groups.values()];
}

export function computeStats(rows: TrackRow[], releases: ReleaseRef[]): CatalogStats {
  const counts = rows
    .map((row) => row.playCount)
    .filter((count): count is number => typeof count === 'number');

  const dates = releases.map((release) => release.releaseDate).filter(Boolean).sort();
  const sorted = [...counts].sort((a, b) => b - a);
  const total = counts.reduce((sum, count) => sum + count, 0);

  return {
    totalPlayCount: counts.length > 0 ? total : null,
    countedTracks: rows.length,
    tracksWithPlayCounts: counts.length,
    averagePlayCount: counts.length > 0 ? Math.round(total / counts.length) : null,
    medianPlayCount: median(counts),
    releaseCount: releases.length,
    leadTrackCount: rows.filter((row) => !row.isFeature).length,
    featureTrackCount: rows.filter((row) => row.isFeature).length,
    top10PlayCount: sorted.length > 0 ? sorted.slice(0, 10).reduce((sum, count) => sum + count, 0) : null,
    firstReleaseDate: dates[0] ?? null,
    latestReleaseDate: dates[dates.length - 1] ?? null,
  };
}

/**
 * Builds the full "every song and its play count" table for one artist by
 * joining the documented Web API (catalogue, popularity) with the private
 * pathfinder API (stream counts).
 */
export class CatalogService {
  constructor(
    private readonly config: Config,
    private readonly official: OfficialClient,
    private readonly partner: PartnerClient,
  ) {}

  async build(
    artistId: string,
    options: CatalogOptions = DEFAULT_CATALOG_OPTIONS,
    onProgress: ProgressReporter = () => {},
  ): Promise<ArtistCatalog> {
    const startedAt = Date.now();
    const warnings: CatalogWarning[] = [];

    onProgress({ phase: 'artist', message: 'Loading artist', completed: 0, total: 1 });
    const summary = await this.official.getArtist(artistId);

    onProgress({ phase: 'releases', message: 'Listing releases', completed: 0, total: 1 });
    const releases = await this.official.getArtistReleases(artistId, options.includeAppearsOn);
    if (releases.length >= this.config.limits.maxReleases) {
      warnings.push({
        code: 'partial_releases',
        message: `Only the first ${this.config.limits.maxReleases} releases were scanned.`,
        detail: 'Raise SPOTIFY_MAX_RELEASES to cover the whole discography.',
      });
    }

    onProgress({
      phase: 'tracks',
      message: `Reading ${releases.length} releases`,
      completed: 0,
      total: releases.length,
    });
    const albums = await this.official.getAlbumsWithTracks(releases);
    onProgress({
      phase: 'tracks',
      message: `Reading ${releases.length} releases`,
      completed: releases.length,
      total: releases.length,
    });

    // Flatten to the tracks this artist is actually on.
    const rows: TrackRow[] = [];
    const seenTrackIds = new Set<string>();

    for (const album of albums) {
      for (const track of album.tracks) {
        // `linked_from` appears when track relinking swapped in a market-local
        // id; the original is the one play counts are reported against.
        const id = track.id ?? track.linked_from?.id ?? null;
        if (!id || seenTrackIds.has(id)) continue;
        if (!creditsArtist(track, album, artistId)) continue;
        seenTrackIds.add(id);

        const artists = (track.artists ?? album.artists).map((artist) => ({
          id: artist.id,
          name: artist.name,
        }));

        rows.push({
          id,
          name: track.name,
          displayName: displayTitle(track.name),
          url: track.external_urls?.spotify ?? `https://open.spotify.com/track/${id}`,
          durationMs: track.duration_ms ?? 0,
          explicit: Boolean(track.explicit),
          discNumber: track.disc_number ?? 1,
          trackNumber: track.track_number ?? 0,
          popularity: typeof track.popularity === 'number' ? track.popularity : null,
          playCount: null,
          album: {
            id: album.release.id,
            name: album.release.name,
            type: album.release.type,
            releaseDate: album.release.releaseDate,
            image: album.release.image,
            url: album.release.url,
          },
          artists,
          isFeature: artists.length > 0 && artists[0]?.id !== artistId,
          groupKey: trackDedupeKey(track.name, artists[0]?.name ?? ''),
          duplicateCount: 0,
          duplicateIds: [],
        });
      }
    }

    log.info(`collected ${rows.length} tracks across ${releases.length} releases for ${summary.name}`);

    // Popularity and play counts are independent; fetch them together.
    const [popularity, playCounts, overview] = await Promise.all([
      this.official
        .getTrackPopularity(rows.map((row) => row.id))
        .catch((error: unknown) => {
          log.warn('popularity lookup failed', (error as Error).message);
          return new Map<string, number>();
        }),
      this.fetchPlayCounts(albums, warnings, onProgress),
      this.fetchOverview(artistId),
    ]);

    for (const row of rows) {
      const pop = popularity.get(row.id);
      if (typeof pop === 'number') row.popularity = pop;
      const count = playCounts.get(row.id);
      if (typeof count === 'number') row.playCount = count;
    }

    const finalRows = options.groupDuplicates ? groupDuplicateTracks(rows) : rows;
    finalRows.sort((a, b) => (b.playCount ?? -1) - (a.playCount ?? -1) || a.name.localeCompare(b.name));

    const withCounts = finalRows.filter((row) => row.playCount !== null).length;
    if (withCounts === 0 && finalRows.length > 0) {
      warnings.push({
        code: 'playcounts_unavailable',
        message: 'Play counts could not be retrieved; showing Spotify popularity instead.',
        detail:
          'The public Web API does not expose stream counts. See the README for how to ' +
          'configure the web-player data source.',
      });
    }

    const artist: ArtistDetail = {
      ...summary,
      monthlyListeners: overview?.monthlyListeners ?? null,
      verified: overview?.verified ?? null,
      biography: overview?.biography ?? null,
      topCity: overview?.topCity ?? null,
    };

    onProgress({ phase: 'done', message: 'Done', completed: 1, total: 1 });

    return {
      artist,
      tracks: finalRows,
      stats: computeStats(finalRows, releases),
      releases,
      warnings,
      playCountsComplete: finalRows.length > 0 && withCounts === finalRows.length,
      source: 'live',
      generatedAt: new Date().toISOString(),
      buildMs: Date.now() - startedAt,
    };
  }

  private async fetchOverview(artistId: string) {
    if (!this.partner.enabled) return null;
    try {
      return await this.partner.getArtistOverview(artistId);
    } catch (error) {
      log.debug('artist overview unavailable', (error as Error).message);
      return null;
    }
  }

  private async fetchPlayCounts(
    albums: AlbumWithTracks[],
    warnings: CatalogWarning[],
    onProgress: ProgressReporter,
  ): Promise<Map<string, number>> {
    if (!this.partner.enabled) {
      warnings.push({
        code: 'playcounts_unavailable',
        message: 'Play-count lookups are disabled (SPOTIFY_PARTNER_ENABLED=0).',
      });
      return new Map();
    }

    const targets = albums.map((album) => ({
      id: album.release.id,
      totalTracks: Math.max(album.release.totalTracks, album.tracks.length),
    }));

    onProgress({
      phase: 'playcounts',
      message: 'Fetching play counts',
      completed: 0,
      total: targets.length,
    });

    try {
      const result = await this.partner.getPlayCounts(targets, (completed, total) => {
        onProgress({ phase: 'playcounts', message: 'Fetching play counts', completed, total });
      });

      if (result.failedAlbums.length > 0) {
        warnings.push({
          code: 'release_fetch_failed',
          message: `Play counts missing for ${result.failedAlbums.length} of ${targets.length} releases.`,
        });
      }
      return result.counts;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push({
        code: error instanceof PartnerUnavailableError ? 'partner_auth_failed' : 'playcounts_unavailable',
        message: 'Play counts are unavailable right now; showing Spotify popularity instead.',
        detail: message,
      });
      log.warn('play-count source unavailable', message);
      return new Map();
    }
  }
}
