import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSearchUrl,
  validateQuery,
  memorialRef,
  parseSearch,
  parseMemorial,
  parseLocations,
  locationQueryBody,
  challengeKind,
  formatHit,
  formatMemorial,
  FindAGraveError,
} from '../src/lib/findagrave.js';
import { search, memorial, httpTransport, parseArgs } from '../src/scripts/findagrave.js';

// Synthetic pages modelled on the live markup (2026-10-30); every name and id is invented.
const card = (id, slug, nameHtml, dates, cemetery = '', place = '', plot = '') => `
    <div role="group" aria-label="Memorial">
    <div class="memorial-item px-2 py-2 gx-4 gy-0 position-relative row border-bottom align-items-md-center" id="sr-${id}">
    <div class="col-12 col-md col-print-3">
    <a class="d-flex align-items-center text-decoration-none" href="/memorial/${id}/${slug}" data-scroll-offset="1">
    <div class="memorial-item-pic ms-sm-3"><figure class="pic-wrapper"><img src="https://images.findagrave.com/photoThumbnails/photos/x/${id}_1.jpg" alt=""></figure></div>
    <div class="memorial-item--info"><div class="memorial-item---grave">
            <h2 class="name-grave d-flex"><i class="pe-2 text-break">${nameHtml}</i></i>
                <div class="d-flex align-items-center gap-1"><b class="icon-vet">V</b></div>
            </h2>
            ${dates ? `<b class="birthDeathDates fw-light fs-5 text-body">${dates}</b>` : ''}
    </div></div>
    </a>
    </div>
    <div class="memorial-item---cemet col-12 col-md-auto">
      ${cemetery ? `<form action="/cemetery/555/${slug}-cem"><button type="submit" class="btn btn-link" role="link" title="${cemetery}">${cemetery}</button></form>` : ''}
      ${place ? `<p class="addr-cemet mb-1">
                        ${place.split(', ').join(',\n                        ')}
                    </p>` : ''}
      ${plot ? `<p class="addr-cemet mb-1"><span class="text-muted">Plot info:</span> <strong>${plot}</strong></p>` : ''}
    </div>
</div>
    </div>`;

const searchPage = ({ header, cards = '', next = false }) => `<html><head><title>Grave Memorial Records - Find a Grave</title></head><body>
<nav><a href="/memorial/search">Memorials</a><a href="/memorial/1/navigation-link">Featured</a></nav>
<h1 class="lead new h6 fw-normal">
   ${header}
</h1>
<div class="memorial-list-data"><div class="list-item-page pt-3 container-lg" data-url="page=1">${cards}</div></div>
<div class="py-4 text-center mx-n2 hidden">
    <button type="button" class="position-relative btn btn-default px-5 mt-n4 ${next ? '' : 'hidden'}" id="load-next-page" aria-label="Load another set of results">Next Page</button>
</div>
<!-- Memorial search result list ends -->
<div class="honor-widget"><a href="/memorial/999999/honoree-example" itemprop="url">Honoring</a></div>
</body></html>`;

const RESULTS = searchPage({
  header: '2 matching records found\n for',
  next: true,
  cards:
    card(1001, 'ann-example', 'Ann <I>Maiden</I> Example', '1801 &ndash; 3 May 1860', 'Synthetic Hill Cemetery', 'Townville, Sample County, Exampleshire', 'Sec A Lot 1') +
    card(1002, 'bo-example', 'Bo Example', '', '', ''),
});

