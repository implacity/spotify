// Spindex — client. No framework, no build step: this is a table and a search
// box, and keeping it dependency-free keeps it fast to load and easy to host.

const view = document.getElementById('view');
const searchForm = document.getElementById('searchbar');
const searchInput = document.getElementById('search-input');
const suggestionBox = document.getElementById('suggestions');
const modeBadge = document.getElementById('mode-badge');

const fullNumber = new Intl.NumberFormat('en-US');
const compactNumber = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const formatCount = (value) => (typeof value === 'number' ? fullNumber.format(value) : '—');
const formatCompact = (value) => (typeof value === 'number' ? compactNumber.format(value) : '—');

function formatDuration(ms) {
  if (!ms) return '—';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

function formatDate(value) {
  if (!value) return '—';
  // Spotify dates can be year-only or year-month.
  const parts = value.split('-');
  if (parts.length === 1) return parts[0];
  const date = new Date(`${value.length === 7 ? `${value}-01` : value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    ...(parts.length === 3 ? { day: 'numeric' } : {}),
    timeZone: 'UTC',
  });
}

/** Build an element; children may be nodes or strings (always set as text). */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Circular avatar with a graceful fallback when Spotify has no image. */
function avatar(src, name, className = '') {
  if (src) {
    return el('img', { src, alt: name, loading: 'lazy', class: className, referrerpolicy: 'no-referrer' });
  }
  return el(
    'div',
    { class: `avatar-fallback ${className}`.trim(), 'aria-hidden': 'true' },
    [],
  );
}

// ---------------------------------------------------------------- routing

function navigate(path, replace = false) {
  if (replace) history.replaceState({}, '', path);
  else history.pushState({}, '', path);
  render();
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-link]');
  if (!link) return;
  event.preventDefault();
  navigate(link.getAttribute('href'));
});

window.addEventListener('popstate', render);

// ---------------------------------------------------------------- search

let suggestionTimer = null;
let suggestionIndex = -1;
let suggestionItems = [];
let searchAbort = null;

async function fetchArtists(query, limit = 8) {
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  const response = await fetch(
    `/api/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    { signal: searchAbort.signal },
  );
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? 'Search failed');
  return (await response.json()).artists ?? [];
}

function closeSuggestions() {
  suggestionBox.hidden = true;
  suggestionBox.replaceChildren();
  suggestionIndex = -1;
  suggestionItems = [];
}

function renderSuggestions(artists) {
  suggestionItems = artists;
  suggestionIndex = -1;
  suggestionBox.replaceChildren();

  if (artists.length === 0) {
    suggestionBox.append(el('div', { class: 'suggestion muted', text: 'No artists found' }));
    suggestionBox.hidden = false;
    return;
  }

  for (const artist of artists) {
    const followers =
      typeof artist.followers === 'number' ? `${formatCompact(artist.followers)} followers` : '';
    const genres = artist.genres?.slice(0, 2).join(', ') ?? '';
    suggestionBox.append(
      el(
        'button',
        {
          type: 'button',
          class: 'suggestion',
          role: 'option',
          onclick: () => {
            closeSuggestions();
            searchInput.value = '';
            navigate(`/artist/${artist.id}`);
          },
        },
        [
          avatar(artist.image, artist.name),
          el('div', { class: 'suggestion-meta' }, [
            el('div', { class: 'suggestion-name', text: artist.name }),
            el('div', {
              class: 'suggestion-sub',
              text: [followers, genres].filter(Boolean).join(' · ') || 'Artist',
            }),
          ]),
        ],
      ),
    );
  }
  suggestionBox.hidden = false;
}

searchInput.addEventListener('input', () => {
  const query = searchInput.value.trim();
  clearTimeout(suggestionTimer);
  if (query.length < 2) {
    closeSuggestions();
    return;
  }
  // Debounce: typeahead shouldn't fire a request per keystroke.
  suggestionTimer = setTimeout(async () => {
    try {
      renderSuggestions(await fetchArtists(query));
    } catch (error) {
      if (error.name !== 'AbortError') closeSuggestions();
    }
  }, 220);
});

