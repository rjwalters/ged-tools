import { controls } from '../lib/controls.js';
import { readFileSync } from 'node:fs';
import { openTab, closeTab, connect, evaluate, requireBrowserLock, browserLockHint, DEFAULT_CDP_ORIGIN, CDP_SEND_TIMEOUT_MS } from './cdp-transport.js';
import { isSignedOut } from './fs-film.js';
import { isAuthUrl, RECOVERY_HINT } from '../lib/fs-classify.js';
import { padDgs, filmDataExpr } from '../lib/fs-film-data.js';
const FTS_PAGE = 'https://www.familysearch.org/en/search/full-text';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SESSION_PROBE_PATH = '/platform/users/current';

export const MISSING_SESSION_TEXT = /missing session id/i;

export const GONE_ROUTE_TEXT = /no static resource/i;

export const INCAPSULA_CHALLENGE = /^\s*<\?xml[^>]*encoding="UTF-16"|_Incapsula_Resource|Incapsula incident ID/i;

export const ALIVE_PROBE_STATUSES = new Set([200]);

export const SIGNED_OUT_PROBE_STATUSES = new Set([401, 403]);

export const SLS_RECORD_BASE = 'https://sg30p0.familysearch.org/service/records/volunteer/orchestration/sls/image/records/';

export const FS_USER_AGENT_CHAIN = 'ged-tools/fs-fulltext';

export const DEFAULT_PROBE_ARK = controls.familysearchProbeArk ?? null;

export const SESSION_PROBE_WAIT_MS = 10_000;

export { padDgs, filmDataExpr };

export function arkFromImageUrl(url) {
  const m = String(url).match(/ark:\/61903\/(3:1:[A-Z0-9-]+)/);
  return m ? m[1] : null;
}

export function batched(list, size = 8) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function parseArksFile(text) {
  const raw = String(text ?? '');
  let parsed;
  let isJson = false;
  try {
    parsed = JSON.parse(raw);
    isJson = true;
  } catch {                                                            }
  if (isJson) {
    if (Array.isArray(parsed)) return parsed.map(String).map((s) => s.trim()).filter(Boolean);
    const shape = parsed === null ? 'null'
      : typeof parsed === 'object' ? 'an object'
        : `a ${typeof parsed}`;
    throw new Error(`parsed as JSON but is ${shape}, not an array`);
  }
  return raw.split(/\s+/).map((s) => s.trim()).filter(Boolean);
}

export function skippedNote(n) {
  return `ignoring ${n} entr${n === 1 ? 'y that is' : 'ies that are'} not 3:1:… arks`;
}

export const GROUP_CONFINE_PARAMS = Object.freeze({
  'm.defaultFacets': 'on',
  'm.queryRequireDefault': 'on',
});

export function parseGroups(spec) {
  const raw = String(spec ?? '').split(',').map((s) => s.trim());
  const bad = raw.filter((s) => s && !/^\d+$/.test(s));
  if (bad.length) throw new Error(`--group wants DGS numbers, got ${bad.map((b) => JSON.stringify(b)).join(', ')}`);
  const ids = raw.filter(Boolean);
  if (!ids.length) throw new Error('--group needs at least one DGS number');
  return ids;
}

export function searchUrl({ query, collection, year, type, place, groups, count, offset }) {
  const p = new URLSearchParams();
  p.set('q.text', query);
  if (place) p.set('q.place', place);
  if (groups && groups.length) {
    p.set('q.groupName', groups.join(','));
    for (const [k, v] of Object.entries(GROUP_CONFINE_PARAMS)) p.set(k, v);
  }
  if (collection) p.set('f.collectionId', collection);
  if (year) p.set('f.recordYear', String(year));
  if (type) p.set('f.recordType', type);
  p.set('count', String(count));
  p.set('offset', String(offset));
  return `/service/search/fulltext/search?${p.toString()}`;
}

export function normalizePlace(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(normalizePlace).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    for (const k of ['text', 'name', 'place', 'original', 'value']) {
      if (typeof v[k] === 'string' && v[k]) return v[k];
    }
    return Object.values(v).map(normalizePlace).filter(Boolean).join(', ');
  }
  return String(v);
}

export function placeMatches(entryPlace, wanted) {
  const want = String(wanted ?? '').trim().toLowerCase();
  if (!want) return true;
  const have = normalizePlace(entryPlace).toLowerCase();
  if (!have) return false;
  if (have.includes(want)) return true;
  const segs = want.split(',').map((x) => x.trim()).filter(Boolean);
  return segs.length > 1 && segs.every((x) => have.includes(x));
}

