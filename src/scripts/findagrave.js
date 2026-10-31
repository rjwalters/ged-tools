import { openTab, closeTab, connect, evaluate, requireBrowserLock, browserLockHint } from './cdp-transport.js';
import {
  ORIGIN,
  GRAPHQL_PATH,
  PAGE_SIZE,
  YEAR_FILTERS,
  USER_AGENT,
  FindAGraveError,
  validateQuery,
  buildSearchUrl,
  memorialRef,
  locationQueryBody,
  parseLocations,
  challengeKind,
  parseSearch,
  parseMemorial,
  formatHit,
  formatMemorial,
} from '../lib/findagrave.js';

const LOCK_NAME = 'findagrave';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLITE_DELAY_MS = 1000;
const DEFAULT_WAIT_MS = 45_000;
// Photos are never fetched: the page's image host is blocked in the tab.
const BLOCKED_URLS = ['*images.findagrave.com*'];

export function usage() {
  console.log(`findagrave — Find a Grave memorial search and memorial pages, read through the shared debug Chrome

  search --last L [--first F] [--middle M]
         [--birth-year YYYY [--birth-filter F]] [--death-year YYYY [--death-filter F]]
         [--location "<text>" | --location-id ID] [--max N=${PAGE_SIZE}] [--json]
      one line per result card: memorial id | URL | name | dates shown | cemetery | place
      Records repeated across pages are dropped; the site's ordering is not
      stable between pages, so deep paging can also skip records — narrow the query.
      F is one of ${YEAR_FILTERS.join('|')} (numbers are ± years; default exact).
      --location text is resolved to the site's own location id (the first
      typeahead match, printed on stderr) — the site IGNORES free-text location
      without one. Pass --location-id (e.g. county_817) to skip the lookup.
  memorial <id|url> [--json]
      name, birth, death, burial cemetery and place, plot, inscription, bio,
      family links (with memorial ids), creator/maintainer, photo count, and the
      site's own citation (accessed today)
  locations "<text>" [--json]
      the site's location typeahead: id and name, for --location-id

  --http      plain HTTP with a browser User-Agent instead of the debug Chrome
              (no lock needed; Cloudflare may refuse it — then drop --http)
  --wait MS   how long to wait out a Cloudflare check in the browser (default ${DEFAULT_WAIT_MS})

PHOTOS: Find a Grave photos are in copyright. This command never downloads or
saves them — it reports a photo COUNT only, and blocks the image host in its
tab. Cite the memorial; do not store its photos.

A Cloudflare "Just a moment..." check is waited out, never solved or bypassed.
If it does not clear (or asks for a CAPTCHA), the command fails with exit 2.

EXIT CODES: 0 answered · 1 bad arguments · 2 browser/lock/request failure, an
            uncleared Cloudflare check, or a page that changed shape ·
            4 answered, nothing matched (no hits / no such memorial)

Without --http, requires the browser lock, held across your whole batch:
${browserLockHint(LOCK_NAME).join('\n')}`);
}

const PAGE_STATE_EXPR = `(() => ({
  ready: document.readyState,
  stale: window.__gedToolsStale === true,
  url: location.href,
  title: document.title,
  text: document.body ? document.body.innerText.slice(0, 4000) : '',
}))()`;

function graphqlExpr(body) {
  return `(async () => {
  const r = await fetch(${JSON.stringify(GRAPHQL_PATH)}, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: ${JSON.stringify(JSON.stringify(body))},
  });
  return { status: r.status, body: await r.text() };
})()`;
}

