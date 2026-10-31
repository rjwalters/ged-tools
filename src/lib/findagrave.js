// Find a Grave — memorial search and memorial pages. Pure core: URL building
// and HTML parsing only; transport lives in scripts/findagrave.js.
//
// Measured 2026-10-30:
//   - search results are server-rendered `div.memorial-item` cards with
//     id="sr-<memorial id>", 20 per page, paged by `&page=N`; the page also
//     carries unrelated /memorial/ links (an "Honoring" sidebar widget, the
//     navigation), so cards are parsed by their own container, never by
//     collecting `a[href*="/memorial/"]`;
//   - the free-text `location` parameter alone is IGNORED by the server: the
//     filter takes effect only with a `locationId` (county_817, state_17, …),
//     which the site's own typeahead resolves through POST /orc/graphql;
//   - an unknown memorial id redirects to the home page (no #bio-name);
//   - plain HTTP is answered with a browser User-Agent and refused by
//     Cloudflare ("Attention Required!", HTTP 403) without one.
//
// Find a Grave photos are in copyright. Nothing here extracts an image URL;
// a memorial's photos are reported as a count only.

export const ORIGIN = 'https://www.findagrave.com';
export const SEARCH_PATH = '/memorial/search';
export const GRAPHQL_PATH = '/orc/graphql';
export const PAGE_SIZE = 20;
export const YEAR_FILTERS = ['exact', 'before', 'after', '1', '3', '5', '10', '25'];
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export class FindAGraveError extends Error {
  constructor(message, { code = 2 } = {}) {
    super(message);
    this.name = 'FindAGraveError';
    this.code = code;
  }
}

const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', reg: '®', middot: '·' };