export function filterNote({ fetched, kept, placeDropped = 0, grepDropped = 0, place = null, grep = null, max = 0, windowFull = false }) {
  if (!fetched) return [];
  const dropped = [];
  if (place) dropped.push(`--place "${place}" dropped ${placeDropped}`);
  if (grep) dropped.push(`--grep dropped ${grepDropped}`);
  if (!dropped.length) return [];
  const lines = [`fetched ${fetched} entr${fetched === 1 ? 'y' : 'ies'}; ${dropped.join(', ')}`];
  if (!kept && place && placeDropped) {
    lines.push(`--place is a q.place RANK hint plus a client-side substring filter, never a hard f.* filter,`);
    lines.push(`so a broad query can fill the --max=${max} window with better-ranked entries from elsewhere`);
    lines.push(`before any ${place} record is reached.${windowFull ? ' The window filled, so there IS more behind it.' : ''}`);
    lines.push('Narrow the query (a quoted phrase, --type, --collection) or raise --max before concluding');
    lines.push('the records do not exist.');
  }
  return lines;
}

export function slsToText(sls) {
  const regs = (sls && sls.stuff && sls.stuff.regions) || [];
  const lines = [];
  for (const reg of regs) for (const ln of reg.lines || []) lines.push((ln.tokens || []).map((t) => t.text).join(' '));
  return lines.join('\n');
}

export function slsMeta(sls) {
  const props = (sls && sls.stuff && sls.stuff.metadata && sls.stuff.metadata.properties) || [];
  const get = (n) => (props.find((p) => p.name === n) || {}).value ?? null;
  return { box: get('EXT_MISC_VOLUME'), dgs: get('GROUP_NAME'), imageId: get('FS_IMAGE_ID'), creator: get('CREATOR') };
}

export function slsBatchExpr(arks) {
  return `(async () => {
    const arks = ${JSON.stringify(arks)};
    const m = document.cookie.match(/fssessionid=([^;]+)/);
    const sid = m ? m[1] : null;
    const out = {};
    await Promise.all(arks.map(async (ark) => {
      try {
        const r = await fetch(${JSON.stringify(SLS_RECORD_BASE)} + ark, {
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + sid, 'FS-User-Agent-Chain': ${JSON.stringify(FS_USER_AGENT_CHAIN)} }
        });
        if (r.status !== 200) { out[ark] = { error: 'HTTP ' + r.status }; return; }
        out[ark] = await r.json();
      } catch (e) { out[ark] = { error: String(e).slice(0, 120) }; }
    }));
    return JSON.stringify(out);
  })()`;
}

export function memberExpr(dgsList) {
  return `(async () => {
    const r = await fetch('/service/search/fulltext/search/groupNumber?ids=' + ${JSON.stringify(dgsList.join(','))});
    return JSON.stringify({ status: r.status, body: await r.text() });
  })()`;
}

export function sessionProbeExpr() {
  return `(async () => {
    const m = document.cookie.match(/fssessionid=([^;]+)/);
    const sid = m ? m[1] : null;
    try {
      const r = await fetch(${JSON.stringify(SESSION_PROBE_PATH)}, {
        credentials: 'include',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + sid }
      });
      return JSON.stringify({ status: r.status, body: (await r.text()).slice(0, 300), cookie: !!sid, finalUrl: r.url, url: location.href });
    } catch (e) {
      return JSON.stringify({ error: String(e).slice(0, 200), cookie: !!sid, url: location.href });
    }
  })()`;
}

export function arkProbeExpr(ark) {
  return `(async () => {
    const m = document.cookie.match(/fssessionid=([^;]+)/);
    const sid = m ? m[1] : null;
    try {
      const r = await fetch(${JSON.stringify(SLS_RECORD_BASE)} + ${JSON.stringify(ark)}, {
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + sid, 'FS-User-Agent-Chain': ${JSON.stringify(FS_USER_AGENT_CHAIN)} }
      });
      return JSON.stringify({ ark: ${JSON.stringify(ark)}, status: r.status, body: (await r.text()).slice(0, 200), cookie: !!sid, url: location.href });
    } catch (e) {
      return JSON.stringify({ ark: ${JSON.stringify(ark)}, error: String(e).slice(0, 200), cookie: !!sid, url: location.href });
    }
  })()`;
}

