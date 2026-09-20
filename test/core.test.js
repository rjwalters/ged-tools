import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModel, parseRecords, loadGed, RefusedError, applyPatches } from '../src/index.js';

// Invented from scratch. Never replace with an export from a real family tree.
const fixture = [
  '0 HEAD', '1 SOUR SYNTHETIC', '1 GEDC', '2 VERS 5.5.1', '1 CHAR UTF-8',
  '0 @I1@ INDI', '1 NAME Synthetic /Alpha/', '1 FAMS @F1@',
  '0 @I2@ INDI', '1 NAME Synthetic /Beta/', '1 FAMC @F1@',
  '1 NOTE first', '2 CONC second', '2 CONT third', '2 SOUR @S1@',
  '0 @F1@ FAM', '1 HUSB @I1@', '1 CHIL @I2@',
  '0 @S1@ SOUR', '1 TITL Synthetic source', '0 TRLR',
].join('\n');

function withFile(t, bytes = fixture) {
  const dir = mkdtempSync(join(tmpdir(), 'ged-tools-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'synthetic.ged');
  writeFileSync(path, bytes);
  return path;
}

test('parser resolves relationships and continuation text', () => {
  const model = buildModel('\uFEFF' + fixture.replaceAll('\n', '\r\n'));
  assert.equal(model.people.I1.name, 'Synthetic Alpha');
  assert.deepEqual(model.families.F1.children, ['I2']);
  assert.deepEqual(model.people.I2.famc, ['F1']);
  assert.equal(model.people.I2.note, 'firstsecond\nthird');
  const records = parseRecords('0 @I1@ INDI\n1 EMAIL synthetic@@example.invalid\n');
  assert.equal(records[0].children[0].value, 'synthetic@example.invalid');
});

test('no-op editing preserves BOM, mixed EOLs, trailing spaces and invalid UTF-8', t => {
  const bytes = Buffer.concat([
    Buffer.from('\uFEFF' + fixture.replace('1 NAME Synthetic /Alpha/', '1 NAME Synthetic /Alpha/  \r')),
    Buffer.from([0xff]),
  ]);
  const path = withFile(t, bytes);
  loadGed(path).save(path);
  assert.deepEqual(readFileSync(path), bytes);
});

test('wrapped replacement removes old continuation but preserves citations', t => {
  const path = withFile(t);
  const ged = loadGed(path);
  ged.setWrapped('I2', 'NOTE', '新しい文章 '.repeat(70));
  ged.save(path);
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes('2 SOUR @S1@'));
  assert.ok(!text.includes('second'));
  assert.ok(!text.includes('\uFFFD'));
  for (const line of text.split('\n')) assert.ok(Buffer.byteLength(line) <= 255);
  assert.ok(buildModel(text).people.I2.note.startsWith('新しい文章'));
});

test('surgical edits preserve untouched record bytes and use dominant CRLF', t => {
  const bytes = Buffer.from('\uFEFF' + fixture.replaceAll('\n', '\r\n'));
  const path = withFile(t, bytes);
  const ged = loadGed(path);
  ged.set('I1', 'BIRT.DATE', '1 JAN 1900');
  ged.save(path);
  const result = readFileSync(path);
  const marker = Buffer.from('0 @I2@');
  assert.deepEqual(result.subarray(result.indexOf(marker)), bytes.subarray(bytes.indexOf(marker)));
  assert.ok(result.toString().includes('1 BIRT\r\n2 DATE 1 JAN 1900\r\n'));
});

test('pointer changes are idempotent; unsafe writes and skipped ordinals refuse', t => {
  const path = withFile(t);
  const ged = loadGed(path);
  assert.throws(() => ged.set('F1', 'CHIL', '@I3@'), RefusedError);
  assert.throws(() => ged.set('I1', 'NOTE[3]', 'synthetic'), RefusedError);
  assert.equal(ged.addPointer('F1', 'CHIL', 'I3'), true);
  assert.equal(ged.addPointer('F1', 'CHIL', 'I3'), false);
  assert.deepEqual(ged.pointers('F1', 'CHIL'), ['I2', 'I3']);
  ged.removePointer('F1', 'CHIL', 'I3');
  assert.deepEqual(ged.pointers('F1', 'CHIL'), ['I2']);
  assert.deepEqual(readFileSync(path), Buffer.from(fixture));
});

test('append notes, remove nested facts, and add/remove whole records', t => {
  const path = withFile(t);
  const ged = loadGed(path);
  ged.appendFact('I2', 'NOTE', 'another synthetic note');
  ged.removePath('I2', 'NOTE[1].SOUR');
  const id = ged.nextXref('I');
  assert.equal(id, 'I3');
  ged.appendRecord([`0 @${id}@ INDI`, '1 NAME Synthetic /Gamma/']);
  ged.removeRecord(id);
  ged.save(path);
  const text = readFileSync(path, 'utf8');
  assert.equal(buildModel(text).people.I2.note, 'firstsecond\nthird\n\nanother synthetic note');
  assert.ok(!text.includes('2 SOUR @S1@'));
  assert.ok(!text.includes('@I3@'));
  assert.ok(text.endsWith('0 TRLR'));
});

test('overlays wire both directions and apply explicit overrides', () => {
  const model = buildModel(fixture);
  assert.equal(applyPatches(model, {
    additions: {
      people: [{ id: 'I3', given: 'Synthetic', surname: 'Gamma' }],
      families: [{ id: 'F2', husband: 'I2', children: ['I3'] }],
    },
    overrides: { I1: { deceased: true } },
  }), model);
  assert.deepEqual(model.people.I2.fams, ['F2']);
  assert.deepEqual(model.people.I3.famc, ['F2']);
  assert.equal(model.people.I1.deceased, true);
  assert.equal(applyPatches(model, null), model);
});