const MEMORIAL = `<html><head><title>Ann Maiden Example (1801-1860) - Find a Grave Memorial</title>
<link rel="canonical" href="https://www.findagrave.com/memorial/1001/ann-example"></head><body>
<a href="#" id="main-photo"><img src="https://images.findagrave.com/photos/x/1001_1.jpg"></a>
<h1 id="bio-name" class="bio-name text-center text-md-start" itemprop="name">Ann <I>Maiden</I> Example  <b class="icon-vet badge"><span aria-hidden="true">V</span></b></h1>
<dl class="mem-events">
<dd><time id="birthDateLabel" class="info" itemprop="birthDate">1801</time>
  <div id="birthLocationLabel" class="place" itemprop="birthPlace">
     Oldtown, Sample County, Exampleshire
  </div></dd>
<dd><span id="deathDateLabel" class="info middot" itemprop="deathDate">3 May 1860 (aged 58&ndash;59)</span></dd>
<dd><div class="info"><a href="/cemetery/555/synthetic-hill-cemetery" itemprop="url" class="add-link text-wrap"><span id="cemeteryNameLabel" itemprop="name">Synthetic Hill Cemetery</span></a></div>
  <span class="place"><span id="cemeteryCityName" itemprop="addressLocality">Townville</span>,
  <span id="cemeteryCountyName">Sample County</span>,
  <span id="cemeteryStateName" itemprop="addressRegion">Exampleshire</span>,
  <span id="cemeteryCountryName" itemprop="addressLocality">Nowhere</span></span></dd>
<dd><span id="plotValueLabel" class="info">Sec A Lot 1</span></dd>
<dd><span id="memNumberLabel" class="hidden info copyme">1001</span></dd>
</dl>
<a id="memorial-all-photos" href="/memorial/1001/ann-example/photo">Photos <span class="badge bg-success rounded-pill photosCount">3</span></a>
<a id="memorial-all-flowers" href="/memorial/1001/ann-example/flower">Flowers <span class="badge bg-success rounded-pill flowersCount">0</span></a>
<div class="bio-min d-print-none" id="partBio">Wife of B. Example.</div>
<div class="bio-min d-none d-print-block" id="fullBio">Wife of B. Example.<br><br>Second paragraph &amp; more.</div>
<p id="inscriptionValue" class="mb-0">AT REST<br />IN PEACE</p>
<div class="overview-panel--body data-filled-user row" id="family-grid">
  <div><b id="parentsLabel" class="label-relation">Parents</b>
  <ul class="member-family" aria-labelledby="parentsLabel">
    <li itemscope itemtype="https://schema.org/Person"><a class="d-block" href="/memorial/2001/cal-maiden" itemprop="url">
      <div class="member-item"><img class="media-object lazyload" data-src="https://images.findagrave.com/photos/x/2001.jpg">
      <h3 itemprop="name">  Cal   Maiden
</h3><p class="life"><span id="familyBirthLabel" itemprop="birthDate">1770</span>&ndash;<span id="familyDeathLabel" itemprop="deathDate">1830</span></p></div></a></li>
  </ul></div>
  <div><b id="spouseLabel" class="label-relation">Spouse</b>
  <ul class="member-family" aria-labelledby="spouseLabel">
    <li itemscope><a href="/memorial/2002/bo-example" itemprop="url"><h3 itemprop="name">Bo Example <b class="icon-vet">V</b></h3><p class="life"><span id="familyBirthLabel">1799</span>&ndash;<span id="familyDeathLabel">1850</span></p></a></li>
  </ul></div>
  <div><b id="childrenLabel" class="label-relation">Children</b>
  <ul class="member-family" aria-labelledby="childrenLabel">
    <li itemscope><a href="/memorial/2003/di-example" itemprop="url"><h3 itemprop="name">Di Example</h3><p class="life"></p></a></li>
  </ul></div>
</div>
<ul class="transfer-list mb-0" id="source">
  <li><b>Maintained by:</b> <a href='/user/profile/301'>Sam Volunteer</a><input type="hidden" id="maintainedBy" value="Maintained by: Sam Volunteer (301)"></li>
  <li><b>Originally Created by:</b> <a href='/user/profile/302'>Pat Volunteer</a><input type="hidden" id="originallyCreatedBy" value="Originally Created by: Pat Volunteer (302)"></li>
  <li>Added:&nbsp;3 Dec 2007<input type="hidden" id="addedDate" value="Added: 2007-12-03T06:41:58.000Z"></li>
  <li class="citation"><div id="citationInfo" class="mb-2">
    <em>Find a Grave</em>, database and images (<a href="https://www.findagrave.com/memorial/1001/ann-example">https://www.findagrave.com/memorial/1001/ann-example</a>: accessed
    <span id="dateHolder"></span>), memorial page for Ann <I>Maiden</I> Example (1801&ndash;3 May 1860), Find a Grave Memorial ID <a href="#">1001</a>, citing Synthetic Hill Cemetery, Townville ;
    Maintained by Sam Volunteer (contributor <a href='#'>301</a>).
  </div></li>
</ul>
<script>var x = { isCenotaph: false, };</script>
</body></html>`;

