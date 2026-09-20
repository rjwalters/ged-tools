import { existsSync, readFileSync } from 'node:fs';
import { openTab, closeTab, connect, evaluate, requireBrowserLock, browserLockHint } from './cdp-transport.js';
import { isSignedOut } from './fs-film.js';
import { filmDataExpr, filmsInCatalog, selectCatalog, padDgs } from '../lib/fs-film-data.js';
const FS = 'https://www.familysearch.org/en';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function placeUrl(place) {
  return `${FS}/search/catalog/results?q.place=${encodeURIComponent(place)}`;
}

export function itemUrl(catalogId) {
  const n = numericCatalogId(catalogId);
  if (!n) throw new Error(`not a catalog id: ${JSON.stringify(catalogId)} (want koha:123456 or 123456)`);
  return `${FS}/search/catalog/${n}`;
}

export function filmUrl(dgs, catalogId, i = 0) {
  const d = String(dgs).trim();
  if (!/^\d{5,12}$/.test(d)) throw new Error(`not a DGS number: ${JSON.stringify(dgs)}`);
  const cat = catalogId ? `&cat=${normalizeCatalogId(catalogId)}` : '';
  return `${FS}/search/catalog/film?dgs=${d}${cat}&i=${i}`;
}

export function gridUrl(dgs, catalogId, i = 0) {
  return `${filmUrl(dgs, catalogId, i)}&view=explore&grid=on`;
}

export function isSingleImageView(url) {
  return /\/search\/catalog\/film\?/.test(String(url)) && !/[?&](grid=on|view=explore)\b/.test(String(url));
}

const numericCatalogId = (id) => {
  const m = String(id ?? '').match(/(?:koha:)?(\d{2,9})\s*$/i);
  return m ? m[1] : null;
};

export function normalizeCatalogId(id) {
  const n = numericCatalogId(id);
  return n ? `koha:${n}` : null;
}

