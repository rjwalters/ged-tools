// newspapers.com — page-level search and full-page image tiles. Pure core:
// URL building, reply classification and parsing, tile-grid arithmetic,
// stitch arguments, OCR line boxes. No network, no browser, no filesystem.
//
// Search is the keyless JSON endpoint the site's own search page reads:
//   GET /api/search/query?keyword=…&entity-types=page&region=…&date-start=…&date-end=…&count=…
// It answers { recordCount, nextStart, records: [{ type: 'page', publication, page }] }.
// Observed behaviour this module encodes:
//   - a hit is a PAGE, not an article: two matched words may sit in two
//     unrelated items on the same page;
//   - calls closer together than about five seconds may be answered HTTP 429;
//   - a phrase with several one-letter tokens is answered HTTP 400 with
//     "Too many single character tokens in keyword parameter";
//   - `start=<nextStart>` continues a result list.
//
// Page images come from the signed-in viewer as a grid of tiles:
//   https://img.newspapers.com/img/img?id=<id>&width=W&height=H&crop=x,y,w,h&…&iat=<token>
// `crop` is in full-resolution page pixels; width/height are the size served.
// Asking for width=w&height=h returns the crop at full resolution. The viewer
// requests only the tiles on screen, so the lower rows (and on a wide page the
// right-hand columns) are absent from what it loads. Cells are therefore
// requested past the captured grid until the server refuses: a crop that
// starts outside the page is answered HTTP 500 with a small JSON body. On the
// pages observed the cell size divided the page exactly (a 5 x 6 grid of equal
// tiles), and cell sizes differed from page to page and were not always square,
// so the step is always taken from the captured tiles, never assumed.

export const ORIGIN = 'https://www.newspapers.com';
export const SEARCH_PATH = '/api/search/query';
export const IMAGE_HOST = 'img.newspapers.com';
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export const MIN_INTERVAL_MS = 5500;
export const DEFAULT_COUNT = 20;
export const MIN_CROP_WIDTH = 1000;
export const TILE_DELAY_MS = 400;
export const VIEWER_SETTLE_MS = 9000;
export const MAX_PROBE_STEPS = 40;
export const PAGE_LEVEL_NOTE =
  'hits are PAGE-level: the matched words may belong to different items on the page — read the page before citing it';

export class NewspapersError extends Error {
  constructor(message, { code = 2 } = {}) {
    super(message);
    this.name = 'NewspapersError';
    this.code = code;
  }
}

const bad = (message) => new NewspapersError(message, { code: 1 });

export function normalizeImageId(input) {
  const raw = String(input ?? '').trim();
  if (!/^\d{1,12}$/.test(raw)) throw bad(`not an image id (digits only, e.g. 123456789): ${JSON.stringify(raw.slice(0, 40))}`);
  return raw;
}

export function viewerUrl(imageId) {
  return `${ORIGIN}/image/${normalizeImageId(imageId)}/`;
}

export function validateQuery({ keyword, region = '', from = '', to = '', count = DEFAULT_COUNT, start = '' } = {}) {
  const kw = String(keyword ?? '').replace(/\s+/g, ' ').trim();
  if (!kw) throw bad('a keyword is required');
  for (const [name, value] of [['from', from], ['to', to]]) {
    if (value !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw bad(`--${name} must be YYYY-MM-DD (got ${JSON.stringify(value)})`);
  }
  if (from && to && String(from) > String(to)) throw bad(`--from ${from} is after --to ${to}`);
  if (region !== '' && !/^[a-z]{2}(?:-[a-z0-9]{1,4})*$/.test(String(region))) {
    throw bad(`--region must look like us or us-xx, lower case (got ${JSON.stringify(region)})`);
  }
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1) throw bad(`--count must be a positive integer (got ${JSON.stringify(count)})`);
  return { keyword: kw, region: String(region), from: String(from), to: String(to), count: n, start: String(start ?? '') };
}

export function buildSearchUrl(query) {
  const q = validateQuery(query);
  const url = new URL(SEARCH_PATH, ORIGIN);
  url.searchParams.set('keyword', q.keyword);
  url.searchParams.set('entity-types', 'page');
  if (q.region) url.searchParams.set('region', q.region);
  if (q.from) url.searchParams.set('date-start', q.from);
  if (q.to) url.searchParams.set('date-end', q.to);
  url.searchParams.set('count', String(q.count));
  if (q.start) url.searchParams.set('start', q.start);
  return url.href;
}

