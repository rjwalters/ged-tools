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
