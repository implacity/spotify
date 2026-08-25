import { chromium } from 'playwright';

/**
 * End-to-end smoke test: drives the real UI in Chromium against a server
 * running in mock mode. Unit tests cover the data layer; this covers the part
 * a user actually touches — search, navigation, sorting, filtering, layout.
 *
 *   npm run build && MOCK=1 PORT=3111 npm start &
 *   BASE=http://127.0.0.1:3111 node scripts/smoke.mjs
 */
const BASE = process.env.BASE ?? 'http://127.0.0.1:3111';
const OUT = process.env.OUT ?? 'screenshots';

import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

// PLAYWRIGHT_BROWSERS_PATH covers most setups; the explicit path is a fallback
// for images that ship Chromium outside Playwright's registry.
const launchOptions = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('requestfailed', (request) => {
  // Closing an EventSource aborts its request by design, so ERR_ABORTED is
  // the normal end of a stream rather than a failure.
  const reason = request.failure()?.errorText ?? '';
  if (reason.includes('ERR_ABORTED')) return;
  errors.push(`requestfailed: ${request.url()} — ${reason}`);
});

const step = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    console.log(`FAIL  ${name}: ${error.message}`);
    process.exitCode = 1;
  }
};

// --- home page ---
await page.goto(BASE, { waitUntil: 'networkidle' });
await step('home renders headline', async () => {
  const text = await page.textContent('h1');
  if (!text?.includes('Every song')) throw new Error(`unexpected h1: ${text}`);
});
await page.screenshot({ path: `${OUT}/01-home.png` });

// --- typeahead in the top bar ---
await step('typeahead returns suggestions', async () => {
  await page.fill('#search-input', 'nova');
  await page.waitForSelector('.suggestion-name', { timeout: 5000 });
  const name = await page.textContent('.suggestion-name');
  if (name !== 'Nova Ardent') throw new Error(`unexpected suggestion: ${name}`);
});
await page.screenshot({ path: `${OUT}/02-typeahead.png` });

// --- navigate to the artist page ---
await step('clicking a suggestion opens the artist page', async () => {
  await page.click('.suggestion');
  await page.waitForSelector('table tbody tr', { timeout: 15000 });
  if (!page.url().includes('/artist/')) throw new Error(`did not navigate: ${page.url()}`);
});

await step('artist header shows the name', async () => {
  const name = await page.textContent('.artist-title h1');
  if (name !== 'Nova Ardent') throw new Error(`unexpected artist: ${name}`);
});

await step('stat tiles are populated', async () => {
  const values = await page.$$eval('.stat-value', (nodes) => nodes.map((n) => n.textContent));
  if (values.length < 5) throw new Error(`only ${values.length} stat tiles`);
  if (values.some((v) => !v || v === '—')) throw new Error(`empty stat tile: ${values.join(' | ')}`);
});

const rowCount = async () => page.$$eval('table tbody tr', (rows) => rows.length);

await step('stat tiles agree with the rows on screen', async () => {
  const shown = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll('.stat')];
    const tracksTile = tiles.find((tile) => tile.querySelector('.stat-label')?.textContent === 'Tracks');
    const rows = [...document.querySelectorAll('table tbody tr')];
    const plays = rows.map((row) => Number((row.querySelector('td.plays')?.textContent ?? '').replace(/[^\d]/g, '')));
    return {
      tileTracks: Number((tracksTile?.querySelector('.stat-value')?.textContent ?? '').replace(/[^\d]/g, '')),
      rowCount: rows.length,
      totalPlays: plays.reduce((sum, n) => sum + n, 0),
      tileTotalSub: tiles[1]?.querySelector('.stat-sub')?.textContent ?? '',
    };
  });
  // The "Tracks" tile must describe the table the user is looking at.
  if (shown.tileTracks !== shown.rowCount) {
    throw new Error(`tile says ${shown.tileTracks} tracks but table has ${shown.rowCount} rows`);
  }
  const subTotal = Number(shown.tileTotalSub.replace(/ across.*/, '').replace(/[^\d]/g, ''));
  if (subTotal !== shown.totalPlays) {
    throw new Error(`total plays tile (${subTotal}) does not match the summed rows (${shown.totalPlays})`);
  }
});

await step('table lists tracks with play counts', async () => {
  const rows = await rowCount();
  if (rows < 10) throw new Error(`only ${rows} rows`);
  const plays = await page.$$eval('td.plays', (cells) => cells.map((c) => c.textContent?.trim()));
  if (plays.some((p) => !p || p === '—')) throw new Error('a play-count cell is empty');
});

