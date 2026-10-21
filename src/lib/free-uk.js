// FreeREG (parish registers) and FreeCEN (1841–1891 census) — the two Rails
// search sites of Free UK Genealogy, sister to FreeBMD. Pure core: form
// building and page parsing only; no network.
//
// Measured 2026-08-20 and 2026-10-21:
//   - both are free, unmetered and need no login or browser; a descriptive
//     User-Agent and ~1 s between requests;
//   - a search is GET /search_queries/new (CSRF token + session cookie), then
//     POST /search_queries, which 302s to /search_queries/<24-hex>. The
//     redirect target 404s ("Missing Page") unless the SAME session cookie is
//     sent, so the client keeps one cookie jar per search;
//   - the result list gives names, dates and places; parents (FreeREG) and the
//     household (FreeCEN) are on each /search_records/<id>/<slug> page, which
//     needs no session;
//   - many registers are loaded twice (Parish Register + another transcript),
//     so expect "View 1 / View 2" pairs of one entry;
//   - a list beyond the cap says "We found more than 500 Results" — narrow the
//     query rather than trusting such a list as complete.

export const SITES = {
  reg: { origin: 'https://www.freereg.org.uk', name: 'FreeREG' },
  cen: { origin: 'https://www.freecen.org.uk', name: 'FreeCEN' },
};
export const USER_AGENT = 'ged-tools (genealogy research; https://github.com/rjwalters/ged-tools)';
export const POLITE_DELAY_MS = 1000;
export const REG_TYPES = { ba: 'ba', baptism: 'ba', ma: 'ma', marriage: 'ma', bu: 'bu', burial: 'bu', all: '' };
export const CEN_YEARS = ['1841', '1851', '1861', '1871', '1881', '1891'];

export class FreeUkError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decode = (s) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Cell text: tags dropped, <br> kept as " / ", whitespace collapsed. */
export const cellText = (html) =>
  decode(html.replace(/<(script|style|small)\b[\s\S]*?<\/\1>/gi, '').replace(/<span[^>]*tooltip[\s\S]*?<\/span>/gi, '')
    .replace(/<br\s*\/?>/gi, ' / ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').replace(/(\s*\/\s*)+$/, '').replace(/^(\s*\/\s*)+/, '').trim();

/** Every <table> as { headers, rows }, where each row is { cells, links, id }. */
export function tables(html) {
  return [...html.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map(([t]) => {
    const headers = [...t.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => cellText(m[1]));
    const body = t.match(/<tbody\b[\s\S]*?<\/tbody>/i)?.[0] ?? t;
    const rows = [...body.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi)]
      .map(([, attrs, tr]) => ({
        id: attrs.match(/\bid="([^"]+)"/)?.[1] ?? null,
        cells: [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => cellText(m[1])),
        links: [...tr.matchAll(/href="([^"]+)"/gi)].map((m) => decode(m[1])),
      }))
      .filter((r) => r.cells.length);
    return { headers, rows };
  });
}

export const csrfToken = (html) => {
  const m = html.match(/name="authenticity_token"[^>]*value="([^"]+)"/) ?? html.match(/<meta name="csrf-token" content="([^"]+)"/);
  if (!m) throw new FreeUkError('no authenticity_token on the search form — the site changed shape');
  return decode(m[1]);
};

/**
 * "We found 25 Results" → { count: 25, exact: 25, uncertain: 0, capped: false };
 * "We found 2 Exact Results and 1 Uncertain Result" → count 3 (FreeREG lists
 * the uncertain ones too); "We found more than 500 Results" → capped.
 */
export function resultCount(html) {
  // The uncertain count sits in a sibling element, so read past the first tag.
  const text = cellText(html.match(/We found[\s\S]{0,400}/)?.[0] ?? '');
  const m = text.match(/We found\s+(more than\s+)?(\d+)\s+(Exact\s+)?Results?/i);
  if (!m) return null;
  const exact = Number(m[2]);
  const uncertain = Number(text.match(/and\W+(\d+)\s+Uncertain/i)?.[1] ?? 0);
  return { count: exact + uncertain, exact, uncertain, capped: Boolean(m[1]) };
}

export function validateRegQuery(q) {
  if (!q.last) throw new FreeUkError('a surname is required', 1);
  if (!(q.type in REG_TYPES)) throw new FreeUkError(`--type must be one of ${Object.keys(REG_TYPES).join(', ')}`, 1);
  for (const k of ['from', 'to']) if (q[k] && !/^\d{4}$/.test(q[k])) throw new FreeUkError(`--${k} must be a 4-digit year`, 1);
  return q;
}

export function validateCenQuery(q) {
  if (!q.last) throw new FreeUkError('a surname is required', 1);
  if (!CEN_YEARS.includes(String(q.year))) throw new FreeUkError(`--year must be one of ${CEN_YEARS.join(', ')}`, 1);
  for (const k of ['from', 'to']) if (q[k] && !/^\d{4}$/.test(q[k])) throw new FreeUkError(`--${k} (birth year) must be a 4-digit year`, 1);
  return q;
}

/** Form fields for POST /search_queries, as [name, value] pairs (repeated keys allowed). */
export function regFields(token, q) {
  const f = [
    ['utf8', '✓'], ['authenticity_token', token], ['commit', 'Search'],
    ['search_query[first_name]', q.first ?? ''], ['search_query[last_name]', q.last],
    ['search_query[record_type]', REG_TYPES[q.type ?? 'all']],
    ['search_query[start_year]', q.from ?? ''], ['search_query[end_year]', q.to ?? ''],
    ['search_query[chapman_codes][]', q.county ?? 'NFK'],
  ];
  for (const id of q.placeIds ?? []) f.push(['search_query[place_ids][]', id]);
  if (q.nearby) f.push(['search_query[search_nearby_places]', 'true']);
  if (q.fuzzy) f.push(['search_query[fuzzy]', 'true']);
  return f;
}

