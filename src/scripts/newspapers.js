import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadChromium } from '../lib/playwright.js';
import { DEFAULT_CDP_ORIGIN, ensureCdpTarget, closeCdpTarget } from './cdp-preflight.js';
import { requireBrowserLock, browserLockHint } from './cdp-transport.js';
import {
  ORIGIN,
  USER_AGENT,
  MIN_INTERVAL_MS,
  DEFAULT_COUNT,
  MIN_CROP_WIDTH,
  TILE_DELAY_MS,
  VIEWER_SETTLE_MS,
  PAGE_LEVEL_NOTE,
  NewspapersError,
  normalizeImageId,
  viewerUrl,
  validateQuery,
  buildSearchUrl,
  classifyResponse,
  parseSearch,
  formatHit,
  parseTerms,
  probeKeyword,
  makePacer,
  formatProbe,
  isSignedOutTitle,
  tileUrl,
  tileFileName,
  selectGrid,
  completeGrid,
  stitchArgs,
  parseTsvLines,
  matchWords,
} from '../lib/newspapers.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function usage() {
  console.log(`newspapers — newspapers.com page-level search (plain HTTP) and full-page images (shared debug Chrome)

  search "<keyword>" [--region us-xx] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                     [--count N=${DEFAULT_COUNT}] [--start <cursor>] [--json]
      one request; prints the request made, the total page count, then one line
      per hit: date | publication | location | page number | image id.
      --start takes the cursor printed as "next" to continue a list.
  search --probe "<base keyword>" --terms a,b,"two words" [--region …] [--from …] [--to …] [--count N] [--json]
      one request per term (base + term), paced, printed as a matrix:
      term → pages matched → image ids. The quickest way to see which of
      several qualifiers narrows a common name.
  page <imageId> --out <dir> [--no-stitch] [--json]
      the whole page at full resolution: tiles t_<y>_<x>.jpg, page.json, and
      full.jpg when ImageMagick (\`magick\`) is installed.
  locate <dir> <word...> [--json]
      run local \`tesseract\` over <dir>/full.jpg and print, for every place
      one of the words occurs, the pixel box of the matched words (as an
      ImageMagick -crop geometry, WxH+X+Y) and the words around it. Pad the
      box to crop to the item. A quoted phrase must match consecutive words.
      Skipped with a message when tesseract is not installed.

    ged-tools newspapers search "Jane Example" --region us-xx --from 1900-01-01 --to 1900-12-31
    ged-tools newspapers search --probe "Jane Example" --terms married,"county fair"
    ged-tools newspapers page 123456789 --out /path/to/page-123456789

SEARCH needs no key, account or browser. What it does and does not tell you:
  - Hits are PAGE-level. Two matched words may belong to different articles on
    the same page. A hit is a reason to read the page, never a finding.
  - The endpoint answers HTTP 429 when called faster than about one request
    per 5 seconds. --probe waits ${MIN_INTERVAL_MS / 1000} s between requests; separate invocations
    are yours to space. A 429 is reported as a refusal (exit 3), never as zero.
  - Phrases heavy in initials are answered HTTP 400 "Too many single character
    tokens in keyword parameter". The message is printed (exit 2); spell the
    words out or drop the initials.
  - A zero is printed as a zero, with the request that produced it (exit 4).
    Before believing it, run a keyword you know is present.

PAGE drives the signed-in shared debug Chrome over CDP and needs Playwright.
It opens the viewer in a new tab, never signs in, and exits 2 with
"not signed in" if the viewer shows a sign-up page. The viewer loads only the
tiles on screen (crops at least ${MIN_CROP_WIDTH} px wide are used), so further rows below
and columns to the right are requested until the image server refuses — that
refusal is the page edge. page.json records which rows and columns came from
probing. A hole inside the grid is an error: the tiles are kept, nothing is
stitched. The signed tile token is never written to disk.

EXIT CODES: 0 answered · 1 bad arguments, or the browser lock is free ·
            2 request failed or refused, not signed in, or an incomplete page ·
            3 rate limited (HTTP 429) · 4 answered, nothing matched

page requires the browser lock, held across your whole batch:
${browserLockHint('newspapers').join('\n')}`);
}

