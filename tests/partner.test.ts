import { describe, expect, it } from 'vitest';
import { extractPlayCounts, findValue } from '../src/spotify/partner.js';
import {
  extractBundleUrls,
  extractPersistedQueries,
} from '../src/spotify/persistedQueries.js';

/**
 * The whole point of the structural extractor is surviving schema drift, so
 * these fixtures deliberately use the several shapes the web player has
 * shipped over time.
 */

const modernAlbum = {
  data: {
    albumUnion: {
      uri: 'spotify:album:abc',
      name: 'Deep Field',
      tracksV2: {
        totalCount: 2,
        items: [
          {
            uid: '1',
            track: {
              uri: 'spotify:track:track1aaaaaaaaaaaaaaaaa',
              name: 'Event Horizon',
              playcount: '184920034',
              duration: { totalMilliseconds: 214000 },
            },
          },
          {
            uid: '2',
            track: {
              uri: 'spotify:track:track2bbbbbbbbbbbbbbbbb',
              name: 'Redshift',
              playcount: '9120',
              duration: { totalMilliseconds: 198000 },
            },
          },
        ],
      },
    },
  },
};

const legacyAlbum = {
  data: {
    album: {
      tracks: {
        items: [
          { track: { uri: 'spotify:track:legacy1ccccccccccccccc', playcount: 42 } },
          // Older payloads nested one level less.
          { uri: 'spotify:track:legacy2ddddddddddddddd', playcount: '7' },
        ],
      },
    },
  },
};

describe('extractPlayCounts', () => {
  it('reads the modern tracksV2 shape', () => {
    const counts = extractPlayCounts(modernAlbum);
    expect(counts.get('track1aaaaaaaaaaaaaaaaa')).toBe(184_920_034);
    expect(counts.get('track2bbbbbbbbbbbbbbbbb')).toBe(9120);
    expect(counts.size).toBe(2);
  });

  it('reads older and flatter shapes without changes', () => {
    const counts = extractPlayCounts(legacyAlbum);
    expect(counts.get('legacy1ccccccccccccccc')).toBe(42);
    expect(counts.get('legacy2ddddddddddddddd')).toBe(7);
  });

  it('ignores non-track URIs', () => {
    const counts = extractPlayCounts({
      data: {
        artistUnion: {
          uri: 'spotify:artist:xyz',
          playcount: '999',
          albums: [{ uri: 'spotify:album:abc', playcount: '888' }],
        },
      },
    });
    expect(counts.size).toBe(0);
  });

  it('treats hidden counts (-1) and non-numeric values as absent', () => {
    const counts = extractPlayCounts({
      items: [
        { uri: 'spotify:track:hiddeneeeeeeeeeeeeeee', playcount: '-1' },
        { uri: 'spotify:track:emptyfffffffffffffff', playcount: '' },
        { uri: 'spotify:track:nullggggggggggggggggg', playcount: null },
        { uri: 'spotify:track:zerohhhhhhhhhhhhhhhh', playcount: '0' },
      ],
    });
    expect(counts.has('hiddeneeeeeeeeeeeeeee')).toBe(false);
    expect(counts.has('emptyfffffffffffffff')).toBe(false);
    expect(counts.has('nullggggggggggggggggg')).toBe(false);
    // Zero is a real answer: the track exists and has no plays.
    expect(counts.get('zerohhhhhhhhhhhhhhhh')).toBe(0);
  });

  it('keeps the highest reading when a track appears twice', () => {
    const counts = extractPlayCounts({
      a: { uri: 'spotify:track:dupiiiiiiiiiiiiiiiii', playcount: '0' },
      b: { uri: 'spotify:track:dupiiiiiiiiiiiiiiiii', playcount: '5000' },
    });
    expect(counts.get('dupiiiiiiiiiiiiiiiii')).toBe(5000);
  });

  it('accepts the camelCase spelling too', () => {
    const counts = extractPlayCounts({ uri: 'spotify:track:cameljjjjjjjjjjjjjjj', playCount: 12 });
    expect(counts.get('cameljjjjjjjjjjjjjjj')).toBe(12);
  });

  it('survives cyclic structures', () => {
    const node: Record<string, unknown> = { uri: 'spotify:track:cyclekkkkkkkkkkkkkkk', playcount: '3' };
    node.self = node;
    expect(() => extractPlayCounts(node)).not.toThrow();
    expect(extractPlayCounts(node).get('cyclekkkkkkkkkkkkkkk')).toBe(3);
  });

  it('returns nothing for junk input', () => {
    expect(extractPlayCounts(null).size).toBe(0);
    expect(extractPlayCounts('nope').size).toBe(0);
    expect(extractPlayCounts({ errors: [{ message: 'PersistedQueryNotFound' }] }).size).toBe(0);
  });
});

