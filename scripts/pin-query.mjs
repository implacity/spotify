#!/usr/bin/env node
/**
 * Pin persisted-query hashes from pathfinder request URLs.
 *
 * When automatic discovery cannot read the hashes out of Spotify's bundles,
 * the reliable fallback is to copy them from a real request. Transcribing
 * 64-character hashes by hand is miserable, so this takes the whole URL:
 *
 *   In devtools: Network tab -> filter "pathfinder" -> right-click a request
 *   -> Copy -> Copy link address
 *
 *   npm run pin -- "<paste>"            (repeat or pass several at once)
 *   npm run pin                          (then paste, one per line, Ctrl-D/Ctrl-Z)
 *
 * It writes SPOTIFY_PQ_* lines into .env, and SPOTIFY_OP_* when the operation
 * name is one this project does not already know.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_PATH = resolve(process.cwd(), '.env');

/** Operation-name spellings already built in, per role. */
const KNOWN = {
  artistOverview: ['queryArtistOverview', 'queryArtistOverviewV2', 'getArtistOverview'],
  album: ['getAlbum', 'queryAlbumTracks', 'getAlbumTracks'],
  search: ['searchArtists', 'searchDesktop', 'searchQuery'],
  discography: [
    'queryArtistDiscographyAll',
    'queryArtistDiscographyOverview',
    'queryArtistAlbums',
  ],
};

/** Which role an operation name serves, by what it mentions. */
function roleFor(name) {
  const lower = name.toLowerCase();
  // Merch, credits, prerelease and similar share the "album"/"artist" prefix
  // but carry none of the data this project needs.
  if (/(merch|credit|prerelease|video|canvas|autoplay|recommend)/.test(lower)) return null;
  if (lower.includes('search')) return 'search';
  if (lower.includes('discograph')) return 'discography';
  if (lower.includes('album')) return 'album';
  if (lower.includes('artist') && lower.includes('overview')) return 'artistOverview';
  return null;
}

function parse(text) {
  const found = [];
  // Accept a bare URL, "copy as fetch" output, or anything containing one.
  const urls = text.match(/https?:\/\/[^\s"'`]+pathfinder[^\s"'`]*/gi) ?? [];

  for (const raw of urls) {
    let url;
    try {
      url = new URL(raw.replace(/[),.]+$/, ''));
    } catch {
      continue;
    }

    const name = url.searchParams.get('operationName');
    const extensions = url.searchParams.get('extensions');
    if (!name || !extensions) continue;

    let hash;
    try {
      hash = JSON.parse(extensions)?.persistedQuery?.sha256Hash;
    } catch {
      continue;
    }
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) continue;

    found.push({ name, hash: hash.toLowerCase(), role: roleFor(name) });
  }

  return found;
}

/** Replace a KEY=... line in place, or append it. */
function upsert(lines, key, value) {
  const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
  if (index === -1) {
    lines.push(`${key}=${value}`);
    return 'added';
  }
  const existing = lines[index].slice(key.length + 1).trim();
  if (existing === value) return 'unchanged';
  lines[index] = `${key}=${value}`;
  return 'updated';
}

const readStdin = () =>
  new Promise((done) => {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (buffer += chunk));
    process.stdin.on('end', () => done(buffer));
  });

const args = process.argv.slice(2);
let input = args.join('\n');

if (!input.trim()) {
  if (process.stdin.isTTY) {
    console.log('Paste pathfinder request URLs, one per line, then press Ctrl-D (Ctrl-Z on Windows):\n');
  }
  input = await readStdin();
}

const entries = parse(input);

if (entries.length === 0) {
  console.error(
    'No pathfinder URLs with a persisted-query hash found.\n\n' +
      'In devtools: Network tab, filter "pathfinder", right-click a request,\n' +
      'Copy -> Copy link address, then pass it here. The URL must contain both\n' +
      'operationName= and extensions= parameters.',
  );
  process.exit(1);
}

const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8').split('\n') : [];
// Drop a trailing blank so appends stay tidy.
while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

const roles = new Set();
let wrote = 0;

for (const { name, hash, role } of entries) {
  const status = upsert(lines, `SPOTIFY_PQ_${name.toUpperCase()}`, hash);
  if (status !== 'unchanged') wrote += 1;

  const label = role ? `role: ${role}` : 'not a role this project uses';
  console.log(`${status.padEnd(9)} ${name}  (${label})`);

  // Pin the operation name too when it is a spelling we do not know.
  if (role && !KNOWN[role].includes(name)) {
    const key = `SPOTIFY_OP_${role.toUpperCase()}`;
    const opStatus = upsert(lines, key, name);
    console.log(`${opStatus.padEnd(9)} ${key}=${name}`);
    if (opStatus !== 'unchanged') wrote += 1;
  }
  if (role) roles.add(role);
}

if (wrote > 0) writeFileSync(ENV_PATH, `${lines.join('\n')}\n`, 'utf8');

const missing = Object.keys(KNOWN).filter((role) => !roles.has(role));
console.log(`\n${wrote} line(s) written to .env`);

if (missing.length > 0) {
  console.log(
    `\nStill needed: ${missing.join(', ')}\n` +
      'Trigger each in the web player and copy that request too:\n' +
      '  search         - type in the search box\n' +
      '  artistOverview - open an artist page\n' +
      '  discography    - open an artist page, then "Discography" / "Show all"\n' +
      '  album          - open an album (the request whose response lists tracks,\n' +
      '                  not queryAlbumMerch)',
  );
} else {
  console.log('\nAll four roles pinned. Restart the server.');
}
