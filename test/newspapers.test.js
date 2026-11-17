import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MIN_INTERVAL_MS,
  NewspapersError,
  normalizeImageId,
  viewerUrl,
  validateQuery,
  buildSearchUrl,
  classifyResponse,
  parseSearch,
  formatHit,
  parseTerms,
  makePacer,
  formatProbe,
  isSignedOutTitle,
  parseTileUrl,
  tileUrl,
  tileFileName,
  selectGrid,
  fillOffsets,
  completeGrid,
  stitchArgs,
  parseTsvLines,
  matchWords,
} from '../src/lib/newspapers.js';
import { search, probe, savePage, locate, parseArgs } from '../src/scripts/newspapers.js';

// Every value below is invented: no real page id, publication, person or token.
const ID = '123456789';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const tile = (x, y, { w = 1400, h = 1400, served = 350, id = ID } = {}) =>
  `https://img.newspapers.com/img/img?id=${id}&width=${Math.round(w / (1400 / served))}&height=${Math.round(h / (1400 / served))}&crop=${x},${y},${w},${h}&brightness=0&contrast=0&invert=0&ts=1&cacheable=1&iat=SYNTHETIC.TOKEN%2Bvalue&user=1`;

const REPLY = {
  recordCount: 7,
  nextStart: 'CURSOR2',
  records: [
    { type: 'page', publication: { id: 1, name: 'The Example Gazette', location: 'Sampletown, Xx' }, page: { date: '1900-01-02', id: 123456789, pageNumber: '3', viewerUrl: 'https://www.newspapers.com/image/123456789?terms=jane' } },
    { type: 'page', publication: { id: 2, name: 'Placeholder Weekly', location: 'Otherville, Xx' }, page: { date: '1900-01-09', id: 123456790, pageNumber: 1 } },
    { type: 'clipping', title: 'not a page' },
  ],
};
const answer = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

test('search URL: required and optional parameters, validation', () => {
  const url = new URL(buildSearchUrl({ keyword: '  Jane   Example ', region: 'us-xx', from: '1900-01-01', to: '1900-12-31', count: 5, start: 'CURSOR' }));
  assert.equal(url.origin + url.pathname, 'https://www.newspapers.com/api/search/query');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    keyword: 'Jane Example', 'entity-types': 'page', region: 'us-xx', 'date-start': '1900-01-01', 'date-end': '1900-12-31', count: '5', start: 'CURSOR',
  });
  const bare = new URL(buildSearchUrl({ keyword: 'county fair' }));
  assert.deepEqual([...bare.searchParams.keys()], ['keyword', 'entity-types', 'count']);
  assert.throws(() => validateQuery({ keyword: ' ' }), (e) => e instanceof NewspapersError && e.code === 1);
  assert.throws(() => validateQuery({ keyword: 'x', from: '1900' }), /YYYY-MM-DD/);
  assert.throws(() => validateQuery({ keyword: 'x', from: '1900-02-01', to: '1900-01-01' }), /is after/);
  assert.throws(() => validateQuery({ keyword: 'x', region: 'US XX' }), /--region/);
  assert.throws(() => validateQuery({ keyword: 'x', count: 0 }), /--count/);
});

test('a search reply is parsed to page hits; non-page records are dropped', () => {
  const r = parseSearch(classifyResponse(200, JSON.stringify(REPLY)));
  assert.equal(r.recordCount, 7);
  assert.equal(r.nextStart, 'CURSOR2');
  assert.equal(r.hits.length, 2);
  assert.deepEqual(r.hits[0], { date: '1900-01-02', publication: 'The Example Gazette', location: 'Sampletown, Xx', pageNumber: '3', imageId: '123456789', viewerUrl: 'https://www.newspapers.com/image/123456789?terms=jane' });
  assert.equal(formatHit(r.hits[1]), '1900-01-09 | Placeholder Weekly | Otherville, Xx | p. 1 | 123456790');
});

