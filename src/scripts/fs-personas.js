import { readFileSync, writeFileSync } from 'node:fs';
import { openTab, closeTab, connect, evaluate, requireBrowserLock, browserLockHint } from './cdp-transport.js';
import { sessionVerdict, verdictExitCode, sessionProbeExpr, SESSION_PROBE_PATH } from './fs-fulltext.js';
export const PERSONAS_PATH = '/service/search/hr/v2/personas';

export const COLLECTIONS_PATH = '/service/search/hr/v2/collections';

export { SESSION_PROBE_PATH };

const SEARCH_PAGE = 'https://www.familysearch.org/search/';

const COLLECTIONS_PAGE = 'https://www.familysearch.org/search/collection/list';

const FS_ORIGIN = 'https://www.familysearch.org';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function personasPath(qs) {
  const q = String(qs ?? '').trim().replace(/^\?+/, '');
  if (!q) throw new Error('empty query string — pass everything that follows the `?`');
  if (!q.includes('=')) throw new Error(`query string has no name=value pair: ${q}`);
  return `${PERSONAS_PATH}?${q}`;
}

export function collectionsPath(count = 2000) {
  const n = Number(count);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--count wants a positive integer, got ${count}`);
  return `${COLLECTIONS_PATH}?count=${n}`;
}

export function nextPath(json, origin = FS_ORIGIN) {
  const href = json?.links?.next?.href;
  if (!href || typeof href !== 'string') return null;
  if (href.startsWith('/')) return href;
  let u;
  try {
    u = new URL(href, origin);
  } catch {
    return null;
  }
  return /(^|\.)familysearch\.org$/i.test(u.hostname) ? `${u.pathname}${u.search}` : href;
}

export function jsonGetExpr(path) {
  return `(async () => {
  const r = await fetch(${JSON.stringify(path)}, { credentials: 'include', headers: { accept: 'application/json' } });
  const t = await r.text();
  return { status: r.status, url: r.url, text: t };
})()`;
}

export function summarizePersona(entry) {
  const c = entry?.content?.gedcomx ?? {};
  const persons = c.persons ?? [];
  const principal = persons.find((p) => p.principal) || persons[0];
  const name = principal?.names?.[0]?.nameForms?.[0]?.fullText ?? '?';
  const facts = (principal?.facts ?? [])
    .map((f) => `${String(f.type ?? '').split('/').pop()}:${f.date?.original ?? ''}@${f.place?.original ?? ''}`)
    .join('; ');
  const collection = (c.sourceDescriptions ?? [])
    .map((s) => s.titles?.[0]?.value)
    .filter(Boolean)
    .slice(0, 1)
    .join('');
  const household = persons
    .filter((p) => p !== principal)
    .map((p) => {
      const n = p.names?.[0]?.nameForms?.[0]?.fullText ?? '?';
      const birth = (p.facts ?? []).find((f) => /Birth/.test(String(f.type ?? '')));
      const age = (p.facts ?? []).find((f) => /Age/.test(String(f.type ?? '')));
      return `${n}${age?.value ? ` (${age.value})` : ''}${birth?.date?.original ? ` b.${birth.date.original}` : ''}${birth?.place?.original ? ` ${birth.place.original}` : ''}`;
    });
  return { id: entry?.id ?? '?', name, facts, collection, household };
}

export function personaLine(s) {
  return `- ${s.id} | ${s.name} | ${s.facts} | ${s.collection} | HH: ${s.household.join('; ')}`;
}

export function mergeCollections(pages) {
  const byId = new Map();
  const anonymous = [];
  for (const page of pages ?? []) {
    for (const el of page?.collections ?? page?.entries ?? []) {
      const wrapped = el?.content?.gedcomx?.collections;
      for (const c of Array.isArray(wrapped) ? wrapped : [el]) {
        const id = c?.id ?? c?.collectionId ?? null;
        if (id == null) anonymous.push(c);
        else if (!byId.has(String(id))) byId.set(String(id), c);
      }
    }
  }
  return [...byId.values(), ...anonymous];
}

export function collectionLine(c) {
  const id = c?.id ?? c?.collectionId ?? '?';
  const title = c?.title ?? c?.name ?? c?.titles?.[0]?.value ?? '';
  return `${String(id).padStart(9)}  ${title}`;
}

async function withPage(page, settleMs, fn) {
  const tab = await openTab();
  let cdp = null;
  try {
    cdp = await connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: page });
    await sleep(settleMs);
    return await fn(cdp);
  } finally {
    try {
      cdp?.close();
    } catch {

    }
    await closeTab(tab);
  }
}

async function guardSession(cdp) {
  let probe;
  try {
    probe = JSON.parse(await evaluate(cdp, sessionProbeExpr()));
  } catch (e) {
    probe = { error: String(e.message ?? e) };
  }
  const verdict = sessionVerdict(probe || {});
  if (verdict === 'ALIVE') return null;
  const label = verdict === 'SIGNED_OUT' ? 'SIGNED OUT' : 'SESSION PROBE INCONCLUSIVE';
  console.error(`${label} — ${SESSION_PROBE_PATH} answered ${probe?.status ?? '?'} ${String(probe?.body ?? probe?.error ?? '').slice(0, 80)}`);
  if (verdict === 'SIGNED_OUT') {
    console.error('Sign in once in the shared debug Chrome, then re-run. An empty result set from a');
    console.error('dead session is not a negative finding.');
  } else {
    console.error('The probe could not be read (no numeric HTTP status) — this is not the same as a');
    console.error('confirmed sign-out. Re-run once the tab can reach FamilySearch.');
  }
  return verdictExitCode(verdict);
}

async function searchCmd(qs, o) {
  let path;
  try {
    path = personasPath(qs);
  } catch (e) {
    console.error(String(e.message ?? e));
    return 1;
  }
  return withPage(SEARCH_PAGE, o.settleMs, async (cdp) => {
    const dead = await guardSession(cdp);
    if (dead) return dead;
    const res = await evaluate(cdp, jsonGetExpr(path));
    console.error(`HTTP ${res.status} ${String(res.url ?? '').slice(0, 160)}`);
    if (!/^[[{]/.test(String(res.text ?? '').trim())) {
      console.error(`NON-JSON body (first 300 chars): ${String(res.text ?? '').slice(0, 300)}`);
      return res.status === 400 ? 1 : 4;
    }
    const j = JSON.parse(res.text);
    if (o.out) {
      writeFileSync(o.out, JSON.stringify(j, null, 1));
      console.error(`wrote ${o.out}`);
    }
    const entries = j.entries ?? [];
    if (o.asJson) {
      console.log(JSON.stringify(entries.map(summarizePersona), null, 1));
    } else {
      console.log(`results total: ${j.results ?? '?'}  entries: ${entries.length}`);
      for (const e of entries.slice(0, o.maxPrint)) console.log(personaLine(summarizePersona(e)));
      if (entries.length > o.maxPrint) console.log(`… ${entries.length - o.maxPrint} more (raise --max-print, or use --out)`);
    }
    return entries.length ? 0 : 4;
  });
}

async function collectionsCmd(o) {
  let first;
  try {
    first = collectionsPath(o.count);
  } catch (e) {
    console.error(String(e.message ?? e));
    return 1;
  }
  return withPage(COLLECTIONS_PAGE, o.settleMs, async (cdp) => {
    const dead = await guardSession(cdp);
    if (dead) return dead;
    const pages = [];
    let path = first;
    for (let i = 0; i < o.pages && path; i++) {
      const res = await evaluate(cdp, jsonGetExpr(path));
      if (!/^[[{]/.test(String(res.text ?? '').trim())) {
        console.error(`page ${i + 1}: HTTP ${res.status}, non-JSON body — stopping the walk`);
        break;
      }
      const j = JSON.parse(res.text);
      pages.push(j);
      path = nextPath(j);
      console.error(`page ${i + 1}: ${(j.collections ?? j.entries ?? []).length} collection(s)${path ? '' : ' — end of walk'}`);
    }
    const merged = mergeCollections(pages);
    if (o.out) {
      writeFileSync(o.out, JSON.stringify(merged, null, 1));
      console.error(`wrote ${o.out}`);
    }
    let rows = merged.map(collectionLine);
    if (o.grep) {
      const re = new RegExp(o.grep, 'i');
      rows = rows.filter((r) => re.test(r));
    }
    if (o.asJson) console.log(JSON.stringify(merged));
    else for (const r of rows) console.log(r);
    console.error(`${merged.length} collection(s) merged${o.grep ? `, ${rows.length} matching /${o.grep}/i` : ''}`);
    return rows.length ? 0 : 4;
  });
}

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) return fallback;
  return argv[i + 1];
}

function usage() {
  console.error(`fs-personas.js — FamilySearch historical-records index search + collection catalogue

  search <query-string> [--out <file.json>] [--max-print N=50] [--json]
      <query-string> is everything after the \`?\` of the site's own
      /service/search/hr/v2/personas call — quote it, and do not double-encode:
        ged-tools fs-personas search \\
          'q.surname=Example&q.givenName=Synthetic&f.recordCountry=United%20States&count=20'
      A rejected parameter answers HTTP 400 naming itself — that is how the
      working parameter set was found, so read the 400 rather than retrying.
  collections [--out <file.json>] [--count N=2000] [--pages N=4] [--grep <re>] [--json]
      Walks ${COLLECTIONS_PATH} through \`links.next\` and merges the pages.
      Use collection identifiers returned by a collection search
      when the site's own collection browser would not surface it:
        ged-tools fs-personas collections --grep '1812' --out colls.json
  --self-test                          pure-function tests; no browser, no lock

EXIT CODES: 0 answered · 1 bad args · 2 signed out · 3 session probe inconclusive · 4 clean but empty

Both verbs probe ${SESSION_PROBE_PATH} first: the debug Chrome's
FamilySearch session lapses every 30-60 minutes in silence, and an empty
result set from a dead session is not a negative finding.

Requires the browser lock, held across your whole batch:
${browserLockHint('fs-personas').join('\n')}`);
}