// ---- search ----

async function getSearch(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  } catch (err) {
    throw new NewspapersError(`request failed: ${url}: ${err.message}`);
  }
  return classifyResponse(res.status, await res.text());
}

export async function search(query, fetchImpl = fetch) {
  const request = buildSearchUrl(query);
  const reply = await getSearch(request, fetchImpl);
  return { request, reply, ...parseSearch(reply) };
}

/**
 * One search per term, at least `minIntervalMs` apart. Stops at the first
 * refusal: the failed term carries `error`, the rest are marked `skipped`, so
 * an unasked term can never be read as a zero.
 */
export async function probe(base, terms, query = {}, { fetchImpl = fetch, minIntervalMs = MIN_INTERVAL_MS, sleepImpl = sleep, now = Date.now, log = () => {} } = {}) {
  validateQuery({ ...query, keyword: base });
  const pace = makePacer(minIntervalMs, { sleep: sleepImpl, now });
  const rows = [];
  let failed = null;
  for (const term of terms) {
    const keyword = probeKeyword(base, term);
    const row = { term, keyword, request: buildSearchUrl({ ...query, keyword }), count: validateQuery({ ...query, keyword }).count };
    if (failed) {
      rows.push({ ...row, skipped: true });
      continue;
    }
    await pace();
    log(`request: GET ${row.request}`);
    try {
      const r = await search({ ...query, keyword }, fetchImpl);
      rows.push({ ...row, recordCount: r.recordCount, hits: r.hits });
    } catch (err) {
      if (!(err instanceof NewspapersError)) throw err;
      failed = err;
      rows.push({ ...row, error: err.message });
    }
  }
  return { base, rows, failed };
}

// ---- page ----

