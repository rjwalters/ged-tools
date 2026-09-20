import { DEFAULT_CDP_ORIGIN } from './cdp-preflight.js';
import { loadChromium } from '../lib/playwright.js';
import { ensureCdpTarget, closeCdpTarget } from './cdp-preflight.js';
import { requireBrowserLock, browserLockHint } from './cdp-transport.js';
export function imageOf(id) {
  const m = String(id).match(/(\d{4,6})(?!.*\d)/);
  return m ? parseInt(m[1], 10) : null;
}

export function snippet(content, term, radius = 160) {
  const t = String(content || '').replace(/\s+/g, ' ');
  const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const m = re.exec(t);
  const i = m ? m.index : 0;
  return (i > radius ? '…' : '') + t.slice(Math.max(0, i - radius), i + radius + term.length) + '…';
}

export function altopagesUrl(itemId, query, limit, offset) {
  return `/library/books/api/altopages?item_id=${itemId}&limit=${limit}&offset=${offset}&q=${encodeURIComponent(query)}`;
}

function fetchAllExpr(itemId, query, limit, cap) {
  return async ({ itemId, query, limit, cap }) => {
    const out = [];
    let offset = 0, total = null;
    while (true) {
      const u = `/library/books/api/altopages?item_id=${itemId}&limit=${limit}&offset=${offset}&q=${encodeURIComponent(query)}`;
      const r = await fetch(u, { headers: { Accept: 'application/json' } });
      if (r.status !== 200) return { error: 'HTTP ' + r.status, total, items: out };
      const j = await r.json();
      total = j._meta ? j._meta.total : total;
      const items = j.items || [];
      for (const it of items) out.push({ id: it.id, content: it.content });
      offset += items.length;
      if (!items.length || out.length >= (total ?? 0) || out.length >= cap) break;
    }
    return { total, items: out };
  };
}

async function withBook(itemId, timeoutMs, fn) {
  const pre = await ensureCdpTarget();
  const browser = await (await loadChromium()).connectOverCDP(DEFAULT_CDP_ORIGIN).catch(async (e) => {
    await closeCdpTarget(pre); throw e;
  });
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const page = await ctx.newPage();
  try {
    await page.goto(`https://www.familysearch.org/library/books/viewer/${itemId}/?offset=1`, {
      waitUntil: 'domcontentloaded', timeout: timeoutMs,
    });
    await page.waitForTimeout(4000);
    const url = page.url();
    if (/\/(signin|login)\b/i.test(url) || /ident\.familysearch\.org/.test(url)) {
      console.error('SIGNED OUT — sign in to FamilySearch in the debug Chrome and re-run.');
      return { code: 2 };
    }
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
    await closeCdpTarget(pre).catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function run(cmd, itemId, query, opts) {
  const res = await withBook(itemId, opts.timeoutMs, async (page) => {
    const data = await page.evaluate(fetchAllExpr(), { itemId, query, limit: opts.limit, cap: opts.cap });
    return data;
  });
  if (res.code === 2) return 2;
  if (res.error) { console.error(`altopages failed: ${res.error}`); return 4; }
  let items = res.items || [];
  if (opts.grep) {
    const re = new RegExp(opts.grep, 'i');
    items = items.filter((it) => re.test(it.content || ''));
  }
  if (cmd === 'count') {
    if (opts.asJson) console.log(JSON.stringify({ item: itemId, query, total: res.total }));
    else console.log(`${res.total} hit(s) for "${query}" in item ${itemId}`);
    return res.total ? 0 : 4;
  }
  const rows = items.map((it) => ({ image: imageOf(it.id), id: it.id, content: it.content }));
  if (opts.asJson) {
    console.log(JSON.stringify({ item: itemId, query, total: res.total, hits: rows.map((r) => ({ image: r.image, content: cmd === 'pages' ? r.content : snippet(r.content, query) })) }, null, 1));
  } else {
    console.error(`${res.total} hit(s) for "${query}" in item ${itemId}${opts.grep ? ` (${rows.length} after --grep)` : ''}`);
    for (const r of rows) {
      console.log(`\n#### image ${r.image}`);
      console.log(cmd === 'pages' ? (r.content || '').replace(/\s+/g, ' ') : '  ' + snippet(r.content, query));
    }
  }
  return rows.length ? 0 : 4;
}

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  return i === -1 || i + 1 >= argv.length ? fallback : argv[i + 1];
}

function usage() {
  console.error(`fs-books.js — search inside a FamilySearch Digital Library book (incl. "Protected / search-only" copyright books: full OCR text, no page image)

  search <item_id> <query>   per-page hits with a one-line snippet
  pages  <item_id> <query>   FULL page OCR for each matching page
  count  <item_id> <query>   just the total hit count
    --limit N   page size per API call (default 40)
    --grep RE   keep only pages whose OCR matches RE (client-side)
    --json      machine-readable   --timeout N (s, default 90)
  --self-test   pure-function tests; no browser, no lock

Find an item id: /library/books/records/results?search=<words> → rows link to
/library/books/records/item/<ID>.  (use the item ID from the catalog.)

EXIT: 0 hits · 1 bad args · 2 signed out · 4 zero hits

Requires the browser lock, held across the batch:
${browserLockHint('fs-books').join('\n')}`);
}

async function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const [cmd, itemId, ...rest] = argv;
  const query = rest.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--limit' && argv[argv.indexOf(a) - 1] !== '--grep' && argv[argv.indexOf(a) - 1] !== '--timeout').join(' ');
  if (!['search', 'pages', 'count'].includes(cmd) || !itemId || !query) { usage(); return 1; }
  const opts = {
    limit: Number(arg(argv, '--limit', '40')),
    cap: Number(arg(argv, '--cap', '400')),
    grep: arg(argv, '--grep'),
    asJson: argv.includes('--json'),
    timeoutMs: Number(arg(argv, '--timeout', '90')) * 1000,
  };
  requireBrowserLock('fs-books');
  return run(cmd, itemId, query, opts);
}
export { main, usage, arg, run, withBook, fetchAllExpr };

function selfTest() { throw new Error("Run npm test in the ged-tools source checkout; private fixtures are not distributed."); }
