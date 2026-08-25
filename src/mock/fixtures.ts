import { displayTitle, trackDedupeKey } from '../util/normalize.js';
import type {
  ArtistCatalog,
  ArtistDetail,
  ArtistSummary,
  ReleaseRef,
  ReleaseType,
  TrackRow,
} from '../spotify/types.js';
import { computeStats } from '../spotify/catalog.js';

/**
 * Deterministic sample data for `MOCK=1`, so the UI can be developed, demoed
 * and tested without Spotify credentials or network access.
 *
 * The artists here are invented. Real artists are deliberately not used:
 * these numbers are generated, and showing generated stream counts under a
 * real name would misrepresent them.
 */

/** Small xorshift PRNG — same seed, same catalogue, every run. */
function seeded(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return Math.abs(state) / 2 ** 31;
  };
}

const hashSeed = (value: string): number => {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash);
};

interface MockArtistSpec {
  id: string;
  name: string;
  genres: string[];
  followers: number;
  popularity: number;
  monthlyListeners: number;
  albums: Array<{ name: string; year: number; type: ReleaseType; tracks: string[] }>;
}

const ARTISTS: MockArtistSpec[] = [
  {
    id: 'mock1novaardent00000',
    name: 'Nova Ardent',
    genres: ['synth-pop', 'alt-electronic'],
    followers: 4_812_339,
    popularity: 81,
    monthlyListeners: 22_401_882,
    albums: [
      {
        name: 'Halogen Hearts',
        year: 2019,
        type: 'album',
        tracks: [
          'Halogen Hearts',
          'Static Bloom',
          'Midnight Arcade',
          'Paper Satellites',
          'Cold Fluorescent',
          'Blue Hour',
          'Ultraviolet Kids',
          'Signal Fade',
        ],
      },
      {
        name: 'Halogen Hearts (Deluxe Edition)',
        year: 2020,
        type: 'album',
        tracks: [
          'Halogen Hearts',
          'Static Bloom',
          'Midnight Arcade',
          'Paper Satellites',
          'Cold Fluorescent',
          'Blue Hour',
          'Ultraviolet Kids',
          'Signal Fade',
          'Afterglow - Bonus Track',
          'Midnight Arcade (Acoustic)',
        ],
      },
      {
        name: 'Static Bloom',
        year: 2018,
        type: 'single',
        tracks: ['Static Bloom', 'Static Bloom (Instrumental)'],
      },
      {
        name: 'Deep Field',
        year: 2023,
        type: 'album',
        tracks: [
          'Event Horizon',
          'Deep Field',
          'Gravity Letters',
          'Slow Collapse',
          'Parallax',
          'Everything At Once',
          'Redshift',
          'Quiet Machines',
          'The Long Dark',
        ],
      },
      {
        name: 'Parallax (Remixes)',
        year: 2024,
        type: 'single',
        tracks: ['Parallax (Kite Machine Remix)', 'Parallax (Club Mix)', 'Parallax - 2024 Remaster'],
      },
      {
        name: 'Neon Anthology',
        year: 2025,
        type: 'compilation',
        tracks: ['Halogen Hearts - 2025 Remaster', 'Deep Field', 'Static Bloom', 'Blue Hour'],
      },
    ],
  },
  {
    id: 'mock2glasscathedral0',
    name: 'Glass Cathedral',
    genres: ['post-rock', 'ambient'],
    followers: 612_004,
    popularity: 58,
    monthlyListeners: 1_988_450,
    albums: [
      {
        name: 'Nave',
        year: 2016,
        type: 'album',
        tracks: ['Transept', 'Nave', 'Buttress', 'Rose Window', 'Clerestory', 'Vault'],
      },
      {
        name: 'Reliquary',
        year: 2021,
        type: 'album',
        tracks: ['Reliquary', 'Ossuary', 'Procession', 'Candlelight Hours', 'Ash Wednesday'],
      },
      {
        name: 'Live at the Old Chapel',
        year: 2022,
        type: 'album',
        tracks: ['Nave (Live)', 'Reliquary (Live)', 'Vault (Live)'],
      },
    ],
  },
  {
    id: 'mock3marisolvega000',
    name: 'Marisol Vega',
    genres: ['indie folk', 'americana'],
    followers: 1_204_776,
    popularity: 69,
    monthlyListeners: 6_733_120,
    albums: [
      {
        name: 'Dust and Citrus',
        year: 2020,
        type: 'album',
        tracks: [
          'Dust and Citrus',
          'Marfa Lights',
          'Two Lane Blacktop',
          'Sonora',
          'Handwriting',
          'Salt Flats',
          'Come Morning',
        ],
      },
      {
        name: 'Marfa Lights',
        year: 2019,
        type: 'single',
        tracks: ['Marfa Lights'],
      },
      {
        name: 'Borrowed Light',
        year: 2024,
        type: 'album',
        tracks: ['Borrowed Light', 'Wildfire Season', 'Kitchen Radio', 'Ten Cent Rose', 'Anyhow'],
      },
    ],
  },
];