export function cenFields(token, q) {
  const f = [
    ['utf8', '✓'], ['authenticity_token', token], ['commit', 'Search'],
    ['search_query[first_name]', q.first ?? ''], ['search_query[last_name]', q.last],
    ['search_query[record_type]', String(q.year)],
    ['search_query[chapman_codes][]', q.county ?? 'NFK'],
  ];
  if (q.from) f.push(['search_query[start_year]', q.from]);
  if (q.to) f.push(['search_query[end_year]', q.to]);
  for (const id of q.placeIds ?? []) f.push(['search_query[freecen2_place_ids][]', id]);
  if (q.fuzzy) f.push(['search_query[fuzzy]', 'true']);
  return f;
}

/** Places JSON ({ id: "Name (County)" or "Name ( 1851)" }) → [{ id, label, years }] whose name is `name`. */
export function matchPlaces(json, name) {
  const want = name.trim().toLowerCase();
  return Object.entries(json)
    .filter(([, label]) => String(label).toLowerCase().replace(/\s*\(.*$/, '').trim() === want)
    .map(([id, label]) => ({ id, label, years: String(label).match(/\b1[89]\d1\b/g) ?? [] }));
}

export const placeIds = (json, name) => matchPlaces(json, name).map((p) => p.id);

/**
 * FreeCEN labels each place with the census years it holds under that place
 * ("Letheringsett ( 1841)"). Measured 2026-10-21: a place-filtered 1871 search
 * for a household that IS on the site (Letheringsett 1871, filed under Holt
 * district) answers zero. A place whose label lacks the year is refused, not
 * searched — the empty answer would read as a negative.
 */
export function assertCenPlaceYear(places, year, name) {
  const labelled = places.filter((p) => p.years.length);
  if (labelled.length && !labelled.some((p) => p.years.includes(String(year)))) {
    const years = [...new Set(labelled.flatMap((p) => p.years))].join(', ');
    throw new FreeUkError(`FreeCEN lists "${name}" for ${years} only; a --place search for ${year} would answer zero whether or not the person is there. Search without --place and read the district column.`, 1);
  }
}

const resultTable = (html, header) => tables(html).find((t) => t.headers.some((h) => h === header));

/** FreeREG result list → [{ url, persons, type, date, county, place }]. */
export function parseRegResults(html) {
  const t = resultTable(html, 'Person or persons');
  if (!t) return [];
  return t.rows.map(({ cells, links }) => ({
    url: links.find((l) => l.startsWith('/search_records/')) ?? null,
    persons: cells[1], type: cells[2], date: cells[3], county: cells[4], place: cells[5],
  })).filter((r) => r.url);
}

/** FreeCEN result list → [{ url, name, birthCounty, birthPlace, born, census, county, district }]. */
export function parseCenResults(html) {
  const t = resultTable(html, 'Individual');
  if (!t) return [];
  return t.rows.map(({ cells, links }) => ({
    url: links.find((l) => l.startsWith('/search_records/')) ?? null,
    name: cells[1], birthCounty: cells[2], birthPlace: cells[3], born: cells[4], census: cells[5], county: cells[6], district: cells[7],
  })).filter((r) => r.url);
}

/** FreeREG record page → ordered [[field, value]] from its Field/Value table. */
export function parseRegRecord(html) {
  const t = tables(html).find((x) => x.headers[0]?.startsWith('Field'));
  if (!t) throw new FreeUkError('no Field/Value table on the record page — the site changed shape');
  return t.rows.filter((r) => r.cells.length >= 2).map((r) => [r.cells[0].replace(/\s*\(Links to more information\)/, ''), r.cells[1]]);
}

/** FreeCEN record page → { dwelling: {header: value}, household: [{header: value}] }. */
export function parseCenRecord(html) {
  const all = tables(html);
  const dw = all.find((t) => t.headers.includes('Piece'));
  const hh = all.find((t) => t.headers.some((h) => /^Surname/i.test(h)) || t.headers.includes('Relationship'));
  if (!dw || !hh) throw new FreeUkError('no dwelling/household tables on the record page — the site changed shape');
  const zip = (headers, cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
  const FOUND = /^the person found in your search\s*/i;
  return {
    dwelling: zip(dw.headers, dw.rows[0]?.cells ?? []),
    // The searched-for person's row carries a screen-reader label in its first cell.
    household: hh.rows.map((r) => ({
      ...zip(hh.headers, [r.cells[0].replace(FOUND, ''), ...r.cells.slice(1)]),
      found: FOUND.test(r.cells[0]),
    })),
  };
}

/** A FreeREG entry's identity, so "View 1 / View 2" transcripts of one event collapse. */
export const regEventKey = (fields) => {
  const get = (k) => fields.find(([f]) => f === k)?.[1] ?? '';
  const date = get('Baptism date') || get('Marriage date') || get('Burial date');
  const who = get('Person forename') || get('Groom forename') || get('Burial person forename');
  return `${get('Place')}|${date.replace(/^0/, '')}|${who}`.toLowerCase();
};

/** A text digest in the house format: URL, FETCHED, KIND, then the fields. */
export function digest({ url, fetched, lines }) {
  return `URL: ${url}\nFETCHED: ${fetched}\nKIND: record\n\n${lines.join('\n')}\n`;
}

/** Filename slug from a record URL's own slug. */
export const slugFromUrl = (url) => (url.split('/').filter(Boolean).pop() || 'record').replace(/[^a-z0-9-]+/gi, '-').replace(/-+$/, '').toLowerCase();
