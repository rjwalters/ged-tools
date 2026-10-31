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

test('fs-image neighbours: window offsets, film edges, DAS name/locator parsing and cross-check', async () => {
  const { neighbourWindow, attachDas, parseDasName, dgsFromLocator, formatOffset, parseSpan, dasSiblingsExpr } = await import('../src/scripts/fs-image.js');
  const arks = ['3:1:AAAA-0000', '3:1:AAAA-0001', '3:1:AAAA-0002', '3:1:AAAA-0003', '3:1:AAAA-0004'];
  assert.deepEqual(neighbourWindow(arks, 2), [
    { offset: -1, frame: 1, ark: '3:1:AAAA-0001' },
    { offset: 0, frame: 2, ark: '3:1:AAAA-0002' },
    { offset: 1, frame: 3, ark: '3:1:AAAA-0003' },
  ]);
  assert.deepEqual(neighbourWindow(arks, 2, 0, 2).map((r) => r.offset), [0, 1, 2]);
  // Clipped at both ends of the film, never padded.
  assert.deepEqual(neighbourWindow(arks, 0, 3, 1).map((r) => [r.offset, r.frame]), [[0, 0], [1, 1]]);
  assert.deepEqual(neighbourWindow(arks, 4, 1, 5).map((r) => [r.offset, r.frame]), [[-1, 3], [0, 4]]);
  assert.deepEqual(neighbourWindow(arks, -1), []);
  assert.deepEqual(neighbourWindow(arks, 5), []);

  assert.deepEqual(parseDasName('007540369_00155'), { dgs: '007540369', order: 155 });
  assert.equal(parseDasName('not-a-frame'), null);
  assert.equal(dgsFromLocator('dgs:007540369.007540369_00155'), '007540369');
  assert.equal(dgsFromLocator('other:1.2'), null);

  // DAS order is 1-based: frame index i ↔ order i + 1.
  const children = [
    { apid: 'TH-1', name: 'X_00002', order: 2 },
    { apid: 'TH-SELF', name: 'X_00003', order: 3 },
    { apid: 'TH-3', name: 'X_00004', order: 4 },
  ];
  const ok = attachDas(neighbourWindow(arks, 2), children, 'TH-SELF');
  assert.equal(ok.agrees, true);
  assert.deepEqual(ok.rows.map((r) => r.apid), ['TH-1', 'TH-SELF', 'TH-3']);
  const off = attachDas(neighbourWindow(arks, 1), children, 'TH-SELF');
  assert.equal(off.agrees, false);
  assert.ok(off.rows.every((r) => r.apid === null && r.name === null));
  assert.equal(attachDas(neighbourWindow(arks, 2), null, 'TH-SELF').agrees, false);

  assert.deepEqual([-2, 0, 3].map(formatOffset), ['-2', '0', '+3']);
  assert.equal(parseSpan(['neighbours', 'x'], '--back'), 1);
  assert.equal(parseSpan(['--back', '0'], '--back'), 0);
  assert.equal(parseSpan(['--fwd', '4'], '--fwd'), 4);
  assert.throws(() => parseSpan(['--back', '-1'], '--back'), /non-negative/);
  assert.throws(() => parseSpan(['--back', '--json'], '--back'), /non-negative/);
  assert.throws(() => parseSpan(['--fwd'], '--fwd'), /non-negative/);

  assert.match(dasSiblingsExpr('TH-1942-1'), /das\/v2\/" \+ "TH-1942-1" \+ '\/parents'/);
  assert.throws(() => dasSiblingsExpr("TH'); alert(1)"), /not an apid/);
  assert.throws(() => dasSiblingsExpr('TH-1', ' '), /must be non-empty/);
});