searchInput.addEventListener('keydown', (event) => {
  if (suggestionBox.hidden) return;
  const buttons = [...suggestionBox.querySelectorAll('.suggestion')];
  if (buttons.length === 0) return;

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    suggestionIndex = (suggestionIndex + delta + buttons.length) % buttons.length;
    buttons.forEach((button, index) =>
      button.setAttribute('aria-selected', String(index === suggestionIndex)),
    );
    buttons[suggestionIndex]?.scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter' && suggestionIndex >= 0) {
    event.preventDefault();
    buttons[suggestionIndex]?.click();
  } else if (event.key === 'Escape') {
    closeSuggestions();
  }
});

document.addEventListener('click', (event) => {
  if (!searchForm.contains(event.target)) closeSuggestions();
});

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = searchInput.value.trim();
  if (!query) return;
  closeSuggestions();
  navigate(`/?q=${encodeURIComponent(query)}`);
});

// `/` focuses search, the way every data site does it.
document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || event.metaKey || event.ctrlKey) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  event.preventDefault();
  searchInput.focus();
});

// ---------------------------------------------------------------- home view

async function renderHome() {
  const template = document.getElementById('tpl-home').content.cloneNode(true);
  view.replaceChildren(template);

  const form = document.getElementById('home-search');
  const input = document.getElementById('home-search-input');
  const results = document.getElementById('home-results');

  const query = new URLSearchParams(location.search).get('q') ?? '';
  input.value = query;

  const run = async (value) => {
    if (!value.trim()) {
      results.replaceChildren();
      return;
    }
    results.replaceChildren(el('div', { class: 'empty', text: 'Searching…' }));
    try {
      const artists = await fetchArtists(value, 24);
      if (artists.length === 0) {
        results.replaceChildren(
          el('div', { class: 'empty', text: `No artists match “${value}”.` }),
        );
        return;
      }
      results.replaceChildren(
        ...artists.map((artist) =>
          el('a', { class: 'artist-card', href: `/artist/${artist.id}`, 'data-link': true }, [
            avatar(artist.image, artist.name),
            el('div', { class: 'artist-card-name', text: artist.name }),
            el('div', {
              class: 'artist-card-sub',
              text:
                typeof artist.followers === 'number'
                  ? `${formatCompact(artist.followers)} followers`
                  : (artist.genres?.[0] ?? 'Artist'),
            }),
          ]),
        ),
      );
    } catch (error) {
      if (error.name === 'AbortError') return;
      results.replaceChildren(el('div', { class: 'notice error' }, [error.message]));
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = input.value.trim();
    history.replaceState({}, '', value ? `/?q=${encodeURIComponent(value)}` : '/');
    run(value);
  });

  if (query) run(query);
  else input.focus();
}

// ---------------------------------------------------------------- artist view

const tableState = {
  sortKey: 'playCount',
  sortDir: 'desc',
  filter: '',
  types: new Set(),
  group: true,
  appearsOn: true,
};

function sortValue(row, key) {
  switch (key) {
    case 'name':
      return row.displayName.toLowerCase();
    case 'album':
      return row.album.name.toLowerCase();
    case 'releaseDate':
      return row.album.releaseDate ?? '';
    case 'duration':
      return row.durationMs;
    case 'popularity':
      return row.popularity ?? -1;
    case 'playCount':
    default:
      return row.playCount ?? -1;
  }
}

function visibleRows(catalog) {
  const needle = tableState.filter.trim().toLowerCase();
  let rows = catalog.tracks;

  if (tableState.types.size > 0) {
    rows = rows.filter((row) => tableState.types.has(row.album.type));
  }
  if (needle) {
    rows = rows.filter(
      (row) =>
        row.displayName.toLowerCase().includes(needle) ||
        row.album.name.toLowerCase().includes(needle) ||
        row.artists.some((artist) => artist.name.toLowerCase().includes(needle)),
    );
  }

  const direction = tableState.sortDir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sortValue(a, tableState.sortKey);
    const right = sortValue(b, tableState.sortKey);
    if (left < right) return -1 * direction;
    if (left > right) return 1 * direction;
    return a.displayName.localeCompare(b.displayName);
  });
}

function statTile(label, value, sub) {
  return el('div', { class: 'stat' }, [
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-value', text: value }),
    sub ? el('div', { class: 'stat-sub', text: sub }) : null,
  ]);
}