test('429, 400 and shapeless replies are refusals, never zero hits', () => {
  assert.throws(() => classifyResponse(429, ''), (e) => e.code === 3 && /429/.test(e.message) && /NOT a zero-hit/.test(e.message));
  const four = JSON.stringify({ status: 400, error: 'Bad Request', message: 'Too many single character tokens in keyword parameter' });
  assert.throws(() => classifyResponse(400, four), (e) => e.code === 2 && /Too many single character tokens in keyword parameter/.test(e.message) && /initials/.test(e.message));
  assert.throws(() => classifyResponse(503, '<html>busy</html>'), /HTTP 503/);
  assert.throws(() => classifyResponse(200, '<html>challenge</html>'), /not JSON/);
  assert.throws(() => classifyResponse(200, '{}'), /changed shape/);
  assert.deepEqual(parseSearch(classifyResponse(200, '{"recordCount":0,"records":[]}')), { recordCount: 0, nextStart: null, returned: 0, hits: [] });
});

test('search(): sends a browser User-Agent and surfaces a refusal as an error', async () => {
  const seen = [];
  const ok = await search({ keyword: 'Jane Example', region: 'us-xx' }, async (url, init) => { seen.push([url, init]); return answer(200, REPLY); });
  assert.equal(ok.request, seen[0][0]);
  assert.match(seen[0][1].headers['User-Agent'], /Mozilla/);
  assert.equal(ok.recordCount, 7);
  await assert.rejects(search({ keyword: 'x' }, async () => answer(429, 'slow down')), (e) => e.code === 3);
  await assert.rejects(search({ keyword: 'a b c d' }, async () => answer(400, { message: 'Too many single character tokens in keyword parameter' })), /single character tokens/);
  await assert.rejects(search({ keyword: 'x' }, async () => { throw new Error('socket hang up'); }), /request failed/);
});

test('pacer: first pass immediate, later passes wait out the minimum interval', async () => {
  let clock = 1000;
  const slept = [];
  const pace = makePacer(5000, { sleep: async (ms) => { slept.push(ms); clock += ms; }, now: () => clock });
  await pace();
  clock += 1200;
  await pace();
  clock += 9000;
  await pace();
  assert.deepEqual(slept, [3800]);
});

test('probe: one paced request per term; a refusal stops it and later terms are not zeros', async () => {
  assert.deepEqual(parseTerms(' alpha, two  words ,,alpha'), ['alpha', 'two words']);
  assert.throws(() => parseTerms(' , '), (e) => e.code === 1);

  const calls = [];
  const slept = [];
  const counts = { alpha: 2, 'two words': 0 };
  const fetchImpl = async (url) => {
    const kw = new URL(url).searchParams.get('keyword');
    calls.push(kw);
    const term = kw.replace('Jane Example ', '');
    return answer(200, { recordCount: counts[term], nextStart: null, records: REPLY.records.slice(0, counts[term]) });
  };
  const io = { fetchImpl, sleepImpl: async (ms) => { slept.push(ms); }, now: () => 0 };
  const good = await probe('Jane Example', ['alpha', 'two words'], { region: 'us-xx' }, io);
  assert.deepEqual(calls, ['Jane Example alpha', 'Jane Example two words']);
  assert.deepEqual(slept, [MIN_INTERVAL_MS]);
  assert.equal(good.failed, null);
  assert.deepEqual(good.rows.map((r) => [r.term, r.recordCount, r.hits.map((h) => h.imageId)]), [['alpha', 2, ['123456789', '123456790']], ['two words', 0, []]]);
  const table = formatProbe(good.rows);
  assert.match(table[1], /^alpha\s+2\s+1900-01-02:123456789 1900-01-09:123456790$/);
  assert.match(table[2], /^two words\s+0\s+\(none\)$/);

  let n = 0;
  const limited = await probe('Jane Example', ['a1', 'b2', 'c3'], {}, { ...io, fetchImpl: async () => (++n === 2 ? answer(429, '') : answer(200, { recordCount: 0, records: [] })) });
  assert.equal(n, 2, 'nothing is requested after the refusal');
  assert.equal(limited.failed.code, 3);
  assert.equal(limited.rows[0].recordCount, 0);
  assert.match(limited.rows[1].error, /429/);
  assert.equal(limited.rows[2].skipped, true);
  assert.equal(limited.rows[2].recordCount, undefined);
  const lines = formatProbe(limited.rows);
  assert.match(lines[2], /ERROR/);
  assert.match(lines[3], /not requested/);
});

