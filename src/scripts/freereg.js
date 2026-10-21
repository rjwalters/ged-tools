import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { recordsDir } from '../lib/tools.js';
import {
  SITES,
  USER_AGENT,
  POLITE_DELAY_MS,
  FreeUkError,
  csrfToken,
  resultCount,
  validateRegQuery,
  validateCenQuery,
  regFields,
  cenFields,
  matchPlaces,
  assertCenPlaceYear,
  parseRegResults,
  parseCenResults,
  parseRegRecord,
  parseCenRecord,
  regEventKey,
  digest,
  slugFromUrl,
} from '../lib/free-uk.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function usage() {
  console.log(`freereg — FreeREG parish registers and FreeCEN census, Free UK Genealogy (plain HTTP)

  reg <surname> [--first G] [--type ba|ma|bu|all] [--from YYYY] [--to YYYY]
      [--county NFK] [--place NAME] [--nearby] [--fuzzy] [--details] [--save] [--json]
      parish-register entries. --details fetches every entry's record page (parents,
      abode, witnesses) and collapses the "View 1 / View 2" transcripts of one event
  cen <surname> --year 1841..1891 [--first G] [--from YYYY] [--to YYYY]
      [--county NFK] [--place NAME] [--fuzzy] [--details] [--save] [--json]
      census index; --from/--to bound the BIRTH year; --details prints each
      person's whole household (piece, folio, schedule, birthplaces)
  record <url> [--save] [--json]
      one /search_records/ page from either site
  control
      a neutral known-positive query (SMITH baptisms, Norfolk, 1800) — run it
      before believing a zero from this instrument

--place matches the site's own place list for the county (exact name, e.g.
"Great Ryburgh"). --save writes a text digest of each record page fetched to
<records>/sources/raw/freereg/ or .../freecen/ (never overwriting one that exists).

EXIT CODES: 0 answered with rows · 1 bad arguments · 2 request failed or the
            site changed shape · 4 answered, zero rows (a real negative only
            if \`control\` passes)`);
}

/** One cookie jar per search: the result redirect 404s without the POST's session. */
export function session(origin, fetchImpl = fetch, delayMs = POLITE_DELAY_MS) {
  const jar = new Map();
  let first = true;
  return async function request(path, fields) {
    if (!first) await sleep(delayMs);
    first = false;
    const headers = { 'User-Agent': USER_AGENT };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (fields) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(fields).toString();
    }
    let url = path.startsWith('http') ? path : origin + path;
    for (let hop = 0; hop < 5; hop++) {
      let res;
      try {
        res = await fetchImpl(url, { method: body ? 'POST' : 'GET', headers, body, redirect: 'manual' });
      } catch (err) {
        throw new FreeUkError(`request failed: ${url}: ${err.message}`);
      }
      const setCookies = res.headers.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
      for (const c of setCookies) {
        const m = c.match(/^\s*([^=;]+)=([^;]*)/);
        if (m) jar.set(m[1], m[2]);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), url).href;
        body = undefined;
        delete headers['Content-Type'];
        headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
        continue;
      }
      const html = await res.text();
      if (res.status !== 200) throw new FreeUkError(`HTTP ${res.status} from ${url}`);
      return { url, html };
    }
    throw new FreeUkError(`too many redirects from ${path}`);
  };
}

async function resolvePlace(request, site, county, place, year) {
  if (!place) return [];
  const path = site === 'reg'
    ? `/places/for_search_form.json?search_query[chapman_codes][]=${encodeURIComponent(county)}`
    : `/freecen2_places/for_search_form.json?search_query[chapman_codes][]=${encodeURIComponent(county)}`;
  const { html } = await request(path);
  let json;
  try {
    json = JSON.parse(html);
  } catch {
    throw new FreeUkError(`the ${SITES[site].name} place list was not JSON`);
  }
  const places = matchPlaces(json, place);
  if (!places.length) throw new FreeUkError(`no ${SITES[site].name} place named "${place}" in ${county}`, 1);
  if (site === 'cen') assertCenPlaceYear(places, year, place);
  return places.map((p) => p.id);
}

export async function search(site, query, { fetchImpl = fetch, delayMs = POLITE_DELAY_MS } = {}) {
  const q = site === 'reg' ? validateRegQuery({ type: 'all', ...query }) : validateCenQuery(query);
  const { origin } = SITES[site];
  const request = session(origin, fetchImpl, delayMs);
  const placeIdList = await resolvePlace(request, site, q.county ?? 'NFK', q.place, q.year);
  const form = await request('/search_queries/new');
  const fields = (site === 'reg' ? regFields : cenFields)(csrfToken(form.html), { ...q, placeIds: placeIdList });
  const { url, html } = await request('/search_queries', fields);
  const count = resultCount(html);
  if (!count) throw new FreeUkError(`the search answered a page with no result count (${url})`);
  const rows = site === 'reg' ? parseRegResults(html) : parseCenResults(html);
  if (count.count > 0 && !rows.length) throw new FreeUkError(`the page reports ${count.count} result(s) but no rows parsed (${url})`);
  return { site, query: q, url, ...count, rows, request };
}