/** The parsed JSON reply, or a NewspapersError — never an empty result for a refusal. */
export function classifyResponse(status, body) {
  const text = String(body ?? '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON: reported below */ }
  if (status === 429) {
    throw new NewspapersError(
      `HTTP 429 — rate limited. The search endpoint tolerates about one request per ${Math.round(MIN_INTERVAL_MS / 1000)} seconds; ` +
        'wait a minute and re-run. This is a refusal, NOT a zero-hit answer.',
      { code: 3 },
    );
  }
  if (status === 400) {
    const message = json?.message ?? text.slice(0, 200);
    const hint = /single character tokens/i.test(message)
      ? ' — drop the initials or spell the words out; one-letter tokens are refused'
      : '';
    throw new NewspapersError(`HTTP 400 — ${message}${hint}`);
  }
  if (status !== 200) throw new NewspapersError(`HTTP ${status} — ${json?.message ?? text.slice(0, 200)}`);
  if (json === null) throw new NewspapersError(`HTTP 200 but the body is not JSON (${text.slice(0, 80).replace(/\s+/g, ' ')}) — refused, not read as zero hits`);
  if (!Array.isArray(json.records) || !Number.isFinite(Number(json.recordCount))) {
    throw new NewspapersError('the reply has no records[] / recordCount — the endpoint changed shape; refused, not read as zero hits');
  }
  return json;
}

export function parseSearch(json) {
  const hits = [];
  for (const r of json.records) {
    if (r?.type !== 'page' || r.page?.id == null) continue;
    hits.push({
      date: r.page.date ?? '',
      publication: r.publication?.name ?? '',
      location: r.publication?.location ?? '',
      pageNumber: String(r.page.pageNumber ?? ''),
      imageId: String(r.page.id),
      viewerUrl: r.page.viewerUrl ?? '',
    });
  }
  return { recordCount: Number(json.recordCount), nextStart: json.nextStart ?? null, returned: json.records.length, hits };
}

export function formatHit(h) {
  return [h.date, h.publication, h.location, `p. ${h.pageNumber || '?'}`, h.imageId].join(' | ');
}

/** "a,b, two words ,," → ['a', 'b', 'two words'] */
export function parseTerms(input) {
  const terms = String(input ?? '').split(',').map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!terms.length) throw bad('--terms wants a comma-separated list, e.g. --terms alpha,beta,"two words"');
  return [...new Set(terms)];
}

export function probeKeyword(base, term) {
  return `${String(base).trim()} ${term}`.trim();
}

/**
 * A gate that resolves no sooner than `minMs` after the previous pass.
 * The first pass is immediate.
 */
export function makePacer(minMs = MIN_INTERVAL_MS, { sleep, now = Date.now } = {}) {
  let last = null;
  return async function pace() {
    if (last !== null) {
      const wait = minMs - (now() - last);
      if (wait > 0) await sleep(wait);
    }
    last = now();
  };
}

export function formatProbe(rows) {
  const width = Math.max(4, ...rows.map((r) => r.term.length));
  const out = [`${'term'.padEnd(width)}  ${'pages'.padStart(6)}  image ids (date:id, first ${rows[0]?.count ?? DEFAULT_COUNT} at most)`];
  for (const r of rows) {
    if (r.error) {
      out.push(`${r.term.padEnd(width)}  ${'ERROR'.padStart(6)}  ${r.error}`);
      continue;
    }
    if (r.skipped) {
      out.push(`${r.term.padEnd(width)}  ${'-'.padStart(6)}  not requested (stopped after the error above)`);
      continue;
    }
    const ids = r.hits.map((h) => `${h.date}:${h.imageId}`).join(' ');
    out.push(`${r.term.padEnd(width)}  ${String(r.recordCount).padStart(6)}  ${ids || '(none)'}`);
  }
  return out;
}

// ---- viewer page ----

export function isSignedOutTitle(title) {
  return /free trial|sign[ -]?up\b|sign[ -]?in\b|log[ -]?in\b/i.test(String(title ?? ''));
}

/** A viewer tile request, or null for any other URL. */
export function parseTileUrl(input) {
  let url;
  try { url = new URL(String(input)); } catch { return null; }
  if (url.hostname !== IMAGE_HOST || url.pathname !== '/img/img') return null;
  const id = url.searchParams.get('id');
  const crop = (url.searchParams.get('crop') ?? '').split(',').map(Number);
  const width = Number(url.searchParams.get('width'));
  const height = Number(url.searchParams.get('height'));
  if (!id || crop.length !== 4 || crop.some((n) => !Number.isInteger(n) || n < 0) || !crop[2] || !crop[3]) return null;
  const [x, y, w, h] = crop;
  return { id, width, height, x, y, w, h, url: String(input) };
}