test('image ids, viewer URL, signed-out titles', () => {
  assert.equal(viewerUrl(' 123456789 '), 'https://www.newspapers.com/image/123456789/');
  assert.throws(() => normalizeImageId('123/../x'), (e) => e.code === 1);
  assert.equal(isSignedOutTitle('Start a Free Trial - Newspapers.com'), true);
  assert.equal(isSignedOutTitle('Sign up to view this page'), true);
  assert.equal(isSignedOutTitle('Jan 02, 1900, page 3 - The Example Signal at Newspapers.com'), false);
});

test('tile URLs: parsed, and rewritten to full resolution without touching the token', () => {
  const t = parseTileUrl(tile(1400, 2800));
  assert.deepEqual({ id: t.id, width: t.width, height: t.height, x: t.x, y: t.y, w: t.w, h: t.h }, { id: ID, width: 350, height: 350, x: 1400, y: 2800, w: 1400, h: 1400 });
  assert.equal(parseTileUrl('https://www.newspapers.com/image/123456789/'), null);
  assert.equal(parseTileUrl('https://img.newspapers.com/img/img?id=1&width=10&height=10&crop=0,0,10'), null);
  assert.equal(parseTileUrl('not a url'), null);

  const full = tileUrl(tile(0, 0), { x: 4200, y: 5600, w: 1400, h: 1400 });
  assert.equal(full, `https://img.newspapers.com/img/img?id=${ID}&width=1400&height=1400&crop=4200,5600,1400,1400&brightness=0&contrast=0&invert=0&ts=1&cacheable=1&iat=SYNTHETIC.TOKEN%2Bvalue&user=1`);
  assert.throws(() => tileUrl('https://example.invalid/x', { x: 0, y: 0, w: 1, h: 1 }), NewspapersError);
  assert.equal(tileFileName({ x: 1400, y: 0 }), 't_00000_01400.jpg');
});

test('grid selection: this image only, crops >= 1000 wide, the largest crop sets the cell', () => {
  const urls = [
    tile(0, 0), tile(1400, 0), tile(0, 1400), tile(1400, 1400),
    tile(0, 0, { w: 700, h: 700 }), tile(700, 700, { w: 700, h: 700 }), // a finer zoom level
    tile(0, 0, { id: '987654321' }), tile(2800, 0, { id: '987654321' }), // a neighbouring page
    'https://www.newspapers.com/api/other',
  ];
  const g = selectGrid(urls, ID);
  assert.deepEqual({ tileW: g.tileW, tileH: g.tileH, xs: g.xs, ys: g.ys }, { tileW: 1400, tileH: 1400, xs: [0, 1400], ys: [0, 1400] });
  assert.equal(selectGrid([tile(0, 0, { w: 700, h: 700 })], ID), null);
  assert.equal(selectGrid([], ID), null);
  assert.throws(() => selectGrid([tile(100, 0)], ID), /not on a 1400x1400 grid/);
  assert.deepEqual(fillOffsets([1400, 4200], 1400), { all: [0, 1400, 2800, 4200], added: [0, 2800] });
});