export function catalogIdFromHref(href) {
  const s = decodeURIComponent(String(href ?? ''));
  const cat = s.match(/[?&]cat=(?:koha:)?(\d{2,9})/i);
  if (cat) return `koha:${cat[1]}`;
  const path = s.match(/\/search\/catalog\/(\d{2,9})(?:[/?#]|$)/i);
  if (path) return `koha:${path[1]}`;
  const bare = s.match(/\bkoha:(\d{2,9})\b/i);
  return bare ? `koha:${bare[1]}` : null;
}

export const ROW_SELECTOR = 'tbody tr';

export const LABEL_CELL_SELECTOR = 'th, td';

export const EXPAND_BUTTON_SELECTOR = 'button[aria-expanded]';

export const CELL_SELECTOR = 'td';

export const ICON_SELECTOR = '[aria-label]';

export const LINK_SELECTOR = 'a[href]';

const q = (s) => JSON.stringify(s);

export function expandExpr(pattern = null) {
  const test = pattern ? `${pattern.toString()}.test(label)` : 'true';
  return `(() => {
    const out = [];
    for (const tr of document.querySelectorAll(${q(ROW_SELECTOR)})) {
      const cell = tr.querySelector(${q(LABEL_CELL_SELECTOR)});
      const label = ((cell && (cell.innerText || cell.textContent)) || '').trim().replace(/\\s+/g, ' ');
      if (!label || !(${test})) continue;
      const btn = tr.querySelector(${q(EXPAND_BUTTON_SELECTOR)});
      if (!btn) { out.push({ row: label, action: 'no-disclosure' }); continue; }
      if (btn.getAttribute('aria-expanded') === 'true') { out.push({ row: label, action: 'already-open' }); continue; }
      btn.click();
      out.push({ row: label, action: 'clicked', ariaLabel: btn.getAttribute('aria-label') });
    }
    return out;
  })()`;
}

export function naiveButtonTextExpr(pattern) {
  return `(() => {
    const out = [];
    for (const el of document.querySelectorAll('button, [role=button], summary')) {
      const t = ((el.innerText || el.textContent) || '').trim();
      if (t && ${pattern.toString()}.test(t)) { el.click(); out.push(t); }
    }
    return out;
  })()`;
}

export const FILM_ROWS_EXPR = `(() => {
  const clean = (s) => (s || '').trim().replace(/\\s+/g, ' ');
  const rows = [];
  for (const tr of document.querySelectorAll(${q(ROW_SELECTOR)})) {
    const cells = Array.from(tr.querySelectorAll(${q(CELL_SELECTOR)}))
      .map((td) => clean(td.innerText || td.textContent));
    if (!cells.length) continue;
    const icons = Array.from(tr.querySelectorAll(${q(ICON_SELECTOR)}))
      .map((el) => clean(el.getAttribute('aria-label')))
      .filter(Boolean);
    const hrefs = Array.from(tr.querySelectorAll(${q(LINK_SELECTOR)}))
      .map((a) => a.getAttribute('href'))
      .filter(Boolean);
    rows.push({ cells, icons, hrefs });
  }
  return rows;
})()`;

export const CATALOG_LINKS_EXPR = `(() => {
  const seen = new Set();
  const out = [];
  for (const a of document.querySelectorAll(${q(LINK_SELECTOR)})) {
    const href = a.getAttribute('href');
    if (!href || !/catalog|koha/i.test(href)) continue;
    const text = ((a.innerText || a.textContent) || '').trim().replace(/\\s+/g, ' ');
    const key = href + '|' + text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ text, href });
  }
  return out;
})()`;

export const ONSITE_ICON_LABEL = /available on microfilm and microfiche at the location indicated/i;

export const RESTRICTED_TEXT = /image restricted/i;

export const GRID_FAILURE_TEXT = /cannot display image group/i;

export const VAULT_LOCATION = /granite mountain record vault/i;

export const ONSITE_LOCATION = /familysearch library|family history library|floor film/i;

const LOCATION_HINT = new RegExp(`${VAULT_LOCATION.source}|${ONSITE_LOCATION.source}`, 'i');

const normDgs = (dgs) => {
  const digits = String(dgs ?? '').replace(/\D/g, '');
  return digits ? padDgs(digits) : '';
};

export function readFilmRow({ cells = [], icons = [], hrefs = [] } = {}) {
  const fromHref = hrefs.map((h) => String(h).match(/[?&]dgs=(\d{5,12})/i)).find(Boolean);
  let dgs = fromHref ? fromHref[1] : null;
  let film = null;
  let location = null;
  const rest = [];
  for (const cell of cells) {
    if (!cell) continue;
    if (!dgs && /^\d{9}$/.test(cell)) {
      dgs = cell;
    } else if (!film && /^\d{4,8}(\s+Items?\s+[\d\s,–—-]+)?$/i.test(cell)) {
      film = cell;
    } else if (!location && LOCATION_HINT.test(cell)) {
      location = cell;
    } else if (dgs && cell === dgs) {

    } else {
      rest.push(cell);
    }
  }
  const note = rest.sort((a, b) => b.length - a.length)[0] ?? null;
  const catalogId = hrefs.map(catalogIdFromHref).find(Boolean) ?? null;
  return { note, location, film, dgs: normDgs(dgs) || null, catalogId, icons: [...icons], hrefs: [...hrefs], other: rest.filter((c) => c !== note) };
}

export function classifyAccess(row = {}) {
  const { location = null, icons = [], dgs = null, catalogId = null, hrefs = [] } = row;
  const labels = icons.join(' | ');
  const verifyWith = dgs ? filmUrl(dgs, catalogId) : null;
  const out = (verdict, why) => ({ verdict, why, provisional: true, verifyWith });

  if (ONSITE_ICON_LABEL.test(labels)) {
    return out('on-site', `icon label: "${icons.find((l) => ONSITE_ICON_LABEL.test(l))}"`);
  }
  if (location && ONSITE_LOCATION.test(location)) {
    return out('on-site', `location "${location}" is an on-site shelf, not a digitised vault copy`);
  }
  if (location && VAULT_LOCATION.test(location)) {
    const viewer = hrefs.some((h) => /dgs=|\/ark:\//i.test(String(h)));
    return viewer || dgs
      ? out('free', `location "${location}" with a viewer link`)
      : out('unknown', `location "${location}" but no viewer link on the row`);
  }
  return out('unknown', location ? `unrecognised location "${location}"` : 'no location cell on the row');
}

export function filmNoteToRow(entry = {}, catalogId = null) {
  const cat = normalizeCatalogId(catalogId);

  const dgs = /^\d{5,12}$/.test(String(entry.dgs ?? '').trim()) ? normDgs(entry.dgs) : null;
  const film = [entry.film, entry.items].map((s) => String(s ?? '').trim()).filter(Boolean).join(' ') || null;
  const note = String(entry.text ?? '').trim() || null;
  const location = String(entry.location ?? '').trim() || null;
  return {
    note,
    location,
    film,
    dgs,
    catalogId: cat,
    icons: [],
    hrefs: dgs ? [filmUrl(dgs, cat)] : [],
    other: [],
    seq: entry.seq ?? null,
  };
}

export function filmRowKey(row = {}) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[‐-―]/g, '-').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  return `${normDgs(row.dgs)}|${norm(row.film)}`;
}

export function dedupeFilmRows(rows = []) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${filmRowKey(row)}|${norm(row.note)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function mergeFilmRows(domRows = [], postRows = []) {
  const byKey = new Map();
  const byDgs = new Map();
  domRows.forEach((row, i) => {
    const push = (map, k) => {
      if (!k) return;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(i);
    };
    push(byKey, filmRowKey(row));

    push(byDgs, normDgs(row.dgs) || null);
  });
  const used = new Set();

  const pairing = new Map();
  const claim = (p, i) => {
    used.add(i);
    pairing.set(p, i);
  };

  postRows.forEach((post, p) => {
    const i = (byKey.get(filmRowKey(post)) ?? []).find((n) => !used.has(n));
    if (i !== undefined) claim(p, i);
  });

  const leftoverByDgs = new Map();
  postRows.forEach((post, p) => {
    if (pairing.has(p) || !post.dgs) return;
    const k = normDgs(post.dgs);
    if (!k) return;
    if (!leftoverByDgs.has(k)) leftoverByDgs.set(k, []);
    leftoverByDgs.get(k).push(p);
  });
  for (const [dgs, posts] of leftoverByDgs) {
    const free = (byDgs.get(dgs) ?? []).filter((i) => !used.has(i));
    if (posts.length > 1 && free.length < posts.length) continue;
    posts.forEach((p, n) => {
      if (free[n] !== undefined) claim(p, free[n]);
    });
  }

  const out = postRows.map((post, p) => {
    const i = pairing.get(p);
    return i === undefined
      ? { ...post, source: 'film-data' }
      : { ...domRows[i], seq: domRows[i].seq ?? post.seq ?? null, source: 'page' };
  });
  domRows.forEach((row, i) => {
    if (!used.has(i)) out.push({ ...row, source: 'page' });
  });
  return out;
}

export function itemRows({ domRaw = [], filmData = null, filmDataError = null, catalogId = null } = {}) {
  const cat = normalizeCatalogId(catalogId);
  const classify = (row) => ({ ...row, access: classifyAccess({ ...row, catalogId: row.catalogId ?? cat }) });
  const domRows = dedupeFilmRows(
    (domRaw ?? [])
      .map((r) => readFilmRow(r))
      .filter((r) => r.film || r.dgs)
      .map((r) => ({ ...r, catalogId: r.catalogId ?? cat }))
  );

  const warnings = [];
  const truncationWarning = (why) =>
    `${why} — showing the ${domRows.length} row(s) the page rendered, WHICH MAY BE TRUNCATED: ` +
    'the catalog page renders only its first ~20 film rows (#359). Cross-check with ' +
    '`ged-tools fs-film films --manifest <film-data.json>` before concluding a roll does not exist.';

  const pageOnly = () => ({
    rows: domRows.map(classify).map((r) => ({ ...r, source: 'page' })),
    domCount: domRows.length,
    postCount: 0,
    recovered: 0,
    warnings,
    filmDataCatalog: null,
  });

  if (filmDataError) {
    warnings.push(truncationWarning(`the film-data cross-check did not run (${filmDataError})`));
    return pageOnly();
  }

  const selected = selectCatalog(filmData, cat);
  const entries = selected.films;
  if (!entries.length) {
    warnings.push(
      truncationWarning('the film-data response carried no catalogs[…].data.film_note list')
    );
    return pageOnly();
  }
  const filmDataCatalog = {
    titleno: selected.titleno,
    title: selected.title,
    matched: selected.matched,
    requested: selected.requested,
    index: selected.index,
    count: selected.count,
  };

  if (selected.requested && !selected.matched) {
    warnings.push(
      `the film-data response carried no catalogue koha:${selected.requested} — the ${entries.length} row(s) merged in ` +
        `come from ${filmDataCatalog.titleno ? `koha:${filmDataCatalog.titleno}` : 'the first catalogue'}` +
        `${filmDataCatalog.title ? ` "${filmDataCatalog.title}"` : ''}, the FIRST of the ${selected.count} catalogue(s) it ` +
        'returned, which may be a DIFFERENT series (#409). Verify each recovered roll before citing it.'
    );
  }

  const postRows = entries.map((e) => filmNoteToRow(e, cat));
  const rows = mergeFilmRows(domRows, postRows).map(classify);
  const recovered = rows.filter((r) => r.source === 'film-data').length;
  return { rows, domCount: domRows.length, postCount: postRows.length, recovered, warnings, filmDataCatalog };
}

export function provenanceLine({ rowCount = 0, domCount = 0, postCount = 0, recovered = 0, filmDataCatalog = null } = {}) {
  const where = `${rowCount} film row(s) (${domCount} from the page`;
  const from = filmDataSource(filmDataCatalog, postCount);
  if (recovered) return `${where}, ${recovered} recovered from the catalogue's full film-data list)${from}`;
  const short = postCount > 0 ? domCount - postCount : 0;
  if (short > 0) return `${where}, the catalogue's film-data list has ${short} fewer row(s) than the page)${from}`;
  return `${where}, the catalogue's film-data list agrees)${from}`;
}

function filmDataSource(sel, postCount) {
  if (!sel || !postCount || !sel.titleno) return '';
  const named = `koha:${sel.titleno}${sel.title ? ` "${sel.title}"` : ''}`;
  if (sel.requested && !sel.matched) {
    return ` — WARNING: film-data rows from ${named}, NOT the requested koha:${sel.requested}` +
      ` (fell back to the first of ${sel.count} catalogue(s) in the response)`;
  }
  return ` — film-data rows from ${named}`;
}

export function classifyViewer({ text = '', url = '' } = {}) {
  const t = String(text);
  if (isSignedOut(url)) {
    return { verdict: 'signed-out', why: `the browser is at ${url} — sign in in the debug Chrome and re-run` };
  }
  if (!isSingleImageView(url) && url) {
    if (GRID_FAILURE_TEXT.test(t)) {
      return {
        verdict: 'inconclusive',
        why: 'that is the GRID view\'s wording for a restricted roll, and it is identical to a real transient failure — re-check the single-image view',
      };
    }
    return { verdict: 'inconclusive', why: 'not the single-image view; only that view states a restriction as a restriction' };
  }
  if (RESTRICTED_TEXT.test(t)) return { verdict: 'restricted', why: 'the single-image view says "Image Restricted"' };
  if (GRID_FAILURE_TEXT.test(t)) {
    return {
      verdict: 'inconclusive',
      why: '"Cannot Display Image Group" is the grid view\'s wording and must not be read as a restriction — reload the single-image view',
    };
  }
  if (/\b\d[\d,]*\s+images?\b/i.test(t) || /download/i.test(t)) {
    return { verdict: 'free', why: 'the viewer rendered a title and its images' };
  }
  return { verdict: 'unknown', why: 'the viewer rendered neither a restriction notice nor an image count' };
}

export function settleVerdict({ url = '', text = '', minChars = 800 } = {}) {
  if (isSignedOut(url)) return 'redirecting';
  return String(text).trim().length > minChars ? 'ready' : 'waiting';
}

export const ROWS_TIMEOUT_MS = 20000;

export const ROWS_POLL_MS = 500;

export function rowsReadyVerdict({ rows = null, elapsedMs = 0, timeoutMs = ROWS_TIMEOUT_MS } = {}) {
  if (Array.isArray(rows) && rows.length > 0) return 'ready';
  return elapsedMs >= timeoutMs ? 'gave-up' : 'waiting';
}

export async function waitForFilmRows(readRows, {
  timeoutMs = ROWS_TIMEOUT_MS,
  everyMs = ROWS_POLL_MS,
  sleepFn = sleep,
  nowFn = () => Date.now(),
} = {}) {
  const started = nowFn();
  for (;;) {
    const rows = (await readRows()) ?? [];
    const verdict = rowsReadyVerdict({ rows, elapsedMs: nowFn() - started, timeoutMs });
    if (verdict !== 'waiting') return Array.isArray(rows) ? rows : [];
    await sleepFn(everyMs);
  }
}

async function withPage(url, timeoutMs, fn) {
  const tab = await openTab();
  let cdp = null;
  try {
    cdp = await connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 1400,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.navigate', { url });

    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      await sleep(1500);
      const here = await evaluate(cdp, 'location.href').catch(() => '');
      const text = (await evaluate(cdp, 'document.body ? document.body.innerText : ""').catch(() => '')) || '';
      const verdict = settleVerdict({ url: here, text });
      if (verdict === 'ready') {
        ready = true;
        break;
      }
    }
    const here = await evaluate(cdp, 'location.href').catch(() => '');
    if (!ready && isSignedOut(here)) {
      console.error(`SIGNED OUT — the debug Chrome never left ${here} within the timeout.`);
      console.error('Sign in there, then re-run this exact command.');
      return 2;
    }
    if (!ready) console.error(`warning: the page never settled within the timeout; reporting what is there (${here})`);
    return await fn(cdp, here);
  } finally {
    try {
      cdp?.close();
    } catch {

    }
    await closeTab(tab);
  }
}

async function runEval(cdp, file) {
  if (!existsSync(file)) {
    console.error(`--eval file not found: ${file}`);
    return 1;
  }
  const out = await evaluate(cdp, readFileSync(file, 'utf8'));
  console.log('=== EVAL ===');
  console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
  return 0;
}

async function placeCmd(place, { timeoutMs, evalFile, asJson }) {
  return withPage(placeUrl(place), timeoutMs, async (cdp, here) => {

    const expanded = await evaluate(cdp, expandExpr(null));
    const clicked = (expanded ?? []).filter((e) => e.action === 'clicked');
    if (clicked.length) await sleep(4000);
    const links = (await evaluate(cdp, CATALOG_LINKS_EXPR)) ?? [];

    const seen = new Map();
    for (const { text, href } of links) {
      const id = catalogIdFromHref(href);
      if (!id || !text) continue;
      if (!seen.has(id)) seen.set(id, { id, title: text, href });
    }
    const catalogs = [...seen.values()];
    if (asJson) {
      console.log(JSON.stringify({ url: here, place, expanded, catalogs }, null, 2));
    } else {
      console.log(here);
      console.log(`subject groups: ${(expanded ?? []).map((e) => `${e.row} [${e.action}]`).join('; ') || '(none)'}`);
      console.log(`${catalogs.length} catalogue(s):`);
      for (const c of catalogs) console.log(`  ${c.id.padEnd(12)} ${c.title}`);
    }
    if (evalFile) await runEval(cdp, evalFile);
    return catalogs.length ? 0 : 4;
  });
}

async function fetchFilmData(cdp, seedDgs, catalogId) {
  if (!seedDgs) return { filmData: null, filmDataError: 'no row on the page carried a DGS to seed the film-data POST' };
  try {
    const raw = await evaluate(cdp, filmDataExpr(seedDgs, { cat: catalogId, withImages: false }));
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!j || j.error) return { filmData: null, filmDataError: j?.error ?? 'the film-data POST returned nothing' };
    return { filmData: j, filmDataError: null };
  } catch (err) {
    return { filmData: null, filmDataError: String(err?.message ?? err).slice(0, 200) };
  }
}

async function itemCmd(catalogId, { timeoutMs, evalFile, asJson }) {
  return withPage(itemUrl(catalogId), timeoutMs, async (cdp, here) => {

    const raw = await waitForFilmRows(async () => (await evaluate(cdp, FILM_ROWS_EXPR)) ?? []);

    const seedDgs = raw.map((r) => readFilmRow(r).dgs).find(Boolean) ?? null;
    const { filmData, filmDataError } = await fetchFilmData(cdp, seedDgs, catalogId);
    const { rows, domCount, postCount, recovered, warnings, filmDataCatalog } =
      itemRows({ domRaw: raw, filmData, filmDataError, catalogId });
    for (const w of warnings) console.error(`warning: ${w}`);
    const provenance = provenanceLine({ rowCount: rows.length, domCount, postCount, recovered, filmDataCatalog });
    if (asJson) {
      console.log(JSON.stringify(
        { url: here, catalog: normalizeCatalogId(catalogId), domRows: domCount, filmDataRows: postCount, recoveredRows: recovered, filmDataCatalog, warnings, rows },
        null,
        2
      ));
    } else {
      console.log(here);

      console.log(postCount ? `${provenance}:` : `${rows.length} film row(s) — FROM THE PAGE ALONE:`);
      for (const r of rows) {
        const from = r.source === 'film-data' ? '  [not on the page — from film-data]' : '';
        console.log(`  film ${String(r.film ?? '?').padEnd(18)} DGS ${String(r.dgs ?? '?').padEnd(10)} ${r.access.verdict.toUpperCase()}${from}`);
        if (r.note) console.log(`    ${r.note}`);
        console.log(`    ${r.access.why}`);
      }
      console.log('');
      console.log('These verdicts are PROVISIONAL — the catalogue icon is a hint, the viewer is the');
      console.log('authority. Confirm each roll that matters with:');
      for (const r of rows.filter((x) => x.access.verifyWith).slice(0, 3)) {
        console.log(`  ged-tools fs-catalog film ${r.dgs} --cat ${normalizeCatalogId(catalogId)}`);
      }
    }
    if (evalFile) await runEval(cdp, evalFile);
    return rows.length ? 0 : 4;
  });
}

async function filmCmd(dgs, catalogId, { timeoutMs, evalFile, asJson }) {
  const url = filmUrl(dgs, catalogId);
  return withPage(url, timeoutMs, async (cdp, here) => {
    const text = (await evaluate(cdp, 'document.body ? document.body.innerText : ""')) || '';
    const verdict = classifyViewer({ text, url: here });
    if (asJson) {
      console.log(JSON.stringify({ requested: url, url: here, ...verdict, text: text.slice(0, 4000) }, null, 2));
    } else {
      console.log(here);
      console.log(`VERDICT ${verdict.verdict.toUpperCase()} — ${verdict.why}`);
      console.log('--- rendered text (first 40 lines) ---');
      console.log(text.split('\n').slice(0, 40).join('\n'));
    }
    if (evalFile) await runEval(cdp, evalFile);
    return { free: 0, restricted: 5, 'signed-out': 2, inconclusive: 4, unknown: 4 }[verdict.verdict] ?? 4;
  });
}

async function urlCmd(url, { timeoutMs, evalFile, expand }) {
  return withPage(url, timeoutMs, async (cdp, here) => {
    if (expand) {
      const expanded = await evaluate(cdp, expandExpr(new RegExp(expand, 'i')));
      console.log('=== EXPANDED ===');
      console.log((expanded ?? []).map((e) => `${e.action}: ${e.row}`).join('\n') || '(nothing matched)');
      if ((expanded ?? []).some((e) => e.action === 'clicked')) await sleep(4000);
    }
    console.log('=== URL ===');
    console.log(here);
    console.log('=== TEXT ===');
    console.log((await evaluate(cdp, 'document.body.innerText')) || '');
    const links = (await evaluate(cdp, CATALOG_LINKS_EXPR)) ?? [];
    console.log('=== LINKS ===');
    console.log(links.map((l) => `${l.text}  ->  ${l.href}`).join('\n'));
    if (evalFile) return runEval(cdp, evalFile);
    return 0;
  });
}

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`${name} needs a value`);
    process.exit(1);
  }
  return v;
}

