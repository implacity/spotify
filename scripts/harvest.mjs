#!/usr/bin/env node
/**
 * Harvest persisted-query hashes by driving a real browser.
 *
 * Reading hashes out of devtools by hand is slow and error-prone, and scraping
 * them out of Spotify's JS bundles is brittle. This does the reliable thing
 * instead: open the web player, visit the pages that trigger the queries we
 * need, and record the requests it makes.
 *
 *   npm run harvest
 *   npm run harvest -- --headed        watch it work
 *   npm run harvest -- --artist <id>   use a specific artist
 *   npm run harvest -- --album <id>    use a specific album
 *
 * It writes SPOTIFY_PQ_* / SPOTIFY_OP_* into .env, and saves every operation
 * it saw — names, hashes and the exact variables the player sent — to
 * harvest-report.json. Those variable shapes matter: persisted queries reject
 * undeclared variables, so a correct hash with a guessed variable set still
 * fails.
 */
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index !== -1 && args[index + 1] ? args[index + 1] : fallback;
};

const BASE = value('base', 'https://open.spotify.com');
const QUERY = value('query', 'bladee');
const ARTIST = value('artist', '');
const ALBUM = value('album', '');
const HEADED = flag('headed');
const TIMEOUT = Number(value('timeout', '45000'));
const ENV_PATH = resolve(process.cwd(), '.env');
const REPORT_PATH = resolve(process.cwd(), 'harvest-report.json');

const ROLES = {
  artistOverview: ['queryArtistOverview', 'queryArtistOverviewV2', 'getArtistOverview'],
  album: ['getAlbum', 'queryAlbumTracks', 'getAlbumTracks'],
  search: ['searchSuggestions', 'searchArtists', 'searchDesktop', 'searchQuery'],
  discography: ['queryArtistDiscographyAll', 'queryArtistDiscographyOverview', 'queryArtistAlbums'],
};

/** Which role an operation serves. Mirrors scripts/pin-query.mjs. */
function roleFor(name) {
  const lower = name.toLowerCase();
  if (/(merch|credit|prerelease|video|canvas|autoplay|recommend|watch|clip)/.test(lower)) return null;
  if (lower.includes('search')) return 'search';
  if (lower.includes('discograph')) return 'discography';
  if (lower.includes('album')) return 'album';
  if (lower.includes('artist') && lower.includes('overview')) return 'artistOverview';
  return null;
}

/** Prefer an operation whose name we already know over an unfamiliar one. */
function bestForRole(seen, role) {
  const candidates = [...seen.values()].filter((entry) => entry.role === role);
  if (candidates.length === 0) return null;
  const known = candidates.find((entry) => ROLES[role].includes(entry.name));
  return known ?? candidates[0];
}

function upsert(lines, key, value) {
  const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
  if (index === -1) {
    lines.push(`${key}=${value}`);
    return 'added';
  }
  if (lines[index].slice(key.length + 1).trim() === value) return 'unchanged';
  lines[index] = `${key}=${value}`;
  return 'updated';
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    'Playwright is not installed.\n\n  npm install\n\n' +
      'then run this again. It drives a browser locally; nothing is uploaded.',
  );
  process.exit(1);
}

/** Use an installed browser where possible so nothing large is downloaded. */
async function launch() {
  const attempts = process.env.CHROMIUM_PATH
    ? [{ executablePath: process.env.CHROMIUM_PATH }]
    : [{ channel: 'chrome' }, { channel: 'msedge' }, {}];

  const failures = [];
  for (const options of attempts) {
    try {
      return await chromium.launch({ headless: !HEADED, ...options });
    } catch (error) {
      failures.push(`${options.channel ?? 'bundled chromium'}: ${error.message.split('\n')[0]}`);
    }
  }
  throw new Error(
    `Could not start a browser.\n  ${failures.join('\n  ')}\n\n` +
      'Install Chrome, or run: npx playwright install chromium',
  );
}

const browser = await launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();

/** operationName -> { name, hash, variables, role } */
const seen = new Map();
let token = null;