function renderStats(catalog) {
  const { stats, artist } = catalog;
  const tiles = [];

  if (typeof artist.monthlyListeners === 'number') {
    tiles.push(
      statTile('Monthly listeners', formatCompact(artist.monthlyListeners), formatCount(artist.monthlyListeners)),
    );
  }
  tiles.push(
    statTile(
      'Total plays',
      formatCompact(stats.totalPlayCount),
      stats.totalPlayCount === null
        ? 'Play counts unavailable'
        : `${formatCount(stats.totalPlayCount)} across ${stats.tracksWithPlayCounts} tracks`,
    ),
  );
  tiles.push(
    statTile('Tracks', formatCount(stats.countedTracks), `${stats.featureTrackCount} as a feature`),
  );
  tiles.push(
    statTile(
      'Top 10 plays',
      formatCompact(stats.top10PlayCount),
      stats.totalPlayCount
        ? `${Math.round(((stats.top10PlayCount ?? 0) / stats.totalPlayCount) * 100)}% of catalogue`
        : null,
    ),
  );
  tiles.push(
    statTile('Median track', formatCompact(stats.medianPlayCount), `Avg ${formatCompact(stats.averagePlayCount)}`),
  );
  tiles.push(
    statTile(
      'Releases',
      formatCount(stats.releaseCount),
      [stats.firstReleaseDate?.slice(0, 4), stats.latestReleaseDate?.slice(0, 4)]
        .filter(Boolean)
        .join(' – ') || null,
    ),
  );

  return el('div', { class: 'stat-grid' }, tiles);
}

function renderHeader(artist) {
  const facts = [];
  if (typeof artist.followers === 'number') {
    facts.push(el('span', {}, [el('b', { text: formatCount(artist.followers) }), ' followers']));
  }
  if (typeof artist.popularity === 'number') {
    facts.push(el('span', {}, [el('b', { text: String(artist.popularity) }), '/100 popularity']));
  }
  facts.push(el('a', { href: artist.url, target: '_blank', rel: 'noopener noreferrer' }, ['Open in Spotify ↗']));

  return el('div', { class: 'artist-header' }, [
    avatar(artist.image, artist.name),
    el('div', { class: 'artist-title' }, [
      el('h1', { text: artist.name }),
      el('div', { class: 'artist-facts' }, facts),
      artist.genres?.length
        ? el(
            'div',
            { class: 'genre-list' },
            artist.genres.slice(0, 6).map((genre) => el('span', { class: 'genre', text: genre })),
          )
        : null,
    ]),
  ]);
}

const COLUMNS = [
  { key: 'name', label: 'Track', sortable: true },
  { key: 'album', label: 'Album', sortable: true, className: 'hide-sm' },
  { key: 'releaseDate', label: 'Released', sortable: true, className: 'hide-sm' },
  { key: 'playCount', label: 'Plays', sortable: true, numeric: true },
  { key: 'popularity', label: 'Popularity', sortable: true, numeric: true, className: 'hide-sm' },
  { key: 'duration', label: 'Time', sortable: true, numeric: true, className: 'hide-sm' },
];

