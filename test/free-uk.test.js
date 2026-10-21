import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cellText, tables, csrfToken, resultCount, regFields, cenFields, matchPlaces, assertCenPlaceYear,
  parseRegResults, parseCenResults, parseRegRecord, parseCenRecord, regEventKey, validateRegQuery,
  validateCenQuery, slugFromUrl, FreeUkError,
} from '../src/lib/free-uk.js';
import { session } from '../src/scripts/freereg.js';

const REG_RESULTS = `<h2 class="gamma"> We found 2  Exact Results and <br>
  1  Uncertain Result</h2>
<table class="table--data"><thead><tr><th>Details</th><th><a href="#">Person or persons</a></th><th>Record type</th><th>Event date</th><th>County</th><th>Place : Church : Register type</th></tr></thead>
<tbody>
<tr id="a1"><td><a class="btn" href="/search_records/a1/sample-example-baptism-x-1809-05-07">View 1</a><i><br></i></td>
<td>Sample EXAMPLE<br>Sample SYNTHETIC<span class="tooltip-icon" title="Two surnames are shown">&#9432;</span></td>
<td>Baptism</td><td>07 May 1809</td><td>Norfolk</td><td>Testville : St Test :  Parish Register</td></tr>
<tr id="a2"><td><a class="btn" href="/search_records/a2/other-example-baptism-x-1809-11-12">View 2</a></td>
<td>Other EXAMPLE</td><td>Baptism</td><td>12 Nov 1809</td><td>Norfolk</td><td>Testville : St Test : Archdeacon&#39;s Transcript</td></tr>
</tbody></table>`;

const REG_RECORD = `<table class='table--data'><caption>Baptism entry</caption>
<thead><tr><th>Field <br>(only fields with a value are shown)</th><th>Value </th></tr></thead>
<tbody>
<tr><td>Place</td><td><a href="/x">Testville</a></td></tr>
<tr><td>Church name <small> (Links to more information)</small></td><td>St Test</td></tr>
<tr><td>Baptism date</td><td>07 May 1809</td></tr>
<tr><td>Person forename</td><td>Sample</td></tr>
<tr><td>Father forename</td><td>Example</td></tr>
<tr><td>Mother surname</td><td>SYNTHETIC</td></tr>
</tbody></table>`;

const CEN_RESULTS = `<h2>We found more than 500 Results</h2><table><thead><th>Detail</th><th><a>Individual</a></th><th>Birth County</th><th>Birth Place</th><th>Birth</th><th>Census</th><th>County</th><th>District</th></thead>
<tbody><tr id="c1"><td><a class="btn" href="/search_records/c1/sample-example-1871-x-1840-">View 1</a></td>
<td>Sample EXAMPLE </td><td>Norfolk</td><td>Testville</td><td>1840</td><td>1871</td><td>Norfolk</td><td>Testdistrict</td></tr></tbody></table>`;

const CEN_RECORD = `<table><thead><th>Census</th><th>County</th><th>District</th><th>Civil Parish</th><th>Piece</th><th>Folio</th><th>Schedule</th></thead>
<tbody><tr><td>1871</td><td>Norfolk (NFK)</td><td>Testdistrict</td><td>Testville</td><td>1</td><td>2</td><td>3</td></tr></tbody></table>
<table><thead><th>Surname</th><th>Forenames</th><th>Relationship</th><th>Age</th><th>Birth Place</th></thead><tbody>
<tr><td><span class="accessibility">the person found in your search</span> EXAMPLE</td><td>Sample</td><td>Head</td><td>30</td><td>Testville</td></tr>
<tr><td>EXAMPLE</td><td>Other</td><td>Wife</td><td>23</td><td>Otherton</td></tr>
</tbody></table>`;

test('cellText drops tags and tooltips, keeps line breaks as " / ", decodes entities', () => {
  assert.equal(cellText('Sample EXAMPLE<br>Sample SYNTHETIC<span class="tooltip-icon">&#9432;</span>'), 'Sample EXAMPLE / Sample SYNTHETIC');
  assert.equal(cellText('Archdeacon&#39;s &amp; Co'), "Archdeacon's & Co");
});

