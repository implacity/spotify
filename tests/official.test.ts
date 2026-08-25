import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { OfficialClient } from '../src/spotify/official.js';

/** Route stubbed responses by URL substring. */
function stubFetch(routes: Array<[RegExp | string, unknown | ((url: string) => unknown)]>) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    for (const [matcher, payload] of routes) {
      const hit = typeof matcher === 'string' ? url.includes(matcher) : matcher.test(url);
      if (!hit) continue;
      const body = typeof payload === 'function' ? (payload as (u: string) => unknown)(url) : payload;
      if (body instanceof Response) return body;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ error: 'unrouted', url }), { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

const TOKEN_ROUTE: [string, unknown] = [
  'accounts.spotify.com',
  { access_token: 'test-token', expires_in: 3600 },
];

function makeConfig() {
  return loadConfig({
    ...process.env,
    SPOTIFY_CLIENT_ID: 'id',
    SPOTIFY_CLIENT_SECRET: 'secret',
    SPOTIFY_CONCURRENCY: '4',
  } as NodeJS.ProcessEnv);
}

beforeEach(() => {
  process.env.SPOTIFY_CLIENT_ID = 'id';
  process.env.SPOTIFY_CLIENT_SECRET = 'secret';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.SPOTIFY_CLIENT_ID;
  delete process.env.SPOTIFY_CLIENT_SECRET;
});

describe('authentication', () => {
  it('requests a client-credentials token and reuses it', async () => {
    const { calls } = stubFetch([
      TOKEN_ROUTE,
      ['/v1/artists/', { id: 'a1', name: 'Nova Ardent', external_urls: { spotify: 'u' } }],
    ]);
    const client = new OfficialClient(makeConfig());

    await client.getArtist('a1');
    await client.getArtist('a1');

    const tokenCalls = calls.filter((url) => url.includes('accounts.spotify.com'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('sends the token as a bearer header', async () => {
    const { fetchMock } = stubFetch([TOKEN_ROUTE, ['/v1/artists/', { id: 'a1', name: 'X' }]]);
    await new OfficialClient(makeConfig()).getArtist('a1');

    const artistCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1/artists/'));
    const headers = (artistCall?.[1] as RequestInit | undefined)?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-token');
  });

  it('re-authenticates once when a token is rejected mid-flight', async () => {
    let artistCalls = 0;
    const { calls } = stubFetch([
      TOKEN_ROUTE,
      [
        '/v1/artists/',
        () => {
          artistCalls += 1;
          // First call fails as if the token was revoked early.
          if (artistCalls === 1) return new Response('{"error":"expired"}', { status: 401 });
          return { id: 'a1', name: 'Nova Ardent' };
        },
      ],
    ]);

    const artist = await new OfficialClient(makeConfig()).getArtist('a1');

    expect(artist.name).toBe('Nova Ardent');
    expect(calls.filter((url) => url.includes('accounts.spotify.com'))).toHaveLength(2);
  });

  it('explains what is missing when credentials are absent', async () => {
    stubFetch([]);
    const config = loadConfig({ ...process.env, SPOTIFY_CLIENT_ID: '', SPOTIFY_CLIENT_SECRET: '' } as NodeJS.ProcessEnv);
    const client = new OfficialClient(config);
    expect(client.configured).toBe(false);
    await expect(client.getArtist('a1')).rejects.toThrow(/SPOTIFY_CLIENT_ID/);
  });
});

describe('searchArtists', () => {
  it('maps the search payload onto artist summaries', async () => {
    stubFetch([
      TOKEN_ROUTE,
      [
        '/v1/search',
        {
          artists: {
            items: [
              {
                id: 'a1',
                name: 'Nova Ardent',
                genres: ['synth-pop'],
                popularity: 81,
                followers: { total: 4_812_339 },
                images: [
                  { url: 'big.jpg', width: 640, height: 640 },
                  { url: 'medium.jpg', width: 320, height: 320 },
                ],
                external_urls: { spotify: 'https://open.spotify.com/artist/a1' },
              },
            ],
            next: null,
            total: 1,
          },
        },
      ],
    ]);

    const [artist] = await new OfficialClient(makeConfig()).searchArtists('nova');

    expect(artist).toMatchObject({
      id: 'a1',
      name: 'Nova Ardent',
      followers: 4_812_339,
      popularity: 81,
      genres: ['synth-pop'],
    });
    // The mid-size image is preferred over the 640px one for table use.
    expect(artist!.image).toBe('medium.jpg');
  });

  it('returns an empty list when Spotify has no matches', async () => {
    stubFetch([TOKEN_ROUTE, ['/v1/search', { artists: { items: [], next: null, total: 0 } }]]);
    expect(await new OfficialClient(makeConfig()).searchArtists('zzzz')).toEqual([]);
  });
});

describe('getArtistReleases', () => {
  it('follows pagination and de-duplicates repeated releases', async () => {
    const page1 = {
      items: [
        { id: 'al1', name: 'One', album_type: 'album', album_group: 'album', release_date: '2019-01-01', release_date_precision: 'day', total_tracks: 8 },
        { id: 'al2', name: 'Two', album_type: 'single', album_group: 'single', release_date: '2020-01-01', release_date_precision: 'day', total_tracks: 1 },
      ],
      next: 'https://api.spotify.com/v1/artists/a1/albums?offset=50',
      total: 3,
    };
    const page2 = {
      items: [
        // Duplicate of al1 — Spotify repeats releases across markets/groups.
        { id: 'al1', name: 'One', album_type: 'album', album_group: 'album', release_date: '2019-01-01', release_date_precision: 'day', total_tracks: 8 },
        { id: 'al3', name: 'Three', album_type: 'compilation', album_group: 'appears_on', release_date: '2021', release_date_precision: 'year', total_tracks: 20 },
      ],
      next: null,
      total: 3,
    };

    stubFetch([
      TOKEN_ROUTE,
      ['offset=50', page2],
      ['/albums', page1],
    ]);

    const releases = await new OfficialClient(makeConfig()).getArtistReleases('a1', true);

    expect(releases.map((release) => release.id)).toEqual(['al1', 'al2', 'al3']);
    expect(releases[2]!.type).toBe('appears_on');
    expect(releases[2]!.releaseDatePrecision).toBe('year');
  });

  it('omits appears_on releases when asked to', async () => {
    const { calls } = stubFetch([TOKEN_ROUTE, ['/albums', { items: [], next: null, total: 0 }]]);
    await new OfficialClient(makeConfig()).getArtistReleases('a1', false);

    const albumsCall = calls.find((url) => url.includes('/albums'))!;
    expect(decodeURIComponent(albumsCall)).toContain('include_groups=album,single,compilation');
    expect(decodeURIComponent(albumsCall)).not.toContain('appears_on');
  });

  it('stops at the configured release ceiling', async () => {
    const config = loadConfig({
      ...process.env,
      SPOTIFY_CLIENT_ID: 'id',
      SPOTIFY_CLIENT_SECRET: 'secret',
      SPOTIFY_MAX_RELEASES: '3',
    } as NodeJS.ProcessEnv);

    const items = Array.from({ length: 50 }, (_, index) => ({
      id: `al${index}`,
      name: `Album ${index}`,
      album_type: 'album',
      album_group: 'album',
      release_date: '2020-01-01',
      release_date_precision: 'day',
      total_tracks: 1,
    }));

    stubFetch([TOKEN_ROUTE, ['/albums', { items, next: null, total: 50 }]]);
    const releases = await new OfficialClient(config).getArtistReleases('a1', true);
    expect(releases).toHaveLength(3);
  });
});

describe('getAlbumsWithTracks', () => {
  const releaseRef = (id: string) => ({
    id,
    name: `Album ${id}`,
    type: 'album' as const,
    releaseDate: '2020-01-01',
    releaseDatePrecision: 'day' as const,
    totalTracks: 2,
    image: null,
    url: `https://open.spotify.com/album/${id}`,
  });

  it('batches album ids 20 at a time', async () => {
    const releases = Array.from({ length: 45 }, (_, index) => releaseRef(`al${index}`));
    const { calls } = stubFetch([
      TOKEN_ROUTE,
      [
        '/v1/albums?',
        (url: string) => {
          const ids = new URL(url).searchParams.get('ids')!.split(',');
          return {
            albums: ids.map((id) => ({
              id,
              name: `Album ${id}`,
              album_type: 'album',
              release_date: '2020-01-01',
              release_date_precision: 'day',
              total_tracks: 1,
              tracks: { items: [{ id: `${id}-t1`, name: 'Track', duration_ms: 1000, explicit: false, disc_number: 1, track_number: 1 }], next: null },
            })),
          };
        },
      ],
    ]);

    const albums = await new OfficialClient(makeConfig()).getAlbumsWithTracks(releases);

    expect(albums).toHaveLength(45);
    const albumCalls = calls.filter((url) => url.includes('/v1/albums?'));
    expect(albumCalls).toHaveLength(3); // 20 + 20 + 5
    for (const call of albumCalls) {
      expect(new URL(call).searchParams.get('ids')!.split(',').length).toBeLessThanOrEqual(20);
    }
  });

  it('pages through albums with more than 50 tracks', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      id: `t${index}`,
      name: `Track ${index}`,
      duration_ms: 1000,
      explicit: false,
      disc_number: 1,
      track_number: index + 1,
    }));
    const secondPage = Array.from({ length: 12 }, (_, index) => ({
      id: `t${50 + index}`,
      name: `Track ${50 + index}`,
      duration_ms: 1000,
      explicit: false,
      disc_number: 1,
      track_number: 51 + index,
    }));

    stubFetch([
      TOKEN_ROUTE,
      ['offset=50', { items: secondPage, next: null, total: 62 }],
      [
        '/v1/albums?',
        {
          albums: [
            {
              id: 'big',
              name: 'Box Set',
              album_type: 'compilation',
              release_date: '2020-01-01',
              release_date_precision: 'day',
              total_tracks: 62,
              tracks: {
                items: firstPage,
                next: 'https://api.spotify.com/v1/albums/big/tracks?offset=50&limit=50',
              },
            },
          ],
        },
      ],
    ]);

    const [album] = await new OfficialClient(makeConfig()).getAlbumsWithTracks([
      { ...releaseRef('big'), totalTracks: 62 },
    ]);

    expect(album!.tracks).toHaveLength(62);
  });

  it('skips null album entries', async () => {
    stubFetch([TOKEN_ROUTE, ['/v1/albums?', { albums: [null] }]]);
    const albums = await new OfficialClient(makeConfig()).getAlbumsWithTracks([releaseRef('gone')]);
    expect(albums).toEqual([]);
  });
});

describe('getTrackPopularity', () => {
  it('batches track ids 50 at a time and maps them by id', async () => {
    const ids = Array.from({ length: 120 }, (_, index) => `t${index}`);
    const { calls } = stubFetch([
      TOKEN_ROUTE,
      [
        '/v1/tracks?',
        (url: string) => ({
          tracks: new URL(url).searchParams
            .get('ids')!
            .split(',')
            .map((id) => ({ id, name: id, duration_ms: 1, explicit: false, disc_number: 1, track_number: 1, popularity: 42 })),
        }),
      ],
    ]);

    const popularity = await new OfficialClient(makeConfig()).getTrackPopularity(ids);

    expect(popularity.size).toBe(120);
    expect(popularity.get('t7')).toBe(42);
    const trackCalls = calls.filter((url) => url.includes('/v1/tracks?'));
    expect(trackCalls).toHaveLength(3); // 50 + 50 + 20
  });

  it('de-duplicates ids before requesting them', async () => {
    const { calls } = stubFetch([
      TOKEN_ROUTE,
      ['/v1/tracks?', { tracks: [{ id: 'dup', popularity: 5, name: 'x', duration_ms: 1, explicit: false, disc_number: 1, track_number: 1 }] }],
    ]);

    await new OfficialClient(makeConfig()).getTrackPopularity(['dup', 'dup', 'dup']);

    const trackCall = calls.find((url) => url.includes('/v1/tracks?'))!;
    expect(new URL(trackCall).searchParams.get('ids')).toBe('dup');
  });

  it('tolerates null entries for unavailable tracks', async () => {
    stubFetch([TOKEN_ROUTE, ['/v1/tracks?', { tracks: [null, { id: 'ok', popularity: 3 }] }]]);
    const popularity = await new OfficialClient(makeConfig()).getTrackPopularity(['gone', 'ok']);
    expect(popularity.size).toBe(1);
    expect(popularity.get('ok')).toBe(3);
  });
});
