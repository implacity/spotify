# Spindex

Look up a Spotify artist and get their whole catalogue ranked by play count — the
kworb.net / musicmetricsvault idea, self-hosted.

Search an artist, and you get every album, single, compilation and guest
appearance flattened into one sortable table: track, album, release date, play
count, popularity and duration, with duplicate releases of the same recording
merged, plus CSV export.

---

## The important caveat, up front

**Spotify's documented Web API does not expose play counts.** It gives you a
`popularity` score from 0 to 100 and nothing more. Any site showing exact
stream numbers per track is reading them from the private GraphQL API that
`open.spotify.com` uses for its own web player.

So this project has two data sources:

| Source | What it provides | Reliability |
| --- | --- | --- |
| **Web API** (`api.spotify.com`) — documented, OAuth client credentials | Artists, releases, tracks, popularity, followers | Stable and supported, **but needs Premium** (below) |
| **Pathfinder** (`api-partner.spotify.com`) — private, undocumented | Search, discography, tracks, play counts, monthly listeners | Unsupported; auth and query hashes rotate without notice |

There is a second catch beyond the missing play counts: **Spotify requires the
account that owns your developer app to have an active Premium subscription**
before the Web API will answer at all. Without it every call returns
`403 — Active premium subscription required for the owner of the app`, valid
credentials or not.

So the app runs in one of two modes, chosen automatically:

- **`official`** — credentials present. Documented API for the catalogue and
  popularity, web player for play counts. The most stable arrangement.
- **`partner`** — no credentials. *Everything* comes from the web player:
  search, discography, track listings and play counts. No developer app, no
  client secret, no Premium. You lose popularity scores, which have no
  web-player equivalent — but play counts, the point of this site, are
  strictly more informative.

Force one with `SPOTIFY_SOURCE=official|partner`; the default `auto` picks
`official` when credentials exist and `partner` otherwise — and if the Web API
then refuses for lack of a Premium subscription, `auto` switches to `partner`
for the rest of the process rather than failing. So leaving unusable
credentials in `.env` costs you one 403, not a broken site. `/api/health`
reports `officialBlocked` when that has happened. Either way, if the
play-count source is unreachable the page still renders and says so rather
than failing.

Two things follow from this that are worth knowing before you deploy it:

