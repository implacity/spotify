import { describe, expect, it } from 'vitest';
import { displayTitle, isAlternateVersion, trackDedupeKey } from '../src/util/normalize.js';

describe('trackDedupeKey', () => {
  const key = (title: string, artist = 'Artist') => trackDedupeKey(title, artist);

  it('treats packaging variants as the same recording', () => {
    const canonical = key('Bohemian Rhapsody');
    expect(key('Bohemian Rhapsody - Remastered 2011')).toBe(canonical);
    expect(key('Bohemian Rhapsody - 2011 Remaster')).toBe(canonical);
    expect(key('Bohemian Rhapsody (Remastered)')).toBe(canonical);
    expect(key('Bohemian Rhapsody - Album Version')).toBe(canonical);
    expect(key('Bohemian Rhapsody (Bonus Track)')).toBe(canonical);
  });

  it('ignores featured-artist credits, which vary by release', () => {
    const canonical = key('Sunflower');
    expect(key('Sunflower (feat. Someone)')).toBe(canonical);
    expect(key('Sunflower (with Someone Else)')).toBe(canonical);
    expect(key('Sunflower - ft. Another')).toBe(canonical);
  });

  it('keeps genuinely different recordings apart', () => {
    const canonical = key('Wonderwall');
    expect(key('Wonderwall - Live')).not.toBe(canonical);
    expect(key('Wonderwall (Acoustic)')).not.toBe(canonical);
    expect(key('Wonderwall (Some Producer Remix)')).not.toBe(canonical);
    expect(key('Wonderwall (Demo)')).not.toBe(canonical);
  });

  it('keeps re-recordings apart from the original', () => {
    expect(key("Love Story (Taylor's Version)")).not.toBe(key('Love Story'));
    expect(key('All Too Well (From The Vault)')).not.toBe(key('All Too Well'));
  });

  it('normalises case, punctuation and accents', () => {
    expect(key('CAFÉ  BLEU!')).toBe(key('cafe bleu'));
    expect(key('Me & You')).toBe(key('Me and You'));
  });

  it('separates same-titled songs by different artists', () => {
    expect(trackDedupeKey('Halo', 'Artist A')).not.toBe(trackDedupeKey('Halo', 'Artist B'));
  });

  it('is order-insensitive across multiple qualifiers', () => {
    expect(key('Song (Live) (Remastered)')).toBe(key('Song (Remastered) (Live)'));
  });
});

describe('displayTitle', () => {
  it('drops packaging noise', () => {
    expect(displayTitle('Bohemian Rhapsody - Remastered 2011')).toBe('Bohemian Rhapsody');
    expect(displayTitle('Song (feat. Someone)')).toBe('Song');
  });

  it('keeps meaningful qualifiers', () => {
    expect(displayTitle('Wonderwall - Live')).toBe('Wonderwall (Live)');
    expect(displayTitle('Parallax (Club Mix)')).toBe('Parallax (Club Mix)');
  });

  it('leaves plain titles untouched', () => {
    expect(displayTitle('Deep Field')).toBe('Deep Field');
  });
});

describe('isAlternateVersion', () => {
  it('flags alternate takes only', () => {
    expect(isAlternateVersion('Song (Live)')).toBe(true);
    expect(isAlternateVersion('Song - Remastered 2011')).toBe(false);
    expect(isAlternateVersion('Song')).toBe(false);
  });
});