page.on('request', (request) => {
  const url = request.url();
  // Match on the path, not the host, so this is testable against a local stub.
  if (!url.includes('/pathfinder/')) return;

  try {
    const parsed = new URL(url);
    const name = parsed.searchParams.get('operationName');
    const extensions = parsed.searchParams.get('extensions');
    const variables = parsed.searchParams.get('variables');
    if (!name || !extensions) return;

    const hash = JSON.parse(extensions)?.persistedQuery?.sha256Hash;
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) return;

    if (!seen.has(name)) {
      seen.set(name, {
        name,
        hash: hash.toLowerCase(),
        variables: variables ? JSON.parse(variables) : {},
        role: roleFor(name),
      });
      const role = roleFor(name);
      console.log(`  captured ${name}${role ? `  (${role})` : ''}`);
    }

    const auth = request.headers().authorization;
    if (!token && auth?.startsWith('Bearer ')) token = auth.slice(7);
  } catch {
    // A request we cannot parse is simply not one we can use.
  }
});

const settle = async (ms = 2500) => {
  await page.waitForTimeout(ms);
};

async function visit(path, label) {
  console.log(`\n→ ${label}`);
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    // The player fires its queries after hydration, not on load.
    await settle();
  } catch (error) {
    console.log(`  (${error.message.split('\n')[0]})`);
  }
}

console.log(`Harvesting from ${BASE}${HEADED ? ' (headed)' : ''}\n`);

await visit('/', 'home');
await visit(`/search/${encodeURIComponent(QUERY)}`, `search for "${QUERY}"`);

// Find an artist to open: the one passed in, or the first the search surfaced.
let artistId = ARTIST;
if (!artistId) {
  artistId = await page
    .$$eval('a[href^="/artist/"]', (links) => links[0]?.getAttribute('href')?.split('/')[2] ?? '')
    .catch(() => '');
}

/** First album link on the current page, if any. */
const findAlbumId = () =>
  page
    .$$eval('a[href^="/album/"]', (links) => links[0]?.getAttribute('href')?.split('/')[2] ?? '')
    .catch(() => '');

if (artistId) {
  await visit(`/artist/${artistId}`, `artist page ${artistId}`);
  // Look here first: the artist page lists releases, and navigating on would
  // lose them.
  let albumId = ALBUM || (await findAlbumId());

  await visit(`/artist/${artistId}/discography/all`, 'full discography');
  if (!albumId) albumId = await findAlbumId();

  if (albumId) await visit(`/album/${albumId}`, `album page ${albumId}`);
  else console.log('\n(no album link found; pass --album <id> to target one directly)');
} else {
  console.log('\n(no artist link found — pass --artist <id> to target one directly)');
}

await browser.close();

// ---------------------------------------------------------------- results

if (seen.size === 0) {
  console.error(
    '\nNo pathfinder requests were captured.\n\n' +
      'Try `npm run harvest -- --headed` to watch what the browser does; a\n' +
      'consent dialog or a region block will be obvious that way.',
  );
  process.exit(1);
}

const report = {
  capturedAt: new Date().toISOString(),
  base: BASE,
  operations: [...seen.values()].map(({ name, hash, variables, role }) => ({
    name,
    role,
    hash,
    variables,
  })),
};
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split('\n') : [];
while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

let wrote = 0;
const resolved = [];
const missing = [];

for (const role of Object.keys(ROLES)) {
  const entry = bestForRole(seen, role);
  if (!entry) {
    missing.push(role);
    continue;
  }

  if (upsert(lines, `SPOTIFY_PQ_${entry.name.toUpperCase()}`, entry.hash) !== 'unchanged') wrote += 1;
  // Pin the name too when it is a spelling the app does not know.
  if (!ROLES[role].includes(entry.name)) {
    if (upsert(lines, `SPOTIFY_OP_${role.toUpperCase()}`, entry.name) !== 'unchanged') wrote += 1;
  }
  resolved.push(`${role} → ${entry.name}`);
}

if (wrote > 0) writeFileSync(ENV_PATH, `${lines.join('\n')}\n`, 'utf8');

console.log(`\n${'-'.repeat(60)}`);
console.log(`Saw ${seen.size} operations, ${wrote} .env line(s) written.\n`);
for (const line of resolved) console.log(`  ${line}`);

if (missing.length > 0) {
  console.log(`\nNot captured: ${missing.join(', ')}`);
  console.log('Re-run with --headed to see whether those pages loaded at all.');
} else {
  console.log('\nAll four roles pinned. Restart the server.');
}

console.log(`\nFull capture written to ${REPORT_PATH}`);
if (token) console.log('(a bearer token was seen but not saved — it expires within the hour)');
