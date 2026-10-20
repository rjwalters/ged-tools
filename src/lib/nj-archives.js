// New Jersey State Archives — "Death Records, June 1878 - December 1900"
// (628,584 entries, data entry complete). Pure core: page parsing only.
//
// The portal (wwwdnet-dos.nj.gov/DOS_ArchivesDBPortal) is ASP.NET WebForms.
// There is no URL per database: index.aspx lists them in GridViews whose
// links are __doPostBack targets, and the search form then posts to
// DeathIndex.aspx with __VIEWSTATE/__EVENTVALIDATION and a session cookie.
// Results come back ten rows at a time in a GridView paged by a
// `Page$N` postback. Measured 2026-10-20:
//   - a bare client gets HTTP 403 on the portal root; a browser User-Agent
//     is accepted;
//   - the master page's site-search <select> must be posted as
//     `+url:www.state.nj.us` or the server answers HTTP 500;
//   - a single-year range (Year1 = Year2) works, and first names match by
//     PREFIX ("Ma" finds Margaret and Mary).
// The database link is found by its row text, never by row position, so a
// reordered portal fails loudly instead of searching the wrong database.

export const ORIGIN = 'https://wwwdnet-dos.nj.gov';
export const BASE = `${ORIGIN}/DOS_ArchivesDBPortal/`;
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export const SITE_SEARCH_VALUE = '+url:www.state.nj.us';
export const DEATHS_1878_1900_LABEL = /Death Records,\s*June 1878\s*-\s*December 1900/i;
export const POLITE_DELAY_MS = 600;
export const COUNTIES = [
  'Atlantic', 'Bergen', 'Burlington', 'Camden', 'Cape May', 'Cumberland', 'Essex', 'Gloucester', 'Hudson',
  'Hunterdon', 'Mercer', 'Middlesex', 'Monmouth', 'Morris', 'Ocean', 'Passaic', 'Salem', 'Somerset',
  'Sussex', 'Union', 'Warren',
];

export class NjArchivesError extends Error {
  constructor(message, { code = 2 } = {}) {
    super(message);
    this.name = 'NjArchivesError';
    this.code = code;
  }
}

const decode = (s) =>
  String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
const text = (html) => decode(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Every hidden input, decoded — the WebForms state that must be posted back. */
export function hiddenFields(html) {
  const out = {};
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/type="hidden"/i.test(tag)) continue;
    const name = tag.match(/name="([^"]+)"/i);
    const value = tag.match(/value="([^"]*)"/i);
    if (name) out[decode(name[1])] = decode(value ? value[1] : '');
  }
  return out;
}

export function formAction(html) {
  const m = html.match(/<form\b[^>]*action="([^"]+)"/i);
  if (!m) throw new NjArchivesError('no <form action> on the page — not a WebForms page');
  return new URL(decode(m[1]), BASE).href;
}

/** The __doPostBack target of the GridView row whose text matches `label`. */
export function databasePostback(indexHtml, label = DEATHS_1878_1900_LABEL) {
  for (const row of indexHtml.split(/<tr\b/i)) {
    if (!label.test(text(row))) continue;
    const m = row.match(/__doPostBack\((?:&#39;|')([^'&]+)(?:&#39;|')/);
    if (m) return decode(m[1]);
  }
  throw new NjArchivesError(`index.aspx has no database row matching ${label} — the portal has changed`);
}

/** The result GridView as rows of cells, header first; null when there is no grid. */
export function parseGrid(html) {
  const tb = html.match(/<table\b[^>]*id="[^"]*GridView[^"]*"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tb) return null;
  const rows = [];
  for (const tr of tb[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => text(c[1]));
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** Data rows only (the grid's own "Select" checkbox column marks them), as objects. */
export function deathRows(grid) {
  if (!grid) return [];
  return grid
    // The header row's first cell also reads "Select"; its second reads "Name".
    .filter((r) => r[0] === 'Select' && r.length >= 8 && r[1] !== 'Name')
    .map(([, name, age, sex, race, location, date, citation]) => ({ name, age, sex, race, location, date, citation }));
}

/** The postback target for page `n` of the grid, or null when there is no such page. */
export function pagePostback(html, n) {
  const re = new RegExp(`__doPostBack\\((?:&#39;|')([^'&]*GridView[^'&]*)(?:&#39;|'),(?:&#39;|')Page\\$${n}(?:&#39;|')\\)`);
  const m = html.match(re);
  return m ? decode(m[1]) : null;
}

export function validateQuery({ surname, given = '', from = '', to = '', county = '' }) {
  if (!surname || !String(surname).trim()) throw new NjArchivesError('a surname is required', { code: 1 });
  for (const [k, v] of [['from', from], ['to', to]]) {
    if (v !== '' && !/^\d{4}$/.test(String(v))) throw new NjArchivesError(`--${k} must be a 4-digit year`, { code: 1 });
  }
  if (county && !COUNTIES.includes(county)) throw new NjArchivesError(`unknown county ${JSON.stringify(county)}; one of ${COUNTIES.join(', ')}`, { code: 1 });
  return { surname: String(surname).trim(), given: String(given).trim(), from: String(from), to: String(to), county };
}

/** The search-form fields DeathIndex.aspx expects, on top of the page's hidden state. */
export function searchFields(hidden, q) {
  const P = 'ctl00$ContentPlaceHolder1$';
  return {
    ...hidden,
    'ctl00$ddlSearchSite': SITE_SEARCH_VALUE,
    'ctl00$tbSearchTerms': '',
    [`${P}txtLN`]: q.surname,
    [`${P}txtFN`]: q.given,
    [`${P}ddlGender`]: '',
    [`${P}ddlRace`]: '',
    [`${P}Year1`]: q.from,
    [`${P}Year2`]: q.to,
    [`${P}ddlCountyList`]: q.county,
    [`${P}Search`]: 'Search',
  };
}
