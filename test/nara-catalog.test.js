import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSearchUrl,
  buildRecordUrl,
  classifyResponse,
  parseSearch,
  parseRecord,
  objectFileName,
  NaraError,
} from '../src/lib/nara-catalog.js';
import { download, search } from '../src/scripts/nara-catalog.js';

const RECORD = {
  naId: 11111111,
  title: '[Florida] Example, A B - Year: 1862 - Synthetic Company',
  levelOfDescription: 'fileUnit',
  ancestors: [{ title: 'Record Group 0' }, { title: 'Synthetic Carded Records' }],
  digitalObjects: [
    { objectFilename: '0001.jpg', objectUrl: 'https://example.invalid/0001.jpg', objectFileSize: 4, objectDesignator: 'Fold3 File #1', objectId: '11111112', objectType: 'Image (JPG)' },
    { objectFilename: '0002a.jpg', objectUrl: 'https://example.invalid/0002a.jpg', objectFileSize: 3, objectDesignator: 'Fold3 File #2', objectId: '11111113', objectType: 'Image (JPG)' },
  ],
};
const envelope = (records) => JSON.stringify({ body: { hits: { total: { value: records.length }, hits: records.map((r) => ({ _source: { record: r } })) } } });

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const r = routes(url);
    return {
      status: r.status ?? 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? r.type : null) },
      text: async () => r.body,
      arrayBuffer: async () => Buffer.from(r.body),
    };
  };
  impl.calls = calls;
  return impl;
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nara-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('URL builders: query is encoded; a NAID must be digits', () => {
  assert.match(buildSearchUrl('"Eakin, Geo W"', { limit: 5 }), /\/proxy\/v3\/records\/search\?q=%22Eakin%2C\+Geo\+W%22&limit=5&page=1$/);
  assert.match(buildRecordUrl(' 32283591 '), /naId_is=32283591&/);
  assert.throws(() => buildRecordUrl('3228x'), (e) => e instanceof NaraError && e.code === 1);
  assert.throws(() => buildSearchUrl('  '), (e) => e.code === 1);
});

test('classifyResponse refuses the web-app HTML shell even with HTTP 200', () => {
  assert.throws(() => classifyResponse(200, 'text/html', '<!doctype html><html>…'), /not JSON .* NOT an empty result/);
  assert.throws(() => classifyResponse(200, 'application/json', '<html>'), NaraError);
  assert.throws(() => classifyResponse(200, 'application/json', '{"body":{}}'), /shape has changed/);
  assert.throws(() => classifyResponse(500, 'application/json', '{}'), /HTTP 500/);
  assert.equal(classifyResponse(200, 'application/json; charset=utf-8', envelope([RECORD])).body.hits.hits.length, 1);
});

test('parseSearch and parseRecord read the envelope', () => {
  const s = parseSearch(JSON.parse(envelope([RECORD])));
  assert.equal(s.total, 1);
  assert.deepEqual(s.results[0], { naId: '11111111', title: RECORD.title, level: 'fileUnit', parent: 'Synthetic Carded Records', objectCount: 2 });
  const r = parseRecord(JSON.parse(envelope([RECORD])), 11111111);
  assert.equal(r.objects.length, 2);
  assert.equal(r.objects[1].designator, 'Fold3 File #2');
  assert.throws(() => parseRecord(JSON.parse(envelope([RECORD])), 999), (e) => e.code === 4);
  assert.equal(objectFileName('11111111', { filename: '0002a.jpg' }), 'nara-11111111-0002a.jpg');
  assert.equal(objectFileName('1', { filename: '../x y.jpg' }), 'nara-1-.._x_y.jpg');
});

test('search through a fake fetch, and an HTML answer is an error not zero hits', async () => {
  const ok = fakeFetch(() => ({ type: 'application/json', body: envelope([RECORD]) }));
  assert.equal((await search('x', {}, ok)).results.length, 1);
  const shell = fakeFetch(() => ({ type: 'text/html', body: '<!doctype html>' }));
  await assert.rejects(() => search('x', {}, shell), NaraError);
});

test('download writes every object, skips a file already of the right size, refuses a size mismatch or HTML', async (t) => {
  const dir = scratch(t);
  const routes = (url) =>
    url.includes('naId_is=') ? { type: 'application/json', body: envelope([RECORD]) }
      : url.endsWith('0001.jpg') ? { type: 'image/jpeg', body: 'AAAA' }
        : { type: 'image/jpeg', body: 'BBB' };
  const quiet = { delayMs: 0, log: () => {} };

  const f1 = fakeFetch(routes);
  const r1 = await download('11111111', dir, { fetchImpl: f1, ...quiet });
  assert.equal(r1.written.filter((w) => !w.skipped).length, 2);
  assert.equal(readFileSync(join(dir, 'nara-11111111-0002a.jpg'), 'utf8'), 'BBB');

  const f2 = fakeFetch(routes);
  const r2 = await download('11111111', dir, { fetchImpl: f2, ...quiet });
  assert.equal(r2.written.every((w) => w.skipped), true, 'second run skips both');
  assert.equal(f2.calls.length, 1, 'only the record lookup was fetched');

  const bad = scratch(t);
  const short = fakeFetch((url) => (url.includes('naId_is=') ? routes(url) : { type: 'image/jpeg', body: 'A' }));
  await assert.rejects(() => download('11111111', bad, { fetchImpl: short, ...quiet }), /catalog says 4/);
  assert.equal(existsSync(join(bad, 'nara-11111111-0001.jpg')), false, 'a short file is not written');

  const html = fakeFetch((url) => (url.includes('naId_is=') ? routes(url) : { type: 'text/html', body: 'AAAA' }));
  await assert.rejects(() => download('11111111', scratch(t), { fetchImpl: html, ...quiet }), /answered HTML/);
});
