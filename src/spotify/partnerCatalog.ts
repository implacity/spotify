import type { Config } from '../config.js';
import { createLogger } from '../util/logger.js';
import { mapWithConcurrency } from '../util/limit.js';
import { displayTitle, trackDedupeKey } from '../util/normalize.js';
import { computeStats } from './catalog.js';
import type { PartnerClient } from './partner.js';
import type { PartnerAlbum } from './partnerEntities.js';
import type {
  ArtistCatalog,
  ArtistDetail,
  CatalogWarning,
  ProgressReporter,
  ReleaseRef,
  TrackRow,
} from './types.js';

const log = createLogger('partner-catalog');

/**
 * Builds a full artist catalogue using only the web player's API.
 *
 * This is the no-credentials path: Spotify gates the documented Web API behind
 * an active Premium subscription on the app owner's account, which makes it
 * unavailable to a lot of people. Everything here comes from the same
 * endpoint that already supplies play counts, so no developer app, client
 * secret or subscription is involved.
 *
 * The trade-off is that the entire site then rests on an undocumented API.
 * Popularity scores are not available from it — but play counts, which are
 * the point of this site, are strictly more informative anyway.
 */
export class PartnerCatalogService {
  constructor(
    private readonly config: Config,
    private readonly partner: PartnerClient,
  ) {}

  private toRelease(album: PartnerAlbum): ReleaseRef {
    return {
      id: album.id,
      name: album.name,
      type: album.type,
      releaseDate: album.releaseDate,
      releaseDatePrecision: album.releaseDatePrecision,
      totalTracks: album.totalTracks,
      image: album.image,
      url: `https://open.spotify.com/album/${album.id}`,
    };
  }

  async build(artistId: string, onProgress: ProgressReporter = () => {}): Promise<ArtistCatalog> {
    const startedAt = Date.now();
    const warnings: CatalogWarning[] = [];

    onProgress({ phase: 'artist', message: 'Loading artist', completed: 0, total: 1 });
    const profile = await this.partner.getArtistProfile(artistId);
    if (!profile) {
      throw new Error(
        `Spotify returned no artist for ${artistId}. The id may be wrong, or the ` +
          'web-player API may have changed shape.',
      );
    }

    onProgress({ phase: 'releases', message: 'Listing releases', completed: 0, total: 1 });
    const albums = await this.partner.getDiscography(artistId, this.config.limits.maxReleases);
    if (albums.length >= this.config.limits.maxReleases) {
      warnings.push({
        code: 'partial_releases',
        message: `Only the first ${this.config.limits.maxReleases} releases were scanned.`,
        detail: 'Raise SPOTIFY_MAX_RELEASES to cover the whole discography.',
      });
    }

    const releases = albums.map((album) => this.toRelease(album));
    log.info(`found ${releases.length} releases for ${profile.name}`);

    onProgress({
      phase: 'playcounts',
      message: 'Fetching tracks and play counts',
      completed: 0,
      total: releases.length,
    });

    const rows: TrackRow[] = [];
    const seen = new Set<string>();
    const failed: string[] = [];
    let completed = 0;

    // One request per album, exactly as the play-count path already does — the
    // track listing and its counts arrive in the same response.
    const perAlbum = await mapWithConcurrency(
      albums,
      this.config.limits.concurrency,
      async (album) => {
        try {
          return { album, tracks: await this.partner.getAlbumTracks(album.id, album.totalTracks) };
        } catch (error) {
          failed.push(album.id);
          log.debug(`album ${album.id} unreadable`, (error as Error).message);
          return { album, tracks: [] };
        } finally {
          completed += 1;
          onProgress({
            phase: 'playcounts',
            message: 'Fetching tracks and play counts',
            completed,
            total: albums.length,
          });
        }
      },
    );

    for (const { album, tracks } of perAlbum) {
      const release = this.toRelease(album);
      for (const track of tracks) {
        if (seen.has(track.id)) continue;
        // Guest appearances come back too; keep only tracks this artist is on.
        const credited =
          track.artists.length === 0 || track.artists.some((artist) => artist.id === artistId);
        if (!credited) continue;
        seen.add(track.id);

        rows.push({
          id: track.id,
          name: track.name,
          displayName: displayTitle(track.name),
          url: `https://open.spotify.com/track/${track.id}`,
          durationMs: track.durationMs,
          explicit: track.explicit,
          discNumber: track.discNumber,
          trackNumber: track.trackNumber,
          // Popularity is an official-API field with no web-player equivalent.
          popularity: null,
          playCount: track.playCount,
          album: {
            id: release.id,
            name: release.name,
            type: release.type,
            releaseDate: release.releaseDate,
            image: release.image,
            url: release.url,
          },
          artists: track.artists.length > 0 ? track.artists : [{ id: artistId, name: profile.name }],
          isFeature: track.artists.length > 0 && track.artists[0]?.id !== artistId,
          groupKey: trackDedupeKey(track.name, track.artists[0]?.name ?? profile.name),
          duplicateCount: 0,
          duplicateIds: [],
        });
      }
    }

    if (failed.length > 0) {
      warnings.push({
        code: 'release_fetch_failed',
        message: `${failed.length} of ${albums.length} releases could not be read.`,
      });
    }

    const withCounts = rows.filter((row) => row.playCount !== null).length;
    if (withCounts === 0 && rows.length > 0) {
      warnings.push({
        code: 'playcounts_unavailable',
        message: 'Tracks loaded, but Spotify returned no play counts for them.',
        detail: 'The web player may have changed its response shape; see the README.',
      });
    }

    rows.sort((a, b) => (b.playCount ?? -1) - (a.playCount ?? -1) || a.name.localeCompare(b.name));

    const artist: ArtistDetail = {
      id: profile.id,
      name: profile.name,
      url: `https://open.spotify.com/artist/${profile.id}`,
      image: profile.image,
      followers: profile.followers,
      popularity: null,
      genres: [],
      monthlyListeners: profile.monthlyListeners,
      verified: profile.verified,
      biography: null,
      topCity: null,
    };

    onProgress({ phase: 'done', message: 'Done', completed: 1, total: 1 });

    return {
      artist,
      tracks: rows,
      stats: computeStats(rows, releases),
      releases,
      warnings,
      playCountsComplete: rows.length > 0 && withCounts === rows.length,
      source: 'live',
      generatedAt: new Date().toISOString(),
      buildMs: Date.now() - startedAt,
    };
  }
}