export function sessionVerdict({ status, body, url, finalUrl } = {}) {
  if (isAuthUrl(url) || isAuthUrl(finalUrl)) return 'SIGNED_OUT';
  const text = String(body ?? '');
  if (MISSING_SESSION_TEXT.test(text)) return 'SIGNED_OUT';
  if (INCAPSULA_CHALLENGE.test(text)) return 'INCONCLUSIVE';
  if (GONE_ROUTE_TEXT.test(text)) return 'INCONCLUSIVE';
  if (!Number.isInteger(status) || status < 100 || status > 599) return 'INCONCLUSIVE';
  if (ALIVE_PROBE_STATUSES.has(status)) return /^\s*[[{]/.test(text) ? 'ALIVE' : 'INCONCLUSIVE';
  if (SIGNED_OUT_PROBE_STATUSES.has(status)) return 'SIGNED_OUT';
  return 'INCONCLUSIVE';
}

export function arkProbeVerdict({ status, body, url } = {}) {
  if (isAuthUrl(url)) return 'SIGNED_OUT';
  const text = String(body ?? '');
  if (MISSING_SESSION_TEXT.test(text)) return 'SIGNED_OUT';
  if (INCAPSULA_CHALLENGE.test(text)) return 'INCONCLUSIVE';
  if (!Number.isInteger(status) || status < 100 || status > 599) return 'INCONCLUSIVE';
  if (status === 200) return 'ALIVE';
  if (status === 404) return 'INCONCLUSIVE';
  return 'SIGNED_OUT';
}

export function combineVerdicts(...verdicts) {
  const seen = verdicts.filter(Boolean);
  if (seen.includes('SIGNED_OUT')) return 'SIGNED_OUT';
  if (seen.includes('INCONCLUSIVE')) return 'INCONCLUSIVE';
  return seen.length ? 'ALIVE' : 'INCONCLUSIVE';
}

export function verdictExitCode(verdict) {
  if (verdict === 'ALIVE') return 0;
  if (verdict === 'SIGNED_OUT') return 2;
  return 3;
}

export function emptyResultNote(verdict) {
  if (!verdict) return [];
  if (verdict === 'ALIVE') {
    return ['session probe: ALIVE — the empty answer is the endpoint\'s, not a signed-out session.'];
  }
  if (verdict === 'SIGNED_OUT') {
    return [
      '0 hit(s) AND the session probe says SIGNED OUT — these results are probably WRONG, not absent.',
      'A signed-out session answers this endpoint with HTTP 200 and an empty entry list, so an empty',
      'search is indistinguishable from a dead one. Sign the debug Chrome back in and re-run before',
      'concluding the records do not exist.',
      RECOVERY_HINT,
    ];
  }
  return [
    '0 hit(s) and the session probe was INCONCLUSIVE — the probe could not be read, so this empty',
    'answer is unverified. Run `ged-tools fs-fulltext session` before concluding',
    'the records do not exist.',
  ];
}

export const SEARCH_FETCH_TIMEOUT_MS = 25000;

export function buildFrameMap(byGroup) {
  const map = new Map();
  for (const [dgs, arks] of Object.entries(byGroup || {})) {
    (arks || []).forEach((ark, i) => { if (!map.has(ark)) map.set(ark, { dgs, frame: i }); });
  }
  return map;
}

export function frameLabel(map, ark) {
  const at = map?.get(ark);
  return at ? `${at.dgs}#${at.frame}` : '-';
}

export function outOfGroupNote({ outside, total, groups }) {
  if (!outside) return [];
  return [
    `WARNING: ${outside} of ${total} hit(s) are NOT on ${groups.length === 1 ? `DGS ${groups[0]}` : `any of DGS ${groups.join(', ')}`} (frame "-" above).`,
    'q.groupName + m.queryRequireDefault=on measured as a HARD filter on 2026-08-22 — every hit was in',
    'the film. If it is now returning out-of-film hits it has softened into a rank hint, and --group is',
    'no longer confining anything. Re-run the negative control in your source-access notes before trusting',
    'a --group answer as film-complete.',
  ];
}

export function groupZeroNote(asked, indexed) {
  const groups = asked ?? [];
  if (!groups.length) return [];
  if (indexed == null) {
    return [`could not check whether DGS ${groups.join(', ')} are in Full-Text Search — an unindexed film answers 0 to every query, so run \`fs-fulltext.js member ${groups.join(',')}\` before reading this zero as an absence.`];
  }
  const missing = groups.filter((g) => !indexed.includes(g));
  if (!missing.length) {
    return [`group check: DGS ${groups.join(', ')} ${groups.length === 1 ? 'is' : 'are'} in Full-Text Search, so the zero is the film's own — the name is not in this roll's OCR.`];
  }
  const all = missing.length === groups.length;
  return [
    `0 hit(s) AND ${all ? (groups.length === 1 ? `DGS ${missing[0]} is` : `NONE of DGS ${groups.join(', ')} are`) : `DGS ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'}`} NOT indexed in Full-Text Search.`,
    'An unindexed image group answers 0 to EVERY query, with HTTP 200 and no error, so this zero is',
    `structural — it says nothing about ${all ? 'whether the name is on the film' : 'the unindexed roll(s)'}.`,
    all
      ? 'Read those frames at the image (`fs-fulltext.js arks <dgs>` then the viewer), or pick a film whose'
      : `Only DGS ${groups.filter((g) => indexed.includes(g)).join(', ')} was actually searched. Read the rest at the image, or pick a film whose`,
    'catalog row carries the "Search Full-Text Transcripts" icon.',
  ];
}

export function searchExpr(opts) {
  return `(async () => {
    let r;
    try {
      r = await fetch(${JSON.stringify(searchUrl(opts))}, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(${SEARCH_FETCH_TIMEOUT_MS}) });
    } catch (e) {
      return JSON.stringify({ error: (e && e.name === 'TimeoutError')
        ? 'no answer in ${SEARCH_FETCH_TIMEOUT_MS / 1000}s (the query stalled — not a verdict on the records)'
        : 'fetch threw: ' + String((e && e.message) || e) });
    }
    if (r.status !== 200) return JSON.stringify({ error: 'HTTP ' + r.status, body: (await r.text()).slice(0, 200) });
    const j = await r.json();
    return JSON.stringify({ results: j.results, entries: (j.entries || []).map((e) => ({
      id: e.id, collectionId: e.collectionId,
      date: e.content && e.content.recordDate, type: e.content && e.content.recordType,
      place: e.content && e.content.recordPlace, title: e.content && e.content.title,
      text: (e.content && e.content.textDocument) || ''
    })) });
  })()`;
}

async function withFtsPage(timeoutMs, fn) {
  const tab = await openTab();
  let cdp = null;
  try {
    cdp = await connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.navigate', { url: FTS_PAGE });
    const deadline = Date.now() + timeoutMs;
    let ready = false;
    while (Date.now() < deadline) {
      await sleep(1500);
      const here = await evaluate(cdp, 'location.href').catch(() => '');
      if (isSignedOut(here)) {
        console.error(`SIGNED OUT — the debug Chrome is parked at ${here}. Sign in and re-run.`);
        return 2;
      }
      const len = await evaluate(cdp, 'document.body ? document.body.innerText.length : 0').catch(() => 0);
      if (len > 500) { ready = true; break; }
    }
    if (!ready) console.error('warning: the full-text page never settled; trying anyway');
    return await fn(cdp);
  } finally {
    try { cdp?.close(); } catch {                      }
    await closeTab(tab);
  }
}

async function evalJson(cdp, expr) {
  const raw = await evaluate(cdp, expr);
  return JSON.parse(raw);
}

async function searchCmd(query, o) {
  const years = o.years ? o.years : [o.year ?? null];
  return withFtsPage(o.timeoutMs, async (cdp) => {

    let frameMap = new Map();
    if (o.groups) {
      const byGroup = {};
      for (const dgs of o.groups) {
        try {
          const fd = await evalJson(cdp, filmDataExpr(dgs));
          if (fd.error) { console.error(`--group ${dgs}: film-data ${fd.error} — frame numbers unavailable for this film`); continue; }
          byGroup[dgs] = fd.images.map(arkFromImageUrl).filter(Boolean);
        } catch (e) {
          console.error(`--group ${dgs}: film-data unreadable (${String(e.message ?? e)}) — frame numbers unavailable for this film`);
        }
      }
      frameMap = buildFrameMap(byGroup);
    }
    const seen = new Map();

    let fetched = 0, placeDropped = 0, grepDropped = 0, windowFull = false;
    for (const year of years) {
      for (let offset = 0; offset < o.max; offset += 100) {
        const j = await evalJson(cdp, searchExpr({ query, collection: o.collection, year, type: o.type, place: o.place, groups: o.groups, count: Math.min(100, o.max - offset), offset }));
        if (j.error) { console.error(`search failed: ${j.error} ${j.body ?? ''}`); return 4; }
        for (const e of j.entries) {
          fetched++;
          if (o.place && !placeMatches(e.place, o.place)) { placeDropped++; continue; }
          if (o.grep && !new RegExp(o.grep, 'i').test(e.text)) { grepDropped++; continue; }
          seen.set(e.id, e);
        }
        windowFull = j.entries.length === 100;
        if (j.entries.length < 100) break;
      }
    }
    const hits = [...seen.values()];
    if (o.asJson) {
      console.log(JSON.stringify(o.groups ? hits.map((e) => ({ ...e, frame: frameMap.get(e.id)?.frame ?? null, dgs: frameMap.get(e.id)?.dgs ?? null })) : hits, null, 1));
    } else {
      for (const e of hits) {
        console.log(`${e.id}  ${o.groups ? `${frameLabel(frameMap, e.id)}  ` : ''}${e.date ?? '-'}  ${e.type ?? '-'}  ${e.place ?? '-'}`);
        if (o.full) console.log(e.text, '\n');
        else if (o.grep) {
          const m = new RegExp(o.grep, 'i').exec(e.text);
          if (m) console.log('   …' + e.text.slice(Math.max(0, m.index - 150), m.index + 180).replace(/\s+/g, ' ') + '…');
        }
      }
      console.error(`${hits.length} hit(s) after filters`);
    }
    for (const line of filterNote({ fetched, kept: hits.length, placeDropped, grepDropped, place: o.place, grep: o.grep, max: o.max, windowFull })) {
      console.error(line);
    }

    if (o.groups && frameMap.size) {
      const outside = hits.filter((e) => !frameMap.has(e.id)).length;
      for (const line of outOfGroupNote({ outside, total: hits.length, groups: o.groups })) console.error(line);
    }

    if (!hits.length) {
      let verdict;
      try {
        verdict = sessionVerdict(await evalJson(cdp, sessionProbeExpr()));
      } catch {
        verdict = 'INCONCLUSIVE';
      }
      for (const line of emptyResultNote(verdict)) console.error(line);

      if (o.groups) {
        let indexed = null;
        try {
          const m = await evalJson(cdp, memberExpr(o.groups));
          if (m.status === 200) indexed = (JSON.parse(m.body).ids ?? []).map(String);
        } catch {                                                                         }
        for (const line of groupZeroNote(o.groups, indexed)) console.error(line);
      }
    }
    return hits.length ? 0 : 4;
  });
}

async function ocrCmd(arks, o) {
  return withFtsPage(o.timeoutMs, async (cdp) => {
    const out = {};
    for (const batch of batched(arks)) {
      const j = await evalJson(cdp, slsBatchExpr(batch));
      for (const [ark, sls] of Object.entries(j)) {
        out[ark] = sls.error ? { error: sls.error } : { meta: slsMeta(sls), text: slsToText(sls) };
      }
    }
    if (o.asJson) console.log(JSON.stringify(out, null, 1));
    else for (const [ark, v] of Object.entries(out)) {
      console.log(`==== ${ark} ${v.error ? `[${v.error}]` : `(${v.meta.box ?? '?'}, dgs ${v.meta.dgs ?? '?'})`}`);
      if (v.text) console.log(v.text, '\n');
    }
    return Object.values(out).some((v) => v.text) ? 0 : 4;
  });
}

async function arksCmd(dgs, o) {
  return withFtsPage(o.timeoutMs, async (cdp) => {
    const j = await evalJson(cdp, filmDataExpr(dgs));
    if (j.error) { console.error(`film-data failed: ${j.error} (note: dgs is auto-padded to ${padDgs(dgs)})`); return 4; }
    const arks = j.images.map(arkFromImageUrl).filter(Boolean);
    if (o.asJson) console.log(JSON.stringify(arks));
    else arks.forEach((a, i) => console.log(`${String(i).padStart(4)} ${a}`));
    console.error(`${arks.length} frame(s) in DGS ${padDgs(dgs)}`);
    return arks.length ? 0 : 4;
  });
}

async function memberCmd(dgsCsv, o) {
  const list = dgsCsv.split(',').map((s) => s.trim()).filter(Boolean);
  return withFtsPage(o.timeoutMs, async (cdp) => {
    const j = await evalJson(cdp, memberExpr(list));
    console.log(j.body ?? JSON.stringify(j));
    return j.status === 200 ? 0 : 4;
  });
}

function waitForLoad(cdp, capMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), capMs);
    cdp.on((m) => {
      if (m.method === 'Page.loadEventFired') {
        clearTimeout(timer);
        resolve('load');
      }
    });
  });
}

