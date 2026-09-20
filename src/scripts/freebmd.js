import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SEARCH_URL,
  USER_AGENT,
  POLITE_DELAY_MS,
  TYPES,
  QUARTERS,
  DETAIL_LABELS,
  FreeBMDError,
  extractHiddenFields,
  extractTokens,
  buildSearchFields,
  assertNoEmptyValues,
  encodeMultipart,
  classifyPage,
  parseSearchData,
  parseResultsTable,
  parseSearchPage,
  CONTROL_QUERY,
  CONTROL_EXPECT,
  verifyControl,
} from '../lib/freebmd.js';
const HERE = dirname(fileURLToPath(import.meta.url));

import { root as ROOT } from '../lib/tools.js';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, init, fetchImpl) {
  const res = await fetchImpl(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (res.status !== 200) {
    throw new FreeBMDError(`HTTP ${res.status} from ${url}\n${text.slice(0, 300)}`);
  }
  return text;
}

export async function postSearch(query, { fetchImpl, sleep }) {
  const form = await fetchText(SEARCH_URL, { method: 'GET' }, fetchImpl);
  const tokens = extractTokens(form);
  await sleep(POLITE_DELAY_MS);
  const { contentType, body } = encodeMultipart(buildSearchFields(query, tokens));
  return fetchText(SEARCH_URL, { method: 'POST', headers: { 'Content-Type': contentType }, body }, fetchImpl);
}

export async function runSearch(query, { fetchImpl = globalThis.fetch, sleep = defaultSleep, saveHtml, controlQuery = CONTROL_QUERY, controlExpected = CONTROL_EXPECT } = {}) {
  const t = { fetchImpl, sleep };
  const html = await postSearch(query, t);
  saveHtml?.('search', html);
  const parsed = parseSearchPage(html);
  if (parsed.status === 'error') return { outcome: 'error', parsed };
  if (parsed.rows.length > 0) return { outcome: 'hits', parsed };

  if (!controlQuery || !Array.isArray(controlExpected) || !controlExpected.length) {
    throw new FreeBMDError('A known-positive control is required before reporting a negative');
  }
  await sleep(POLITE_DELAY_MS);
  const controlHtml = await postSearch(controlQuery, t);
  saveHtml?.('control', controlHtml);
  const controlParsed = parseSearchPage(controlHtml);
  const control =
    controlParsed.status === 'results'
      ? verifyControl(controlParsed.rows, controlExpected)
      : { passed: false, missing: controlExpected.slice() };
  return {
    outcome: control.passed ? 'genuine-negative' : 'refused-negative',
    parsed,
    control,
    controlParsed,
  };
}

export function quarterLabel(row, queryType) {
  const observed = row?.type ?? null;
  const period = `${row?.quarter ?? '?'}${row?.year ?? '?'}`;
  if (!queryType) return `${observed ?? '?'} ${period}`;
  if (observed && observed !== queryType) return `${queryType} (page says ${observed}) ${period}`;
  return `${queryType} ${period}`;
}

export function renderRows(rows, type) {
  const lines = [`  Surname | First name(s) | ${DETAIL_LABELS[type] ?? 'detail'} | District | Vol | Page`];
  let last = null;
  for (const r of rows) {
    const q = quarterLabel(r, type);
    if (q !== last) {
      lines.push(`  -- ${q}`);
      last = q;
    }
    lines.push(`  ${r.surname} | ${r.given} | ${r.detail} | ${r.district} | ${r.volume} | ${r.page}`);
  }
  return lines.join('\n');
}

export function describeQuery(q) {
  const bits = [q.type, q.surname];
  if (q.given) bits.push(`given=${q.given}`);
  if (q.sSurname) bits.push(`s_surname=${q.sSurname}`);
  bits.push(`${QUARTERS[q.startQuarter ?? 1]}${q.startYear}-${QUARTERS[q.endQuarter ?? 4]}${q.endYear}`);
  if (q.countyid && q.countyid !== 'all') bits.push(`county=${q.countyid}`);
  if (q.districtid && q.districtid !== 'all') bits.push(`district=${q.districtid}`);
  return bits.join(' ');
}

export function slugFor(q) {
  return ['freebmd', q.type, q.surname, q.given, q.sSurname, `${q.startYear}-${q.endYear}`]
    .filter(Boolean)
    .join('-')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .toLowerCase();
}

export function parseArgs(argv) {
  const opts = { selfTest: false, controlOnly: false, save: null };
  const rest = [];
  const q = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--self-test': opts.selfTest = true; break;
      case '--control': opts.controlOnly = true; break;
      case '--given': q.given = argv[++i]; break;
      case '--spouse': q.spouse = argv[++i]; break;
      case '--mmn': q.mmn = argv[++i]; break;
      case '--start': q.startYear = argv[++i]; break;
      case '--end': q.endYear = argv[++i]; break;
      case '--sq': q.startQuarter = parseInt(argv[++i], 10); break;
      case '--eq': q.endQuarter = parseInt(argv[++i], 10); break;
      case '--county': q.countyid = argv[++i]; break;
      case '--district': q.districtid = argv[++i]; break;
      case '--save': opts.save = argv[++i]; break;
      default:
        if (a.startsWith('--')) throw new FreeBMDError(`unknown option ${a}`);
        rest.push(a);
    }
  }
  if (opts.selfTest || opts.controlOnly) return { opts, query: null };

  const [typeWord, surname] = rest;
  const type = TYPES[String(typeWord ?? '').toLowerCase()];
  if (!type || !surname || !q.startYear) {
    throw new FreeBMDError(
      'usage: ged-tools freebmd <births|marriages|deaths> <SURNAME> --start YYYY ' +
        '[--end YYYY] [--given X] [--spouse X | --mmn X] [--sq 1-4] [--eq 1-4] ' +
        '[--county ID] [--district ID] [--save SLUG] | --control | --self-test',
    );
  }
  if (q.spouse && type !== 'Marriages') throw new FreeBMDError('--spouse only makes sense for marriages');
  if (q.mmn && type !== 'Births') throw new FreeBMDError('--mmn only makes sense for births');
  if (q.mmn && Number(q.startYear) < 1911) {
    console.error(
      'note: the printed index FreeBMD transcribes only carries the mother\'s maiden surname from ' +
        'Sep 1911 — pre-1911 rows will not match an --mmn filter. Use scripts/gro-search.js for those.',
    );
  }
  const query = {
    type,
    surname,
    given: q.given,
    sSurname: q.spouse ?? q.mmn,
    startYear: q.startYear,
    endYear: q.endYear ?? q.startYear,
    ...(q.startQuarter ? { startQuarter: q.startQuarter } : {}),
    ...(q.endQuarter ? { endQuarter: q.endQuarter } : {}),
    ...(q.countyid !== undefined ? { countyid: q.countyid } : {}),
    ...(q.districtid !== undefined ? { districtid: q.districtid } : {}),
  };
  return { opts, query };
}

