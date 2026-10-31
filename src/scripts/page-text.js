import { writeFileSync } from 'node:fs';
import { openTab, closeTab, connect, evaluate, requireBrowserLock, browserLockHint } from './cdp-transport.js';
import { resolveCacheOut } from '../lib/tools.js';

// A generic reader for pages behind a Cloudflare JS check ("Just a moment..."):
// open the URL in the operator's own signed-in debug Chrome, let the normal
// challenge clear by itself, then print the page's text. It waits; it never
// solves, clicks or bypasses anything. A check that needs a person (a
// checkbox or CAPTCHA) is reported as a failure for a person to complete.

const LOCK_NAME = 'page-text';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const DEFAULT_SETTLE_MS = 1500;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_SAVE_BYTES = 50 * 1024 * 1024;

export class PageTextError extends Error {
  constructor(message, { code = 2 } = {}) {
    super(message);
    this.name = 'PageTextError';
    this.code = code;
  }
}

export function usage() {
  console.log(`page-text — print a page's text through the shared debug Chrome, waiting out a Cloudflare check

  page-text <url> [--selector CSS] [--links] [--max-chars N] [--wait MS] [--timeout MS]
      document.body.innerText (or the text of every element matching --selector,
      separated by blank lines), then with --links a "--LINKS--" section of
      "href<TAB>text" lines (links inside --selector only, when given)
  page-text save <url> <out> [--wait MS] [--timeout MS]
      once the check clears, fetch <url> from inside the page and write the bytes
      to <out> — for an image or PDF served behind the check. An HTML answer is
      refused (it is a challenge or an error page, not the file)

  --wait MS      settle time after the page loads, for script-rendered content (default ${DEFAULT_SETTLE_MS})
  --timeout MS   how long to wait for a Cloudflare check to clear (default ${DEFAULT_TIMEOUT_MS})
  --max-chars N  truncate the text to N characters (a note goes to stderr)

A Cloudflare "Just a moment..." / "Checking your browser" page is detected by
its title or text and re-polled until it clears or --timeout passes. Nothing
is solved or bypassed, and no stealth tricks are used: the normal JS check
clears by itself in the operator's own browser. If it asks for a checkbox or
CAPTCHA, a person must complete it in that browser; this command exits 2.

EXIT CODES: 0 printed/saved · 1 bad arguments · 2 browser/lock failure, the check
            never cleared, or the save answered HTML/an error · 4 the page loaded
            but --selector matched nothing

Requires the browser lock, held across your whole batch:
${browserLockHint(LOCK_NAME).join('\n')}`);
}

/** 'challenge' for a Cloudflare interstitial, 'blocked' for a hard block, else null. */
export function challengeKind({ title = '', text = '' } = {}) {
  const t = String(title);
  const b = String(text).slice(0, 4000);
  if (/just a moment|checking your browser|un instant|einen moment/i.test(t)) return 'challenge';
  if (/checking (if the site connection is secure|your browser)|verify(ing)? you are (a )?human|enable javascript and cookies to continue|needs to review the security of your connection/i.test(b)) {
    return 'challenge';
  }
  if (/attention required/i.test(t) && /cloudflare/i.test(t + b)) return 'blocked';
  return null;
}

export function pageStateExpr() {
  return `(() => ({
  ready: document.readyState,
  stale: window.__gedToolsStale === true,
  url: location.href,
  title: document.title,
  text: document.body ? document.body.innerText.slice(0, 4000) : '',
}))()`;
}

/** In-page extraction: text (whole body or per selector match) and optional links. */
export function extractExpr({ selector = null, links = false } = {}) {
  return `(() => {
  const sel = ${JSON.stringify(selector)};
  const roots = sel ? [...document.querySelectorAll(sel)] : [document.body].filter(Boolean);
  const text = roots.map((el) => (el.innerText ?? el.textContent ?? '').trim()).join('\\n\\n');
  let links = null;
  if (${links ? 'true' : 'false'}) {
    const seen = new Set();
    links = [];
    for (const root of roots) {
      for (const a of root.querySelectorAll('a[href]')) {
        const href = a.href;
        const label = (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim();
        const key = href + '\\t' + label;
        if (!href || seen.has(key)) continue;
        seen.add(key);
        links.push({ href, text: label });
      }
    }
  }
  return { url: location.href, title: document.title, matched: roots.length, text, links };
})()`;
}

/** In-page fetch of the (now-cleared) URL, returned base64 so it crosses CDP intact. */
export function fetchBytesExpr(url, maxBytes = MAX_SAVE_BYTES) {
  return `(async () => {
  const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
  const type = r.headers.get('content-type') || '';
  if (!r.ok || /text\\/html/i.test(type)) {
    return { status: r.status, type, body: (await r.text()).slice(0, 300) };
  }
  const buf = await r.arrayBuffer();
  if (buf.byteLength > ${Number(maxBytes)}) return { status: r.status, type, tooLarge: buf.byteLength };
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { status: r.status, type, len: buf.byteLength, b64: btoa(s) };
})()`;
}

export function truncate(text, maxChars) {
  const s = String(text ?? '');
  if (!maxChars || s.length <= maxChars) return { text: s, truncated: false };
  return { text: s.slice(0, maxChars), truncated: true };
}

export function formatOutput({ text, links }, { maxChars = 0 } = {}) {
  const t = truncate(text, maxChars);
  let out = t.text;
  if (links) out += `\n--LINKS--\n${links.map((l) => `${l.href}\t${l.text}`).join('\n')}`;
  return { out, truncated: t.truncated };
}

