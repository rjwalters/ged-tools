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
      'https://familysearch.org/ark:/61903/3:1:939L-F857-P/image.xml',
      { ark: 'ark:/61903/3:1:939L-F8VG-Y' },
      'garbage',
    ]),
    ['3:1:939L-F857-P', '3:1:939L-F8VG-Y', null],
  );
  assert.deepEqual(frameArks(undefined), []);
});
