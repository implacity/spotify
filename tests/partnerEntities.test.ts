import { describe, expect, it } from 'vitest';
import {
  collectNodes,
  extractAlbums,
  extractArtists,
  extractTracks,
  parseUri,
  readReleaseDate,
} from '../src/spotify/partnerEntities.js';

/**
 * Fixtures mirror the shapes the web player has actually shipped, including
 * the wrapper differences between search results and artist queries. The
 * readers must cope with all of them, since Spotify changes these freely.
 */

const searchResponse = {
  data: {
    searchV2: {
      artists: {
        totalCount: 2,
        items: [
          {
            data: {
              uri: 'spotify:artist:artist1aaaaaaaaaaaaaaa',
              profile: { name: 'Bladee', verified: true },
              visuals: {
                avatarImage: {
                  sources: [
                    { url: 'small.jpg', width: 160, height: 160 },
                    { url: 'medium.jpg', width: 320, height: 320 },
                  ],
                },
              },
            },
          },
          {
            data: {
              uri: 'spotify:artist:artist2bbbbbbbbbbbbbbb',
              profile: { name: 'Ecco2k' },
              visuals: { avatarImage: { sources: [] } },
            },
          },
        ],
      },
    },
  },
};

const discographyResponse = {
  data: {
    artistUnion: {
      uri: 'spotify:artist:artist1aaaaaaaaaaaaaaa',
      discography: {
        all: {
          items: [
            {
              releases: {
                items: [
                  {
                    uri: 'spotify:album:album1cccccccccccccc',
                    name: '333',
                    type: 'ALBUM',
                    date: { year: 2020, month: 4, day: 24 },
                    tracks: { totalCount: 12 },
                    coverArt: { sources: [{ url: 'cover-s.jpg' }, { url: 'cover-m.jpg' }] },
                  },
                ],
              },
            },
            {
              releases: {
                items: [
                  {
                    uri: 'spotify:album:album2dddddddddddddd',
                    name: 'Red Light',
                    type: 'SINGLE',
                    date: { year: 2018 },
                    tracks: { totalCount: 1 },
                  },
                ],
              },
            },
          ],
        },
      },
    },
  },
};

const albumResponse = {
  data: {
    albumUnion: {
      uri: 'spotify:album:album1cccccccccccccc',
      name: '333',
      tracksV2: {
        items: [
          {
            track: {
              uri: 'spotify:track:track1eeeeeeeeeeeeeee',
              name: 'Western Union',
              playcount: '48120394',
              duration: { totalMilliseconds: 187000 },
              trackNumber: 1,
              discNumber: 1,
              contentRating: { label: 'EXPLICIT' },
              artists: {
                items: [
                  { uri: 'spotify:artist:artist1aaaaaaaaaaaaaaa', profile: { name: 'Bladee' } },
                ],
              },
            },
          },
        ],
      },
    },
  },
};

describe('parseUri', () => {
  it('splits a Spotify URI into kind and id', () => {
    expect(parseUri('spotify:track:abc123')).toEqual({ kind: 'track', id: 'abc123' });
    expect(parseUri('spotify:artist:xyz')).toEqual({ kind: 'artist', id: 'xyz' });
  });

  it('rejects anything that is not a Spotify URI', () => {
    expect(parseUri('https://open.spotify.com/track/abc')).toBeNull();
    expect(parseUri('spotify:track:')).toBeNull();
    expect(parseUri(42)).toBeNull();
    expect(parseUri(null)).toBeNull();
  });
});

describe('collectNodes', () => {
  it('finds nodes of one kind anywhere in the tree', () => {
    expect(collectNodes(searchResponse, 'artist')).toHaveLength(2);
    expect(collectNodes(searchResponse, 'album')).toHaveLength(0);
  });

  it('de-duplicates repeated ids', () => {
    const payload = { a: { uri: 'spotify:album:dup' }, b: { uri: 'spotify:album:dup' } };
    expect(collectNodes(payload, 'album')).toHaveLength(1);
  });

  it('survives cyclic structures', () => {
    const node: Record<string, unknown> = { uri: 'spotify:track:cyc' };
    node.self = node;
    expect(() => collectNodes(node, 'track')).not.toThrow();
    expect(collectNodes(node, 'track')).toHaveLength(1);
  });
});