export const PARK_LOGIN_URL = FTS_PAGE;

const PARK_HTTP_TIMEOUT_MS = 5000;

const PARK_LOAD_WAIT_MS = 10_000;

const PARK_POLL_MS = 250;

// DELIBERATELY BROAD: an existing sign-in tab may be the operator's own tab.
// Reuse it without navigation; do not claim that this tool created it.
export function isParkedLoginTab(target, excludeId = null) {
  if (!target || target.type !== 'page' || typeof target.url !== 'string') return false;
  if (excludeId != null && target.id === excludeId) return false;
  return isParkOrigin(target.url);
}

export function isParkOrigin(url) {
  return typeof url === 'string' && (isAuthUrl(url) || url.startsWith('https://www.familysearch.org/'));
}

export function parkReportLine(parked) {
  if (!parked) return null;
  if (parked.url) {
    return `Parked the FamilySearch sign-in page as a BACKGROUND tab in the debug Chrome (${parked.url}) — the window was not raised; switch to that Chrome for the click above (#342).`;
  }
  if (parked.existing) {

    return `A FamilySearch tab is already open in the debug Chrome (${parked.existing}) — signed out, it is the sign-in wall on its next click; reusing it, no new tab opened.`;
  }
  return `note: could not park a sign-in tab in the debug Chrome (${parked.error}); open ${PARK_LOGIN_URL} there yourself.`;
}

