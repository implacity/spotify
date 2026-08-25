/**
 * Artists ship the same recording many times over: on a single, on the album,
 * on the deluxe reissue, on a greatest-hits compilation. Spotify gives each a
 * distinct track id and a distinct play count, so a raw listing shows "Song"
 * five times with five different numbers.
 *
 * These helpers decide what counts as the same song. The rule: strip
 * packaging noise (remaster tags, edition markers, featured-artist credits)
 * but preserve anything that means a genuinely different recording (live,
 * acoustic, remix, demo, a named alternate version).
 */

/** Suffixes that describe the *release*, not the recording. */
const PACKAGING_QUALIFIERS = [
  /^remaster(ed)?$/,
  /^\d{4}\s*remaster(ed)?$/,
  /^remaster(ed)?\s*\d{4}$/,
  /^remaster(ed)?\s*version$/,
  /^\d{4}\s*(digital\s*)?remaster(ed)?(\s*version)?$/,
  /^album\s*version$/,
  /^single\s*version$/,
  /^original\s*(mix|version)$/,
  /^bonus\s*track$/,
  /^deluxe(\s*edition)?$/,
  /^expanded(\s*edition)?$/,
  /^explicit(\s*version)?$/,
  /^clean(\s*version)?$/,
  /^mono(\s*version|\s*mix)?$/,
  /^stereo(\s*version|\s*mix)?$/,
  /^anniversary\s*edition$/,
];

/** Featured-artist credits, which vary by release but not by recording. */
const FEATURE_PREFIX = /^(feat|ft|featuring|with|w\/)\.?\s+/i;

const stripDiacritics = (value: string): string =>
  value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

/** Split a title into its base and any parenthetical/dash-suffixed segments. */
function segments(title: string): { base: string; parts: string[] } {
  const parts: string[] = [];

  // Pull out bracketed groups first: "Song (feat. X) [Remastered]".
  let base = title.replace(/[([{]([^)\]}]*)[)\]}]/g, (_match, inner: string) => {
    parts.push(inner.trim());
    return ' ';
  });

  // Then dash-separated suffixes: "Song - 2011 Remaster".
  const dashSplit = base.split(/\s+[-–—]\s+/);
  if (dashSplit.length > 1) {
    base = dashSplit[0] ?? base;
    parts.push(...dashSplit.slice(1).map((part) => part.trim()));
  }

  return { base: base.trim(), parts: parts.filter(Boolean) };
}

const isPackaging = (part: string): boolean => {
  const clean = part.trim().toLowerCase().replace(/\s+/g, ' ');
  if (FEATURE_PREFIX.test(clean)) return true;
  return PACKAGING_QUALIFIERS.some((pattern) => pattern.test(clean));
};

/**
 * Key used to group releases of the same recording. Two tracks share a key
 * when they are the same song in the same form.
 */
export function trackDedupeKey(title: string, primaryArtist = ''): string {
  const { base, parts } = segments(title);

  // Qualifiers that survive normalisation mark a distinct recording.
  const meaningful = parts
    .filter((part) => !isPackaging(part))
    .map((part) => stripDiacritics(part).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
    .filter(Boolean)
    .sort();

  const normalizedBase = stripDiacritics(base)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const artistKey = stripDiacritics(primaryArtist)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  return [artistKey, normalizedBase, ...meaningful].join('|');
}

/** Human-facing title: packaging noise removed, real variants kept. */
export function displayTitle(title: string): string {
  const { base, parts } = segments(title);
  const kept = parts.filter((part) => !isPackaging(part));
  return kept.length > 0 ? `${base} (${kept.join(') (')})` : base;
}

/** True when the title marks a live, remixed or otherwise alternate take. */
export function isAlternateVersion(title: string): boolean {
  const { parts } = segments(title);
  return parts.some((part) => !isPackaging(part) && /live|remix|acoustic|demo|version|edit|mix/i.test(part));
}

/** Loose match used by the client-side search filter. */
export function searchNormalize(value: string): string {
  return stripDiacritics(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