function renderTable(catalog, onChange) {
  const rows = visibleRows(catalog);
  const peak = rows.reduce((max, row) => Math.max(max, row.playCount ?? 0), 0);

  const head = el(
    'tr',
    {},
    [el('th', { class: 'col-rank', text: '#' })].concat(
      COLUMNS.map((column) => {
        const active = tableState.sortKey === column.key;
        const th = el('th', {
          class: [column.sortable ? 'sortable' : '', column.numeric ? 'col-num' : '', column.className ?? '']
            .filter(Boolean)
            .join(' '),
          ...(active ? { 'aria-sort': tableState.sortDir === 'asc' ? 'ascending' : 'descending' } : {}),
        });
        th.append(column.label);
        if (active) {
          th.append(' ', el('span', { class: 'sort-arrow', text: tableState.sortDir === 'asc' ? '▲' : '▼' }));
        }
        if (column.sortable) {
          th.addEventListener('click', () => {
            if (tableState.sortKey === column.key) {
              tableState.sortDir = tableState.sortDir === 'asc' ? 'desc' : 'asc';
            } else {
              tableState.sortKey = column.key;
              // Numbers read best largest-first; text reads best A-Z.
              tableState.sortDir = column.numeric || column.key === 'releaseDate' ? 'desc' : 'asc';
            }
            onChange();
          });
        }
        return th;
      }),
    ),
  );

  const body = el('tbody');
  rows.forEach((row, index) => {
    const subtitle = row.artists
      .filter((artist) => artist.id !== catalog.artist.id)
      .map((artist) => artist.name)
      .join(', ');

    const playsCell = el('td', { class: 'col-num plays' }, [
      row.playCount === null ? el('span', { class: 'muted', text: '—' }) : formatCount(row.playCount),
    ]);
    if (row.playCount !== null && peak > 0) {
      // Width tracks the share of the biggest track, kworb-style.
      playsCell.append(
        el('span', {
          class: 'play-bar',
          style: `width:${Math.max(2, Math.round((row.playCount / peak) * 68))}px`,
        }),
      );
    }

    const nameCell = el('div', { class: 'track-cell' }, [
      avatar(row.album.image, row.album.name, 'art-fallback'),
      el('div', { style: 'min-width:0' }, [
        el('div', { class: 'track-name' }, [
          el('a', { href: row.url, target: '_blank', rel: 'noopener noreferrer', text: row.displayName }),
          row.isFeature ? el('span', { class: 'tag feature', text: 'feat' }) : null,
          row.explicit ? el('span', { class: 'tag explicit', text: 'E' }) : null,
          row.duplicateCount > 0
            ? el('span', {
                class: 'tag',
                title: `Also appears on ${row.duplicateCount} other release${row.duplicateCount === 1 ? '' : 's'}`,
                text: `+${row.duplicateCount}`,
              })
            : null,
        ]),
        subtitle ? el('div', { class: 'track-sub', text: subtitle }) : null,
      ]),
    ]);

    body.append(
      el('tr', {}, [
        el('td', { class: 'col-rank', text: String(index + 1) }),
        el('td', {}, [nameCell]),
        el('td', { class: 'album-cell hide-sm' }, [
          el('a', { href: row.album.url, target: '_blank', rel: 'noopener noreferrer', text: row.album.name }),
        ]),
        el('td', { class: 'hide-sm muted', text: formatDate(row.album.releaseDate) }),
        playsCell,
        el('td', { class: 'col-num hide-sm' }, [
          row.popularity === null
            ? el('span', { class: 'muted', text: '—' })
            : el('span', { class: 'pop-meter' }, [
                el('span', { class: 'pop-track' }, [
                  el('span', { class: 'pop-fill', style: `width:${row.popularity}%` }),
                ]),
                el('span', { text: String(row.popularity) }),
              ]),
        ]),
        el('td', { class: 'col-num hide-sm muted', text: formatDuration(row.durationMs) }),
      ]),
    );
  });

  if (rows.length === 0) {
    return el('div', { class: 'empty', text: 'No tracks match these filters.' });
  }

  return el('div', { class: 'table-wrap' }, [
    el('table', {}, [el('thead', {}, [head]), body]),
  ]);
}

function downloadCsv(catalog) {
  const rows = visibleRows(catalog);
  const header = ['Rank', 'Track', 'Album', 'Album type', 'Released', 'Plays', 'Popularity', 'Duration (s)', 'Track URL'];
  const escape = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [header.join(',')];
  rows.forEach((row, index) => {
    lines.push(
      [
        index + 1,
        row.displayName,
        row.album.name,
        row.album.type,
        row.album.releaseDate,
        row.playCount ?? '',
        row.popularity ?? '',
        Math.round(row.durationMs / 1000),
        row.url,
      ]
        .map(escape)
        .join(','),
    );
  });

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', {
    href: url,
    download: `${catalog.artist.name.replace(/[^\w -]+/g, '')} — plays.csv`,
  });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function renderControls(catalog, onChange, onReload) {
  const types = [...new Set(catalog.tracks.map((row) => row.album.type))].sort();
  const labels = { album: 'Albums', single: 'Singles', compilation: 'Compilations', appears_on: 'Appears on' };

  const chips = types.map((type) =>
    el('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(tableState.types.has(type)),
      text: labels[type] ?? type,
      onclick: () => {
        if (tableState.types.has(type)) tableState.types.delete(type);
        else tableState.types.add(type);
        onChange();
      },
    }),
  );

  const filter = el('input', {
    type: 'search',
    class: 'filter-input',
    placeholder: 'Filter tracks…',
    value: tableState.filter,
    'aria-label': 'Filter tracks',
  });
  filter.addEventListener('input', () => {
    tableState.filter = filter.value;
    onChange({ keepFocus: 'filter' });
  });

  return el('div', { class: 'controls' }, [
    filter,
    el('div', { class: 'chip-group' }, chips),
    el('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(tableState.group),
      text: 'Merge duplicates',
      title: 'Combine the same song across singles, albums and reissues',
      onclick: () => {
        tableState.group = !tableState.group;
        onReload();
      },
    }),
    el('div', { class: 'spacer' }),
    el('button', {
      type: 'button',
      class: 'ghost-button',
      text: 'Export CSV',
      onclick: () => downloadCsv(catalog),
    }),
    el('button', {
      type: 'button',
      class: 'ghost-button',
      text: 'Refresh',
      title: 'Bypass the cache and rebuild from Spotify',
      onclick: () => onReload(true),
    }),
  ]);
}