export function parkJsonFields(parked) {
  return {
    parkedLoginTab: parked ? (parked.url ?? parked.existing ?? null) : null,
    parkError: parked?.error ?? null,
  };
}

export async function readBackParkedUrl(origin, id, { waitMs = PARK_LOAD_WAIT_MS, pollMs = PARK_POLL_MS } = {}) {
  const deadline = Date.now() + waitMs;
  let lastUrl = null;
  let lastError = null;
  for (;;) {
    try {
      const res = await fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(PARK_HTTP_TIMEOUT_MS) });
      if (!res.ok) {
        lastError = `/json/list answered HTTP ${res.status}`;
      } else {
        const targets = await res.json();
        const target = (Array.isArray(targets) ? targets : []).find((t) => t?.id === id);
        if (!target) {
          lastError = `target ${id} is not in /json/list`;
        } else {
          lastError = null;
          lastUrl = typeof target.url === 'string' ? target.url : null;
          if (isParkOrigin(lastUrl)) return { url: lastUrl };
        }
      }
    } catch (e) {
      lastError = String(e.message ?? e).split('\n')[0].slice(0, 120);
    }
    const left = deadline - Date.now();
    if (left <= 0) return { lastUrl, ...(lastError ? { error: lastError } : {}) };
    await new Promise((r) => setTimeout(r, Math.min(pollMs, left)));
  }
}