export function magickAvailable(run = execFileSync) {
  try {
    run('magick', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Everything after the viewer has loaded: fetch the grid, write tiles and
 * page.json, stitch. `fetchTile(url)` answers { status, body }.
 */
export async function savePage({ imageId, title, capturedUrls, outDir, fetchTile, stitch = true, delayMs = TILE_DELAY_MS, sleepImpl = sleep, log = console.error, run = execFileSync, hasMagick = magickAvailable }) {
  const grid = selectGrid(capturedUrls, imageId);
  if (!grid) {
    throw new NewspapersError(
      `the viewer requested no tile at least ${MIN_CROP_WIDTH} px wide for image ${imageId} (${capturedUrls.length} image request(s) seen) — ` +
        'not signed in, the page did not load, or the viewer changed. Nothing written.',
    );
  }
  mkdirSync(outDir, { recursive: true });
  let first = true;
  const result = await completeGrid(grid, async (cell) => {
    if (!first) await sleepImpl(delayMs);
    first = false;
    return fetchTile(tileUrl(grid.sample, cell));
  });
  const tiles = result.tiles.map((t) => {
    const file = tileFileName(t);
    writeFileSync(join(outDir, file), t.body);
    return { file, x: t.x, y: t.y, bytes: t.bytes };
  });
  log(`tiles: ${tiles.length} written (${result.xs.length} column(s) x ${result.ys.length} row(s)); ` +
    `probing added columns [${result.probedColumns.join(', ')}] and rows [${result.probedRows.join(', ')}]`);

  const complete = result.missing.length === 0 && !result.probeCapReached;
  let stitched = null;
  let stitchNote;
  if (!complete) {
    stitchNote = result.probeCapReached
      ? 'probe limit reached before the page edge — the page may be cut short; not stitched'
      : `${result.missing.length} tile(s) inside the grid were refused — INCOMPLETE page; not stitched`;
  } else if (!stitch) {
    stitchNote = 'not stitched (--no-stitch)';
  } else if (!hasMagick(run)) {
    stitchNote = 'ImageMagick (`magick`) is not installed — tiles left unstitched';
  } else {
    const rows = result.ys.map((y) => result.xs.map((x) => join(outDir, tileFileName({ x, y }))));
    stitched = join(outDir, 'full.jpg');
    run('magick', stitchArgs(rows, stitched), { stdio: ['ignore', 'ignore', 'pipe'] });
    stitchNote = 'stitched with ImageMagick';
  }

  const meta = {
    imageId,
    title,
    url: viewerUrl(imageId),
    tile: { width: result.tileW, height: result.tileH },
    columns: result.xs,
    rows: result.ys,
    capturedColumns: grid.xs,
    capturedRows: grid.ys,
    probedColumns: result.probedColumns,
    probedRows: result.probedRows,
    filledColumns: result.filledColumns,
    filledRows: result.filledRows,
    missing: result.missing,
    retried: result.retried,
    complete,
    stitched: stitched ? 'full.jpg' : null,
    stitchNote,
    tiles,
  };
  const metaPath = join(outDir, 'page.json');
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
  return { meta, metaPath, stitched, outDir };
}

async function fetchPage(imageId, outDir, { stitch }) {
  const chromium = await loadChromium();
  requireBrowserLock('newspapers');
  const preflight = await ensureCdpTarget();
  let browser = null;
  let page = null;
  try {
    browser = await chromium.connectOverCDP(DEFAULT_CDP_ORIGIN);
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    page = await ctx.newPage();
    const captured = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.startsWith('https://img.newspapers.com/img/img?')) captured.push(u);
    });
    await page.goto(viewerUrl(imageId), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(VIEWER_SETTLE_MS);
    const title = await page.title();
    console.error(`title: ${title}`);
    if (isSignedOutTitle(title)) {
      throw new NewspapersError('not signed in — the viewer shows a sign-up page. Sign in to newspapers.com in the shared debug Chrome yourself, then re-run.');
    }
    return await savePage({
      imageId,
      title,
      capturedUrls: captured,
      outDir,
      stitch,
      fetchTile: async (url) => {
        const res = await ctx.request.get(url, { headers: { referer: `${ORIGIN}/` } });
        let body = null;
        try { body = await res.body(); } catch { /* no body: a refusal */ }
        return { status: res.status(), body };
      },
    });
  } finally {
    try { await page?.close(); } catch { /* already closed */ }
    try { await browser?.close(); } catch { /* already disconnected */ }
    await closeCdpTarget(preflight);
  }
}

// ---- locate ----

export function locate(dir, words, { run = execFileSync } = {}) {
  const image = join(dir, 'full.jpg');
  if (!existsSync(image)) throw new NewspapersError(`${image} does not exist — run \`newspapers page\` (with ImageMagick installed) first`);
  let tsv;
  try {
    tsv = run('tesseract', [image, 'stdout', 'tsv'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    if (err?.code === 'ENOENT') return { image, skipped: 'tesseract is not installed — locate skipped' };
    throw new NewspapersError(`tesseract failed on ${image}: ${err.message}`);
  }
  const lines = parseTsvLines(tsv);
  return { image, lineCount: lines.length, matches: matchWords(lines, words) };
}

// ---- CLI ----

const VALUE_FLAGS = new Set(['--region', '--from', '--to', '--count', '--start', '--probe', '--terms', '--out']);

export function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= args.length) throw new NewspapersError(`${a} wants a value`, { code: 1 });
      flags[a.slice(2)] = args[++i];
    } else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { flags, positional };
}

function queryFrom(flags, keyword) {
  return {
    keyword,
    region: flags.region ?? '',
    from: flags.from ?? '',
    to: flags.to ?? '',
    count: flags.count ?? DEFAULT_COUNT,
    start: flags.start ?? '',
  };
}