describe('extractArtists', () => {
  it('reads artists out of a search response', () => {
    const artists = extractArtists(searchResponse);
    expect(artists.map((artist) => artist.name)).toEqual(['Bladee', 'Ecco2k']);
    expect(artists[0]).toMatchObject({ id: 'artist1aaaaaaaaaaaaaaa', verified: true });
    // Middle source preferred for a thumbnail.
    expect(artists[0]!.image).toBe('medium.jpg');
  });

  it('tolerates a missing image set', () => {
    expect(extractArtists(searchResponse)[1]!.image).toBeNull();
  });

  it('reads monthly listeners when the payload carries them', () => {
    const payload = {
      artistUnion: {
        uri: 'spotify:artist:solo',
        profile: { name: 'Solo' },
        stats: { followers: 1234, monthlyListeners: 98765 },
      },
    };
    expect(extractArtists(payload)[0]).toMatchObject({
      followers: 1234,
      monthlyListeners: 98765,
    });
  });

  it('skips nodes with no usable name', () => {
    expect(extractArtists({ uri: 'spotify:artist:nameless' })).toEqual([]);
  });
});

describe('extractAlbums', () => {
  it('reads a nested discography response', () => {
    const albums = extractAlbums(discographyResponse);
    expect(albums).toHaveLength(2);

    expect(albums[0]).toMatchObject({
      id: 'album1cccccccccccccc',
      name: '333',
      type: 'album',
      releaseDate: '2020-04-24',
      releaseDatePrecision: 'day',
      totalTracks: 12,
    });
    expect(albums[1]).toMatchObject({ type: 'single', releaseDate: '2018', releaseDatePrecision: 'year' });
  });

  it('maps release types onto the shared vocabulary', () => {
    const types = ['ALBUM', 'SINGLE', 'COMPILATION', 'EP'].map(
      (type) => extractAlbums({ uri: `spotify:album:x${type}`, name: 'n', type })[0]!.type,
    );
    expect(types).toEqual(['album', 'single', 'compilation', 'single']);
  });
});

describe('readReleaseDate', () => {
  it('handles the structured form at each precision', () => {
    expect(readReleaseDate({ year: 2020, month: 4, day: 24 })).toEqual({
      date: '2020-04-24',
      precision: 'day',
    });
    expect(readReleaseDate({ year: 2020, month: 4 })).toEqual({ date: '2020-04', precision: 'month' });
    expect(readReleaseDate({ year: 2020 })).toEqual({ date: '2020', precision: 'year' });
  });

  it('handles ISO strings', () => {
    expect(readReleaseDate({ isoString: '2020-04-24T00:00:00Z' })).toEqual({
      date: '2020-04-24',
      precision: 'day',
    });
    expect(readReleaseDate('2019-07-05')).toEqual({ date: '2019-07-05', precision: 'day' });
  });

  it('degrades to an empty date rather than throwing', () => {
    expect(readReleaseDate(null).date).toBe('');
    expect(readReleaseDate({}).date).toBe('');
  });
});

describe('extractTracks', () => {
  it('reads tracks with their play counts', () => {
    const tracks = extractTracks(albumResponse);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({
      id: 'track1eeeeeeeeeeeeeee',
      name: 'Western Union',
      playCount: 48_120_394,
      durationMs: 187_000,
      trackNumber: 1,
      explicit: true,
    });
    expect(tracks[0]!.artists).toEqual([
      { id: 'artist1aaaaaaaaaaaaaaa', name: 'Bladee' },
    ]);
  });

  it('treats a hidden count as unknown rather than zero', () => {
    const tracks = extractTracks({ uri: 'spotify:track:hidden', name: 'x', playcount: '-1' });
    expect(tracks[0]!.playCount).toBeNull();
  });

  it('keeps a genuine zero', () => {
    const tracks = extractTracks({ uri: 'spotify:track:zero', name: 'x', playcount: '0' });
    expect(tracks[0]!.playCount).toBe(0);
  });

  it('handles the older flat shape without a track wrapper', () => {
    const legacy = {
      album: {
        tracks: {
          items: [
            { uri: 'spotify:track:legacy1', name: 'Old', playcount: 12, duration: { totalMilliseconds: 1000 } },
          ],
        },
      },
    };
    expect(extractTracks(legacy)[0]).toMatchObject({ id: 'legacy1', name: 'Old', playCount: 12 });
  });

  it('marks non-explicit tracks correctly', () => {
    const tracks = extractTracks({ uri: 'spotify:track:clean', name: 'x', contentRating: { label: 'NONE' } });
    expect(tracks[0]!.explicit).toBe(false);
  });
});