/** Classify an in-page fetch result for `save`: { bytes } or a PageTextError. */
export function saveResult(res, url) {
  if (res?.b64) return { bytes: Buffer.from(res.b64, 'base64'), type: res.type };
  if (res?.tooLarge) return { error: new PageTextError(`${url} is ${res.tooLarge} bytes — over the ${MAX_SAVE_BYTES}-byte limit`) };
  if (/text\/html/i.test(res?.type ?? '')) {
    return { error: new PageTextError(`${url} answered HTML (HTTP ${res?.status ?? '?'}), not a file — a challenge or error page; nothing written`) };
  }
  return { error: new PageTextError(`${url} answered HTTP ${res?.status ?? '?'}: ${String(res?.body ?? '').slice(0, 160)}`) };
}

const VALUE_FLAGS = new Set(['--wait', '--timeout', '--selector', '--max-chars']);

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUE_FLAGS.has(a)) {
      if (i + 1 >= argv.length) throw new PageTextError(`${a} needs a value`, { code: 1 });
      flags[a.slice(2)] = argv[++i];
    } else if (a === '--links') flags.links = true;
    else if (a.startsWith('--')) throw new PageTextError(`unknown option ${a}`, { code: 1 });
    else positional.push(a);
  }
  for (const k of ['wait', 'timeout', 'max-chars']) {
    if (flags[k] === undefined) continue;
    const n = Number(flags[k]);
    if (!Number.isInteger(n) || n < 0) throw new PageTextError(`--${k} must be a non-negative integer`, { code: 1 });
    flags[k] = n;
  }
  const save = positional[0] === 'save';
  const [url, out] = save ? positional.slice(1) : positional;
  if (!url) throw new PageTextError(save ? 'save wants <url> <out>' : 'a URL is required', { code: 1 });
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new PageTextError(`not a URL: ${url}`, { code: 1 });
  }
  if (!/^https?:$/.test(parsedUrl.protocol)) throw new PageTextError(`only http(s) URLs are read (got ${parsedUrl.protocol})`, { code: 1 });
  if (save && !out) throw new PageTextError('save wants <url> <out>', { code: 1 });
  if (save && (flags.selector || flags.links || flags['max-chars'] !== undefined)) {
    throw new PageTextError('--selector, --links and --max-chars apply to text output, not save', { code: 1 });
  }
  return {
    mode: save ? 'save' : 'text',
    url: parsedUrl.href,
    out: out ?? null,
    selector: flags.selector ?? null,
    links: Boolean(flags.links),
    maxChars: flags['max-chars'] ?? 0,
    settleMs: flags.wait ?? DEFAULT_SETTLE_MS,
    timeoutMs: flags.timeout ?? DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Navigate and poll until the document is complete and is not a Cloudflare
 * interstitial. `cdp` needs only send(); `evalFn` defaults to evaluate().
 */
export async function loadPastChallenge(cdp, url, { timeoutMs = DEFAULT_TIMEOUT_MS, pollMs = 1000, log = console.error, evalFn = evaluate, now = Date.now, nap = sleep } = {}) {
  // Mark the current document: until the new one replaces it, a poll could
  // read the OLD page's readyState === 'complete' and take it for the new one.
  try { await evalFn(cdp, 'window.__gedToolsStale = true'); } catch { /* no document yet */ }
  await cdp.send('Page.navigate', { url });
  const deadline = now() + timeoutMs;
  let announced = false;
  let last = null;
  await nap(Math.min(750, pollMs));
  for (;;) {
    try {
      last = await evalFn(cdp, pageStateExpr());
    } catch {
      last = null; // mid-navigation: the execution context was replaced
    }
    const kind = last ? challengeKind(last) : null;
    if (last?.ready === 'complete' && !last.stale && !kind) return { state: last, waited: announced };
    if (kind && !announced) {
      log(`Cloudflare check on ${new URL(url).host} ("${last.title}") — waiting up to ${Math.round(timeoutMs / 1000)}s for it to clear; nothing is solved or bypassed`);
      announced = true;
    }
    if (now() >= deadline) {
      throw new PageTextError(
        kind
          ? `the Cloudflare check on ${url} did not clear within ${Math.round(timeoutMs / 1000)}s ("${last.title}"). If it shows a checkbox or CAPTCHA, a person must complete it in the shared Chrome — this command will not. Then re-run.`
          : `${url} did not finish loading within ${Math.round(timeoutMs / 1000)}s`,
      );
    }
    await nap(pollMs);
  }
}

async function withTab(fn) {
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
    return await fn(cdp);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (!argv.length) {
    usage();
    return 1;
  }
  let o;
  try {
    o = parseArgs(argv);
    if (o.out) o.out = resolveCacheOut(o.out);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  try {
    return await withTab(async (cdp) => {
      const { state } = await loadPastChallenge(cdp, o.url, { timeoutMs: o.timeoutMs });
      if (state.url !== o.url) console.error(`landed on ${state.url}`);
      if (o.mode === 'save') {
        const r = saveResult(await evaluate(cdp, fetchBytesExpr(o.url)), o.url);
        if (r.error) throw r.error;
        writeFileSync(o.out, r.bytes);
        console.error(`wrote ${o.out} (${r.bytes.length} bytes, ${r.type || 'no content-type'})`);
        return 0;
      }
      if (o.settleMs) await sleep(o.settleMs);
      const page = await evaluate(cdp, extractExpr({ selector: o.selector, links: o.links }));
      if (o.selector && !page.matched) {
        console.error(`--selector ${o.selector} matched nothing on ${page.url} ("${page.title}")`);
        return 4;
      }
      const { out, truncated } = formatOutput(page, { maxChars: o.maxChars });
      console.log(out);
      if (truncated) console.error(`text truncated to ${o.maxChars} of ${page.text.length} characters (--max-chars)`);
      return 0;
    });
  } catch (err) {
    console.error(err?.message ?? String(err));
    return err instanceof PageTextError ? err.code : 2;
  }
}