test('search URL: only the fields given, default exact filter, paging', () => {
  assert.equal(
    buildSearchUrl({ first: 'Ann', last: 'Example', birthYear: '1801', deathYear: 1860, deathFilter: 'after' }),
    'https://www.findagrave.com/memorial/search?firstname=Ann&lastname=Example&birthyear=1801&birthyearfilter=exact&deathyear=1860&deathyearfilter=after',
  );
  assert.equal(buildSearchUrl({ last: 'Example', locationId: 'county_1' }, 3), 'https://www.findagrave.com/memorial/search?lastname=Example&locationId=county_1&page=3');
  // A filter without its year is dropped rather than sent.
  assert.equal(buildSearchUrl({ last: 'X', birthFilter: 'before' }), 'https://www.findagrave.com/memorial/search?lastname=X');
});

test('query validation refuses bad input with exit code 1', () => {
  for (const q of [{}, { last: ' ' }, { last: 'X', birthYear: '18' }, { last: 'X', deathYear: '1850', deathFilter: '2' }, { last: 'X', locationId: 'Indiana' }]) {
    assert.throws(() => validateQuery(q), (e) => e instanceof FindAGraveError && e.code === 1, JSON.stringify(q));
  }
  assert.equal(validateQuery({ last: 'X', birthYear: '1800', birthFilter: 'BEFORE' }).birthFilter, 'before');
});

test('memorial refs: bare ids and any memorial URL', () => {
  assert.deepEqual(memorialRef('1001'), { id: '1001', url: 'https://www.findagrave.com/memorial/1001' });
  assert.equal(memorialRef('https://www.findagrave.com/memorial/1001/ann-example/photo').id, '1001');
  assert.equal(memorialRef(' /memorial/77/x ').id, '77');
  assert.throws(() => memorialRef('https://www.findagrave.com/cemetery/555'), (e) => e.code === 1);
});

test('search cards are parsed from their containers, not from stray /memorial/ links', () => {
  const r = parseSearch(RESULTS);
  assert.equal(r.total, 2);
  assert.equal(r.hasNext, true);
  assert.deepEqual(r.hits.map((h) => h.id), ['1001', '1002'], 'navigation and Honoring-widget links are not hits');
  assert.deepEqual(r.hits[0], {
    id: '1001',
    url: 'https://www.findagrave.com/memorial/1001/ann-example',
    name: 'Ann Maiden Example',
    dates: '1801 – 3 May 1860',
    cemetery: 'Synthetic Hill Cemetery',
    cemeteryId: '555',
    place: 'Townville, Sample County, Exampleshire',
    plot: 'Sec A Lot 1',
  });
  assert.deepEqual({ ...r.hits[1], url: undefined }, { id: '1002', url: undefined, name: 'Bo Example', dates: '', cemetery: '', cemeteryId: '', place: '', plot: '' });
  assert.equal(formatHit(r.hits[0]), '1001 | https://www.findagrave.com/memorial/1001/ann-example | Ann Maiden Example | 1801 – 3 May 1860 | Synthetic Hill Cemetery | Townville, Sample County, Exampleshire | plot: Sec A Lot 1');
});

test('search: a stated zero, a single result, and a page that is not a result page', () => {
  const none = parseSearch(searchPage({ header: '<span class="icon-warning"></span> No matches found for' }));
  assert.deepEqual(none, { total: 0, hits: [], hasNext: false });
  const one = parseSearch(searchPage({ header: '1 matching record found for', cards: card(5, 'x', 'X Y', '1900 &ndash; 1950') }));
  assert.equal(one.total, 1);
  assert.equal(one.hasNext, false);
  assert.equal(parseSearch(searchPage({ header: '12,345 matching records found for', cards: card(5, 'x', 'X', '') })).total, 12345);
  assert.throws(() => parseSearch('<html><title>Find a Grave</title><a href="/memorial/9/x">x</a></html>'), (e) => e.code === 2);
});

