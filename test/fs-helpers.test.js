import test from 'node:test';
import assert from 'node:assert/strict';
import { recordLinks, recordGetExpr } from '../src/scripts/fs-personas.js';
import { frameArks } from '../src/scripts/fs-catalog.js';

test('recordLinks: image arks and external hosts; vocabulary and internal hosts dropped', () => {
  const json = {
    sourceDescriptions: [
      { citations: [{ value: 'Entry for Example, Synthetic Collection, 1862.' }], about: 'http://www.fold3.com/document.php?doc=1&xid=2&p=ma' },
      { about: 'https://www.familysearch.org/ark:/61903/3:1:ABCD-EFG9-HI' },
      { about: 'http://group-service.rms.records.service.prod.us-east-1.prod.fslocal.org/group/X' },
      { about: 'http://treatment/NameTreatment/ver/1' },
      { about: 'http://confidence/92' },
    ],
    persons: [{ facts: [{ type: 'http://gedcomx.org/MilitaryService' }] }],
  };
  const r = recordLinks(json);
  assert.deepEqual(r.imageArks, ['3:1:ABCD-EFG9-HI']);
  assert.deepEqual(r.external, ['http://www.fold3.com/document.php?doc=1&xid=2&p=ma']);
  assert.equal(r.citation, 'Entry for Example, Synthetic Collection, 1862.');
  assert.deepEqual(recordLinks(null), { imageArks: [], external: [], citation: '' });
});

test('recordGetExpr accepts only 1:1 record ids', () => {
  assert.match(recordGetExpr('ABCD-123'), /\/platform\/records\/personas\/ABCD-123/);
  assert.throws(() => recordGetExpr("X'); alert(1); ('"), /not a 1:1 record id/);
});

test('frameArks: ark URLs and objects to bare arks, order kept, gaps visible', () => {
  assert.deepEqual(
    frameArks([
      'https://familysearch.org/ark:/61903/3:1:ZZZZ-AAA1-B/image.xml',
      { ark: 'ark:/61903/3:1:ZZZZ-AAA2-C' },
      'garbage',
    ]),
    ['3:1:ZZZZ-AAA1-B', '3:1:ZZZZ-AAA2-C', null],
  );
  assert.deepEqual(frameArks(undefined), []);
});

test('release manifest: identical contents pass; any drift is refused', async () => {
  const { compare } = await import('../scripts/release-manifest.js');
  const m = { name: 'pkg', version: '1.0.0', files: { 'a.js': 'h1', 'b.js': 'h2' } };
  assert.deepEqual(compare(m, structuredClone(m)), []);
  assert.deepEqual(compare(m, { ...m, files: { 'a.js': 'h1', 'b.js': 'XX' } }), ['content differs: b.js']);
  assert.deepEqual(compare(m, { ...m, files: { 'a.js': 'h1' } }), ['missing from package: b.js']);
  assert.deepEqual(compare(m, { ...m, files: { ...m.files, 'c.js': 'h3' } }), ['not in manifest: c.js']);
  assert.deepEqual(compare(m, { ...m, version: '1.0.1' }), ['version: manifest 1.0.0, package 1.0.1']);
});

test('fs-fulltext search caps: --max is a total across years, --max-per-year bounds each window', async () => {
  const { nextPageCount, parseCap, yearsSkippedNote, SEARCH_PAGE_SIZE } = await import('../src/scripts/fs-fulltext.js');
  assert.equal(SEARCH_PAGE_SIZE, 100);
  // Simulate the search loop against a fake endpoint that always has more entries.
  const walk = (years, max, maxPerYear) => {
    let total = 0;
    const perYear = [];
    for (const _ of years) {
      if (total >= max) break;
      let y = 0;
      for (;;) {
        const count = nextPageCount({ total, max, yearFetched: y, maxPerYear });
        if (!count) break;
        y += count;
        total += count;
      }
      perYear.push(y);
    }
    return { total, perYear };
  };
  const years = Array.from({ length: 32 }, (_, i) => 1784 + i);
  // The reported bug: --max 60 over 32 years used to fetch up to 60 PER year.
  assert.deepEqual(walk(years, 60, Infinity), { total: 60, perYear: [60] });
  assert.deepEqual(walk(years, 250, Infinity).perYear, [250]);
  assert.equal(walk(years, 640, 20).total, 640);
  assert.deepEqual(walk(years, 640, 20).perYear, Array(32).fill(20));
  assert.deepEqual(walk([1800, 1801], 250, 150).perYear, [150, 100]);
  assert.equal(nextPageCount({ total: 0, max: 300, yearFetched: 0 }), 100);
  assert.equal(nextPageCount({ total: 290, max: 300, yearFetched: 0 }), 10);
  assert.equal(nextPageCount({ total: 300, max: 300, yearFetched: 0 }), 0);
  assert.equal(nextPageCount({ total: 10, max: 300, yearFetched: 20, maxPerYear: 20 }), 0);

  assert.equal(parseCap(['search', 'q'], '--max', 300), 300);
  assert.equal(parseCap(['search', 'q', '--max', '60'], '--max', 300), 60);
  assert.throws(() => parseCap(['--max', '0'], '--max', 300), /positive integer/);
  assert.throws(() => parseCap(['--max', 'lots'], '--max', 300), /positive integer/);
  assert.throws(() => parseCap(['--max'], '--max', 300), /needs a positive integer/);

  assert.deepEqual(yearsSkippedNote([], 60), []);
  assert.match(yearsSkippedNote([1790, 1791, 1792], 60)[0], /TOTAL .* before 1790-1792 \(3 year\(s\)\)/);
});

test('browser-lock banner goes to stderr, so --json stdout stays parseable', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'gt-lock-'));
  try {
    const lock = join(dir, 'lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'meta.json'), JSON.stringify({ holder: 'synthetic', since: '2026-01-01T00:00:00Z' }));
    const mod = new URL('../src/scripts/cdp-transport.js', import.meta.url).href;
    const script = `const { requireBrowserLock } = await import(${JSON.stringify(mod)});
      requireBrowserLock('t', { lockDir: ${JSON.stringify(lock)}, metaFile: ${JSON.stringify(join(lock, 'meta.json'))}, actualHolder: 'synthetic' });
      console.log(JSON.stringify(['3:1:SYNT-HETI-C']));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ['3:1:SYNT-HETI-C']);
    assert.match(r.stderr, /browser lock HELD by synthetic .* proceeding/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fs-personas: session is a subcommand and its verdict line names itself', async () => {
  const { SUBCOMMANDS, sessionLine } = await import('../src/scripts/fs-personas.js');
  assert.ok(SUBCOMMANDS.includes('session'));
  assert.match(sessionLine('ALIVE', { status: 200, body: '{}' }), /^SESSION ALIVE — \/platform\/users\/current answered 200/);
  assert.match(sessionLine('SIGNED_OUT', { status: 401, body: '' }), /^SIGNED OUT — .* 401$/);
  assert.match(sessionLine('INCONCLUSIVE', { error: 'boom' }), /^SESSION PROBE INCONCLUSIVE — .* \? boom$/);
});