test('resultCount reads exact, uncertain and capped counts', () => {
  assert.deepEqual(resultCount(REG_RESULTS), { count: 3, exact: 2, uncertain: 1, capped: false });
  assert.deepEqual(resultCount('<h2> We found 0  Results</h2>'), { count: 0, exact: 0, uncertain: 0, capped: false });
  assert.equal(resultCount(CEN_RESULTS).capped, true);
  assert.equal(resultCount('<p>Search</p>'), null);
});

test('parseRegResults and parseRegRecord', () => {
  const rows = parseRegResults(REG_RESULTS);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    url: '/search_records/a1/sample-example-baptism-x-1809-05-07', persons: 'Sample EXAMPLE / Sample SYNTHETIC',
    type: 'Baptism', date: '07 May 1809', county: 'Norfolk', place: 'Testville : St Test : Parish Register',
  });
  const fields = parseRegRecord(REG_RECORD);
  assert.deepEqual(fields[1], ['Church name', 'St Test']);
  assert.deepEqual(fields.at(-1), ['Mother surname', 'SYNTHETIC']);
  assert.equal(regEventKey(fields), 'testville|7 may 1809|sample');
  assert.throws(() => parseRegRecord('<p>gone</p>'), FreeUkError);
});

test('parseCenResults and parseCenRecord flag the searched person', () => {
  assert.equal(parseCenResults(CEN_RESULTS)[0].birthPlace, 'Testville');
  const rec = parseCenRecord(CEN_RECORD);
  assert.equal(rec.dwelling.Folio, '2');
  assert.deepEqual(rec.household.map((p) => [p.Surname, p.Forenames, p.found]), [['EXAMPLE', 'Sample', true], ['EXAMPLE', 'Other', false]]);
});

test('form fields, csrf token and validation', () => {
  assert.equal(csrfToken('<input type="hidden" name="authenticity_token" value="t&#43;k" />'), 't+k');
  assert.throws(() => csrfToken('<form></form>'), FreeUkError);
  const reg = regFields('tok', { last: 'Example', type: 'ba', from: '1800', to: '1810', placeIds: ['p1'], fuzzy: true });
  assert.ok(reg.some(([k, v]) => k === 'search_query[record_type]' && v === 'ba'));
  assert.ok(reg.some(([k, v]) => k === 'search_query[place_ids][]' && v === 'p1'));
  const cen = cenFields('tok', { last: 'Example', year: '1851', placeIds: ['q1'] });
  assert.ok(cen.some(([k, v]) => k === 'search_query[freecen2_place_ids][]' && v === 'q1'));
  assert.throws(() => validateRegQuery({ last: 'Example', type: 'xx' }), /--type/);
  assert.throws(() => validateCenQuery({ last: 'Example', year: '1850' }), /--year/);
  assert.equal(slugFromUrl('https://x/search_records/abc/sample-example-1871-x-1840-'), 'sample-example-1871-x-1840');
});

test('FreeCEN place labels: a place without the census year is refused', () => {
  const places = matchPlaces({ p1: 'Testville ( 1841)', p2: 'Testvillage ( 1851, 1861)', p3: 'Otherton' }, 'Testville');
  assert.deepEqual(places, [{ id: 'p1', label: 'Testville ( 1841)', years: ['1841'] }]);
  assert.doesNotThrow(() => assertCenPlaceYear(places, '1841', 'Testville'));
  assert.throws(() => assertCenPlaceYear(places, '1871', 'Testville'), /1841 only/);
  assert.doesNotThrow(() => assertCenPlaceYear(matchPlaces({ p3: 'Otherton' }, 'Otherton'), '1871', 'Otherton'));
});

test('session keeps the POST cookie across the result redirect', async () => {
  const calls = [];
  const fake = async (url, opts) => {
    calls.push({ url, method: opts.method, cookie: opts.headers.Cookie });
    if (opts.method === 'POST') {
      return new Response('', { status: 302, headers: { location: '/search_queries/abc', 'set-cookie': 'sess=two; path=/' } });
    }
    return new Response('ok', { status: 200, headers: { 'set-cookie': 'sess=one; path=/' } });
  };
  const request = session('https://example.test', fake, 0);
  await request('/search_queries/new');
  const res = await request('/search_queries', [['a', 'b']]);
  assert.equal(res.url, 'https://example.test/search_queries/abc');
  assert.equal(calls[1].cookie, 'sess=one');
  assert.deepEqual([calls[2].method, calls[2].cookie], ['GET', 'sess=two']);
});