test('memorial page: every field, family ids, citation with access date', () => {
  const m = parseMemorial(MEMORIAL, { accessed: '1 Jan 2030' });
  assert.equal(m.id, '1001');
  assert.equal(m.url, 'https://www.findagrave.com/memorial/1001/ann-example');
  assert.equal(m.name, 'Ann Maiden Example');
  assert.deepEqual(m.birth, { date: '1801', place: 'Oldtown, Sample County, Exampleshire' });
  assert.deepEqual(m.death, { date: '3 May 1860 (aged 58–59)', place: '' });
  assert.deepEqual(m.burial, { cemetery: 'Synthetic Hill Cemetery', cemeteryId: '555', place: 'Townville, Sample County, Exampleshire, Nowhere', plot: 'Sec A Lot 1' });
  assert.equal(m.inscription, 'AT REST\nIN PEACE');
  assert.equal(m.bio, 'Wife of B. Example.\n\nSecond paragraph & more.', 'the full bio wins over the truncated one');
  assert.deepEqual(m.family, [
    { relation: 'Parents', members: [{ id: '2001', url: 'https://www.findagrave.com/memorial/2001', name: 'Cal Maiden', dates: '1770–1830' }] },
    { relation: 'Spouse', members: [{ id: '2002', url: 'https://www.findagrave.com/memorial/2002', name: 'Bo Example', dates: '1799–1850' }] },
    { relation: 'Children', members: [{ id: '2003', url: 'https://www.findagrave.com/memorial/2003', name: 'Di Example', dates: '' }] },
  ]);
  assert.deepEqual(m.createdBy, { name: 'Pat Volunteer', contributorId: '302' });
  assert.deepEqual(m.maintainedBy, { name: 'Sam Volunteer', contributorId: '301' });
  assert.equal(m.added, '2007-12-03');
  assert.equal(m.photoCount, 3);
  assert.equal(m.cenotaph, false);
  assert.match(m.citation, /^Find a Grave, database and images \(https:\/\/www\.findagrave\.com\/memorial\/1001\/ann-example: accessed 1 Jan 2030\), memorial page for Ann Maiden Example/);
  assert.match(m.citation, /Townville; Maintained by Sam Volunteer \(contributor 301\)\.$/);
});

