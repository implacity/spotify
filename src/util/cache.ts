import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('cache');

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheOptions {
  maxEntries: number;
  /** Empty string disables the disk tier. */
  dir: string;
}

/**
 * Two-tier cache: an LRU in memory, backed by JSON files on disk so a restart
 * doesn't force every artist to be rebuilt from scratch. Building a full
 * catalogue costs dozens of upstream calls, so this is the difference between
 * a snappy site and a rate-limited one.
 */
export class Cache {
  private readonly memory = new Map<string, Entry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly options: CacheOptions) {}

  private fileFor(key: string): string {
    const digest = createHash('sha1').update(key).digest('hex');
    return join(this.options.dir, `${digest}.json`);
  }

  private touch(key: string, entry: Entry<unknown>): void {
    this.memory.delete(key);
    this.memory.set(key, entry);
    while (this.memory.size > this.options.maxEntries) {
      const oldest = this.memory.keys().next().value;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    const hit = this.memory.get(key);
    if (hit) {
      if (hit.expiresAt > Date.now()) {
        this.touch(key, hit);
        return hit.value as T;
      }
      this.memory.delete(key);
    }

    if (!this.options.dir) return undefined;
    try {
      const raw = await readFile(this.fileFor(key), 'utf8');
      const entry = JSON.parse(raw) as Entry<T>;
      if (entry.expiresAt > Date.now()) {
        this.touch(key, entry as Entry<unknown>);
        return entry.value;
      }
    } catch {
      // Cold cache or unreadable file: treat as a miss.
    }
    return undefined;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const entry: Entry<T> = { value, expiresAt: Date.now() + ttlSeconds * 1000 };
    this.touch(key, entry as Entry<unknown>);
    if (!this.options.dir) return;
    try {
      await mkdir(this.options.dir, { recursive: true });
      await writeFile(this.fileFor(key), JSON.stringify(entry), 'utf8');
    } catch (error) {
      log.warn('failed to persist cache entry', (error as Error).message);
    }
  }

  /** Drop the in-memory copy only. */
  delete(key: string): void {
    this.memory.delete(key);
  }

  /**
   * Drop an entry from *both* tiers.
   *
   * Clearing memory alone is not enough: `wrap` re-reads on a miss and would
   * hand back the on-disk copy, which made "force refresh" a no-op whenever a
   * disk cache was configured.
   */
  async invalidate(key: string): Promise<void> {
    this.memory.delete(key);
    // A build already in flight would re-populate the entry on completion.
    this.inflight.delete(key);
    if (!this.options.dir) return;
    try {
      await rm(this.fileFor(key), { force: true });
    } catch (error) {
      log.warn('failed to remove cache entry', (error as Error).message);
    }
  }

  /**
   * Cache-aside with single-flight: concurrent misses for the same key share
   * one upstream build instead of stampeding it.
   */
  async wrap<T>(key: string, ttlSeconds: number, build: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      try {
        const value = await build();
        await this.set(key, value, ttlSeconds);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  get size(): number {
    return this.memory.size;
  }
}
