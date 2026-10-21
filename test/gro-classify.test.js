import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSex, splitForename, pageInfo, parseResults } from '../src/lib/gro-classify.js';

test('normalizeSex accepts M/F in any case and rejects everything else', () => {
  assert.equal(normalizeSex('m'), 'M');
  assert.equal(normalizeSex(' F '), 'F');
  assert.equal(normalizeSex(undefined), null);
  assert.equal(normalizeSex(''), null);
  assert.equal(normalizeSex('male'), null);
});

test('splitForename puts the first word in Forename1 and the rest in Forename2', () => {
  assert.deepEqual(splitForename('Mary Ann'), ['Mary', 'Ann']);
  assert.deepEqual(splitForename('  Sample  Middle Name '), ['Sample', 'Middle Name']);
  assert.deepEqual(splitForename('Sample'), ['Sample', '']);
  assert.deepEqual(splitForename(undefined), ['', '']);
});

test('pageInfo reads the record count and page position', () => {
  assert.deepEqual(pageInfo('93 Record(s) Found - Showing Page 1 of 2\nGo to page'), { count: 93, page: 1, pages: 2 });
  assert.deepEqual(pageInfo('3 Record(s) Found'), { count: 3, page: 1, pages: 1 });
  assert.deepEqual(pageInfo('Search the GRO Online Indexes'), { count: null, page: 1, pages: 1 });
});

test('parseResults pairs each name line with its GRO reference', () => {
  const text = [
    'Results:',
    'Select the button by an individual result',
    '\tEXAMPLE, SAMPLE  ANN  \tSYNTHETIC  ',
    'GRO Reference: 1846  D Quarter in OF THE TESTING UNION  Volume 13  Page 64',
    '\tEXAMPLE, OTHER  \t-  ',
    "GRO Reference: 1845  J Quarter in ST. MARY'S DISTRICT  Volume 02  Page 7",
    '2 Record(s) Found - Showing Page 1 of 1',
  ].join('\n');
  assert.deepEqual(parseResults(text), [
    { name: 'EXAMPLE, SAMPLE ANN', mothersMaidenSurname: 'SYNTHETIC', year: '1846', quarter: 'D', district: 'OF THE TESTING UNION', volume: '13', page: '64' },
    { name: 'EXAMPLE, OTHER', mothersMaidenSurname: '-', year: '1845', quarter: 'J', district: "ST. MARY'S DISTRICT", volume: '02', page: '7' },
  ]);
});

test('parseResults keeps districts with commas and ampersands', () => {
  const text = [
    'Results:',
    '\tEXAMPLE, ONE  \tSYNTHETIC  ',
    'GRO Reference: 1846  S Quarter in NORTHTOWN, SOUTHTOWN, AND WESTON  Volume 03  Page 343',
    '\tEXAMPLE, TWO  \t-  ',
    'GRO Reference: 1846  M Quarter in EAST & WEST UNION  Volume 12  Page 330',
  ].join('\n');
  assert.deepEqual(parseResults(text).map((r) => r.district), ['NORTHTOWN, SOUTHTOWN, AND WESTON', 'EAST & WEST UNION']);
});