describe('findValue', () => {
  const overview = {
    data: {
      artistUnion: {
        profile: { name: 'Nova Ardent', verified: true },
        stats: { monthlyListeners: 22_401_882, followers: 4_812_339 },
      },
    },
  };

  it('finds a deeply nested key', () => {
    expect(findValue(overview, 'monthlyListeners')).toBe(22_401_882);
    expect(findValue(overview, 'verified')).toBe(true);
  });

  it('returns undefined when the key is absent', () => {
    expect(findValue(overview, 'topCity')).toBeUndefined();
  });

  it('skips null values rather than returning them', () => {
    expect(findValue({ a: { monthlyListeners: null }, b: { monthlyListeners: 5 } }, 'monthlyListeners')).toBe(5);
  });
});

describe('extractPersistedQueries', () => {
  it('reads the name-then-hash bundle shape', () => {
    const source =
      'x={name:"queryArtistOverview",operationKind:"query",value:"' + 'a'.repeat(64) + '"};';
    expect(extractPersistedQueries(source)).toEqual({ queryArtistOverview: 'a'.repeat(64) });
  });

  it('reads the hash-then-name shape', () => {
    const source = 'e=["' + 'b'.repeat(64) + '",{name:"getAlbum",operationKind:"query"}]';
    expect(extractPersistedQueries(source).getAlbum).toBe('b'.repeat(64));
  });

  it('reads the explicit sha256Hash shape', () => {
    const source = '{operationName:"getAlbum",extensions:{sha256Hash:"' + 'c'.repeat(64) + '"}}';
    expect(extractPersistedQueries(source).getAlbum).toBe('c'.repeat(64));
  });

  it('finds several operations in one bundle', () => {
    const source =
      '{name:"queryArtistOverview",value:"' + 'd'.repeat(64) + '"},' +
      '{name:"getAlbum",value:"' + 'e'.repeat(64) + '"}';
    const found = extractPersistedQueries(source);
    expect(Object.keys(found).sort()).toEqual(['getAlbum', 'queryArtistOverview']);
  });

  it('ignores strings that are not 64-char hex', () => {
    expect(extractPersistedQueries('{name:"getAlbum",value:"deadbeef"}')).toEqual({});
    expect(extractPersistedQueries('nothing here')).toEqual({});
  });
});

describe('extractBundleUrls', () => {
  it('collects script sources and resolves them against the player origin', () => {
    const html = `
      <script src="/cdn/build/web-player.abc123.js"></script>
      <script src="https://open-web-player.spotifycdn.com/vendor~xpui.def456.js"></script>
      <link rel="preload" href="/cdn/build/xpui.ghi789.js">
    `;
    const urls = extractBundleUrls(html);
    expect(urls).toContain('https://open.spotify.com/cdn/build/web-player.abc123.js');
    expect(urls).toContain('https://open-web-player.spotifycdn.com/vendor~xpui.def456.js');
    expect(urls).toContain('https://open.spotify.com/cdn/build/xpui.ghi789.js');
  });

  it('de-duplicates and tolerates malformed markup', () => {
    const html = '<script src="/a.js"></script><script src="/a.js"></script><script src="">';
    expect(extractBundleUrls(html)).toEqual(['https://open.spotify.com/a.js']);
  });
});