/** Shared Chrome transport: one background tab for the whole command. */
export async function cdpTransport({ waitMs = DEFAULT_WAIT_MS, log = console.error } = {}) {
  requireBrowserLock(LOCK_NAME);
  const tab = await openTab();
  let cdp = null;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { cdp?.close(); } catch { /* already closed */ }
    await closeTab(tab);
  };
  const onSignal = (sig) => {
    close().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    cdp = await connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS });
  } catch (err) {
    await close();
    throw new FindAGraveError(`could not attach to the debug Chrome tab: ${err.message}`);
  }
  let onOrigin = false;
  const load = async (url) => {
    // Mark the current document: until the new one replaces it, a poll could
    // read the OLD page's readyState === 'complete' (page 1 parsed as page 2).
    try { await evaluate(cdp, 'window.__gedToolsStale = true'); } catch { /* no document yet */ }
    await cdp.send('Page.navigate', { url });
    const deadline = Date.now() + waitMs;
    let announced = false;
    let last = null;
    await sleep(750);
    for (;;) {
      try {
        last = await evaluate(cdp, PAGE_STATE_EXPR);
      } catch {
        last = null; // mid-navigation: the execution context was replaced
      }
      if (last?.ready === 'complete' && !last.stale) {
        const kind = challengeKind(last);
        if (!kind) break;
        if (!announced) {
          log(`Cloudflare check on ${new URL(url).host} — waiting up to ${Math.round(waitMs / 1000)}s for it to clear (it is never solved or bypassed)`);
          announced = true;
        }
      }
      if (Date.now() > deadline) {
        const kind = last ? challengeKind(last) : null;
        throw new FindAGraveError(
          kind
            ? `the Cloudflare check on ${url} did not clear within ${Math.round(waitMs / 1000)}s ("${last.title}"). If it shows a checkbox or CAPTCHA, a person must complete it in the shared Chrome — this tool will not. Then re-run.`
            : `${url} did not finish loading within ${Math.round(waitMs / 1000)}s`,
        );
      }
      await sleep(1000);
    }
    onOrigin = true;
    return evaluate(cdp, 'document.documentElement.outerHTML');
  };
  const postJson = async (body) => {
    if (!onOrigin) await load(`${ORIGIN}/`);
    const res = await evaluate(cdp, graphqlExpr(body));
    if (res?.status !== 200) throw new FindAGraveError(`location lookup answered HTTP ${res?.status ?? '?'}`);
    try {
      return JSON.parse(res.body);
    } catch {
      throw new FindAGraveError('location lookup answered non-JSON (a challenge page?)');
    }
  };
  return {
    load,
    postJson,
    close: async () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      await close();
    },
  };
}

