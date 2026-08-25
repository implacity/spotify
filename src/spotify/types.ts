export type ReleaseType = 'album' | 'single' | 'compilation' | 'appears_on';

export interface ArtistSummary {
  id: string;
  name: string;
  url: string;
  image: string | null;
  followers: number | null;
  popularity: number | null;
  genres: string[];
}

export interface ArtistDetail extends ArtistSummary {
  /** Only available from the partner API; null when it could not be reached. */
  monthlyListeners: number | null;
  verified: boolean | null;
  biography: string | null;
  topCity: string | null;
}

export interface ReleaseRef {
  id: string;
  name: string;
  type: ReleaseType;
  releaseDate: string;
  releaseDatePrecision: 'year' | 'month' | 'day';
  totalTracks: number;
  image: string | null;
  url: string;
}

export interface TrackRow {
  id: string;
  name: string;
  /** Disambiguated title, e.g. "Song (feat. X) - Remastered". */
  displayName: string;
  url: string;
  durationMs: number;
  explicit: boolean;
  discNumber: number;
  trackNumber: number;
  popularity: number | null;
  /** Real stream count from the partner API; null when unavailable. */
  playCount: number | null;
  album: {
    id: string;
    name: string;
    type: ReleaseType;
    releaseDate: string;
    image: string | null;
    url: string;
  };
  artists: Array<{ id: string; name: string }>;
  /** True when the looked-up artist is not the first credited artist. */
  isFeature: boolean;
  /**
   * Normalised identity of the recording, computed server-side so the client
   * can fold duplicates using exactly the same rules.
   */
  groupKey: string;
  /** Number of other releases carrying the same recording. */
  duplicateCount: number;
  /** Track ids merged into this row when grouping duplicates. */
  duplicateIds: string[];
}

export interface CatalogStats {
  totalPlayCount: number | null;
  countedTracks: number;
  tracksWithPlayCounts: number;
  averagePlayCount: number | null;
  medianPlayCount: number | null;
  releaseCount: number;
  leadTrackCount: number;
  featureTrackCount: number;
  /** Sum of the ten biggest tracks — the "hits carry the catalogue" number. */
  top10PlayCount: number | null;
  firstReleaseDate: string | null;
  latestReleaseDate: string | null;
}

export interface CatalogWarning {
  code:
    | 'playcounts_unavailable'
    | 'partner_auth_failed'
    | 'partial_releases'
    | 'release_fetch_failed'
    | 'rate_limited';
  message: string;
  detail?: string;
}

export interface ArtistCatalog {
  artist: ArtistDetail;
  tracks: TrackRow[];
  stats: CatalogStats;
  releases: ReleaseRef[];
  warnings: CatalogWarning[];
  /** True when every track carries a real play count. */
  playCountsComplete: boolean;
  source: 'live' | 'mock';
  generatedAt: string;
  buildMs: number;
}

export interface SearchResult {
  artists: ArtistSummary[];
  query: string;
}

export interface BuildProgress {
  phase: 'artist' | 'releases' | 'tracks' | 'playcounts' | 'done';
  message: string;
  completed: number;
  total: number;
}

export type ProgressReporter = (progress: BuildProgress) => void;
