import { recordsDir } from '../lib/tools.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { openTab, closeTab, connect, evaluate, requireBrowserLock, CDP_ORIGIN } from './cdp-transport.js';
import { RECORD_KINDS, parsePageSpec } from './prdh-couples.js';
import {
  aborts,
  classify,
  exitCodeFor,
  relPathFor,
  rendered,
  summarize,
  terminal,
} from '../lib/prdh-classify.js';
import { root } from '../lib/tools.js';

const outDir = join(recordsDir, 'sources', 'raw', 'prdh');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const describe = (err) => (err?.cause?.message ? `${err.message} (${err.cause.message})` : (err?.message ?? String(err)));

const PRDH_HOST = 'www.prdh-igd.com';

const PRDH_ORIGIN = `https://${PRDH_HOST}`;

const MEMBER_AREA = 'Membership';

const FAMILLE_LIST_PATH = 'Liste/Famille';

export const FAMILLE_LIST_PARAMS = ['nh', 'ph', 'nf', 'pf', 'pg'];

export function familleListUrl({ nh = '', ph = '', nf = '', pf = '', pg = 1 } = {}) {
  const raw = { nh, ph, nf, pf, pg };
  const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
  if (!clean(nh) && !clean(nf)) {
    throw new Error('a famille-list query needs at least a husband surname (--nh) or a wife surname (--nf)');
  }
  const params = new URLSearchParams();
  for (const k of FAMILLE_LIST_PARAMS) params.set(k, clean(raw[k]));
  return `${PRDH_ORIGIN}/${MEMBER_AREA}/en/PRDH/${FAMILLE_LIST_PATH}?${params}`;
}

const FREE_SURFACE_PATH = new RegExp(`^\\/${MEMBER_AREA}\\/en\\/PRDH\\/${FAMILLE_LIST_PATH.replace('/', '\\/')}$`);

export function assertFreeSurface(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`refusing to navigate: not a URL (${String(url).slice(0, 120)})`);
  }
  if (u.protocol !== 'https:' || u.hostname !== PRDH_HOST) {
    throw new Error(`refusing to navigate to ${u.protocol}//${u.hostname} — this script only ever fetches ${PRDH_ORIGIN}`);
  }
  if (!FREE_SURFACE_PATH.test(u.pathname)) {
    throw new Error(
      `refusing to fetch ${u.pathname} — scripts/prdh-familles.js drives PRDH's member Liste/Famille list only ` +
        '(the couple list is scripts/prdh-couples.js’s job). Opening a record file spends a hit; ' +
        'that is scripts/prdh-record.js’s job.'
    );
  }
  return url;
}

const CELL_ORDER = ['date', 'parish', 'husbandSurname', 'husbandGiven', 'wifeSurname', 'wifeGiven'];

const UNION_ID_HREF_SEGMENTS = ['famille', 'union'];

const decodeEntities = (s) =>
  s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');

const cellText = (fragment) => decodeEntities(fragment.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const row = (unionId, cells) => {
  const c = Object.fromEntries(CELL_ORDER.map((k, i) => [k, cells[i] ?? '']));
  return {
    unionId: unionId ?? null,
    date: c.date,
    parish: c.parish,
    husbandSurname: c.husbandSurname,
    husbandGiven: c.husbandGiven,
    wifeSurname: c.wifeSurname,
    wifeGiven: c.wifeGiven,
  };
};

export function unionIdFromRowHtml(rowHtml) {
  const src = String(rowHtml ?? '');
  const th = src.match(/<th\b[^>]*>\s*(\d+)\s*<\/th>/i);
  if (th) return th[1];
  const anchor = src.match(/<a\b[^>]*class="date"[^>]*>/i);
  const href = (anchor ? anchor[0] : src).match(new RegExp(`href="[^"]*?\\/(?:${UNION_ID_HREF_SEGMENTS.join('|')})\\/(\\d+)"`, 'i'));
  return href ? href[1] : null;
}

export function parseFamilleRowsFromHtml(html) {
  const src = String(html ?? '');
  const rows = [];
  for (const m of src.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    const tr = m[0];

    if (!/class="date"/i.test(tr)) continue;
    const cells = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cellText(c[1]));
    if (cells.length < CELL_ORDER.length) continue;
    rows.push(row(unionIdFromRowHtml(tr), cells));
  }
  return rows;
}

export function parseFamilleRowsFromText(text) {
  const lines = String(text ?? '').split(/\r\n|\r|\n/);
  const head = lines.findIndex((l) => /^(?:idUnion\t)?date\t/.test(l));
  if (head === -1) return [];
  const withId = lines[head].startsWith('idUnion');
  const width = CELL_ORDER.length + (withId ? 1 : 0);
  const rows = [];
  for (const line of lines.slice(head + 1)) {
    const fields = line.split('\t').map((f) => f.trim());
    if (fields.length < width) break;
    rows.push(row(withId ? fields[0] : null, fields.slice(withId ? 1 : 0, width)));
  }
  return rows;
}

export function parseFamilleRows({ html = '', text = '' } = {}) {
  const fromHtml = parseFamilleRowsFromHtml(html);
  return fromHtml.length ? fromHtml : parseFamilleRowsFromText(text);
}

export const hitsOf = (text) => {
  const m = String(text ?? '').match(/Hits:\s*(\d+)/);
  return m ? Number(m[1]) : null;
};