/** Plain-HTTP transport (opt-in). */
export function httpTransport({ fetchImpl = fetch } = {}) {
  const request = async (url, init = {}) => {
    let res;
    try {
      res = await fetchImpl(url, { redirect: 'follow', ...init, headers: { 'User-Agent': USER_AGENT, ...(init.headers ?? {}) } });
    } catch (err) {
      throw new FindAGraveError(`request failed: ${url}: ${err.message}`);
    }
    const body = await res.text();
    const title = body.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '';
    if (challengeKind({ title, text: body.replace(/<[^>]+>/g, ' ') })) {
      throw new FindAGraveError(`Cloudflare refused plain HTTP for ${url} ("${title.trim()}") — re-run without --http to read it through the debug Chrome`);
    }
    if (res.status !== 200) throw new FindAGraveError(`HTTP ${res.status} from ${url}`);
    return body;
  };
  return {
    load: (url) => request(url),
    postJson: async (body) => {
      const t = await request(`${ORIGIN}${GRAPHQL_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
      try {
        return JSON.parse(t);
      } catch {
        throw new FindAGraveError('location lookup answered non-JSON');
      }
    },
    close: async () => {},
  };
}

export async function lookupLocations(transport, name) {
  return parseLocations(await transport.postJson(locationQueryBody(name)));
}

export async function search(transport, query, { max = PAGE_SIZE, log = console.error, delayMs = POLITE_DELAY_MS } = {}) {
  const q = validateQuery(query);
  if (q.location && !q.locationId) {
    const found = await lookupLocations(transport, q.location);
    if (!found.length) throw new FindAGraveError(`no Find a Grave location matches "${q.location}"`, { code: 4 });
    q.locationId = found[0].id;
    log(`location: "${q.location}" → ${found[0].text} (${found[0].id})${found.length > 1 ? ` — first of ${found.length}; see \`findagrave locations\`` : ''}`);
  }
  // The site's order among equally relevant results is not stable between
  // page requests (measured: a page-2 record also served on page 1), so a
  // record can repeat across pages — dropped here — or be skipped, which no
  // client can detect. Narrow the query rather than paging deep.
  const hits = [];
  const seen = new Set();
  let duplicates = 0;
  let total = 0;
  let page = 1;
  let hasNext = false;
  for (;;) {
    const result = parseSearch(await transport.load(buildSearchUrl(q, page)));
    total = result.total;
    hasNext = result.hasNext;
    for (const h of result.hits) {
      if (seen.has(h.id)) duplicates += 1;
      else {
        seen.add(h.id);
        hits.push(h);
      }
    }
    if (!hasNext || !result.hits.length || hits.length >= max) break;
    page += 1;
    await sleep(delayMs);
  }
  if (duplicates) log(`dropped ${duplicates} record(s) the site repeated across pages (its ordering is unstable; paging can also skip records — narrow the query for completeness)`);
  return { query: q, total, hits: hits.slice(0, max), pages: page, duplicates, truncated: hits.length > max || hasNext };
}

export async function memorial(transport, ref, { accessed = todayStamp() } = {}) {
  const { id, url } = memorialRef(ref);
  const m = parseMemorial(await transport.load(url), { accessed });
  if (!m) throw new FindAGraveError(`memorial ${id} not found (the site answered a page that is not a memorial)`, { code: 4 });
  if (m.id && m.id !== id) m.requestedId = id; // merged or redirected memorial
  return m;
}

function todayStamp(d = new Date()) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

const VALUE_FLAGS = new Set(['--first', '--middle', '--last', '--birth-year', '--birth-filter', '--death-year', '--death-filter', '--location', '--location-id', '--max', '--wait']);

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= argv.length) throw new FindAGraveError(`${a} needs a value`, { code: 1 });
      flags[a.slice(2)] = argv[++i];
    } else if (a === '--json' || a === '--http') flags[a.slice(2)] = true;
    else if (a.startsWith('--')) throw new FindAGraveError(`unknown option ${a}`, { code: 1 });
    else positional.push(a);
  }
  for (const k of ['max', 'wait']) {
    if (flags[k] !== undefined && !(Number.isInteger(Number(flags[k])) && Number(flags[k]) > 0)) {
      throw new FindAGraveError(`--${k} must be a positive integer`, { code: 1 });
    }
  }
  return { verb: positional[0], positional: positional.slice(1), flags };
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  const { verb, positional, flags } = parsed;
  if (!verb || !['search', 'memorial', 'locations'].includes(verb)) {
    usage();
    return 1;
  }
  let job;
  try {
    // Validate everything before touching the browser or the lock.
    if (verb === 'search') {
      const query = validateQuery({
        first: flags.first, middle: flags.middle, last: flags.last,
        birthYear: flags['birth-year'], birthFilter: flags['birth-filter'],
        deathYear: flags['death-year'], deathFilter: flags['death-filter'],
        location: flags.location, locationId: flags['location-id'],
      });
      const max = Number(flags.max ?? PAGE_SIZE);
      job = (t) => search(t, query, { max });
    } else if (verb === 'memorial') {
      if (!positional[0]) throw new FindAGraveError('memorial wants <id|url>', { code: 1 });
      memorialRef(positional[0]);
      job = (t) => memorial(t, positional[0]);
    } else {
      if (!positional[0]) throw new FindAGraveError('locations wants "<text>"', { code: 1 });
      job = (t) => lookupLocations(t, positional.join(' '));
    }
  } catch (err) {
    if (err instanceof FindAGraveError) {
      console.error(err.message);
      return err.code;
    }
    throw err;
  }

  let transport;
  try {
    transport = flags.http ? httpTransport() : await cdpTransport({ waitMs: Number(flags.wait ?? DEFAULT_WAIT_MS) });
    const result = await job(transport);
    if (verb === 'search') {
      if (flags.json) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`${result.hits.length} of ${result.total.toLocaleString('en-US')} matching record(s)${result.truncated ? ' — more on the site; raise --max' : ''}`);
        for (const h of result.hits) console.log(formatHit(h));
      }
      return result.hits.length ? 0 : 4;
    }
    if (verb === 'memorial') {
      if (result.requestedId) console.error(`note: memorial ${result.requestedId} resolved to ${result.id} (merged or moved)`);
      console.log(flags.json ? JSON.stringify(result, null, 2) : formatMemorial(result));
      return 0;
    }
    if (flags.json) console.log(JSON.stringify(result, null, 2));
    else for (const l of result) console.log(`${l.id} | ${l.text}`);
    return result.length ? 0 : 4;
  } catch (err) {
    if (err instanceof FindAGraveError) {
      console.error(err.message);
      return err.code;
    }
    console.error(err?.message ?? String(err));
    return 2;
  } finally {
    await transport?.close();
  }
}