/**
 * Inline SVG initials so sample mode needs no network at all — handy when
 * developing offline, and it keeps the fixtures free of third-party requests.
 */
function imageFor(seed: string): string {
  const initials = seed
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
  const hue = hashSeed(seed) % 360;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<rect width="200" height="200" fill="hsl(${hue} 22% 16%)"/>` +
    `<text x="100" y="100" fill="hsl(${hue} 45% 62%)" font-family="Helvetica,Arial,sans-serif" ` +
    `font-size="76" font-weight="700" text-anchor="middle" dominant-baseline="central">${initials}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function toSummary(spec: MockArtistSpec): ArtistSummary {
  return {
    id: spec.id,
    name: spec.name,
    url: `https://open.spotify.com/artist/${spec.id}`,
    image: imageFor(spec.name),
    followers: spec.followers,
    popularity: spec.popularity,
    genres: spec.genres,
  };
}

export function mockSearch(query: string): ArtistSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return ARTISTS.map(toSummary);
  return ARTISTS.filter(
    (artist) =>
      artist.name.toLowerCase().includes(needle) ||
      artist.genres.some((genre) => genre.includes(needle)),
  ).map(toSummary);
}

export function mockArtistIds(): string[] {
  return ARTISTS.map((artist) => artist.id);
}

export function buildMockCatalog(artistId: string): ArtistCatalog | null {
  const spec = ARTISTS.find((artist) => artist.id === artistId);
  if (!spec) return null;

  const random = seeded(hashSeed(spec.id));
  const releases: ReleaseRef[] = [];
  const rows: TrackRow[] = [];

  // A plausible power-law: a few big tracks carry the catalogue.
  const ceiling = spec.monthlyListeners * 40;

  spec.albums.forEach((album, albumIndex) => {
    const albumId = `${spec.id}-al${albumIndex}`;
    const releaseDate = `${album.year}-0${(albumIndex % 9) + 1}-1${albumIndex % 9}`;
    const release: ReleaseRef = {
      id: albumId,
      name: album.name,
      type: album.type,
      releaseDate,
      releaseDatePrecision: 'day',
      totalTracks: album.tracks.length,
      image: imageFor(album.name),
      url: `https://open.spotify.com/album/${albumId}`,
    };
    releases.push(release);

    album.tracks.forEach((title, trackIndex) => {
      const decay = 1 / (1 + trackIndex * 0.55 + albumIndex * 0.4);
      const playCount = Math.round(ceiling * decay * (0.35 + random() * 0.9));
      rows.push({
        id: `${albumId}-tr${trackIndex}`,
        name: title,
        displayName: displayTitle(title),
        url: `https://open.spotify.com/track/${albumId}-tr${trackIndex}`,
        durationMs: Math.round(150_000 + random() * 140_000),
        explicit: random() > 0.85,
        discNumber: 1,
        trackNumber: trackIndex + 1,
        popularity: Math.max(1, Math.min(100, Math.round(spec.popularity * decay * 1.6))),
        playCount,
        album: {
          id: release.id,
          name: release.name,
          type: release.type,
          releaseDate: release.releaseDate,
          image: release.image,
          url: release.url,
        },
        artists: [{ id: spec.id, name: spec.name }],
        isFeature: false,
        groupKey: trackDedupeKey(title, spec.name),
        duplicateCount: 0,
        duplicateIds: [],
      });
    });
  });

  rows.sort((a, b) => (b.playCount ?? 0) - (a.playCount ?? 0));

  const artist: ArtistDetail = {
    ...toSummary(spec),
    monthlyListeners: spec.monthlyListeners,
    verified: true,
    biography: `${spec.name} is a fictional artist used for offline development of this site.`,
    topCity: 'Portland, OR',
  };

  return {
    artist,
    tracks: rows,
    stats: computeStats(rows, releases),
    releases,
    warnings: [],
    playCountsComplete: true,
    source: 'mock',
    generatedAt: new Date().toISOString(),
    buildMs: 0,
  };
}