export function decode(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

/** Inline text: tags dropped, whitespace collapsed. */
export function text(html) {
  return decode(String(html ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Block text: <br> and </p> become line breaks, each line collapsed. */
export function blockText(html) {
  const raw = String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n');
  return decode(raw.replace(/<[^>]+>/g, ''))
    .split('\n')
    .map((l) => l.replace(/[ \t\r\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function validYear(name, v) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v).trim();
  if (!/^\d{4}$/.test(s)) throw new FindAGraveError(`${name} must be a 4-digit year (got ${s})`, { code: 1 });
  return s;
}

function validFilter(name, v) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v).trim().toLowerCase();
  if (!YEAR_FILTERS.includes(s)) throw new FindAGraveError(`${name} must be one of ${YEAR_FILTERS.join('|')} (got ${s})`, { code: 1 });
  return s;
}

/** Normalise a search query; throws FindAGraveError(code 1) on bad input. */
export function validateQuery(q = {}) {
  const last = String(q.last ?? '').trim();
  if (!last) throw new FindAGraveError('--last is required', { code: 1 });
  const out = {
    first: String(q.first ?? '').trim(),
    middle: String(q.middle ?? '').trim(),
    last,
    birthYear: validYear('--birth-year', q.birthYear),
    birthFilter: validFilter('--birth-filter', q.birthFilter),
    deathYear: validYear('--death-year', q.deathYear),
    deathFilter: validFilter('--death-filter', q.deathFilter),
    location: String(q.location ?? '').trim(),
    locationId: String(q.locationId ?? '').trim(),
  };
  if (out.locationId && !/^[a-z]+_\d+$/.test(out.locationId)) {
    throw new FindAGraveError(`--location-id looks like county_817 or state_17 (got ${out.locationId})`, { code: 1 });
  }
  // A year filter means nothing without its year; the site default is exact.
  if (out.birthYear && !out.birthFilter) out.birthFilter = 'exact';
  if (out.deathYear && !out.deathFilter) out.deathFilter = 'exact';
  if (!out.birthYear) out.birthFilter = '';
  if (!out.deathYear) out.deathFilter = '';
  return out;
}

export function buildSearchUrl(query, page = 1) {
  const q = validateQuery(query);
  const p = new URLSearchParams();
  const put = (k, v) => { if (v) p.set(k, v); };
  put('firstname', q.first);
  put('middlename', q.middle);
  put('lastname', q.last);
  put('birthyear', q.birthYear);
  put('birthyearfilter', q.birthFilter);
  put('deathyear', q.deathYear);
  put('deathyearfilter', q.deathFilter);
  put('location', q.location);
  put('locationId', q.locationId);
  if (page > 1) p.set('page', String(page));
  return `${ORIGIN}${SEARCH_PATH}?${p}`;
}

/** Accepts 12345, "12345", or any findagrave.com/memorial/12345[/slug] URL. */
export function memorialRef(input) {
  const raw = String(input ?? '').trim();
  let id = null;
  if (/^\d+$/.test(raw)) id = raw;
  else {
    const m = raw.match(/findagrave\.com\/memorial\/(\d+)/i) ?? raw.match(/^\/?memorial\/(\d+)/i);
    if (m) id = m[1];
  }
  if (!id) throw new FindAGraveError(`not a memorial id or URL: ${raw.slice(0, 80)}`, { code: 1 });
  return { id, url: `${ORIGIN}/memorial/${id}` };
}

/** Request body for the site's own location typeahead. */
export function locationQueryBody(name) {
  return {
    query: 'query locationTypeahead($search: LocationSearchInput) { locationsByTypeahead(search: $search) { total locations { ... on Location { id locations(format: short) { city county state country } } } } }',
    variables: { search: { name: String(name), autocomplete: 'location' } },
  };
}

export function parseLocations(json) {
  const list = json?.data?.locationsByTypeahead?.locations;
  if (!Array.isArray(list)) throw new FindAGraveError('location lookup answered without a location list');
  return list
    .filter((l) => l?.id)
    .map((l) => {
      const parts = l.locations?.[0] ?? {};
      return { id: l.id, text: ['city', 'county', 'state', 'country'].map((k) => parts[k]).filter(Boolean).join(', ') };
    });
}

/** Cloudflare interstitials and blocks, by title or visible text. */
export function challengeKind({ title = '', text: body = '' } = {}) {
  const t = String(title);
  const b = String(body).slice(0, 4000);
  if (/just a moment|checking your browser|un instant/i.test(t) || /checking (if the site connection is secure|your browser)|verify(ing)? you are (a )?human|enable javascript and cookies to continue/i.test(b)) {
    return 'challenge';
  }
  if (/attention required/i.test(t) && /cloudflare/i.test(t + b)) return 'blocked';
  return null;
}

function attr(tag, name) {
  const m = String(tag).match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return m ? decode(m[1]) : null;
}

function byId(html, id) {
  const m = String(html).match(new RegExp(`<(\\w+)\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</\\1>`, 'i'));
  return m ? m[2] : null;
}

function hiddenValue(html, id) {
  const m = String(html).match(new RegExp(`<input\\b[^>]*\\bid="${id}"[^>]*>`, 'i'));
  return m ? attr(m[0], 'value') : null;
}

/** One search results page: { total, hits, hasNext }. */
export function parseSearch(html) {
  const s = String(html ?? '');
  const headerMatch = s.match(/<h1 class="lead[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  const header = headerMatch ? text(headerMatch[1]) : '';
  let total = null;
  if (/no matches found/i.test(header)) total = 0;
  else {
    const m = header.match(/([\d,]+)\s+matching records? found/i);
    if (m) total = Number(m[1].replace(/,/g, ''));
  }
  const starts = [...s.matchAll(/<div class="memorial-item [^"]*"[^>]*\bid="sr-(\d+)"[^>]*>/gi)];
  const end = s.search(/<!--\s*Memorial search result list ends\s*-->/i);
  const hits = starts.map((m, i) => {
    const from = m.index;
    let to = i + 1 < starts.length ? starts[i + 1].index : end > from ? end : s.length;
    const card = s.slice(from, to);
    const id = m[1];
    const href = card.match(/<a\b[^>]*href="(\/memorial\/(\d+)\/[^"]*)"/i);
    const nameHtml = card.match(/<h2 class="name-grave[^"]*"[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? '';
    const name = text(nameHtml.split(/<div\b/i)[0]);
    const dates = text(card.match(/<b class="birthDeathDates[^"]*"[^>]*>([\s\S]*?)<\/b>/i)?.[1] ?? '');
    const cemetBlock = card.match(/memorial-item---cemet[^>]*>([\s\S]*)$/i)?.[1] ?? '';
    const form = cemetBlock.match(/<form action="\/cemetery\/(\d+)\/[^"]*">\s*<button\b[^>]*>([\s\S]*?)<\/button>/i);
    const addrs = [...cemetBlock.matchAll(/<p class="addr-cemet[^"]*"[^>]*>([\s\S]*?)<\/p>/gi)].map((a) => a[1]);
    const placeHtml = addrs.find((a) => !/Plot info/i.test(a));
    const plotHtml = addrs.find((a) => /Plot info/i.test(a));
    return {
      id,
      url: `${ORIGIN}${href && href[2] === id ? href[1] : `/memorial/${id}`}`,
      name,
      dates,
      cemetery: form ? text(form[2]) : '',
      cemeteryId: form ? form[1] : '',
      place: placeHtml ? text(placeHtml).replace(/\s+,/g, ',').replace(/,\s*$/, '') : '',
      plot: plotHtml ? text(plotHtml.replace(/<span class="text-muted">[\s\S]*?<\/span>/i, '')) : '',
    };
  });
  if (total === null && !hits.length) {
    throw new FindAGraveError('the search page has neither a result count nor result cards — not a Find a Grave results page, or the layout changed');
  }
  const next = s.match(/<button\b[^>]*\bid="load-next-page"[^>]*>/i)?.[0] ?? '';
  const hasNext = Boolean(next) && !/class="[^"]*\bhidden\b[^"]*"/i.test(next);
  return { total: total ?? hits.length, hits, hasNext };
}

function parseContributor(value) {
  if (!value) return null;
  const v = String(value).replace(/^[^:]*:\s*/, '').trim();
  const m = v.match(/^(.*?)\s*\((\d+)\)$/);
  return m ? { name: m[1], contributorId: m[2] } : { name: v, contributorId: null };
}

function cleanName(h) {
  // Drop veteran/famous badges (<b …>V</b>) — the maiden name is in <i>, not <b>.
  return text(String(h ?? '').replace(/<b\b[^>]*>[\s\S]*?<\/b>/gi, '').replace(/<span\b[^>]*>[\s\S]*?<\/span>/gi, ''));
}

/** A memorial page; null when the page is not a memorial (unknown id → home page). */
export function parseMemorial(html, { accessed = null } = {}) {
  const s = String(html ?? '');
  const nameHtml = s.match(/<h1\b[^>]*\bid="bio-name"[^>]*>([\s\S]*?)<\/h1>/i);
  if (!nameHtml) return null;
  const id = text(byId(s, 'memNumberLabel') ?? '') || null;
  const canonical = s.match(/<link rel="canonical" href="([^"]+)"/i)?.[1] ?? (id ? `${ORIGIN}/memorial/${id}` : null);
  const place = ['cemeteryCityName', 'cemeteryCountyName', 'cemeteryStateName', 'cemeteryCountryName']
    .map((k) => text(byId(s, k) ?? ''))
    .filter(Boolean)
    .join(', ');
  const cemHref = s.match(/<a href="\/cemetery\/(\d+)\/[^"]*"[^>]*>\s*<span id="cemeteryNameLabel"/i);
  const bio = byId(s, 'fullBio') ?? byId(s, 'partBio');
  const family = [];
  for (const m of s.matchAll(/<b\b[^>]*class="label-relation"[^>]*>([\s\S]*?)<\/b>\s*<ul class="member-family"[^>]*>([\s\S]*?)<\/ul>/gi)) {
    const relation = text(m[1]);
    const members = [];
    for (const li of m[2].split(/<li\b/i).slice(1)) {
      const href = li.match(/href="\/memorial\/(\d+)\/[^"]*"/i);
      if (!href) continue;
      const birth = text(li.match(/id="familyBirthLabel"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '');
      const death = text(li.match(/id="familyDeathLabel"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? '');
      members.push({
        id: href[1],
        url: `${ORIGIN}/memorial/${href[1]}`,
        name: cleanName(li.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1]),
        dates: [birth, death].some(Boolean) ? `${birth}–${death}` : '',
      });
    }
    family.push({ relation, members });
  }
  const count = (cls) => {
    const m = s.match(new RegExp(`class="[^"]*\\b${cls}\\b[^"]*">\\s*([\\d,]+)`, 'i'));
    return m ? Number(m[1].replace(/,/g, '')) : 0;
  };
  let citation = byId(s, 'citationInfo');
  if (citation !== null) {
    citation = text(citation).replace(/\s+([,.;:)])/g, '$1').replace(/\(\s+/g, '(');
    if (accessed) citation = citation.replace(/accessed\s*\)/i, `accessed ${accessed})`);
  }
  const added = hiddenValue(s, 'addedDate');
  const cenotaph = s.match(/isCenotaph:\s*(true|false)/);
  return {
    id,
    url: canonical,
    name: cleanName(nameHtml[1]),
    birth: { date: text(byId(s, 'birthDateLabel') ?? ''), place: text(byId(s, 'birthLocationLabel') ?? '') },
    death: { date: text(byId(s, 'deathDateLabel') ?? ''), place: text(byId(s, 'deathLocationLabel') ?? '') },
    burial: {
      cemetery: text(byId(s, 'cemeteryNameLabel') ?? ''),
      cemeteryId: cemHref ? cemHref[1] : '',
      place,
      plot: text(byId(s, 'plotValueLabel') ?? ''),
    },
    cenotaph: cenotaph ? cenotaph[1] === 'true' : null,
    inscription: blockText(byId(s, 'inscriptionValue') ?? ''),
    bio: blockText(bio ?? ''),
    family,
    createdBy: parseContributor(hiddenValue(s, 'originallyCreatedBy') ?? hiddenValue(s, 'createdBy')),
    maintainedBy: parseContributor(hiddenValue(s, 'maintainedBy')),
    added: added ? added.replace(/^Added:\s*/i, '').slice(0, 10) : '',
    photoCount: count('photosCount'),
    flowerCount: count('flowersCount'),
    citation: citation ?? '',
  };
}

export function formatHit(h) {
  return [h.id, h.url, h.name, h.dates, h.cemetery, h.place].join(' | ') + (h.plot ? ` | plot: ${h.plot}` : '');
}

export function formatMemorial(m) {
  const lines = [];
  const put = (label, v) => { if (v) lines.push(`${label.padEnd(12)}${v}`); };
  put('Name', m.name);
  put('Memorial', `${m.id}  ${m.url}`);
  put('Birth', [m.birth.date, m.birth.place].filter(Boolean).join(' — '));
  put('Death', [m.death.date, m.death.place].filter(Boolean).join(' — '));
  put('Burial', [m.burial.cemetery, m.burial.place].filter(Boolean).join(' — ') + (m.burial.cemeteryId ? ` (cemetery ${m.burial.cemeteryId})` : ''));
  put('Plot', m.burial.plot);
  if (m.cenotaph) put('Cenotaph', 'yes');
  if (m.inscription) lines.push('Inscription', ...m.inscription.split('\n').map((l) => `  ${l}`));
  if (m.bio) lines.push('Bio', ...m.bio.split('\n').map((l) => `  ${l}`));
  for (const f of m.family) {
    lines.push(f.relation);
    for (const p of f.members) lines.push(`  ${p.id} | ${p.name}${p.dates ? ` | ${p.dates}` : ''}`);
  }
  const who = (c) => (c ? `${c.name}${c.contributorId ? ` (${c.contributorId})` : ''}` : '');
  put('Created by', who(m.createdBy));
  put('Maintained', who(m.maintainedBy));
  put('Added', m.added);
  lines.push(`${'Photos'.padEnd(12)}${m.photoCount} (count only — photos are in copyright; cite the memorial, do not save them)`);
  put('Citation', m.citation);
  return lines.join('\n');
}
