import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ArtistService } from '../src/service.js';
import { searchVariables } from '../src/spotify/partner.js';

/**
 * End-to-end cover for the no-credentials path: search, discography and
 * catalogue built entirely from the web-player API, with no Web API client id
 * and no Premium subscription involved.
 *
 * The transport is stubbed, so this proves the wiring, request shapes and
 * assembly — not that Spotify's live endpoint still answers this way.
 */

const HASH = 'a'.repeat(64);
const ARTIST = 'artist1aaaaaaaaaaaaaaa';

function partnerConfig(overrides: Record<string, string> = {}) {
  return loadConfig({
    SPOTIFY_SOURCE: 'partner',
    // Pinning hashes and a token skips discovery and auth, which are covered
    // separately; this test is about the catalogue assembly.
    SPOTIFY_PARTNER_TOKEN: 'test-token',
    SPOTIFY_PQ_SEARCHSUGGESTIONS: HASH,
    SPOTIFY_PQ_QUERYARTISTDISCOGRAPHYALL: HASH,
    SPOTIFY_PQ_GETALBUM: HASH,
    SPOTIFY_PQ_QUERYARTISTOVERVIEW: HASH,
    CACHE_DIR: '',
    SPOTIFY_CONCURRENCY: '4',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

const artistNode = {
  uri: `spotify:artist:${ARTIST}`,
  profile: { name: 'Bladee', verified: true },
  stats: { followers: 900_000, monthlyListeners: 4_200_000 },
  visuals: { avatarImage: { sources: [{ url: 'a.jpg' }, { url: 'b.jpg' }] } },
};

const albums = [
  { id: 'album1cccccccccccccc', name: '333', type: 'ALBUM', year: 2020, tracks: 2 },
  { id: 'album2dddddddddddddd', name: 'Red Light', type: 'SINGLE', year: 2018, tracks: 1 },
];

/** Two albums that share a recording, so duplicate merging is exercised. */
const albumTracks: Record<string, unknown> = {
  album1cccccccccccccc: {
    data: {
      albumUnion: {
        uri: 'spotify:album:album1cccccccccccccc',
        tracksV2: {
          items: [
            {
              track: {
                uri: 'spotify:track:trackAAAAAAAAAAAAAAA',
                name: 'Western Union',
                playcount: '48120394',
                duration: { totalMilliseconds: 187000 },
                trackNumber: 1,
                discNumber: 1,
                artists: { items: [{ uri: `spotify:artist:${ARTIST}`, profile: { name: 'Bladee' } }] },
              },
            },
            {
              track: {
                uri: 'spotify:track:trackBBBBBBBBBBBBBBB',
                name: 'Be Nice 2 Me',
                playcount: '91000000',
                duration: { totalMilliseconds: 165000 },
                trackNumber: 2,
                discNumber: 1,
                artists: { items: [{ uri: `spotify:artist:${ARTIST}`, profile: { name: 'Bladee' } }] },
              },
            },
          ],
        },
      },
    },
  },
  album2dddddddddddddd: {
    data: {
      albumUnion: {
        uri: 'spotify:album:album2dddddddddddddd',
        tracksV2: {
          items: [
            {
              track: {
                // Same recording as on the album, lower count.
                uri: 'spotify:track:trackCCCCCCCCCCCCCCC',
                name: 'Western Union',
                playcount: '120000',
                duration: { totalMilliseconds: 187000 },
                trackNumber: 1,
                discNumber: 1,
                artists: { items: [{ uri: `spotify:artist:${ARTIST}`, profile: { name: 'Bladee' } }] },
              },
            },
          ],
        },
      },
    },
  },
};

function stubPathfinder(options: { failAlbum?: string } = {}) {
  const operations: string[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const operation = url.searchParams.get('operationName') ?? '';
      operations.push(operation);
      const variables = JSON.parse(url.searchParams.get('variables') ?? '{}');

      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });

      if (operation === 'searchSuggestions' || operation === 'searchArtists') {
        return json({ data: { searchV2: { artists: { items: [{ data: artistNode }] } } } });
      }

      if (operation === 'queryArtistOverview') {
        return json({ data: { artistUnion: artistNode } });
      }

      if (operation === 'queryArtistDiscographyAll') {
        // Second page empty, so paging terminates.
        if ((variables.offset ?? 0) > 0) {
          return json({ data: { artistUnion: { discography: { all: { items: [] } } } } });
        }
        return json({
          data: {
            artistUnion: {
              uri: `spotify:artist:${ARTIST}`,
              discography: {
                all: {
                  items: albums.map((album) => ({
                    releases: {
                      items: [
                        {
                          uri: `spotify:album:${album.id}`,
                          name: album.name,
                          type: album.type,
                          date: { year: album.year },
                          tracks: { totalCount: album.tracks },
                        },
                      ],
                    },
                  })),
                },
              },
            },
          },
        });
      }

      if (operation === 'getAlbum') {
        const id = String(variables.uri ?? '').split(':').pop() ?? '';
        if (options.failAlbum === id) {
          return new Response('{"errors":[{"message":"boom"}]}', { status: 500 });
        }
        return json(albumTracks[id] ?? {});
      }

      return new Response('{}', { status: 404 });
    }),
  );

  return { operations };
}

