import type { Config } from '../config.js';
import { HttpError, requestJson } from '../util/http.js';
import { createLogger } from '../util/logger.js';
import { mapWithConcurrency } from '../util/limit.js';
import type { ArtistSummary, ReleaseRef, ReleaseType } from './types.js';

const log = createLogger('official');

const ACCOUNTS_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

/** `/v1/albums` accepts at most 20 ids per call. */
const ALBUM_BATCH = 20;
/** `/v1/tracks` accepts at most 50 ids per call. */
const TRACK_BATCH = 50;
const PAGE_LIMIT = 50;

interface RawImage {
  url: string;
  width: number | null;
  height: number | null;
}

interface RawArtist {
  id: string;
  name: string;
  images?: RawImage[];
  followers?: { total: number };
  popularity?: number;
  genres?: string[];
  external_urls?: { spotify?: string };
}

interface RawAlbum {
  id: string;
  name: string;
  album_type: string;
  album_group?: string;
  release_date: string;
  release_date_precision: 'year' | 'month' | 'day';
  total_tracks: number;
  images?: RawImage[];
  external_urls?: { spotify?: string };
  artists?: Array<{ id: string; name: string }>;
  tracks?: { items: RawTrack[]; next: string | null };
}

export interface RawTrack {
  id: string | null;
  name: string;
  duration_ms: number;
  explicit: boolean;
  disc_number: number;
  track_number: number;
  popularity?: number;
  is_playable?: boolean;
  external_urls?: { spotify?: string };
  artists?: Array<{ id: string; name: string }>;
  linked_from?: { id: string };
}

interface Paged<T> {
  items: T[];
  next: string | null;
  total: number;
}

export interface AlbumWithTracks {
  release: ReleaseRef;
  tracks: RawTrack[];
  artists: Array<{ id: string; name: string }>;
}

function pickImage(images: RawImage[] | undefined): string | null {
  if (!images || images.length === 0) return null;
  // Spotify returns images largest-first; the middle one is the best
  // size/bandwidth trade-off for a table thumbnail.
  return images[Math.min(1, images.length - 1)]?.url ?? images[0]?.url ?? null;
}

function toArtistSummary(raw: RawArtist): ArtistSummary {
  return {
    id: raw.id,
    name: raw.name,
    url: raw.external_urls?.spotify ?? `https://open.spotify.com/artist/${raw.id}`,
    image: pickImage(raw.images),
    followers: raw.followers?.total ?? null,
    popularity: raw.popularity ?? null,
    genres: raw.genres ?? [],
  };
}

function toReleaseType(raw: RawAlbum): ReleaseType {
  const group = (raw.album_group ?? raw.album_type ?? 'album').toLowerCase();
  if (group === 'appears_on') return 'appears_on';
  if (group === 'single') return 'single';
  if (group === 'compilation') return 'compilation';
  return 'album';
}