/**
 * The same signed request for another cell, at full resolution: the served
 * size is set to the crop size. Edited textually so the token is not re-encoded.
 */
export function tileUrl(sampleUrl, { x, y, w, h }) {
  if (!parseTileUrl(sampleUrl)) throw new NewspapersError('not a viewer tile URL — cannot derive tile requests from it');
  const set = (s, name, value) => {
    const re = new RegExp(`([?&]${name}=)[^&]*`);
    if (!re.test(s)) throw new NewspapersError(`tile URL has no ${name}= parameter — the viewer changed`);
    return s.replace(re, `$1${value}`);
  };
  let out = String(sampleUrl);
  out = set(out, 'width', w);
  out = set(out, 'height', h);
  out = set(out, 'crop', `${x},${y},${w},${h}`);
  return out;
}

export function tileFileName({ x, y }) {
  const pad = (n) => String(n).padStart(5, '0');
  return `t_${pad(y)}_${pad(x)}.jpg`;
}

const uniqueSorted = (values) => [...new Set(values)].sort((a, b) => a - b);

/**
 * The full-resolution grid behind the viewer's tile requests for `imageId`.
 * The viewer may load a second, coarser or finer zoom level and thumbnails;
 * only crops at least MIN_CROP_WIDTH wide count, and the largest crop sets the
 * cell size. Null when no usable tile was requested.
 */
export function selectGrid(urls, imageId) {
  const wanted = String(imageId);
  const tiles = urls.map(parseTileUrl).filter((t) => t && t.id === wanted && t.w >= MIN_CROP_WIDTH);
  if (!tiles.length) return null;
  const tileW = Math.max(...tiles.map((t) => t.w));
  const tileH = Math.max(...tiles.map((t) => t.h));
  const full = tiles.filter((t) => t.w === tileW && t.h === tileH);
  if (!full.length) throw new NewspapersError('no tile has both the largest crop width and height — cannot infer the grid');
  const offGrid = full.find((t) => t.x % tileW !== 0 || t.y % tileH !== 0);
  if (offGrid) {
    throw new NewspapersError(
      `tile at ${offGrid.x},${offGrid.y} is not on a ${tileW}x${tileH} grid — the viewer changed; refusing to guess the layout`,
    );
  }
  const onGrid = tiles.filter((t) => t.x % tileW === 0 && t.y % tileH === 0);
  return {
    imageId: wanted,
    tileW,
    tileH,
    xs: uniqueSorted(onGrid.map((t) => t.x)),
    ys: uniqueSorted(onGrid.map((t) => t.y)),
    sample: full[0].url,
  };
}

/** Offsets from 0 to the highest captured one, with any gap filled in. */
export function fillOffsets(captured, step) {
  const max = Math.max(...captured);
  const all = [];
  for (let v = 0; v <= max; v += step) all.push(v);
  return { all, added: all.filter((v) => !captured.includes(v)) };
}

/**
 * A usable tile: a JPEG whose frame header declares a non-zero size. Past the
 * bottom edge of a page whose height is an exact multiple of the cell, the
 * image server answers 200 with a ~330-byte JPEG of height 0 ("Empty JPEG
 * image" to a decoder) instead of refusing — that is the page edge, not a tile.
 */
export function isJpeg(body) {
  if (!body || body.length <= 3 || body[0] !== 0xff || body[1] !== 0xd8) return false;
  const size = jpegSize(body);
  return size === null || (size.width > 0 && size.height > 0);
}