test('no photo URL ever leaves the memorial parser', () => {
  const m = parseMemorial(MEMORIAL);
  assert.doesNotMatch(JSON.stringify(m), /images\.findagrave\.com|\.jpg/);
  assert.doesNotMatch(formatMemorial(m), /images\.findagrave\.com|\.jpg/);
  assert.match(formatMemorial(m), /Photos\s+3 \(count only — photos are in copyright/);
  assert.doesNotMatch(JSON.stringify(parseSearch(RESULTS)), /images\.findagrave\.com/);
});

test('a page without #bio-name is not a memorial', () => {
  assert.equal(parseMemorial('<html><title>Find a Grave - Millions of Cemetery Records</title><h1>Home</h1></html>'), null);
});

test('location typeahead request and answer', () => {
  const body = locationQueryBody('Sample County');
  assert.equal(body.variables.search.name, 'Sample County');
  assert.match(body.query, /locationsByTypeahead/);
  const json = { data: { locationsByTypeahead: { total: 2, locations: [
    { id: 'county_1', locations: [{ city: null, county: 'Sample County', state: 'Exampleshire', country: 'Nowhere' }] },
    { id: 'city_2', locations: [{ city: 'Townville', county: 'Sample County', state: 'Exampleshire', country: 'Nowhere' }] },
  ] } } };
  assert.deepEqual(parseLocations(json), [
    { id: 'county_1', text: 'Sample County, Exampleshire, Nowhere' },
    { id: 'city_2', text: 'Townville, Sample County, Exampleshire, Nowhere' },
  ]);
  assert.throws(() => parseLocations({ errors: [] }), (e) => e.code === 2);
});

test('Cloudflare pages are recognised by title or text', () => {
  assert.equal(challengeKind({ title: 'Just a moment...', text: '' }), 'challenge');
  assert.equal(challengeKind({ title: '', text: 'Verifying you are human. This may take a few seconds.' }), 'challenge');
  assert.equal(challengeKind({ title: 'Attention Required! | Cloudflare', text: 'Sorry, you have been blocked' }), 'blocked');
  assert.equal(challengeKind({ title: 'Ann Maiden Example (1801-1860) - Find a Grave Memorial', text: 'BIRTH 1801' }), null);
});

function fakeTransport(pages) {
  const calls = [];
  return {
    calls,
    load: async (url) => {
      calls.push(url);
      const page = pages(url);
      if (page === undefined) throw new Error(`unexpected ${url}`);
      return page;
    },
    postJson: async (body) => {
      calls.push(`graphql:${body.variables.search.name}`);
      return { data: { locationsByTypeahead: { locations: [{ id: 'county_1', locations: [{ county: 'Sample County', state: 'Exampleshire' }] }] } } };
    },
    close: async () => {},
  };
}

test('search resolves a location to its id, follows pages and stops at --max', async () => {
  const page2 = searchPage({ header: '3 matching records found for', cards: card(1003, 'cy-example', 'Cy Example', '1900') });
  const t = fakeTransport((url) => (url.includes('page=2') ? page2 : RESULTS));
  const r = await search(t, { last: 'Example', location: 'Sample County' }, { max: 50, log: () => {}, delayMs: 0 });
  assert.deepEqual(t.calls, [
    'graphql:Sample County',
    'https://www.findagrave.com/memorial/search?lastname=Example&location=Sample+County&locationId=county_1',
    'https://www.findagrave.com/memorial/search?lastname=Example&location=Sample+County&locationId=county_1&page=2',
  ]);
  assert.deepEqual(r.hits.map((h) => h.id), ['1001', '1002', '1003']);
  const capped = await search(fakeTransport(() => RESULTS), { last: 'Example' }, { max: 1, log: () => {}, delayMs: 0 });
  assert.equal(capped.hits.length, 1);
  assert.equal(capped.truncated, true);
});

test('memorial: unknown id is a code-4 negative', async () => {
  await assert.rejects(memorial(fakeTransport(() => '<html><h1>Home</h1></html>'), '42'), (e) => e.code === 4);
  const m = await memorial(fakeTransport(() => MEMORIAL), '1001', { accessed: 'today' });
  assert.equal(m.requestedId, undefined);
  const merged = await memorial(fakeTransport(() => MEMORIAL), '999');
  assert.equal(merged.requestedId, '999');
});

test('plain HTTP sends a browser User-Agent and refuses a Cloudflare page', async () => {
  const seen = [];
  const ok = httpTransport({ fetchImpl: async (url, init) => { seen.push(init.headers['User-Agent']); return { status: 200, text: async () => RESULTS }; } });
  assert.equal(parseSearch(await ok.load('https://www.findagrave.com/memorial/search?lastname=X')).total, 2);
  assert.match(seen[0], /Mozilla\/5\.0/);
  const cf = httpTransport({ fetchImpl: async () => ({ status: 403, text: async () => '<title>Attention Required! | Cloudflare</title>blocked' }) });
  await assert.rejects(cf.load('https://www.findagrave.com/memorial/1'), (e) => e.code === 2 && /without --http/.test(e.message));
});

test('argument parsing', () => {
  const a = parseArgs(['search', '--last', 'X', '--birth-year', '1800', '--json', '--http']);
  assert.equal(a.verb, 'search');
  assert.deepEqual(a.flags, { last: 'X', 'birth-year': '1800', json: true, http: true });
  assert.throws(() => parseArgs(['search', '--last']), (e) => e.code === 1);
  assert.throws(() => parseArgs(['search', '--bogus']), (e) => e.code === 1);
  assert.throws(() => parseArgs(['search', '--max', '0']), (e) => e.code === 1);
});