function toRelease(raw: RawAlbum): ReleaseRef {
  return {
    id: raw.id,
    name: raw.name,
    type: toReleaseType(raw),
    releaseDate: raw.release_date ?? '',
    releaseDatePrecision: raw.release_date_precision ?? 'day',
    totalTracks: raw.total_tracks ?? 0,
    image: pickImage(raw.images),
    url: raw.external_urls?.spotify ?? `https://open.spotify.com/album/${raw.id}`,
  };
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Client for Spotify's documented Web API (client-credentials flow).
 *
 * This is the authoritative source for the catalogue: artists, releases and
 * tracks. It deliberately does *not* provide play counts — the public API has
 * never exposed them, only a 0-100 `popularity` score. See `partner.ts`.
 */
export class OfficialClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private tokenRefresh: Promise<string> | null = null;

  constructor(private readonly config: Config) {}

  get configured(): boolean {
    return Boolean(this.config.official.clientId && this.config.official.clientSecret);
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (this.tokenRefresh) return this.tokenRefresh;

    this.tokenRefresh = (async () => {
      const { clientId, clientSecret } = this.config.official;
      if (!clientId || !clientSecret) {
        throw new Error(
          'Missing SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET. Create an app at ' +
            'https://developer.spotify.com/dashboard and put the credentials in .env',
        );
      }
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const payload = await requestJson<{ access_token: string; expires_in: number }>(
        ACCOUNTS_URL,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${basic}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: 'grant_type=client_credentials',
          timeoutMs: this.config.limits.requestTimeoutMs,
        },
      );
      this.token = payload.access_token;
      // Refresh a minute early so an in-flight burst never straddles expiry.
      this.tokenExpiresAt = Date.now() + Math.max(0, payload.expires_in - 60) * 1000;
      log.debug('obtained client-credentials token');
      return this.token;
    })();

    try {
      return await this.tokenRefresh;
    } finally {
      this.tokenRefresh = null;
    }
  }

  private async get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = path.startsWith('http')
      ? new URL(path)
      : new URL(`${API_BASE}${path.startsWith('/') ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

    const send = async (): Promise<T> =>
      requestJson<T>(url.toString(), {
        headers: { authorization: `Bearer ${await this.accessToken()}` },
        timeoutMs: this.config.limits.requestTimeoutMs,
      });

    try {
      return await send();
    } catch (error) {
      // A token can be revoked before its stated expiry; retry once on a fresh one.
      if (error instanceof HttpError && error.status === 401) {
        this.token = null;
        this.tokenExpiresAt = 0;
        return send();
      }
      throw error;
    }
  }

  async searchArtists(query: string, limit = 20): Promise<ArtistSummary[]> {
    const payload = await this.get<{ artists: Paged<RawArtist> }>('/search', {
      q: query,
      type: 'artist',
      limit: Math.min(50, Math.max(1, limit)),
      market: this.config.official.market,
    });
    return (payload.artists?.items ?? []).map(toArtistSummary);
  }

  async getArtist(id: string): Promise<ArtistSummary> {
    return toArtistSummary(await this.get<RawArtist>(`/artists/${id}`));
  }

  /** Every release credited to the artist, including ones they only appear on. */
  async getArtistReleases(id: string, includeAppearsOn: boolean): Promise<ReleaseRef[]> {
    const groups = includeAppearsOn
      ? 'album,single,compilation,appears_on'
      : 'album,single,compilation';

    const releases: ReleaseRef[] = [];
    const seen = new Set<string>();
    let url: string | null = null;
    let offset = 0;

    while (releases.length < this.config.limits.maxReleases) {
      const page: Paged<RawAlbum> = url
        ? await this.get<Paged<RawAlbum>>(url)
        : await this.get<Paged<RawAlbum>>(`/artists/${id}/albums`, {
            include_groups: groups,
            limit: PAGE_LIMIT,
            offset,
            market: this.config.official.market,
          });

      for (const raw of page.items ?? []) {
        if (seen.has(raw.id)) continue;
        seen.add(raw.id);
        releases.push(toRelease(raw));
      }

      if (!page.next) break;
      url = page.next;
      offset += PAGE_LIMIT;
    }

    return releases.slice(0, this.config.limits.maxReleases);
  }

  /** Full track listings for the given releases, batched 20 albums at a time. */
  async getAlbumsWithTracks(releases: readonly ReleaseRef[]): Promise<AlbumWithTracks[]> {
    const batches = chunk(releases, ALBUM_BATCH);
    const byId = new Map(releases.map((release) => [release.id, release]));

    const results = await mapWithConcurrency(
      batches,
      this.config.limits.concurrency,
      async (batch): Promise<AlbumWithTracks[]> => {
       try {
        const payload = await this.get<{ albums: Array<RawAlbum | null> }>('/albums', {
          ids: batch.map((release) => release.id).join(','),
          market: this.config.official.market,
        });

        const out: AlbumWithTracks[] = [];
        for (const album of payload.albums ?? []) {
          if (!album) continue;
          const tracks = [...(album.tracks?.items ?? [])];
          // Albums with >50 tracks (compilations, deluxe box sets) need paging.
          let next = album.tracks?.next ?? null;
          while (next) {
            const page = await this.get<Paged<RawTrack>>(next);
            tracks.push(...(page.items ?? []));
            next = page.next;
          }
          out.push({
            release: byId.get(album.id) ?? toRelease(album),
            tracks,
            artists: album.artists ?? [],
          });
        }
        return out;
       } catch (error) {
        // One unreadable batch must not take the whole catalogue down; the
        // caller reports the shortfall as a warning instead.
        log.warn(
          `could not read ${batch.length} album(s)`,
          error instanceof Error ? error.message : String(error),
        );
        return [];
       }
      },
    );

    return results.flat();
  }

  /**
   * Hydrate popularity for tracks. `/v1/albums` omits per-track popularity, so
   * it has to be fetched from `/v1/tracks` in batches of 50.
   */
  async getTrackPopularity(ids: readonly string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const batches = chunk([...new Set(ids)], TRACK_BATCH);

    await mapWithConcurrency(batches, this.config.limits.concurrency, async (batch) => {
      const payload = await this.get<{ tracks: Array<RawTrack | null> }>('/tracks', {
        ids: batch.join(','),
        market: this.config.official.market,
      });
      for (const track of payload.tracks ?? []) {
        if (track?.id && typeof track.popularity === 'number') {
          out.set(track.id, track.popularity);
        }
      }
    });

    return out;
  }
}