/** Width/height from the first SOFn segment, or null if none is found. */
export function jpegSize(body) {
  let i = 2;
  while (i + 9 < body.length) {
    if (body[i] !== 0xff) return null;
    const marker = body[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    if (marker === 0xda || marker === 0xd9) return null;
    const len = (body[i + 2] << 8) | body[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (body[i + 5] << 8) | body[i + 6], width: (body[i + 7] << 8) | body[i + 8] };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/**
 * Fetch every cell of the page. `fetchTile(cell)` answers { status, body }.
 * Captured rows/columns first, then columns to the right (tested on the first
 * row) and rows below (kept while any column answers) until the server refuses.
 * A refusal while probing is the page edge; a refusal inside the final
 * rectangle is a hole and is reported in `missing`.
 */
export async function completeGrid(grid, fetchTile, { maxProbe = MAX_PROBE_STEPS, onTile = () => {} } = {}) {
  const { tileW, tileH } = grid;
  const cols = fillOffsets(grid.xs, tileW);
  const rows = fillOffsets(grid.ys, tileH);
  const xs = [...cols.all];
  const ys = [...rows.all];
  const got = new Map();
  const key = (x, y) => `${x},${y}`;
  const fetchCell = async (x, y) => {
    const cell = { x, y, w: tileW, h: tileH };
    let res;
    try { res = await fetchTile(cell); } catch (err) { res = { status: 0, body: null, error: String(err?.message ?? err) }; }
    const ok = res?.status === 200 && isJpeg(res.body);
    const tile = { ...cell, ok, status: res?.status ?? 0, bytes: res?.body?.length ?? 0, body: ok ? res.body : null };
    onTile(tile);
    return tile;
  };

  for (const y of ys) for (const x of xs) got.set(key(x, y), await fetchCell(x, y));

  const probedColumns = [];
  for (let i = 0, x = xs.at(-1) + tileW; i < maxProbe; i++, x += tileW) {
    const first = await fetchCell(x, ys[0]);
    if (!first.ok) break;
    got.set(key(x, ys[0]), first);
    for (const y of ys.slice(1)) got.set(key(x, y), await fetchCell(x, y));
    xs.push(x);
    probedColumns.push(x);
  }

  const probedRows = [];
  for (let i = 0, y = ys.at(-1) + tileH; i < maxProbe; i++, y += tileH) {
    const row = [];
    for (const x of xs) row.push(await fetchCell(x, y));
    if (!row.some((t) => t.ok)) break;
    for (const t of row) got.set(key(t.x, t.y), t);
    ys.push(y);
    probedRows.push(y);
  }

  const tiles = [];
  const missing = [];
  for (const y of ys) for (const x of xs) {
    const t = got.get(key(x, y));
    if (t.ok) tiles.push(t);
    else missing.push({ x, y, status: t.status });
  }
  return {
    tileW, tileH, xs, ys, tiles, missing,
    probedColumns, probedRows,
    filledColumns: cols.added, filledRows: rows.added,
    // Reaching the cap means the edge was never seen: the page may be cut short.
    probeCapReached: probedColumns.length >= maxProbe || probedRows.length >= maxProbe,
  };
}

/** ImageMagick arguments: each row appended left to right, rows stacked top to bottom. */
export function stitchArgs(rows, out) {
  if (!rows.length || rows.some((r) => !r.length)) throw new NewspapersError('nothing to stitch');
  const args = [];
  for (const row of rows) args.push('(', ...row, '+append', ')');
  args.push('-append', out);
  return args;
}

// ---- OCR boxes (tesseract TSV) ----

/** Text lines and their words, with pixel boxes, from `tesseract <image> stdout tsv`. */
export function parseTsvLines(tsv) {
  const lines = new Map();
  for (const raw of String(tsv).split('\n').slice(1)) {
    const f = raw.split('\t');
    if (f.length < 12 || f[0] !== '5') continue;
    const text = f.slice(11).join('\t').trim();
    if (!text) continue;
    const [x, y, w, h] = f.slice(6, 10).map(Number);
    const k = f.slice(1, 5).join('.');
    if (!lines.has(k)) lines.set(k, []);
    lines.get(k).push({ x, y, w, h, text });
  }
  return [...lines.values()].map((words) => ({ ...unionBox(words), text: words.map((w) => w.text).join(' '), words }));
}

function unionBox(boxes) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
}

/**
 * Every place a needle occurs, as the box of the matched WORDS plus the words
 * around them. The line box is not used: OCR of a whole newspaper page often
 * reads straight across the columns, so a "line" can be as wide as the page.
 * A needle of several words must match consecutive words.
 */
export function matchWords(lines, needles, context = 6) {
  const wanted = needles.map((n) => String(n).toLowerCase().split(/\s+/).filter(Boolean)).filter((n) => n.length);
  if (!wanted.length) throw bad('locate wants at least one word');
  const out = [];
  for (const line of lines) {
    const lower = line.words.map((w) => w.text.toLowerCase());
    for (const tokens of wanted) {
      for (let i = 0; i + tokens.length <= lower.length; i++) {
        if (!tokens.every((t, j) => lower[i + j].includes(t))) continue;
        const hit = line.words.slice(i, i + tokens.length);
        const around = line.words.slice(Math.max(0, i - context), i + tokens.length + context);
        out.push({ ...unionBox(hit), needle: tokens.join(' '), text: around.map((w) => w.text).join(' ') });
      }
    }
  }
  return out;
}