export function parkStallReason(id, seen, waitMs, navError = null) {
  const nav = navError ? `; the navigation request itself failed: ${navError}` : '';
  if (seen?.error) return `created target ${id} but could not read its url back (${seen.error})${nav}`;
  const where = seen?.lastUrl ? `still on ${String(seen.lastUrl).slice(0, 80)}` : 'has no readable url';
  return `created target ${id} but ${waitMs}ms later it is ${where}, not FamilySearch — the navigation never landed (blank target left open)${nav}`;
}

export async function navigateParkTarget(wsUrl, url, timeoutMs) {
  const cdp = await connect(wsUrl, timeoutMs, timeoutMs);
  try {
    await cdp.send('Page.navigate', { url });
  } finally {
    cdp.close();
  }
}

export async function parkLoginTab({
  origin = DEFAULT_CDP_ORIGIN,
  excludeId = null,
  loadWaitMs = PARK_LOAD_WAIT_MS,
  pollMs = PARK_POLL_MS,
} = {}) {
  try {

    try {
      const res = await fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(PARK_HTTP_TIMEOUT_MS) });
      if (res.ok) {
        const targets = await res.json();
        const existing = (Array.isArray(targets) ? targets : []).find((t) => isParkedLoginTab(t, excludeId));
        if (existing) return { existing: existing.url };
      }
    } catch {                                                              }
    const deadline = Date.now() + loadWaitMs;

    const tab = await openTab(origin);
    let navError = null;
    try {
      await navigateParkTarget(tab.webSocketDebuggerUrl, PARK_LOGIN_URL, Math.max(1, deadline - Date.now()));
    } catch (e) {

      navError = String(e.message ?? e).split('\n')[0].slice(0, 120);
    }

    const seen = await readBackParkedUrl(origin, tab.id, { waitMs: Math.max(0, deadline - Date.now()), pollMs });
    if (seen.url) return { url: seen.url };
    return { error: parkStallReason(tab.id, seen, loadWaitMs, navError) };
  } catch (e) {

    return { error: String(e.message ?? e).split('\n')[0].slice(0, 200) };
  }
}

async function sessionCmd(o) {
  if (!o.probeArk) throw new Error('session requires --probe-ark or familysearchProbeArk in GENEALOGY_CONTROLS_PATH');
  const tab = await openTab();
  let cdp = null;
  try {
    cdp = await connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    const loaded = waitForLoad(cdp, o.probeWaitMs ?? SESSION_PROBE_WAIT_MS);
    await cdp.send('Page.navigate', { url: FTS_PAGE });
    await loaded;
    let probe;
    try {
      probe = JSON.parse(await evaluate(cdp, sessionProbeExpr()));
    } catch (e) {

      probe = { error: String(e.message ?? e).slice(0, 200) };
    }
    const verdict = sessionVerdict(probe);

    let arkProbe;
    try {
      arkProbe = JSON.parse(await evaluate(cdp, arkProbeExpr(o.probeArk)));
    } catch (e) {
      arkProbe = { ark: o.probeArk, error: String(e.message ?? e).slice(0, 200) };
    }
    const arkVerdict = arkProbeVerdict(arkProbe);
    const overall = combineVerdicts(verdict, arkVerdict);

    let parked = null;
    if (overall === 'SIGNED_OUT') parked = await parkLoginTab({ excludeId: tab.id });

    if (o.asJson) {
      console.log(JSON.stringify({ verdict: overall, ...parkJsonFields(parked), session: { verdict, ...probe }, ark: arkProbe ? { verdict: arkVerdict, ...arkProbe } : null }, null, 1));
    } else {

      if (verdict === 'ALIVE') {
        console.log(`SESSION ALIVE — ${SESSION_PROBE_PATH} answered HTTP ${probe.status}`);
      } else {
        const why = probe.error ? `probe unreadable (${probe.error})`
          : isAuthUrl(probe.url) ? `the tab parked on ${probe.url}`
            : `${SESSION_PROBE_PATH} answered HTTP ${probe.status ?? '?'} ${String(probe.body ?? '').slice(0, 80)}`;
        console.error(`SESSION ${verdict === 'SIGNED_OUT' ? 'SIGNED OUT' : 'INCONCLUSIVE'} — ${why}.`);
      }
      if (arkVerdict) {
        const how = arkProbe.error ? `probe unreadable (${arkProbe.error})`
          : `answered HTTP ${arkProbe.status ?? '?'}${arkProbe.cookie === false ? ' (no fssessionid cookie to bear)' : ''}`;
        const label = arkVerdict === 'ALIVE' ? 'OCR PROBE ALIVE' : arkVerdict === 'SIGNED_OUT' ? 'OCR PROBE SIGNED OUT' : 'OCR PROBE INCONCLUSIVE';
        const line = `${label} — sls/image/records/${o.probeArk} ${how}`;
        if (arkVerdict === 'ALIVE') console.log(line); else console.error(`${line}.`);
      }
      if (overall === 'ALIVE') {
        console.error('Pre-flight signal only: a session can pass this probe and still hit the');
        console.error('sign-in wall on a real query. The honest test is the query you actually need.');
      } else if (overall === 'SIGNED_OUT') {
        console.error(RECOVERY_HINT);
        console.error(parkReportLine(parked));
      } else {
        console.error('Could not ask — this is not "signed out", it is "no answer". A wedged debug Chrome');
        console.error('(blank window, spinner, ECONNREFUSED mid-run) looks like this: relaunch it and re-run,');
        console.error('and treat no empty search result as real until a probe answers one way or the other.');
      }
    }
    return verdictExitCode(overall);
  } finally {
    try { cdp?.close(); } catch {                      }
    await closeTab(tab);
  }
}

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) return fallback;
  return argv[i + 1];
}