async function rawHtmlDir() {
  const { loadConfig } = await import('../lib/config.js');
  return join(loadConfig(ROOT).recordsDir, 'sources', 'raw', 'html');
}

async function main(argv = process.argv.slice(2)) {
  let opts, query;
  try {
    ({ opts, query } = parseArgs(argv));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (opts.selfTest) return selfTest();
  if (!CONTROL_QUERY || !CONTROL_EXPECT.length) throw new Error('Configure freebmd.query and freebmd.expected in GENEALOGY_CONTROLS_PATH before searching');

  const target = opts.controlOnly ? CONTROL_QUERY : query;
  const slug = opts.save ?? slugFor(target);
  const outDir = await rawHtmlDir();
  mkdirSync(outDir, { recursive: true });
  const saved = [];
  const saveHtml = (stage, html) => {
    const name = stage === 'control' && !opts.controlOnly ? `control-${slug}.html` : `${slug}.html`;
    writeFileSync(join(outDir, name), html);
    saved.push(name);
  };

  console.log(`FreeBMD — ${describeQuery(target)}`);
  console.log('  free, unmetered, no login; plain HTTP with a descriptive User-Agent;');
  console.log(`  ${POLITE_DELAY_MS / 1000}s pauses between requests. No browser, no mutex, no metered spend.\n`);

  let result;
  try {
    result = opts.controlOnly
      ? await (async () => {
          const html = await postSearch(CONTROL_QUERY, { fetchImpl: globalThis.fetch, sleep: defaultSleep });
          saveHtml('search', html);
          const parsed = parseSearchPage(html);
          if (parsed.status === 'error') return { outcome: 'error', parsed };
          const control = verifyControl(parsed.rows);
          return { outcome: control.passed ? 'hits' : 'refused-negative', parsed, control, controlParsed: parsed };
        })()
      : await runSearch(query, { saveHtml });
  } catch (err) {
    console.error(err.stack || err.message);
    process.exit(2);
  }

  const { outcome, parsed, control, controlParsed } = result;
  switch (outcome) {
    case 'hits':
      console.log(`${parsed.rows.length} row(s) [${parsed.source} format]:\n`);
      console.log(renderRows(parsed.rows, target.type));
      if (opts.controlOnly) console.log('\ncontrol PASSED — all configured expected records present.');
      break;
    case 'genuine-negative':
      console.log('0 rows — and the known-positive control PASSED');
      console.log(`  (control returned ${controlParsed.rows.length} row(s), all expected records present),`);
      console.log('  so this is a GENUINE NEGATIVE of the transcribed index. Remember coverage');
      console.log('  caveats: death coverage thins after ~1960, and pre-Sep-1911 births carry no MMN.');
      break;
    case 'refused-negative':
      console.error('0 rows — but the known-positive control FAILED, so this is a TOOLING ERROR,');
      console.error('not a research finding. NO NEGATIVE MAY BE CLAIMED from this run.');
      console.error(
        `  control expected ${CONTROL_EXPECT.map((e) => `${e.given} (${e.detail}, ${e.district} ${e.volume} ${e.page})`).join(' + ')}`,
      );
      console.error(
        `  control got: ${controlParsed.status === 'results' ? `${controlParsed.rows.length} row(s)` : controlParsed.message}`,
      );
      break;
    case 'error':
      console.error(`FreeBMD returned a failure page (${parsed.reason}):`);
      console.error(`  ${parsed.message}`);
      break;
  }
  if (saved.length) console.log(`\nsaved: ${saved.map((n) => `records/sources/raw/html/${n}`).join(', ')}`);
  console.log('digest the kept results into records/sources/raw/freebmd/ per its README.');
  if (outcome === 'refused-negative' || outcome === 'error') process.exit(2);
}
export { fetchText, defaultSleep, main, rawHtmlDir, ROOT, HERE };

function selfTest() { throw new Error("Run npm test in the ged-tools source checkout; private fixtures are not distributed."); }
