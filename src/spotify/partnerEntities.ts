import type { ReleaseType } from './types.js';

/**
 * Readers for the web player's GraphQL payloads.
 *
 * As with play counts, nothing here reads a fixed path. Spotify reshapes these
 * responses between player releases — `tracks` became `tracksV2`, items gained
 * and lost wrapper objects, `searchV2` replaced `search` — so instead we walk
 * the tree for nodes carrying a `spotify:<kind>:<id>` URI and read whatever
 * recognisable fields sit on them.
 */

export interface PartnerArtist {
  id: string;
  name: string;
  image: string | null;
  followers: number | null;
  monthlyListeners: number | null;
  verified: boolean | null;
}

export interface PartnerAlbum {
  id: string;
  name: string;
  type: ReleaseType;
  releaseDate: string;
  releaseDatePrecision: 'year' | 'month' | 'day';
  totalTracks: number;
  image: string | null;
}

export interface PartnerTrack {
  id: string;
  name: string;
  playCount: number | null;
  durationMs: number;
  trackNumber: number;
  discNumber: number;
  explicit: boolean;
  artists: Array<{ id: string; name: string }>;
}

const URI_PATTERN = /^spotify:([a-z]+):([A-Za-z0-9]+)$/;

export function parseUri(value: unknown): { kind: string; id: string } | null {
  if (typeof value !== 'string') return null;
  const match = URI_PATTERN.exec(value);
  return match ? { kind: match[1]!, id: match[2]! } : null;
}

type Node = Record<string, unknown>;

/** Every object in the tree carrying a `spotify:<kind>:…` URI, in document order. */
export function collectNodes(payload: unknown, kind: string): Node[] {
  const found: Node[] = [];
  const seen = new Set<unknown>();
  const seenIds = new Set<string>();

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    const record = node as Node;
    const uri = parseUri(record.uri);
    if (uri && uri.kind === kind && !seenIds.has(uri.id)) {
      seenIds.add(uri.id);
      found.push(record);
    }

    for (const value of Object.values(record)) visit(value);
  };

  visit(payload);
  return found;
}

const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/** Read the first present key from a node, trying several spellings. */
function pick(node: Node, keys: string[]): unknown {
  for (const key of keys) {
    if (node[key] !== undefined && node[key] !== null) return node[key];
  }
  return undefined;
}

/** Names live at `name`, `profile.name` or `data.name` depending on the query. */
function readName(node: Node): string {
  const direct = pick(node, ['name']);
  if (typeof direct === 'string' && direct) return direct;
  const profile = node.profile as Node | undefined;
  if (typeof profile?.name === 'string' && profile.name) return profile.name;
  const data = node.data as Node | undefined;
  if (typeof data?.name === 'string' && data.name) return data.name;
  return '';
}

/** Image sets appear under several wrappers, always as `{ sources: [...] }`. */
export function readImage(node: Node): string | null {
  const candidates = [
    (node.visuals as Node | undefined)?.avatarImage,
    (node.visuals as Node | undefined)?.headerImage,
    node.coverArt,
    node.avatarImage,
    node.image,
    (node.album as Node | undefined)?.coverArt,
  ];

  for (const candidate of candidates) {
    const sources = (candidate as Node | undefined)?.sources;
    if (!Array.isArray(sources) || sources.length === 0) continue;
    // Sources run smallest-first here; the middle entry suits a thumbnail.
    const sorted = [...sources].filter(
      (source): source is Node => typeof source === 'object' && source !== null,
    );
    const chosen = sorted[Math.min(1, sorted.length - 1)] ?? sorted[0];
    if (typeof chosen?.url === 'string') return chosen.url;
  }
  return null;
}

export function toArtist(node: Node): PartnerArtist | null {
  const uri = parseUri(node.uri);
  if (!uri || uri.kind !== 'artist') return null;

  const stats = (node.stats ?? (node.data as Node | undefined)?.stats) as Node | undefined;
  const profile = (node.profile ?? (node.data as Node | undefined)?.profile) as Node | undefined;
  const name = readName(node);
  if (!name) return null;

  return {
    id: uri.id,
    name,
    image: readImage(node) ?? readImage((node.data as Node) ?? {}),
    followers: asNumber(stats?.followers),
    monthlyListeners: asNumber(stats?.monthlyListeners),
    verified: typeof profile?.verified === 'boolean' ? profile.verified : null,
  };
}