// Every test in this file talks to the stubbed pathfinder; the few that need
// a different behaviour re-stub with options.
beforeEach(() => {
  stubPathfinder();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('searchVariables', () => {
  it('matches the shape a live searchSuggestions request sends', () => {
    // Captured from a real web-player request. Persisted queries validate
    // variables against the stored document, so an undeclared extra is
    // rejected outright — this set has to stay exact.
    expect(searchVariables('searchSuggestions', 'bladee', 30)).toEqual({
      query: 'bladee',
      limit: 30,
      numberOfTopResults: 30,
      offset: 0,
      includeAuthors: true,
      includeAlbumPreReleases: false,
      includeEpisodeContentRatingsV2: true,
    });
  });

  it('never mixes searchTerm into searchSuggestions', () => {
    // Sending both keys would fail validation on whichever is undeclared.
    expect(searchVariables('searchSuggestions', 'x', 5)).not.toHaveProperty('searchTerm');
    expect(searchVariables('searchDesktop', 'x', 5)).not.toHaveProperty('query');
  });

  it('uses searchTerm for the older desktop spellings', () => {
    expect(searchVariables('searchDesktop', 'bladee', 10)).toMatchObject({
      searchTerm: 'bladee',
      limit: 10,
    });
    expect(searchVariables('searchArtists', 'bladee', 10)).toMatchObject({ searchTerm: 'bladee' });
  });

  it('falls back to sending both term keys for an unknown operation', () => {
    const variables = searchVariables('searchSomethingNew', 'bladee', 10);
    expect(variables).toMatchObject({ query: 'bladee', searchTerm: 'bladee' });
  });
});

describe('source selection', () => {
  it('uses the web player when there are no Web API credentials', () => {
    const service = new ArtistService(loadConfig({ CACHE_DIR: '' } as NodeJS.ProcessEnv));
    expect(service.activeSource).toBe('partner');
  });

  it('prefers the documented API when credentials exist', () => {
    const service = new ArtistService(
      loadConfig({ SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret', CACHE_DIR: '' } as NodeJS.ProcessEnv),
    );
    expect(service.activeSource).toBe('official');
  });

  it('honours an explicit override even with credentials present', () => {
    const service = new ArtistService(
      loadConfig({
        SPOTIFY_SOURCE: 'partner',
        SPOTIFY_CLIENT_ID: 'id',
        SPOTIFY_CLIENT_SECRET: 'secret',
        CACHE_DIR: '',
      } as NodeJS.ProcessEnv),
    );
    expect(service.activeSource).toBe('partner');
  });

  it('reports the active source in status', () => {
    const service = new ArtistService(partnerConfig());
    expect(service.status().activeSource).toBe('partner');
  });
});

describe('falling back when the app owner has no Premium', () => {
  const PREMIUM_403 =
    'Active premium subscription required for the owner of the app. When the ' +
    'subscription status changes, it can take a few hours before requests are allowed again.';

  /** Web API always 403s on subscription; the web player answers normally. */
  function stubPremiumRefusal() {
    const base = stubPathfinder();
    const pathfinder = globalThis.fetch as unknown as (input: RequestInfo | URL) => Promise<Response>;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('accounts.spotify.com')) {
          return new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.includes('api.spotify.com')) return new Response(PREMIUM_403, { status: 403 });
        return pathfinder(input);
      }),
    );
    return base;
  }

  const withCredentials = () =>
    partnerConfig({
      SPOTIFY_SOURCE: 'auto',
      SPOTIFY_CLIENT_ID: 'id',
      SPOTIFY_CLIENT_SECRET: 'secret',
    });

  it('starts on the documented API when credentials are present', () => {
    expect(new ArtistService(withCredentials()).activeSource).toBe('official');
  });

  it('serves search from the web player instead of failing', async () => {
    stubPremiumRefusal();
    const service = new ArtistService(withCredentials());

    const artists = await service.search('bladee');

    expect(artists[0]).toMatchObject({ name: 'Bladee' });
    expect(service.activeSource).toBe('partner');
    expect(service.status().officialBlocked).toBe(true);
  });

  it('serves a full catalogue after falling back', async () => {
    stubPremiumRefusal();
    const catalog = await new ArtistService(withCredentials()).getCatalog(ARTIST, {
      groupDuplicates: false,
    });

    expect(catalog.artist.name).toBe('Bladee');
    expect(catalog.tracks.length).toBeGreaterThan(0);
  });

  it('does not retry the Web API once it has refused', async () => {
    stubPremiumRefusal();
    const service = new ArtistService(withCredentials());
    await service.search('bladee');

    const before = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.length;
    await service.search('ecco');
    const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;

    // The second search must not touch api.spotify.com again.
    expect(calls.slice(before).some(([url]) => String(url).includes('api.spotify.com'))).toBe(false);
  });

  it('does not fall back when the source is pinned to official', async () => {
    stubPremiumRefusal();
    const service = new ArtistService(
      partnerConfig({
        SPOTIFY_SOURCE: 'official',
        SPOTIFY_CLIENT_ID: 'id',
        SPOTIFY_CLIENT_SECRET: 'secret',
      }),
    );
    // An explicit choice is honoured, error and all.
    await expect(service.search('bladee')).rejects.toThrow(/Premium subscription/i);
  });
});