function renderWarnings(catalog) {
  if (catalog.warnings.length === 0) return null;
  return el(
    'div',
    {},
    catalog.warnings.map((warning) =>
      el('div', { class: 'notice warn' }, [
        el('div', {}, [
          el('b', { text: warning.message }),
          warning.detail ? el('div', { text: warning.detail }) : null,
        ]),
      ]),
    ),
  );
}

/** Stream a catalogue build, reporting progress as it goes. */
function loadCatalog(artistId, options, onProgress) {
  const params = new URLSearchParams({
    group: '0', // Grouping is a display concern; ask for the full list once.
    appearsOn: options.appearsOn ? '1' : '0',
  });
  if (options.refresh) params.set('refresh', '1');
  const url = `/api/artist/${artistId}?${params}`;

  return new Promise((resolve, reject) => {
    let settled = false;

    // EventSource can't set headers, so signal the stream via a query flag.
    const source = new EventSource(`${url}&stream=1`);

    source.addEventListener('progress', (event) => {
      try {
        onProgress(JSON.parse(event.data));
      } catch {
        // A malformed frame is not worth failing the load over.
      }
    });

    source.addEventListener('catalog', (event) => {
      settled = true;
      source.close();
      try {
        resolve(JSON.parse(event.data));
      } catch (error) {
        reject(new Error('Could not parse the catalogue response.'));
      }
    });

    source.addEventListener('failed', (event) => {
      settled = true;
      source.close();
      let message = 'Could not load this artist.';
      try {
        message = JSON.parse(event.data).error ?? message;
      } catch {
        // Keep the generic message.
      }
      reject(new Error(message));
    });

    source.onerror = () => {
      if (settled) return;
      settled = true;
      source.close();
      // Fall back to a plain request: some proxies drop event streams.
      fetch(url)
        .then(async (response) => {
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`);
          resolve(payload);
        })
        .catch(reject);
    };
  });
}

function renderProgress(progress) {
  const percent = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;
  return el('div', { class: 'progress-panel' }, [
    el('div', { class: 'progress-label', text: progress.message }),
    el('div', { class: 'progress-bar' }, [
      el('div', { class: 'progress-fill', style: `width:${Math.max(4, percent)}%` }),
    ]),
    el('div', {
      class: 'progress-label',
      text: progress.total > 1 ? `${progress.completed} / ${progress.total}` : 'Working…',
    }),
  ]);
}

/**
 * Pick the representative row for a group of duplicates. Mirrors the server's
 * rule: most plays wins, then original album over compilation, then earliest
 * release.
 */
const TYPE_RANK = { album: 0, single: 1, compilation: 2, appears_on: 3 };

function preferRow(current, candidate) {
  const currentCount = current.playCount ?? -1;
  const candidateCount = candidate.playCount ?? -1;
  if (candidateCount !== currentCount) return candidateCount > currentCount ? candidate : current;

  const rankDelta = (TYPE_RANK[candidate.album.type] ?? 9) - (TYPE_RANK[current.album.type] ?? 9);
  if (rankDelta !== 0) return rankDelta < 0 ? candidate : current;

  if (candidate.album.releaseDate && current.album.releaseDate) {
    return candidate.album.releaseDate < current.album.releaseDate ? candidate : current;
  }
  return current;
}

/**
 * Recompute the summary from the rows actually on screen.
 *
 * The server sends the ungrouped catalogue and grouping happens here, so the
 * server's own stats describe a different row set. Reusing them would show
 * "36 tracks" above a 22-row table.
 */
function recomputeStats(rows, base) {
  const counts = rows.map((row) => row.playCount).filter((count) => typeof count === 'number');
  const total = counts.reduce((sum, count) => sum + count, 0);
  const descending = [...counts].sort((a, b) => b - a);

  const median = () => {
    if (counts.length === 0) return null;
    const sorted = [...counts].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
  };

  return {
    ...base,
    totalPlayCount: counts.length > 0 ? total : null,
    countedTracks: rows.length,
    tracksWithPlayCounts: counts.length,
    averagePlayCount: counts.length > 0 ? Math.round(total / counts.length) : null,
    medianPlayCount: median(),
    leadTrackCount: rows.filter((row) => !row.isFeature).length,
    featureTrackCount: rows.filter((row) => row.isFeature).length,
    top10PlayCount: descending.length > 0 ? descending.slice(0, 10).reduce((sum, c) => sum + c, 0) : null,
  };
}

/**
 * Grouping is applied client-side so the toggle is instant: the server always
 * returns the ungrouped catalogue and we fold duplicates here.
 */
function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.groupKey ?? `${row.artists[0]?.name ?? ''}|${row.displayName.toLowerCase()}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...row, duplicateCount: 0 });
      continue;
    }
    groups.set(key, { ...preferRow(existing, row), duplicateCount: existing.duplicateCount + 1 });
  }
  return [...groups.values()];
}

async function renderArtist(artistId) {
  let raw = null;

  const paint = (options = {}) => {
    if (!raw) return;
    const tracks = tableState.group ? groupRows(raw.tracks) : raw.tracks;
    const catalog = { ...raw, tracks, stats: recomputeStats(tracks, raw.stats) };

    const onChange = (opts = {}) => paint(opts);
    const onReload = (refresh = false) => {
      if (refresh === true) load(true);
      else paint();
    };

    view.replaceChildren(
      renderHeader(catalog.artist),
      renderWarnings(catalog) ?? document.createComment(''),
      renderStats(catalog),
      renderControls(catalog, onChange, onReload),
      renderTable(catalog, onChange),
    );

    if (options.keepFocus === 'filter') {
      const input = view.querySelector('.filter-input');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
    }
  };

  const load = async (refresh = false) => {
    view.replaceChildren(
      renderProgress({ message: 'Loading artist…', completed: 0, total: 1 }),
    );
    try {
      raw = await loadCatalog(artistId, { appearsOn: tableState.appearsOn, refresh }, (progress) => {
        if (!raw) view.replaceChildren(renderProgress(progress));
      });
      document.title = `${raw.artist.name} — Spindex`;
      paint();
    } catch (error) {
      view.replaceChildren(
        el('div', { class: 'notice error' }, [
          el('div', {}, [el('b', { text: 'Could not load this artist.' }), el('div', { text: error.message })]),
        ]),
        el('div', { class: 'empty' }, [el('a', { href: '/', 'data-link': true, text: '← Back to search' })]),
      );
    }
  };

  await load();
}

// ---------------------------------------------------------------- boot

/** The sticky table header sits directly under the top bar, which changes
 * height when the search field wraps on narrow screens. */
function syncTopbarHeight() {
  const height = document.querySelector('.topbar')?.getBoundingClientRect().height ?? 57;
  document.documentElement.style.setProperty('--topbar-height', `${Math.round(height)}px`);
}

window.addEventListener('resize', syncTopbarHeight);

function render() {
  syncTopbarHeight();
  closeSuggestions();
  const match = /^\/artist\/([A-Za-z0-9]+)/.exec(location.pathname);
  if (match) {
    renderArtist(match[1]);
  } else {
    document.title = 'Spindex — Spotify artist play counts';
    renderHome();
  }
}

fetch('/api/health')
  .then((response) => response.json())
  .then((health) => {
    if (health?.config?.mock) {
      modeBadge.textContent = 'Sample data';
      modeBadge.title = 'MOCK=1 — generated data for offline development, not real Spotify figures';
      modeBadge.hidden = false;
    }
  })
  .catch(() => {
    // Health is advisory; the app works without it.
  });

render();