function usage() {
  console.error(`fs-catalog.js — read a FamilySearch catalog page: places, catalogues, rolls, access

  place <place string>            every catalogue for a place, subject groups EXPANDED
  item  <koha:NNNNN>              one catalogue's film table, with a provisional
                                  free / on-site verdict per roll. The page renders
                                  only its first ~20 rows, so this also asks the
                                  catalogue for its own full film list and reports
                                  both counts; if that call fails it says the rows
                                  shown may be truncated rather than pretending
                                  they are the catalogue
  film  <dgs> --cat <koha:NNNNN>  open the roll and report what the viewer really
                                  renders — the SINGLE-IMAGE view, which is the only
                                  one where a restriction states itself
  url   <url>                     settle any catalog url and dump text + links
  --self-test                     pure-function tests; no browser, no lock, no network

OPTIONS
  --eval <file>   run a file of JavaScript in the settled page and print the result
  --expand <re>   (url) open only the subject rows whose first cell matches
  --json          machine-readable output
  --timeout N     seconds to wait for the page to settle (default 120)

EXIT CODES
  0  answered — catalogues found / rows read / the roll is free
  1  bad arguments
  2  signed out — sign in in the debug Chrome and re-run
  4  the page settled but said nothing useful, or the verdict is inconclusive
  5  the roll is RESTRICTED (film only) — a real answer, not an error

Requires the browser lock (it drives the shared debug Chrome), held across your
whole batch — this script refuses without it, and never takes it for you:
${browserLockHint('fs-catalog').join('\n')}`);
}