async function runSearch(flags, positional) {
  const json = Boolean(flags.json);
  const say = json ? console.error : console.log;
  if (flags.probe !== undefined) {
    if (flags.probe === true || flags.terms === undefined) throw new NewspapersError('--probe wants "<base keyword>" and --terms a,b,c', { code: 1 });
    const terms = parseTerms(flags.terms);
    const result = await probe(flags.probe, terms, queryFrom(flags), { log: (line) => say(line) });
    if (json) console.log(JSON.stringify({ base: result.base, rows: result.rows }, null, 2));
    else {
      console.log(`probe: ${JSON.stringify(result.base)} + ${terms.length} term(s)`);
      for (const line of formatProbe(result.rows)) console.log(line);
      console.log(`note: ${PAGE_LEVEL_NOTE}`);
    }
    if (result.failed) {
      console.error(result.failed.message);
      return result.failed.code;
    }
    return result.rows.some((r) => r.recordCount > 0) ? 0 : 4;
  }
  const keyword = positional[0];
  if (!keyword) { usage(); return 1; }
  const request = buildSearchUrl(queryFrom(flags, keyword));
  say(`request: GET ${request}`);
  const r = await search(queryFrom(flags, keyword));
  if (json) console.log(JSON.stringify({ request: r.request, ...r.reply }, null, 2));
  else {
    console.log(`hits: ${r.recordCount} page(s) match; ${r.hits.length} listed${r.nextStart && r.hits.length < r.recordCount ? `; next: --start ${r.nextStart}` : ''}`);
    for (const h of r.hits) console.log(formatHit(h));
    if (r.recordCount === 0) console.log('ZERO pages matched this request. Run a keyword you know is present before trusting it.');
    else console.log(`note: ${PAGE_LEVEL_NOTE}`);
  }
  return r.recordCount > 0 ? 0 : 4;
}

async function runPage(flags, positional) {
  if (!positional[0] || typeof flags.out !== 'string') { usage(); return 1; }
  const imageId = normalizeImageId(positional[0]);
  const outDir = resolve(flags.out);
  const { meta, metaPath, stitched } = await fetchPage(imageId, outDir, { stitch: !flags['no-stitch'] });
  if (flags.json) console.log(JSON.stringify(meta, null, 2));
  else {
    console.log(`title:  ${meta.title}`);
    console.log(`tiles:  ${outDir} (${meta.tiles.length} file(s), ${meta.columns.length} x ${meta.rows.length})`);
    console.log(`meta:   ${metaPath}`);
    console.log(`full:   ${stitched ?? `none — ${meta.stitchNote}`}`);
  }
  if (!meta.complete) {
    console.error(`INCOMPLETE: ${meta.stitchNote}. Missing cells: ${meta.missing.map((m) => `${m.x},${m.y} (HTTP ${m.status})`).join('; ') || 'unknown (probe limit)'}`);
    return 2;
  }
  if (!stitched && !flags['no-stitch']) console.error(meta.stitchNote);
  return 0;
}

function runLocate(flags, positional) {
  const [dir, ...words] = positional;
  if (!dir || !words.length) { usage(); return 1; }
  const r = locate(resolve(dir), words);
  if (r.skipped) {
    console.error(r.skipped);
    return 0;
  }
  if (flags.json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`image: ${r.image} — ${r.lineCount} OCR line(s), ${r.matches.length} occurrence(s) of ${words.map((w) => JSON.stringify(w)).join(' or ')}`);
    for (const m of r.matches) console.log(`${m.w}x${m.h}+${m.x}+${m.y}  ${m.text}`);
    if (!r.matches.length) console.log('ZERO occurrences. OCR of newsprint misses words; this is not evidence the word is absent.');
  }
  return r.matches.length ? 0 : 4;
}

export async function main(args = process.argv.slice(2)) {
  const [verb, ...rest] = args;
  try {
    const { flags, positional } = parseArgs(rest);
    if (verb === 'search') return await runSearch(flags, positional);
    if (verb === 'page') return await runPage(flags, positional);
    if (verb === 'locate') return runLocate(flags, positional);
    usage();
    return 1;
  } catch (err) {
    if (err instanceof NewspapersError) {
      console.error(err.message);
      return err.code;
    }
    throw err;
  }
}
