import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cache } from '../src/util/cache.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'spindex-cache-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const memoryCache = () => new Cache({ maxEntries: 100, dir: '' });

describe('Cache', () => {
  it('stores and returns a value', async () => {
    const cache = memoryCache();
    await cache.set('k', { hello: 'world' }, 60);
    expect(await cache.get('k')).toEqual({ hello: 'world' });
  });

  it('returns undefined for a miss', async () => {
    expect(await memoryCache().get('nope')).toBeUndefined();
  });

  it('expires entries once the TTL passes', async () => {
    vi.useFakeTimers();
    const cache = memoryCache();
    await cache.set('k', 'value', 10);

    vi.advanceTimersByTime(9_000);
    expect(await cache.get('k')).toBe('value');

    vi.advanceTimersByTime(2_000);
    expect(await cache.get('k')).toBeUndefined();
  });

  it('evicts least-recently-used entries past the limit', async () => {
    const cache = new Cache({ maxEntries: 2, dir: '' });
    await cache.set('a', 1, 60);
    await cache.set('b', 2, 60);
    // Touch 'a' so 'b' becomes the least recently used.
    await cache.get('a');
    await cache.set('c', 3, 60);

    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toBe(1);
    expect(await cache.get('c')).toBe(3);
  });

  it('survives a restart via the disk tier', async () => {
    const first = new Cache({ maxEntries: 10, dir });
    await first.set('artist:1', { tracks: 12 }, 600);

    const second = new Cache({ maxEntries: 10, dir });
    expect(await second.get('artist:1')).toEqual({ tracks: 12 });
  });

  it('does not resurrect expired entries from disk', async () => {
    const first = new Cache({ maxEntries: 10, dir });
    await first.set('artist:1', 'stale', -1);

    const second = new Cache({ maxEntries: 10, dir });
    expect(await second.get('artist:1')).toBeUndefined();
  });

  it('keeps working when the disk tier is unwritable', async () => {
    // A regular file standing in for the cache directory makes mkdir fail
    // with ENOTDIR; the memory tier must carry on regardless.
    const blocker = join(dir, 'not-a-directory');
    await writeFile(blocker, 'x');

    const cache = new Cache({ maxEntries: 10, dir: join(blocker, 'sub') });
    await expect(cache.set('k', 'v', 60)).resolves.toBeUndefined();
    expect(await cache.get('k')).toBe('v');
  });

  describe('wrap', () => {
    it('builds once and serves the cached value after', async () => {
      const cache = memoryCache();
      const build = vi.fn(async () => 'built');

      expect(await cache.wrap('k', 60, build)).toBe('built');
      expect(await cache.wrap('k', 60, build)).toBe('built');
      expect(build).toHaveBeenCalledTimes(1);
    });

    it('collapses concurrent misses into a single build', async () => {
      const cache = memoryCache();
      let resolve!: (value: string) => void;
      const pending = new Promise<string>((r) => {
        resolve = r;
      });
      const build = vi.fn(() => pending);

      const all = Promise.all([cache.wrap('k', 60, build), cache.wrap('k', 60, build), cache.wrap('k', 60, build)]);
      // wrap() checks the cache asynchronously before calling build, so let
      // those microtasks drain before releasing the build.
      await Promise.resolve();
      resolve('once');

      expect(await all).toEqual(['once', 'once', 'once']);
      // A catalogue build costs dozens of upstream calls; three page loads
      // must not trigger three of them.
      expect(build).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failed build, and lets the next caller retry', async () => {
      const cache = memoryCache();
      const build = vi
        .fn()
        .mockRejectedValueOnce(new Error('upstream down'))
        .mockResolvedValueOnce('recovered');

      await expect(cache.wrap('k', 60, build)).rejects.toThrow('upstream down');
      expect(await cache.wrap('k', 60, build)).toBe('recovered');
      expect(build).toHaveBeenCalledTimes(2);
    });
  });

  it('drops an entry on delete', async () => {
    const cache = memoryCache();
    await cache.set('k', 'v', 60);
    cache.delete('k');
    expect(await cache.get('k')).toBeUndefined();
  });
});

describe('invalidate', () => {
  it('drops the disk copy too, so a forced refresh really rebuilds', async () => {
    const cache = new Cache({ maxEntries: 10, dir });
    await cache.set('artist:1', 'stale', 600);

    await cache.invalidate('artist:1');

    // Nothing may survive in either tier, or "refresh" silently serves the
    // old catalogue back from disk.
    expect(await cache.get('artist:1')).toBeUndefined();

    const build = vi.fn(async () => 'fresh');
    expect(await cache.wrap('artist:1', 600, build)).toBe('fresh');
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('is safe to call for a key that was never cached', async () => {
    const cache = new Cache({ maxEntries: 10, dir });
    await expect(cache.invalidate('never-seen')).resolves.toBeUndefined();
  });
});