describe('search without credentials', () => {
  it('returns artists from the web player', async () => {
    stubPathfinder();
    const artists = await new ArtistService(partnerConfig()).search('bladee');

    expect(artists).toHaveLength(1);
    expect(artists[0]).toMatchObject({
      id: ARTIST,
      name: 'Bladee',
      followers: 900_000,
      // No popularity score exists outside the documented API.
      popularity: null,
    });
  });

  it('sends the search term and a bearer token', async () => {
    stubPathfinder();
    await new ArtistService(partnerConfig()).search('bladee');

    const call = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const url = new URL(String(call[0]));
    expect(JSON.parse(url.searchParams.get('variables')!).query).toBe('bladee');
    expect(JSON.parse(url.searchParams.get('extensions')!).persistedQuery.sha256Hash).toBe(HASH);

    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-token');
  });
});

describe('catalogue without credentials', () => {
  it('builds a full catalogue with play counts', async () => {
    const catalog = await new ArtistService(partnerConfig()).getCatalog(ARTIST, {
      groupDuplicates: false,
    });

    expect(catalog.artist).toMatchObject({ name: 'Bladee', monthlyListeners: 4_200_000 });
    expect(catalog.releases).toHaveLength(2);
    expect(catalog.tracks).toHaveLength(3);

    const top = catalog.tracks[0]!;
    expect(top.name).toBe('Be Nice 2 Me');
    expect(top.playCount).toBe(91_000_000);
    expect(catalog.playCountsComplete).toBe(true);
  });

  it('sorts by play count descending', async () => {
    const catalog = await new ArtistService(partnerConfig()).getCatalog(ARTIST, {
      groupDuplicates: false,
    });
    const counts = catalog.tracks.map((track) => track.playCount ?? 0);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('merges the same recording across releases without summing', async () => {
    const catalog = await new ArtistService(partnerConfig()).getCatalog(ARTIST, {
      groupDuplicates: true,
    });

    const western = catalog.tracks.filter((track) => track.displayName === 'Western Union');
    expect(western).toHaveLength(1);
    expect(western[0]!.playCount).toBe(48_120_394);
    expect(western[0]!.duplicateCount).toBe(1);
  });

  it('reports popularity as absent rather than inventing it', async () => {
    const catalog = await new ArtistService(partnerConfig()).getCatalog(ARTIST);
    expect(catalog.tracks.every((track) => track.popularity === null)).toBe(true);
  });

  it('degrades to a warning when one album fails', async () => {
    stubPathfinder({ failAlbum: 'album2dddddddddddddd' });
    const catalog = await new ArtistService(partnerConfig()).getCatalog(ARTIST, {
      groupDuplicates: false,
    });

    // The readable album still renders.
    expect(catalog.tracks.length).toBeGreaterThan(0);
    expect(catalog.warnings.map((warning) => warning.code)).toContain('release_fetch_failed');
  });

  it('emits progress while building', async () => {
    stubPathfinder();
    const phases: string[] = [];
    await new ArtistService(partnerConfig()).getCatalog(ARTIST, {}, (progress) =>
      phases.push(progress.phase),
    );

    expect(phases).toContain('releases');
    expect(phases).toContain('playcounts');
    expect(phases[phases.length - 1]).toBe('done');
  });
});
