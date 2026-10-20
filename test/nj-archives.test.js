import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hiddenFields,
  formAction,
  databasePostback,
  parseGrid,
  deathRows,
  pagePostback,
  validateQuery,
  searchFields,
  SITE_SEARCH_VALUE,
  NjArchivesError,
} from '../src/lib/nj-archives.js';

const INDEX = `<form method="post" action="./index.aspx">
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="abc&#43;def" />
<input type="hidden" name="__EVENTVALIDATION" value="ev1" />
<table id="ctl00_ContentPlaceHolder1_GridView1">
<tr><td><a href="javascript:__doPostBack(&#39;ctl00$ContentPlaceHolder1$GridView1$ctl03$lbtn&#39;,&#39;&#39;)"><span>Marriage Records, May 1848 - December 1900</span></a></td></tr>
<tr><td><a href="javascript:__doPostBack(&#39;ctl00$ContentPlaceHolder1$GridView1$ctl05$lbtn&#39;,&#39;&#39;)"><span>Death Records, June 1878 - December 1900</span></a></td></tr>
</table></form>`;

const RESULTS = `<form method="post" action="DeathIndex.aspx">
<table id="ctl00_ContentPlaceHolder1_GridView2">
<tr><th>Select</th><th>Name</th><th>Age</th><th>Sex</th><th>Race</th><th>Location</th><th>Date</th><th>Citation</th></tr>
<tr><td>Select</td><td>Example, Ann</td><td>70y</td><td>F</td><td></td><td>Passaic County : Paterson</td><td>15 May 1887</td><td>1886-87. 83 - X1</td></tr>
<tr><td>Select</td><td>Example, Bo &amp; Co</td><td>3y</td><td>M</td><td></td><td>Essex County : Newark</td><td>1880</td><td>1879-80. 30 - X2</td></tr>
<tr><td colspan="8"><a href="javascript:__doPostBack(&#39;ctl00$ContentPlaceHolder1$GridView2&#39;,&#39;Page$2&#39;)">2</a></td></tr>
</table></form>`;

test('hidden WebForms state is read and decoded', () => {
  assert.deepEqual(hiddenFields(INDEX), { __VIEWSTATE: 'abc+def', __EVENTVALIDATION: 'ev1' });
  assert.equal(formAction(INDEX), 'https://wwwdnet-dos.nj.gov/DOS_ArchivesDBPortal/index.aspx');
  assert.equal(formAction(RESULTS), 'https://wwwdnet-dos.nj.gov/DOS_ArchivesDBPortal/DeathIndex.aspx');
});

test('the death database is found by its row text, not its position', () => {
  assert.equal(databasePostback(INDEX), 'ctl00$ContentPlaceHolder1$GridView1$ctl05$lbtn');
  const reordered = INDEX.replace('ctl05', 'ctl09');
  assert.equal(databasePostback(reordered), 'ctl00$ContentPlaceHolder1$GridView1$ctl09$lbtn');
  assert.throws(() => databasePostback(INDEX.replace('June 1878', 'July 1879')), NjArchivesError);
});

test('grid rows exclude the header; paging targets are found', () => {
  const rows = deathRows(parseGrid(RESULTS));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { name: 'Example, Ann', age: '70y', sex: 'F', race: '', location: 'Passaic County : Paterson', date: '15 May 1887', citation: '1886-87. 83 - X1' });
  assert.equal(rows[1].name, 'Example, Bo & Co');
  assert.equal(pagePostback(RESULTS, 2), 'ctl00$ContentPlaceHolder1$GridView2');
  assert.equal(pagePostback(RESULTS, 3), null);
  assert.equal(parseGrid('<form action="x"></form>'), null);
  assert.deepEqual(deathRows(null), []);
});

test('query validation and the posted fields', () => {
  assert.throws(() => validateQuery({ surname: ' ' }), (e) => e.code === 1);
  assert.throws(() => validateQuery({ surname: 'X', from: '89' }), /4-digit/);
  assert.throws(() => validateQuery({ surname: 'X', county: 'Atlantis' }), /unknown county/);
  const q = validateQuery({ surname: ' Example ', given: 'Ma', from: '1885', to: '1888', county: 'Passaic' });
  const f = searchFields({ __VIEWSTATE: 'v' }, q);
  assert.equal(f.__VIEWSTATE, 'v');
  assert.equal(f['ctl00$ddlSearchSite'], SITE_SEARCH_VALUE, 'the site-search select must be posted or the server 500s');
  assert.equal(f['ctl00$ContentPlaceHolder1$txtLN'], 'Example');
  assert.equal(f['ctl00$ContentPlaceHolder1$txtFN'], 'Ma');
  assert.equal(f['ctl00$ContentPlaceHolder1$ddlCountyList'], 'Passaic');
});