export function flagIsDangling(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  const next = argv[i + 1];
  return next === undefined || next.startsWith('--');
}

export function resolveProbeArk(argv) {
  if (!argv.includes('--probe-ark') || flagIsDangling(argv, '--probe-ark')) return DEFAULT_PROBE_ARK;
  return arg(argv, '--probe-ark');
}

function usage() {
  console.error(`fs-fulltext.js — FamilySearch Full-Text Search + per-image OCR, headless over CDP

  search <query>  --collection <ftsId> [--year Y | --years A-B] [--type T]
                  [--place <substr>] [--group <dgs>[,<dgs>…]] [--max N=300]
                  [--grep <re>] [--full] [--json]
      f.collectionId / f.recordYear / f.recordType are HARD server filters.
      --group is ALSO a hard filter, despite travelling as q.groupName: it sends
      m.queryRequireDefault=on with it (plus m.defaultFacets=on, which the site
      sends and which measurably does nothing), and that pair CONFINES the search
      to the named image group(s) rather than re-ranking toward them. Measured
      Several films go in one comma-joined value and union
      (10 + 39 = 49, measured); repeating the flag would 400. Each hit prints as
      dgs#frame — the frame number the viewer wants — and a hit that is somehow
      NOT on the film is reported rather than hidden. An empty --group answer
      also asks whether the film is in Full-Text Search at all, because a film
      FTS does not index answers 0 to every query with no error to show for it.
      Do not combine --group with a --collection the film is not in: that is an
      honest AND, and it silently answers 0 (measured).
      --place is NOT: it is sent as a q.place RANK hint (which entries come back
      first) and then re-applied client-side as a case-insensitive substring test
      on the very place string each result row prints — a town name keeps matching places; comma-separated needles match in
      any order. Because ranking is all the server offers for place, a broad
      query can still fill the --max window before a matching county is reached;
      when that happens the run reports how many entries --place/--grep dropped,
      so an empty answer can be told apart from an absent record. Narrow the query
      or raise --max. --grep is client-side over the OCR text, same caveat.
      A run that ends with 0 hits also probes the session and says so: a
      signed-out session answers this endpoint 200-with-no-entries, so an empty
      search and a dead session print identically otherwise (#413).
      The FTS collection id is the entry-level
      collectionId on a search hit (e.g. <collection-id> "Example collection"),
      NOT a historical-records CID.
  ocr    <ark> [<ark>…] [--arks-file <path>] [--json]
      token-level OCR + box metadata via the SLS service. --arks-file reads arks
      from <path> — a newline/whitespace-separated list OR a JSON array (exactly
      what \`arks --json\` prints) — unioned with any positional arks and de-duped,
      so a 400-ark box needs no $(cat …) argv splice:
        ged-tools fs-fulltext arks <DGS> --json > arks.json
        ged-tools fs-fulltext ocr --arks-file arks.json --json
  arks   <dgs> [--json]            every image ark of a DGS group, in frame order
  member <dgs>[,<dgs>…]            which DGS groups are in Full-Text Search
  session [--probe-ark [<ark>]] [--json]
                                   is the debug Chrome's FamilySearch session alive?
      A seconds-long pre-flight to run BEFORE a long film/OCR walk, so a dead
      session is reported now rather than at frame 40. Probes ${SESSION_PROBE_PATH}
      with a bearer built from the fssessionid cookie — an endpoint whose answer
      is auth-dependent BY DESIGN: HTTP 200 with your user record means ALIVE,
      401/403 means SIGNED OUT, and anything else (a gone route's 404, a 5xx, the
      Incapsula bot wall's challenge page) is INCONCLUSIVE — it says nothing
      about the session either way. Opens and closes its own tab; never
      navigates yours.
      A SECOND, independent probe always runs too (#425): one real cross-origin
      SLS request (the same service \`ocr\` walks) for a known-free ark —
      ${DEFAULT_PROBE_ARK} unless --probe-ark <ark> overrides it. Each probe
      prints its own line and its own verdict; the exit code is the worst of them.
      Exit 0 alive · 2 signed out · 3 probe inconclusive (could not ask — a
      thrown fetch or an unreadable evaluate, which wants a different fix than
      signing back in).
      NECESSARY BUT NOT SUFFICIENT: a session can pass the first probe and still
      hit the sign-in wall on the query you actually need (seen 2026-08-07) —
      which is what --probe-ark exists to catch. Exit 0 still means "not
      obviously dead", never "the next long operation will succeed".
      On a SIGNED OUT verdict it also parks the sign-in page as a BACKGROUND
      tab in the debug Chrome, always-on, so recovery is one window-switch away.
      The window is never raised and nothing is clicked — the Continue-with-
      Google click is the operator's (see the recovery hint it prints). Re-runs
      reuse a tab already waiting there; a park that fails (Chrome died mid-run)
      is one note, never an error, and never changes the exit code. --json
      carries parkedLoginTab (the waiting tab's url) and parkError (why a park
      failed); both null means no park was attempted.
  --timeout N (s, default 120)     --self-test  (no browser, no lock)

EXIT CODES: 0 answered · 1 bad args · 2 signed out · 3 probe inconclusive (session verb)
            · 4 clean but empty

Requires the browser lock, held across your whole batch:
${browserLockHint('fs-fulltext').join('\n')}`);
}