async function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    return cmd ? 0 : 1;
  }
  if (cmd !== 'search' && cmd !== 'collections') {
    usage();
    return 1;
  }
  if (cmd === 'search' && (!argv[1] || argv[1].startsWith('--'))) {
    console.error('search: needs a query string (quote it) — see --help');
    return 1;
  }
  const o = {
    out: arg(argv, '--out'),
    count: arg(argv, '--count', '2000'),
    pages: Number(arg(argv, '--pages', '4')),
    grep: arg(argv, '--grep'),
    maxPrint: Number(arg(argv, '--max-print', '50')),
    asJson: argv.includes('--json'),
    settleMs: Number(arg(argv, '--settle', '4')) * 1000,
  };
  if (!Number.isInteger(o.pages) || o.pages <= 0) {
    console.error(`--pages wants a positive integer, got ${arg(argv, '--pages')}`);
    return 1;
  }

  requireBrowserLock('fs-personas');
  return cmd === 'search' ? searchCmd(argv[1], o) : collectionsCmd(o);
}
export { FS_ORIGIN, main, usage, arg, searchCmd, withPage, sleep, SEARCH_PAGE, guardSession, collectionsCmd, COLLECTIONS_PAGE };

function selfTest() { throw new Error("Run npm test in the ged-tools source checkout; private fixtures are not distributed."); }