export function slugFor({ nh = '', ph = '', nf = '', pf = '', pg = 1 } = {}) {
  return ['famillelist', nh, ph, nf, pf, String(pg) === '1' ? '' : `pg${pg}`]
    .filter((p) => p !== '' && p !== undefined && p !== null)
    .join('-')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

async function fetchFamilleList(url, timeoutMs) {
  assertFreeSurface(url);
  let tab;
  try {
    tab = await openTab(CDP_ORIGIN);
    const cdp = await connect(tab.webSocketDebuggerUrl);
    try {
      await cdp.send('Page.enable');
      await cdp.send('Page.navigate', { url });

      const probe = async (expression) => (await evaluate(cdp, expression)) ?? '';
      const getHtml = () => probe('document.documentElement ? document.documentElement.outerHTML : ""');
      const getText = () => probe('document.body ? document.body.innerText : ""');

      const getUrl = () => probe('location.href');

      const deadline = Date.now() + timeoutMs;
      let html = '';
      let text = '';
      let finalUrl = '';
      let verdict = 'OK';
      for (;;) {
        await sleep(Math.min(1500, Math.max(0, deadline - Date.now())));
        html = await getHtml();
        text = await getText();
        finalUrl = await getUrl();
        verdict = classify({ html, text, finalUrl, url });

        if (terminal(verdict) || rendered(text) || Date.now() >= deadline) break;
        console.error('(waiting for the famille list to render)');
      }
      return { html, text, finalUrl, verdict };
    } finally {
      cdp.close();
    }
  } finally {
    await closeTab(tab, CDP_ORIGIN);
  }
}

function save(stem, html, text, verdict) {
  const file = join(outDir, relPathFor(stem, verdict));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  writeFileSync(file.replace(/\.html$/, '.txt'), text);
  return file.replace(`${root}/`, '');
}

const printRows = (rows) => {
  console.log('===ROWS===');
  for (const r of rows) {
    console.log(
      [r.unionId ?? '?', r.date, `${r.husbandSurname} ${r.husbandGiven}`.trim(), `${r.wifeSurname} ${r.wifeGiven}`.trim(), r.parish].join('\t')
    );
  }
  console.log('===END===');
};

const USAGE = [
  'usage: ged-tools prdh-familles --nh SURNAME [--ph GIVEN] [--nf SURNAME] [--pf GIVEN]',
  '                                     [--page N|N-M] [--timeout SECS] [--no-lock-check] [--json]',
  '       ged-tools prdh-familles --self-test',
].join('\n');

const KNOWN_FLAGS = new Set(['--nh', '--ph', '--nf', '--pf', '--page', '--json', '--no-lock-check', '--timeout', '--self-test']);

function parseArgs(argv) {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const unknown = argv.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a));
  if (unknown.length) throw new Error(`unknown flag(s): ${unknown.join(', ')}\n${USAGE}`);
  return {
    nh: flag('--nh') ?? '',
    ph: flag('--ph') ?? '',
    nf: flag('--nf') ?? '',
    pf: flag('--pf') ?? '',
    pages: parsePageSpec(flag('--page') ?? '1'),
    json: argv.includes('--json'),
    noLockCheck: argv.includes('--no-lock-check'),
    timeoutMs: Number(flag('--timeout') ?? 45) * 1000,
  };
}

async function main(argv) {
  let q;
  try {
    q = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  let urls;
  try {
    urls = q.pages.map((pg) => assertFreeSurface(familleListUrl({ ...q, pg })));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(1);
  }

  if (!q.noLockCheck) requireBrowserLock('prdh-familles');
  console.log('surface: MEMBER Liste/Famille (free at 0 hits — only record files cost; anonymous access is walled)');

  const verdicts = [];
  let skipped = 0;
  for (const [i, url] of urls.entries()) {
    const pg = q.pages[i];
    const stem = `${slugFor({ ...q, pg })}-${createHash('sha1').update(url).digest('hex').slice(0, 8)}`;
    console.log(`\n===URL=== ${url}`);
    let page;
    try {
      page = await fetchFamilleList(url, q.timeoutMs);
    } catch (err) {
      console.error(`FAILED ${url}: ${describe(err)}`);
      verdicts.push('FAILED');
      continue;
    }
    const rel = save(stem, page.html, page.text, page.verdict);
    console.log(`VERDICT ${page.verdict}  ${url}  (saved ${rel}, ${page.html.length} bytes)`);
    verdicts.push(page.verdict);
    if (aborts(page.verdict)) {
      console.error('subscribers interstitial / login redirect — aborting the batch rather than quarantining page after page (#79, #444).');
      skipped = urls.length - i - 1;
      break;
    }
    const rows = parseFamilleRows(page);
    console.log(`hits: ${hitsOf(page.text) ?? '?'} | rows: ${rows.length} | idUnions: ${rows.filter((r) => r.unionId).length}`);
    if (q.json) console.log(JSON.stringify(rows, null, 1));
    else printRows(rows);
  }

  console.log(`\n${summarize(verdicts, skipped)}`);
  process.exit(exitCodeFor(verdicts));
}
export { PRDH_ORIGIN, PRDH_HOST, MEMBER_AREA, FAMILLE_LIST_PATH, FREE_SURFACE_PATH, UNION_ID_HREF_SEGMENTS, cellText, decodeEntities, CELL_ORDER, row, main, parseArgs, KNOWN_FLAGS, USAGE, fetchFamilleList, sleep, describe, save, outDir, root, printRows };