async function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const cmd = argv[0];
  const target = argv[1];

  if (!cmd || (!target && cmd !== 'ocr' && cmd !== 'session')) { usage(); return 1; }
  const yearsArg = arg(argv, '--years');
  let years = null;
  if (yearsArg) {
    const m = yearsArg.match(/^(\d{4})-(\d{4})$/);
    if (!m) { console.error(`--years wants A-B, got ${yearsArg}`); return 1; }
    years = [];
    for (let y = Number(m[1]); y <= Number(m[2]); y++) years.push(y);
  }

  let groups = null;
  if (argv.includes('--group')) {
    if (flagIsDangling(argv, '--group')) {
      console.error('--group needs a DGS number (e.g. --group 0000001)');
      return 1;
    }
    try {
      groups = parseGroups(arg(argv, '--group'));
    } catch (e) {
      console.error(String(e.message ?? e));
      return 1;
    }
  }
  const o = {
    collection: arg(argv, '--collection'),
    year: arg(argv, '--year'),
    years,
    type: arg(argv, '--type'),
    place: arg(argv, '--place'),
    groups,
    grep: arg(argv, '--grep'),
    max: Number(arg(argv, '--max', '300')),
    full: argv.includes('--full'),
    asJson: argv.includes('--json'),
    timeoutMs: Number(arg(argv, '--timeout', '120')) * 1000,
    probeArk: resolveProbeArk(argv),
  };

  if (o.probeArk && !o.probeArk.startsWith('3:1:')) {
    console.error(`--probe-ark wants a 3:1:… image ark, got ${o.probeArk}`);
    return 1;
  }

  let ocrArks = null;
  if (cmd === 'ocr') {

    if (flagIsDangling(argv, '--arks-file')) {
      console.error('--arks-file needs a path');
      return 1;
    }
    const arksFile = arg(argv, '--arks-file');
    let fromFile = [];
    if (arksFile) {
      let text;
      try {
        text = readFileSync(arksFile, 'utf8');
      } catch (e) {
        console.error(`--arks-file ${arksFile}: ${e.code === 'ENOENT' ? 'no such file' : String(e.message ?? e)}`);
        return 1;
      }

      let entries;
      try {
        entries = parseArksFile(text);
      } catch (e) {
        console.error(`--arks-file ${arksFile}: ${String(e.message ?? e)}`);
        return 1;
      }
      fromFile = entries.filter((a) => a.startsWith('3:1:'));
      const skipped = entries.length - fromFile.length;
      if (skipped) console.error(`--arks-file ${arksFile}: ${skippedNote(skipped)}`);
    }
    const positional = argv.slice(1).filter((a) => a.startsWith('3:1:'));
    ocrArks = [...new Set([...fromFile, ...positional])];
    if (!ocrArks.length) {
      console.error('ocr: no arks — pass 3:1:… arks positionally and/or --arks-file <path>');
      return 1;
    }
  }

  requireBrowserLock('fs-fulltext');
  switch (cmd) {
    case 'search': return searchCmd(target, o);
    case 'ocr': return ocrCmd(ocrArks, o);
    case 'arks': return arksCmd(target, o);
    case 'member': return memberCmd(target, o);
    case 'session': return sessionCmd(o);
    default: usage(); return 1;
  }
}
export { FTS_PAGE, PARK_LOAD_WAIT_MS, PARK_POLL_MS, PARK_HTTP_TIMEOUT_MS, arg, main, usage, searchCmd, withFtsPage, sleep, evalJson, ocrCmd, arksCmd, memberCmd, sessionCmd, waitForLoad };

async function selfTest() { throw new Error("Run npm test in the ged-tools source checkout; private fixtures are not distributed."); }