export async function fetchRecord(site, path, { request, fetchImpl = fetch } = {}) {
  const req = request ?? session(SITES[site].origin, fetchImpl);
  const { url, html } = await req(path);
  return site === 'reg'
    ? { site, url, fields: parseRegRecord(html) }
    : { site, url, ...parseCenRecord(html) };
}

export const recordLines = (rec) =>
  rec.site === 'reg'
    ? rec.fields.map(([k, v]) => `${k} | ${v}`)
    : [
      Object.entries(rec.dwelling).map(([k, v]) => `${k}: ${v}`).join(' | '),
      ...rec.household.map((p) => `${p.found ? '* ' : '  '}${[p.Surname, p.Forenames, p.Relationship, p['Marital Status'], p.Sex, p.Age, p.Occupation, p['Birth County'], p['Birth Place'], p.Notes].join(' | ')}`),
    ];

function save(rec) {
  const dir = join(recordsDir, 'sources', 'raw', rec.site === 'reg' ? 'freereg' : 'freecen');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${rec.site === 'reg' ? 'freereg' : 'freecen'}-${slugFromUrl(rec.url)}.txt`);
  if (existsSync(file)) return `kept ${file}`;
  writeFileSync(file, digest({ url: rec.url, fetched: new Date().toISOString(), lines: recordLines(rec) }));
  return `saved ${file}`;
}

function flag(args, name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}

function printRow(site, r) {
  if (site === 'reg') console.log(`  ${r.date} | ${r.type} | ${r.persons} | ${r.place}\n      ${SITES.reg.origin}${r.url}`);
  else console.log(`  ${r.census} | ${r.name} | b. ${r.born} ${r.birthPlace}, ${r.birthCounty} | ${r.district}\n      ${SITES.cen.origin}${r.url}`);
}

export async function main(args = process.argv.slice(2)) {
  const [verb, arg] = args;
  const json = args.includes('--json');
  try {
    if (verb === 'reg' || verb === 'cen') {
      if (!arg || arg.startsWith('--')) { usage(); return 1; }
      const query = {
        last: arg, first: flag(args, '--first', ''), type: flag(args, '--type', 'all'), year: flag(args, '--year'),
        from: flag(args, '--from'), to: flag(args, '--to'), county: flag(args, '--county', 'NFK'),
        place: flag(args, '--place'), nearby: args.includes('--nearby'), fuzzy: args.includes('--fuzzy'),
      };
      const res = await search(verb, query);
      const details = [];
      if (args.includes('--details')) {
        const seen = new Set();
        for (const r of res.rows) {
          const rec = await fetchRecord(verb, r.url, { request: res.request });
          if (verb === 'reg') {
            const key = regEventKey(rec.fields);
            if (seen.has(key)) continue;
            seen.add(key);
          }
          if (args.includes('--save')) rec.saved = save(rec);
          details.push(rec);
        }
      }
      if (json) {
        console.log(JSON.stringify({ url: res.url, count: res.count, exact: res.exact, uncertain: res.uncertain, capped: res.capped, rows: res.rows, details }, null, 2));
      } else {
        console.log(`${SITES[verb].name}: ${res.capped ? 'MORE THAN ' : ''}${res.count} result(s)${res.uncertain ? ` (${res.exact} exact, ${res.uncertain} uncertain)` : ''} — ${res.url}`);
        if (res.capped) console.log('  the list is capped: narrow the query (years, --first, --place) before trusting it as complete');
        if (details.length) {
          for (const rec of details) {
            console.log(`\n${rec.url}${rec.saved ? `  (${rec.saved})` : ''}`);
            for (const l of recordLines(rec)) console.log(`  ${l}`);
          }
        } else {
          for (const r of res.rows) printRow(verb, r);
        }
      }
      return res.count ? 0 : 4;
    }
    if (verb === 'record') {
      if (!arg) { usage(); return 1; }
      const site = arg.includes('freecen') ? 'cen' : 'reg';
      const rec = await fetchRecord(site, arg);
      if (args.includes('--save')) rec.saved = save(rec);
      if (json) console.log(JSON.stringify(rec, null, 2));
      else {
        console.log(`${rec.url}${rec.saved ? `  (${rec.saved})` : ''}`);
        for (const l of recordLines(rec)) console.log(`  ${l}`);
      }
      return 0;
    }
    if (verb === 'control') {
      const res = await search('reg', { last: 'Smith', type: 'ba', from: '1800', to: '1800', county: 'NFK' });
      const ok = res.count > 0 && res.rows.length > 0;
      console.log(ok ? `control OK — ${res.count} row(s)` : 'control FAILED — a common surname answered zero rows; do not trust a negative');
      return ok ? 0 : 2;
    }
    usage();
    return 1;
  } catch (err) {
    if (err instanceof FreeUkError) {
      console.error(err.message);
      return err.code;
    }
    throw err;
  }
}