async function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const cmd = argv[0];
  if (!cmd || cmd.startsWith('--')) {
    usage();
    process.exit(1);
  }
  const opts = {
    timeoutMs: Number(arg(argv, '--timeout', '120')) * 1000,
    evalFile: arg(argv, '--eval'),
    asJson: argv.includes('--json'),
    expand: arg(argv, '--expand'),
  };
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    console.error('--timeout needs a positive number of seconds');
    process.exit(1);
  }

  const target = argv[1];
  if (!target || target.startsWith('--')) {
    usage();
    process.exit(1);
  }

  requireBrowserLock('fs-catalog');

  switch (cmd) {
    case 'place':
      return process.exit(await placeCmd(target, opts));
    case 'item':
      return process.exit(await itemCmd(target, opts));
    case 'film': {
      const cat = arg(argv, '--cat');
      if (!cat) {
        console.error('film needs --cat <koha:NNNNN>: the viewer resolves a DGS in the context of its catalogue');
        process.exit(1);
      }
      return process.exit(await filmCmd(target, cat, opts));
    }
    case 'url':
      return process.exit(await urlCmd(target, opts));
    default:
      usage();
      process.exit(1);
  }
}
export { FS, numericCatalogId, q, LOCATION_HINT, normDgs, filmDataSource, sleep, main, usage, arg, placeCmd, withPage, runEval, itemCmd, fetchFilmData, filmCmd, urlCmd };

async function selfTest() { throw new Error("Run npm test in the ged-tools source checkout; private fixtures are not distributed."); }