await step('rows are sorted by plays descending', async () => {
  const plays = await page.$$eval('td.plays', (cells) =>
    cells.map((c) => Number((c.textContent ?? '').replace(/[^\d]/g, ''))),
  );
  const sorted = [...plays].sort((a, b) => b - a);
  if (JSON.stringify(plays) !== JSON.stringify(sorted)) throw new Error('not sorted by plays');
});

await page.screenshot({ path: `${OUT}/03-artist.png`, fullPage: true });

// --- sorting ---
await step('clicking a header re-sorts the table', async () => {
  const before = await page.$$eval('.track-name a', (a) => a.map((n) => n.textContent));
  await page.click('thead th:nth-child(2)');
  await page.waitForTimeout(200);
  const after = await page.$$eval('.track-name a', (a) => a.map((n) => n.textContent));
  if (JSON.stringify(before) === JSON.stringify(after)) throw new Error('order unchanged');
  const sorted = [...after].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(after) !== JSON.stringify(sorted)) throw new Error('not alphabetical');
});

// --- filtering ---
await step('the filter box narrows the table', async () => {
  const before = await rowCount();
  await page.fill('.filter-input', 'parallax');
  await page.waitForTimeout(250);
  const after = await rowCount();
  if (after >= before || after === 0) throw new Error(`filter gave ${after} of ${before} rows`);
  await page.fill('.filter-input', '');
  await page.waitForTimeout(250);
});

// --- keyboard + focus behaviour ---
await step('the filter input keeps focus while typing', async () => {
  await page.click('.filter-input');
  await page.keyboard.type('para');
  await page.waitForTimeout(250);
  const focused = await page.evaluate(() => document.activeElement?.className ?? '');
  if (!focused.includes('filter-input')) throw new Error(`focus moved to "${focused}"`);
  const caret = await page.evaluate(() => document.activeElement.selectionStart);
  if (caret !== 4) throw new Error(`caret at ${caret}, expected 4`);
  await page.fill('.filter-input', '');
  await page.waitForTimeout(200);
});

await step('sortable headers work from the keyboard', async () => {
  const before = await page.$$eval('.track-name a', (a) => a.map((n) => n.textContent));
  await page.evaluate(() => document.querySelector('thead th.sortable').focus());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const after = await page.$$eval('.track-name a', (a) => a.map((n) => n.textContent));
  if (JSON.stringify(before) === JSON.stringify(after)) throw new Error('Enter did not sort');
});

// --- album-type chips ---
await step('album-type chips filter the table', async () => {
  const before = await rowCount();
  const chip = page.locator('.chip', { hasText: 'Singles' }).first();
  await chip.click();
  await page.waitForTimeout(250);
  const after = await rowCount();
  if (after >= before) throw new Error(`chip did not filter (${after} vs ${before})`);
  await chip.click();
  await page.waitForTimeout(250);
});

// --- duplicate merging ---
await step('merge-duplicates toggle changes the row count', async () => {
  const grouped = await rowCount();
  await page.locator('.chip', { hasText: 'Merge duplicates' }).click();
  await page.waitForTimeout(300);
  const ungrouped = await rowCount();
  if (ungrouped <= grouped) throw new Error(`ungrouping gave ${ungrouped} vs ${grouped}`);
  await page.locator('.chip', { hasText: 'Merge duplicates' }).click();
  await page.waitForTimeout(300);
});

// --- deep link / reload ---
await step('a deep link loads the artist directly', async () => {
  const url = page.url();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('table tbody tr', { timeout: 15000 });
  const name = await page.textContent('.artist-title h1');
  if (name !== 'Nova Ardent') throw new Error(`deep link failed: ${name}`);
});

// --- mobile ---
await step('mobile layout renders without horizontal overflow', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 2) throw new Error(`page overflows by ${overflow}px`);
});
await page.screenshot({ path: `${OUT}/04-mobile.png` });
await page.setViewportSize({ width: 1440, height: 1000 });

// --- unknown artist ---
await step('an unknown artist shows an error, not a blank page', async () => {
  await page.goto(`${BASE}/artist/zzzzzzzzzzzzzzzzzzzzzz`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.notice.error', { timeout: 10000 });
});

console.log(errors.length === 0 ? 'PASS  no console/network errors' : `FAIL  page errors:\n  ${errors.join('\n  ')}`);
if (errors.length > 0) process.exitCode = 1;

await browser.close();