test('grid completion: probes right and down until the server refuses', async () => {
  // A synthetic page 3 columns x 4 rows; the viewer showed 2 x 2.
  const requested = [];
  const fetchTile = async ({ x, y, w, h }) => {
    requested.push(`${x},${y}`);
    assert.deepEqual([w, h], [1400, 1400]);
    return x < 3 * 1400 && y < 4 * 1400 ? { status: 200, body: JPEG } : { status: 500, body: Buffer.from('{"error":"x"}') };
  };
  const r = await completeGrid({ tileW: 1400, tileH: 1400, xs: [0, 1400], ys: [0, 1400] }, fetchTile);
  assert.deepEqual(r.xs, [0, 1400, 2800]);
  assert.deepEqual(r.ys, [0, 1400, 2800, 4200]);
  assert.deepEqual(r.probedColumns, [2800]);
  assert.deepEqual(r.probedRows, [2800, 4200]);
  assert.equal(r.tiles.length, 12);
  assert.deepEqual(r.missing, []);
  assert.equal(r.probeCapReached, false);
  assert.deepEqual(requested.slice(0, 4), ['0,0', '1400,0', '0,1400', '1400,1400'], 'captured cells first');
  assert.ok(requested.includes('4200,0'), 'the column past the edge is asked for once');
  assert.equal(requested.filter((k) => k.startsWith('4200,')).length, 1, 'and its other rows are not');
  assert.equal(requested.filter((k) => k.endsWith(',5600')).length, 3, 'the row past the edge is asked for in every column');
});

test('grid completion: a hole is reported, an empty or non-image body is a refusal, the cap is flagged', async () => {
  const hole = await completeGrid({ tileW: 1400, tileH: 1400, xs: [0, 1400], ys: [0] }, async ({ x, y }) => {
    if (y > 0 || x > 1400) return { status: 500, body: null };
    return x === 1400 ? { status: 200, body: Buffer.alloc(0) } : { status: 200, body: JPEG };
  });
  assert.deepEqual(hole.missing, [{ x: 1400, y: 0, status: 200 }]);
  assert.equal(hole.tiles.length, 1);

  const thrown = await completeGrid({ tileW: 1400, tileH: 1400, xs: [0], ys: [0] }, async ({ x, y }) => {
    if (x || y) throw new Error('reset');
    return { status: 200, body: JPEG };
  });
  assert.deepEqual([thrown.xs, thrown.ys, thrown.missing], [[0], [0], []]);

  const endless = await completeGrid({ tileW: 1400, tileH: 1400, xs: [0], ys: [0] }, async () => ({ status: 200, body: JPEG }), { maxProbe: 2 });
  assert.equal(endless.probeCapReached, true);

  const gap = await completeGrid({ tileW: 1400, tileH: 1400, xs: [1400], ys: [1400] }, async ({ x, y }) => (x <= 1400 && y <= 1400 ? { status: 200, body: JPEG } : { status: 500, body: null }));
  assert.deepEqual([gap.filledColumns, gap.filledRows, gap.tiles.length], [[0], [0], 4]);
});

test('stitch arguments: rows appended across, then stacked', () => {
  assert.deepEqual(stitchArgs([['a.jpg', 'b.jpg'], ['c.jpg', 'd.jpg']], 'full.jpg'), ['(', 'a.jpg', 'b.jpg', '+append', ')', '(', 'c.jpg', 'd.jpg', '+append', ')', '-append', 'full.jpg']);
  assert.throws(() => stitchArgs([], 'full.jpg'), /nothing to stitch/);
});