/** `{ year, month, day }`, `{ isoString }` or a bare year — normalise to ISO-ish. */
export function readReleaseDate(value: unknown): {
  date: string;
  precision: 'year' | 'month' | 'day';
} {
  if (typeof value === 'string' && value) {
    const iso = value.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { date: iso, precision: 'day' };
    if (/^\d{4}-\d{2}$/.test(iso)) return { date: iso, precision: 'month' };
    if (/^\d{4}$/.test(iso.slice(0, 4))) return { date: iso.slice(0, 4), precision: 'year' };
  }

  if (value && typeof value === 'object') {
    const node = value as Node;
    if (typeof node.isoString === 'string') return readReleaseDate(node.isoString);

    const year = asNumber(node.year);
    if (year === null) return { date: '', precision: 'year' };
    const month = asNumber(node.month);
    const day = asNumber(node.day);
    const pad = (part: number): string => String(part).padStart(2, '0');

    if (month !== null && day !== null) {
      return { date: `${year}-${pad(month)}-${pad(day)}`, precision: 'day' };
    }
    if (month !== null) return { date: `${year}-${pad(month)}`, precision: 'month' };
    return { date: String(year), precision: 'year' };
  }

  return { date: '', precision: 'year' };
}

function readAlbumType(node: Node): ReleaseType {
  const raw = String(pick(node, ['type', 'albumType', 'releaseType']) ?? 'ALBUM').toLowerCase();
  if (raw.includes('single')) return 'single';
  if (raw.includes('compilation')) return 'compilation';
  if (raw.includes('appears')) return 'appears_on';
  if (raw.includes('ep')) return 'single';
  return 'album';
}

export function toAlbum(node: Node): PartnerAlbum | null {
  const uri = parseUri(node.uri);
  if (!uri || uri.kind !== 'album') return null;
  const name = readName(node);
  if (!name) return null;

  const { date, precision } = readReleaseDate(pick(node, ['date', 'releaseDate']));
  const tracks = node.tracks as Node | undefined;

  return {
    id: uri.id,
    name,
    type: readAlbumType(node),
    releaseDate: date,
    releaseDatePrecision: precision,
    totalTracks: asNumber(tracks?.totalCount) ?? asNumber(node.totalTracks) ?? 0,
    image: readImage(node),
  };
}

function readTrackArtists(node: Node): Array<{ id: string; name: string }> {
  const container = node.artists as Node | undefined;
  const items = Array.isArray(container?.items)
    ? container.items
    : Array.isArray(container)
      ? container
      : [];

  const out: Array<{ id: string; name: string }> = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Node;
    const uri = parseUri(entry.uri);
    const name = readName(entry);
    if (name) out.push({ id: uri?.id ?? '', name });
  }
  return out;
}

export function toTrack(node: Node): PartnerTrack | null {
  const uri = parseUri(node.uri);
  if (!uri || uri.kind !== 'track') return null;
  const name = readName(node);
  if (!name) return null;

  const duration = node.duration as Node | undefined;
  const rating = node.contentRating as Node | undefined;
  const playCount = asNumber(pick(node, ['playcount', 'playCount']));

  return {
    id: uri.id,
    name,
    // Spotify uses -1 for a hidden count; treat it as unknown, not zero.
    playCount: playCount !== null && playCount >= 0 ? playCount : null,
    durationMs:
      asNumber(duration?.totalMilliseconds) ?? asNumber(node.durationMs) ?? asNumber(node.duration) ?? 0,
    trackNumber: asNumber(node.trackNumber) ?? 0,
    discNumber: asNumber(node.discNumber) ?? 1,
    explicit: String(rating?.label ?? '').toUpperCase() === 'EXPLICIT',
    artists: readTrackArtists(node),
  };
}

export const extractArtists = (payload: unknown): PartnerArtist[] =>
  collectNodes(payload, 'artist')
    .map(toArtist)
    .filter((artist): artist is PartnerArtist => artist !== null);

export const extractAlbums = (payload: unknown): PartnerAlbum[] =>
  collectNodes(payload, 'album')
    .map(toAlbum)
    .filter((album): album is PartnerAlbum => album !== null);

export const extractTracks = (payload: unknown): PartnerTrack[] =>
  collectNodes(payload, 'track')
    .map(toTrack)
    .filter((track): track is PartnerTrack => track !== null);
