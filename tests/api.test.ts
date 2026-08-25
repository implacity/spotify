import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/server/app.js';
import { mockArtistIds } from '../src/mock/fixtures.js';
import type { ArtistCatalog } from '../src/spotify/types.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const config = loadConfig({ MOCK: '1', CACHE_DIR: '', RATE_LIMIT_PER_MINUTE: '0' } as NodeJS.ProcessEnv);
  const app = createApp(config);
  server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const artistId = mockArtistIds()[0]!;

describe('GET /api/health', () => {
  it('reports mock mode and service status', async () => {
    const response = await fetch(`${base}/api/health`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.config.mock).toBe(true);
    expect(body.service.officialConfigured).toBe(false);
  });
});

describe('GET /api/search', () => {
  it('finds an artist by name', async () => {
    const response = await fetch(`${base}/api/search?q=nova`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.artists).toHaveLength(1);
    expect(body.artists[0].name).toBe('Nova Ardent');
  });

  it('matches on genre too', async () => {
    const body = await (await fetch(`${base}/api/search?q=post-rock`)).json();
    expect(body.artists[0].name).toBe('Glass Cathedral');
  });

  it('returns an empty list for an empty query rather than erroring', async () => {
    const response = await fetch(`${base}/api/search?q=`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ query: '', artists: [] });
  });

  it('respects the limit parameter', async () => {
    const body = await (await fetch(`${base}/api/search?q=a&limit=1`)).json();
    expect(body.artists.length).toBeLessThanOrEqual(1);
  });
});

describe('GET /api/artist/:id', () => {
  it('returns a full catalogue sorted by play count', async () => {
    const response = await fetch(`${base}/api/artist/${artistId}`);
    expect(response.status).toBe(200);

    const catalog: ArtistCatalog = await response.json();
    expect(catalog.artist.name).toBe('Nova Ardent');
    expect(catalog.tracks.length).toBeGreaterThan(10);
    expect(catalog.source).toBe('mock');

    const counts = catalog.tracks.map((track) => track.playCount ?? 0);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('gives every track the fields the table renders', async () => {
    const catalog: ArtistCatalog = await (await fetch(`${base}/api/artist/${artistId}`)).json();
    for (const track of catalog.tracks) {
      expect(track).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        displayName: expect.any(String),
        url: expect.stringContaining('open.spotify.com'),
        durationMs: expect.any(Number),
        groupKey: expect.any(String),
      });
      expect(track.album.name).toEqual(expect.any(String));
    }
  });

  it('merges duplicate recordings when grouping is on', async () => {
    const grouped: ArtistCatalog = await (await fetch(`${base}/api/artist/${artistId}?group=1`)).json();
    const ungrouped: ArtistCatalog = await (await fetch(`${base}/api/artist/${artistId}?group=0`)).json();

    expect(grouped.tracks.length).toBeLessThan(ungrouped.tracks.length);

    // "Static Bloom" ships on the album, as a single and on the compilation.
    const staticBlooms = grouped.tracks.filter((track) => track.displayName === 'Static Bloom');
    expect(staticBlooms).toHaveLength(1);
    expect(staticBlooms[0]!.duplicateCount).toBeGreaterThan(0);
  });

  it('keeps alternate versions separate even when grouping', async () => {
    const grouped: ArtistCatalog = await (await fetch(`${base}/api/artist/${artistId}?group=1`)).json();
    const titles = grouped.tracks.map((track) => track.displayName);
    expect(titles).toContain('Midnight Arcade');
    expect(titles).toContain('Midnight Arcade (Acoustic)');
  });

  it('recomputes stats to match the grouped view', async () => {
    const catalog: ArtistCatalog = await (await fetch(`${base}/api/artist/${artistId}?group=1`)).json();
    const sum = catalog.tracks.reduce((total, track) => total + (track.playCount ?? 0), 0);
    expect(catalog.stats.totalPlayCount).toBe(sum);
    expect(catalog.stats.countedTracks).toBe(catalog.tracks.length);
  });

  it('rejects a malformed artist id', async () => {
    const response = await fetch(`${base}/api/artist/not-a-real-id`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/invalid artist id/i);
  });

  it('404s for an unknown artist', async () => {
    const response = await fetch(`${base}/api/artist/aaaaaaaaaaaaaaaaaaaaaa`);
    expect(response.status).toBe(404);
  });
});

describe('SSE streaming', () => {
  it('streams progress events and a final catalogue', async () => {
    const response = await fetch(`${base}/api/artist/${artistId}?stream=1`, {
      headers: { accept: 'text/event-stream' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const text = await response.text();
    expect(text).toContain('event: progress');
    expect(text).toContain('event: catalog');

    // The final frame must be parseable on its own.
    const frame = text.split('event: catalog\ndata: ')[1]!.split('\n\n')[0]!;
    const catalog: ArtistCatalog = JSON.parse(frame);
    expect(catalog.artist.name).toBe('Nova Ardent');
    expect(catalog.tracks.length).toBeGreaterThan(0);
  });

  it('reports failures as an event rather than a dropped connection', async () => {
    const response = await fetch(`${base}/api/artist/aaaaaaaaaaaaaaaaaaaaaa?stream=1`, {
      headers: { accept: 'text/event-stream' },
    });
    const text = await response.text();
    expect(text).toContain('event: failed');
    expect(text).toMatch(/Unknown artist/);
  });
});

describe('static shell', () => {
  it('serves the SPA at the root', async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>Spindex');
  });

  it('serves the same shell for deep artist links', async () => {
    const response = await fetch(`${base}/artist/${artistId}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="view"');
  });

  it('serves the client bundle and stylesheet', async () => {
    expect((await fetch(`${base}/app.js`)).status).toBe(200);
    expect((await fetch(`${base}/styles.css`)).status).toBe(200);
  });
});

describe('rate limiting', () => {
  it('rejects a client that exceeds the per-minute budget', async () => {
    const config = loadConfig({ MOCK: '1', CACHE_DIR: '', RATE_LIMIT_PER_MINUTE: '3' } as NodeJS.ProcessEnv);
    const app = createApp(config);
    const limited = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const address = limited.address();
    const url = `http://127.0.0.1:${(address as { port: number }).port}/api/health`;

    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await fetch(url)).status);

      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses[3]).toBe(429);
      expect(statuses[4]).toBe(429);
    } finally {
      await new Promise<void>((resolve) => limited.close(() => resolve()));
    }
  });
});
