import { describe, expect, it } from 'vitest';
import { computeStats, groupDuplicateTracks } from '../src/spotify/catalog.js';
import { trackDedupeKey } from '../src/util/normalize.js';
import { displayTitle } from '../src/util/normalize.js';
import type { ReleaseRef, ReleaseType, TrackRow } from '../src/spotify/types.js';

let counter = 0;

function track(
  name: string,
  playCount: number | null,
  albumName = 'Album',
  type: ReleaseType = 'album',
  releaseDate = '2020-01-01',
  artist = 'Nova Ardent',
): TrackRow {
  counter += 1;
  return {
    id: `track${counter}`,
    name,
    displayName: displayTitle(name),
    url: `https://open.spotify.com/track/track${counter}`,
    durationMs: 200_000,
    explicit: false,
    discNumber: 1,
    trackNumber: 1,
    popularity: 50,
    playCount,
    album: {
      id: `album-${albumName}`,
      name: albumName,
      type,
      releaseDate,
      image: null,
      url: `https://open.spotify.com/album/${albumName}`,
    },
    artists: [{ id: 'artist1', name: artist }],
    isFeature: false,
    groupKey: trackDedupeKey(name, artist),
    duplicateCount: 0,
    duplicateIds: [],
  };
}

function release(name: string, date: string): ReleaseRef {
  return {
    id: `album-${name}`,
    name,
    type: 'album',
    releaseDate: date,
    releaseDatePrecision: 'day',
    totalTracks: 10,
    image: null,
    url: `https://open.spotify.com/album/${name}`,
  };
}

describe('groupDuplicateTracks', () => {
  it('merges the same recording across releases and counts the duplicates', () => {
    const rows = groupDuplicateTracks([
      track('Static Bloom', 500, 'Halogen Hearts'),
      track('Static Bloom', 300, 'Static Bloom', 'single'),
      track('Static Bloom - 2025 Remaster', 90, 'Neon Anthology', 'compilation'),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.duplicateCount).toBe(2);
    expect(rows[0]!.duplicateIds).toHaveLength(2);
  });

  it('does not sum play counts across duplicate releases', () => {
    const rows = groupDuplicateTracks([
      track('Static Bloom', 500, 'Halogen Hearts'),
      track('Static Bloom', 300, 'Static Bloom', 'single'),
    ]);
    // 500, not 800: these are two catalogue entries for one song.
    expect(rows[0]!.playCount).toBe(500);
  });

  it('keeps the highest-played copy as the representative row', () => {
    const rows = groupDuplicateTracks([
      track('Blue Hour', 100, 'Compilation', 'compilation'),
      track('Blue Hour', 9000, 'Halogen Hearts'),
    ]);
    expect(rows[0]!.playCount).toBe(9000);
    expect(rows[0]!.album.name).toBe('Halogen Hearts');
  });

  it('prefers the original album when play counts tie', () => {
    const rows = groupDuplicateTracks([
      track('Blue Hour', 100, 'Greatest Hits', 'compilation', '2025-01-01'),
      track('Blue Hour', 100, 'Halogen Hearts', 'album', '2019-01-01'),
    ]);
    expect(rows[0]!.album.name).toBe('Halogen Hearts');
  });

  it('prefers a row with real counts over one without', () => {
    const rows = groupDuplicateTracks([
      track('Blue Hour', null, 'Unknown'),
      track('Blue Hour', 25, 'Halogen Hearts'),
    ]);
    expect(rows[0]!.playCount).toBe(25);
  });

  it('keeps live and remix versions as separate songs', () => {
    const rows = groupDuplicateTracks([
      track('Parallax', 800),
      track('Parallax (Club Mix)', 40),
      track('Parallax - Live', 12),
    ]);
    expect(rows).toHaveLength(3);
  });

  it('keeps same-titled songs by different artists apart', () => {
    const rows = groupDuplicateTracks([
      track('Halo', 10, 'A', 'album', '2020-01-01', 'Artist A'),
      track('Halo', 20, 'B', 'album', '2020-01-01', 'Artist B'),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('handles an empty catalogue', () => {
    expect(groupDuplicateTracks([])).toEqual([]);
  });
});

describe('computeStats', () => {
  const releases = [release('One', '2019-03-01'), release('Two', '2023-11-05')];

  it('summarises a catalogue with play counts', () => {
    const rows = [track('A', 1000), track('B', 500), track('C', 100)];
    const stats = computeStats(rows, releases);

    expect(stats.totalPlayCount).toBe(1600);
    expect(stats.countedTracks).toBe(3);
    expect(stats.tracksWithPlayCounts).toBe(3);
    expect(stats.averagePlayCount).toBe(533);
    expect(stats.medianPlayCount).toBe(500);
    expect(stats.releaseCount).toBe(2);
    expect(stats.firstReleaseDate).toBe('2019-03-01');
    expect(stats.latestReleaseDate).toBe('2023-11-05');
  });

  it('averages the two middle values for an even count', () => {
    const stats = computeStats([track('A', 10), track('B', 20), track('C', 30), track('D', 40)], []);
    expect(stats.medianPlayCount).toBe(25);
  });

  it('caps the top-10 sum at ten tracks', () => {
    const rows = Array.from({ length: 15 }, (_, index) => track(`T${index}`, (index + 1) * 100));
    const stats = computeStats(rows, []);
    // Top ten are 600..1500.
    expect(stats.top10PlayCount).toBe(10_500);
    expect(stats.totalPlayCount).toBe(12_000);
  });

  it('reports nulls rather than zeros when no play counts exist', () => {
    const stats = computeStats([track('A', null), track('B', null)], releases);
    expect(stats.totalPlayCount).toBeNull();
    expect(stats.averagePlayCount).toBeNull();
    expect(stats.medianPlayCount).toBeNull();
    expect(stats.countedTracks).toBe(2);
    expect(stats.tracksWithPlayCounts).toBe(0);
  });

  it('ignores missing counts when only some tracks have them', () => {
    const stats = computeStats([track('A', 100), track('B', null)], []);
    expect(stats.totalPlayCount).toBe(100);
    expect(stats.tracksWithPlayCounts).toBe(1);
    expect(stats.countedTracks).toBe(2);
  });

  it('handles an empty catalogue without dividing by zero', () => {
    const stats = computeStats([], []);
    expect(stats.totalPlayCount).toBeNull();
    expect(stats.averagePlayCount).toBeNull();
    expect(stats.countedTracks).toBe(0);
    expect(stats.firstReleaseDate).toBeNull();
  });

  it('splits lead tracks from features', () => {
    const lead = track('Lead', 10);
    const feature = { ...track('Guest', 5), isFeature: true };
    const stats = computeStats([lead, feature], []);
    expect(stats.leadTrackCount).toBe(1);
    expect(stats.featureTrackCount).toBe(1);
  });
});