test('savePage: tiles and page.json written, token kept out, stitch run or plainly skipped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'newspapers-test-'));
  try {
    const urls = [tile(0, 0), tile(1400, 0)];
    const fetched = [];
    const fetchTile = async (url) => {
      fetched.push(url);
      const t = parseTileUrl(url);
      assert.deepEqual([t.width, t.height], [t.w, t.h], 'every request is full resolution');
      return t.x < 2800 && t.y < 2800 ? { status: 200, body: JPEG } : { status: 500, body: null };
    };
    const ran = [];
    const run = (cmd, args) => { ran.push([cmd, args]); };
    const base = { imageId: ID, title: 'Jan 02, 1900, page 3 - The Example Gazette', capturedUrls: urls, fetchTile, sleepImpl: async () => {}, log: () => {}, run };

    const a = await savePage({ ...base, outDir: join(dir, 'a'), hasMagick: () => true });
    assert.equal(a.meta.complete, true);
    assert.deepEqual([a.meta.columns, a.meta.rows, a.meta.probedColumns, a.meta.probedRows], [[0, 1400], [0, 1400], [], [1400]]);
    assert.deepEqual(readdirSync(join(dir, 'a')).sort(), ['page.json', 't_00000_00000.jpg', 't_00000_01400.jpg', 't_01400_00000.jpg', 't_01400_01400.jpg']);
    assert.equal(ran.length, 1);
    assert.equal(ran[0][0], 'magick');
    assert.deepEqual(ran[0][1], stitchArgs([
      [join(dir, 'a', 't_00000_00000.jpg'), join(dir, 'a', 't_00000_01400.jpg')],
      [join(dir, 'a', 't_01400_00000.jpg'), join(dir, 'a', 't_01400_01400.jpg')],
    ], join(dir, 'a', 'full.jpg')));
    const written = readFileSync(join(dir, 'a', 'page.json'), 'utf8');
    assert.equal(JSON.parse(written).title, base.title);
    assert.doesNotMatch(written, /SYNTHETIC|iat=/, 'the signed token never reaches disk');

    const b = await savePage({ ...base, outDir: join(dir, 'b'), hasMagick: () => false });
    assert.equal(b.stitched, null);
    assert.match(b.meta.stitchNote, /not installed/);
    const c = await savePage({ ...base, outDir: join(dir, 'c'), stitch: false, hasMagick: () => true });
    assert.match(c.meta.stitchNote, /--no-stitch/);
    assert.equal(ran.length, 1, 'no further stitch was run');

    await assert.rejects(savePage({ ...base, capturedUrls: [], outDir: join(dir, 'd') }), /requested no tile/);
    const e = await savePage({ ...base, outDir: join(dir, 'e'), hasMagick: () => true, fetchTile: async (url) => (parseTileUrl(url).x === 1400 ? { status: 403, body: null } : fetchTile(url)) });
    assert.equal(e.meta.complete, false);
    assert.equal(e.stitched, null);
    assert.match(e.meta.stitchNote, /INCOMPLETE/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('locate: OCR words grouped to lines, matches boxed by word; absent tesseract is skipped, not an error', () => {
  const head = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';
  const tsv = [
    head,
    '4\t1\t1\t1\t1\t0\t10\t20\t300\t30\t-1\t',
    '5\t1\t1\t1\t1\t1\t10\t20\t80\t30\t96\tJane',
    '5\t1\t1\t1\t1\t2\t100\t22\t120\t28\t91\tExample',
    '5\t1\t1\t1\t2\t1\t10\t60\t90\t30\t90\tCounty',
    '5\t1\t1\t1\t2\t2\t110\t58\t60\t34\t88\tFair',
  ].join('\n');
  const lines = parseTsvLines(tsv);
  assert.deepEqual(lines.map((l) => [l.x, l.y, l.w, l.h, l.text, l.words.length]), [[10, 20, 210, 30, 'Jane Example', 2], [10, 58, 160, 34, 'County Fair', 2]]);
  assert.deepEqual(matchWords(lines, ['example', 'zzz']), [{ x: 100, y: 22, w: 120, h: 28, needle: 'example', text: 'Jane Example' }]);
  assert.deepEqual(matchWords(lines, ['county fair']), [{ x: 10, y: 58, w: 160, h: 34, needle: 'county fair', text: 'County Fair' }]);
  assert.deepEqual(matchWords(lines, ['fair county']), [], 'a phrase matches consecutive words in order');
  assert.deepEqual(matchWords(lines, ['jane'], 0)[0].text, 'Jane');
  assert.throws(() => matchWords(lines, [' ']), (e) => e.code === 1);

  const dir = mkdtempSync(join(tmpdir(), 'newspapers-test-'));
  try {
    assert.throws(() => locate(dir, ['x']), /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('argument parsing keeps flag values out of the positionals', () => {
  assert.deepEqual(parseArgs(['Jane Example', '--region', 'us-xx', '--json', '--count', '5']), { flags: { region: 'us-xx', json: true, count: '5' }, positional: ['Jane Example'] });
  assert.throws(() => parseArgs(['x', '--out']), (e) => e.code === 1);
});