- **It can break at any time.** Spotify changes the private API's auth scheme
  and its persisted-query hashes regularly. The code is built to adapt (see
  [Play counts](#play-counts)), but no undocumented API is a stable dependency.
- **Check the terms that apply to you.** Reading the private endpoint is not
  covered by Spotify's Developer Terms of Service, and scraping is generally
  disallowed by them. Running this privately against public data is a different
  proposition from operating it as a public service. That call is yours to make.

---

## Quick start

No credentials needed — this runs the whole site on generated sample data:

```bash
npm install
npm run build
npm run start:mock
# → http://localhost:3000
```

`start:mock` works the same in cmd, PowerShell and any Unix shell. (The
`MOCK=1 npm start` form you may see elsewhere is bash-only and fails on
Windows cmd with *'MOCK' is not recognized*.) Setting `MOCK=1` in a `.env`
file works everywhere too.

Sample mode uses three invented artists (Nova Ardent, Glass Cathedral, Marisol
Vega) with generated numbers, and the UI badges it as **Sample data**. Real
artists are deliberately not used there — putting made-up stream counts under a
real name would misrepresent them.

### Real data, no credentials

```bash
npm run build && npm start
```

With no `SPOTIFY_CLIENT_ID` set, the app runs in `partner` mode and gets
everything from the web player. Nothing to register, nothing to pay for.
Check `activeSource` at `/api/health` to confirm which mode you are in.

This path rests entirely on an undocumented API, so treat it as the trade-off
it is: no setup, less stability.

### Real data, via the documented API

Needs Premium on the account that owns the app.

```bash
cp .env.example .env          # Windows: copy .env.example .env
# fill in SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET
npm run build && npm start
```

Everything else is read from `.env`, so no shell-specific environment syntax
is needed on any platform.

> **Spotify requires the account that owns the app to have an active Premium
> subscription** to use the Web API. Without it every request comes back
> `403 — Active premium subscription required for the owner of the app`, even
> though the credentials themselves are valid. A free account can create the
> app but cannot call the API.

Get credentials from the [Spotify developer dashboard](https://developer.spotify.com/dashboard),
then **Create app**:

- **Redirect URI** — required by the form, but never used here: the
  client-credentials flow has no redirect step. Enter
  `http://127.0.0.1:3000/callback`. Do *not* use `http://localhost:3000/...`;
  Spotify rejects `localhost` for new apps and wants an explicit loopback
  address (`127.0.0.1`, or `[::1]` for IPv6).
- **Which API/SDKs are you planning to use?** — tick **Web API**.

Copy the client ID and secret from the app's settings into `.env`. That alone
gets you the full catalogue with popularity. For play counts, read on.

---

## Play counts

Getting stream counts means talking to the web player's own API, which needs
two things that Spotify rotates: an access token, and a SHA-256 hash
identifying each persisted GraphQL query. Rather than hard-code values that
would go stale, the client resolves both at runtime and lets you override them.

**Tokens** are tried in this order, first hit wins:

1. `SPOTIFY_PARTNER_TOKEN` — a bearer token you paste in from devtools. Always
   works, expires in about an hour. Best for a quick test.
2. `SPOTIFY_SP_DC` — the `sp_dc` cookie from a logged-in session, used to mint
   tokens automatically. Longest-lived option. *Treat it like a password: it
   authenticates your Spotify account.*
3. Anonymous — the web player's public token endpoint.
4. Scraping the token the player embeds in its own HTML.

If Spotify demands TOTP-signed token requests, set `SPOTIFY_TOTP_SECRET` (base32)
and the requests get signed. The TOTP implementation is plain RFC 6238 and is
verified against the RFC's own test vectors.

**Query hashes** are read out of the web player's JS bundles on first use and
cached, so a Spotify release that rotates them heals itself. If discovery ever
fails, pin one by hand (names are matched case-insensitively):

```bash
SPOTIFY_PQ_QUERYARTISTOVERVIEW=<sha256>
SPOTIFY_PQ_GETALBUM=<sha256>
SPOTIFY_PQ_SEARCHARTISTS=<sha256>
SPOTIFY_PQ_QUERYARTISTDISCOGRAPHYALL=<sha256>
```

Rather than transcribing 64-character hashes by hand, paste the request URL:

```bash
npm run pin -- "<url>"
```

In devtools, open the **Network** tab, filter for `pathfinder`, right-click a
request and choose **Copy → Copy link address**. The helper reads the
operation name and hash out of the URL, writes the right `.env` lines, and
tells you which of the four roles are still missing. Pass several URLs at
once, or run `npm run pin` with no arguments and paste them one per line.

You do not need all four to get something useful. With only **search** and
**artistOverview** pinned, the site works and shows the artist's top tracks
with real play counts, and says so; adding **discography** and **album**
expands that to the full catalogue.

Trigger each role in the web player: **search** by typing in the search box,
**artistOverview** and **discography** by opening an artist page (then
"Discography"/"Show all"), and **album** by opening an album — the request
listing tracks, not `queryAlbumMerch`, which carries merchandise and is
ignored.

**Operation names** also change between releases, so each role has a list of
candidate spellings and the first one with a resolvable hash wins. Pin one
explicitly with `SPOTIFY_OP_SEARCH`, `SPOTIFY_OP_DISCOGRAPHY`,
`SPOTIFY_OP_ALBUM` or `SPOTIFY_OP_ARTISTOVERVIEW` if Spotify introduces a
spelling this doesn't know about. The error message names the candidates it tried.

### How play counts are reported

Spotify counts plays per *track id*, and the same recording has a different id
on the single, the album and the deluxe reissue — each with its own count.

With **Merge duplicates** on (the default), those collapse into one row.
**Play counts are not summed**, because those rows are several catalogue
entries for one song, and adding them would overstate it. The row keeps the
highest count and shows a `+N` badge for the other releases carrying it.

Merging is conservative about what counts as the same song. Packaging noise is
ignored — `- Remastered 2011`, `(Bonus Track)`, `(feat. …)`, `- Album Version`.
Anything that means a genuinely different recording is kept separate: live,
acoustic, remixes, demos, and re-recordings like `(Taylor's Version)`.

---

## Configuration

Everything is environment variables; see `.env.example` for the annotated list.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | — | Web API credentials |
| `SPOTIFY_MARKET` | `US` | Market for availability and track relinking |
| `SPOTIFY_PARTNER_ENABLED` | `1` | Set `0` to run on popularity alone |
| `SPOTIFY_PARTNER_TOKEN` / `SPOTIFY_SP_DC` | — | Play-count auth (see above) |
| `SPOTIFY_TOTP_SECRET` / `SPOTIFY_TOTP_VERSION` | — / `5` | Token-request signing |
| `SPOTIFY_PQ_<OPERATION>` | — | Pin a persisted-query hash (case-insensitive) |
| `SPOTIFY_SOURCE` | `auto` | `auto`, `official` or `partner` |
| `SPOTIFY_OP_SEARCH` / `_DISCOGRAPHY` / `_ALBUM` / `_ARTISTOVERVIEW` | — | Pin a GraphQL operation name |
| `MOCK` | `0` | Serve sample data, no credentials needed |
| `CACHE_DIR` | `.cache` | Disk cache location; empty disables it |
| `CACHE_ARTIST_TTL` | `21600` | Catalogue freshness, seconds |
| `CACHE_MAX_ENTRIES` | `64` | In-memory catalogues; each can be megabytes |
| `SPOTIFY_CONCURRENCY` | `6` | Parallel upstream requests |
| `SPOTIFY_MAX_RELEASES` | `400` | Ceiling on releases per artist |
| `RATE_LIMIT_PER_MINUTE` | `120` | Per-IP API budget; `0` disables |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |

---

## API

The frontend is a thin client over a small JSON API you can use directly.

```
GET /api/search?q=<query>&limit=20
GET /api/artist/:id?group=1&appearsOn=1&refresh=0
GET /api/health
```

`/api/artist/:id` also speaks Server-Sent Events — send
`Accept: text/event-stream` or add `&stream=1`. A full catalogue can take tens
of seconds, so the stream emits `progress` frames while it builds, then one
`catalog` frame, or `failed` on error:

```
event: progress
data: {"phase":"playcounts","message":"Fetching play counts","completed":18,"total":42}

event: catalog
data: { "artist": {...}, "tracks": [...], "stats": {...}, "warnings": [...] }
```

Every response carries a `warnings` array. That's where degraded states are
reported — play counts unavailable, some releases unreadable, discography
truncated — so a partial answer is still a usable one.

---

## How it works

```
public/            Vanilla ES-module frontend. No build step, no framework.
src/
  server/app.ts    Express routes, SSE streaming, per-IP rate limiting
  service.ts       Facade over both sources + caching + mock mode
  spotify/
    official.ts    Web API: token cache, pagination, batching, 401 recovery
    partner.ts     Private GraphQL: token strategies, play-count extraction
    persistedQueries.ts  Discovers query hashes from the web player
    catalog.ts     Joins both sources, merges duplicates, computes stats
    totp.ts        RFC 6238, for signed token requests
  util/            HTTP retry/backoff, two-tier cache, concurrency limiter
```

A few decisions worth calling out:

**Play-count extraction is structural, not path-based.** The private API's
response shape has changed repeatedly (`tracks` → `tracksV2`, extra wrapper
objects, and so on). Instead of reading fixed paths, the extractor walks the
response for `{ uri: "spotify:track:…", playcount }` pairs. Tests pin several
historical shapes to keep that honest.

**Caching is two-tier with single-flight.** Building one artist costs dozens of
upstream calls, so results are cached in an LRU and on disk, and concurrent
requests for the same artist share one build rather than stampeding it.

**Failures degrade instead of propagating.** One unreadable album doesn't fail
the page — it becomes a warning, and the other 95% still renders.

---

## Tests

```bash
npm test          # 99 unit + integration tests
npm run typecheck
```

Covers title normalization and duplicate merging, stats, the two-tier cache
(including that a forced refresh really clears both tiers)
(TTL, LRU eviction, single-flight, disk persistence), the Web API client
against a stubbed `fetch` (token reuse, 401 re-auth, pagination, batch sizes),
play-count extraction across old and new response shapes, and the HTTP API
end-to-end including the SSE stream, rate limiting, security headers, and
that responses are gzipped while event streams deliberately are not.

There's also a browser smoke test that drives the real UI in Chromium:

```bash
npm run build
npm run start:mock          # in one terminal
npm run smoke               # in another (BASE defaults to :3000)
```

It checks search, typeahead, navigation, sorting, filtering, duplicate
merging, deep links, mobile layout, the error state, and that the stat tiles
agree with the rows actually on screen.

---

## Deployment

```bash
docker build -t spindex .
docker run -p 3000:3000 --env-file .env spindex
```

Or run `npm ci && npm run build && npm start` behind a reverse proxy. Notes
for anything public-facing:

- Give `CACHE_DIR` a persistent volume, or every restart rebuilds from scratch.
- `CACHE_MAX_ENTRIES` counts whole catalogues, not rows. A large artist is
  megabytes in memory, so raise it only with the RAM to match — the disk tier
  is the durable one and costs nothing to keep large.
- Keep `RATE_LIMIT_PER_MINUTE` on. The app sits in front of a rate-limited
  upstream and one impatient client can spend the whole budget.
- The app trusts one proxy hop (`trust proxy = 1`) for client IPs. Adjust in
  `src/server/app.ts` if your topology differs.
- Never ship `SPOTIFY_SP_DC` in a client-side bundle or a public image — it is
  an account credential.

---

## Limitations

- Play counts are what Spotify reports to its web player, refreshed on their
  schedule. They aren't audited figures.
- Popularity is a relative 0-100 score, not a stream count. Where play counts
  are missing, that's the fallback signal.
- Very large discographies are capped by `SPOTIFY_MAX_RELEASES`; the response
  warns when it truncates.
- Regional availability varies. `SPOTIFY_MARKET` changes which tracks resolve.

Not affiliated with, endorsed by, or connected to Spotify.
