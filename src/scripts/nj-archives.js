import {
  BASE,
  USER_AGENT,
  SITE_SEARCH_VALUE,
  POLITE_DELAY_MS,
  NjArchivesError,
  hiddenFields,
  formAction,
  databasePostback,
  parseGrid,
  deathRows,
  pagePostback,
  validateQuery,
  searchFields,
} from '../lib/nj-archives.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function usage() {
  console.log(`nj-archives — New Jersey State Archives death index, June 1878 – December 1900 (plain HTTP)

  deaths <surname> [--given G] [--from YYYY] [--to YYYY] [--county C] [--max-pages N=20] [--json]
      every matching row, all pages. --given matches by PREFIX ("Ma" finds Mary and
      Margaret); --from/--to may be equal for a single year
  control
      a neutral known-positive query (SMITH, Passaic, 1896) — run it before
      believing a zero from this instrument

Each row prints name | age | sex | location | date | citation. The citation
(e.g. "1889-90. 83 - W52") is what the State Archives order form asks for.

EXIT CODES: 0 answered with rows · 1 bad arguments · 2 request failed or the
            portal changed shape · 4 answered, zero rows (a real negative only
            if \`control\` passes)`);
}

/** A tiny cookie jar — the WebForms session lives in a cookie. */
function session(fetchImpl) {
  const jar = new Map();
  return async function request(url, form) {
    const headers = { 'User-Agent': USER_AGENT };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }
    let res;
    try {
      res = await fetchImpl(url, { method: form ? 'POST' : 'GET', headers, body, redirect: 'follow' });
    } catch (err) {
      throw new NjArchivesError(`request failed: ${url}: ${err.message}`);
    }
    const setCookies = res.headers.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
    for (const c of setCookies) {
      const m = c.match(/^\s*([^=;]+)=([^;]*)/);
      if (m) jar.set(m[1], m[2]);
    }
    const html = await res.text();
    if (res.status !== 200) throw new NjArchivesError(`HTTP ${res.status} from ${url}`);
    return html;
  };
}

export async function searchDeaths(query, { fetchImpl = fetch, maxPages = 20, delayMs = POLITE_DELAY_MS } = {}) {
  const q = validateQuery(query);
  const request = session(fetchImpl);
  const index = await request(`${BASE}index.aspx`);
  const open = { ...hiddenFields(index), __EVENTTARGET: databasePostback(index), __EVENTARGUMENT: '', 'ctl00$ddlSearchSite': SITE_SEARCH_VALUE, 'ctl00$tbSearchTerms': '' };
  const formPage = await request(formAction(index), open);
  if (!/txtLN/.test(formPage)) throw new NjArchivesError('the database postback did not land on the death search form');
  let page = await request(formAction(formPage), searchFields(hiddenFields(formPage), q));
  const grid = parseGrid(page);
  if (grid === null && !/no records|0 records/i.test(page)) {
    // Neither a grid nor a stated empty result: refuse rather than report zero.
    if (!/txtLN/.test(page)) throw new NjArchivesError('the search answered a page with no result grid and no search form');
  }
  const rows = deathRows(grid);
  let pages = 1;
  while (pages < maxPages) {
    const target = pagePostback(page, pages + 1);
    if (!target) break;
    await sleep(delayMs);
    // A paging postback carries the search fields but NOT the Search button.
    const form = { ...searchFields(hiddenFields(page), q), __EVENTTARGET: target, __EVENTARGUMENT: `Page$${pages + 1}` };
    delete form['ctl00$ContentPlaceHolder1$Search'];
    page = await request(formAction(page), form);
    pages += 1;
    rows.push(...deathRows(parseGrid(page)));
  }
  const truncated = Boolean(pagePostback(page, pages + 1));
  return { query: q, rows, pages, truncated };
}

function flag(args, name, fallback = '') {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

function print(result, json) {
  if (json) return console.log(JSON.stringify(result, null, 2));
  console.log(`${result.rows.length} row(s), ${result.pages} page(s)${result.truncated ? ' — TRUNCATED at --max-pages' : ''}`);
  for (const r of result.rows) console.log([r.name, r.age, r.sex, r.location, r.date, r.citation].join(' | '));
}

export async function main(args = process.argv.slice(2)) {
  const [verb, surname] = args;
  const json = args.includes('--json');
  try {
    if (verb === 'deaths') {
      if (!surname) { usage(); return 1; }
      const result = await searchDeaths(
        { surname, given: flag(args, '--given'), from: flag(args, '--from'), to: flag(args, '--to'), county: flag(args, '--county') },
        { maxPages: Number(flag(args, '--max-pages', 20)) },
      );
      print(result, json);
      return result.rows.length ? 0 : 4;
    }
    if (verb === 'control') {
      const result = await searchDeaths({ surname: 'Smith', from: '1896', to: '1896', county: 'Passaic' }, { maxPages: 1 });
      const ok = result.rows.length > 0;
      console.log(ok ? `control OK — ${result.rows.length} row(s) on page 1` : 'control FAILED — a common surname answered zero rows; do not trust a negative');
      return ok ? 0 : 2;
    }
    usage();
    return 1;
  } catch (err) {
    if (err instanceof NjArchivesError) {
      console.error(err.message);
      return err.code;
    }
    throw err;
  }
}
