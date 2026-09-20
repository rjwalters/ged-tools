import { DEFAULT_CDP_ORIGIN } from './cdp-preflight.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { mainRoot, lockDir, lockMetaFile, resolveCacheOut } from '../lib/tools.js';
import { acquireDriverSlot, driverSlotDirFor } from './cdp-transport.js';
const CDP_ORIGIN = DEFAULT_CDP_ORIGIN;

const STATE_FILE = '_state.json';

const DEFAULT_CONCURRENCY = 2;

const DEFAULT_DELAY_MS = 750;

export function sniff(buf) {
  if (!buf || buf.length < 4) return { type: null, ok: false, why: 'empty or truncated response' };
  const b = buf;
  const starts = (...bytes) => bytes.every((v, i) => b[i] === v);

  if (starts(0xff, 0xd8, 0xff)) return { type: 'jpg', ok: true };
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { type: 'png', ok: true };
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return { type: 'tif', ok: true };
  if (starts(0x25, 0x50, 0x44, 0x46)) return { type: 'pdf', ok: true };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { type: 'gif', ok: true };
  if (b.length > 11 && starts(0x52, 0x49, 0x46, 0x46) && b.slice(8, 12).toString('latin1') === 'WEBP') {
    return { type: 'webp', ok: true };
  }

  const head = b.slice(0, 4096).toString('latin1');
  const looksHtml = /^\s*(<!doctype html|<html|<\?xml|\{|\[)/i.test(head);
  const authWords =
    /\b(sign in|signin|log ?in|anmelden|anmeldung|passwor[dt]|authenticat|session (has )?(expired|timed out)|abgemeldet|nicht angemeldet|please log|access denied|unauthori[sz]ed)\b/i.test(
      head
    );
  return {
    type: null,
    ok: false,
    auth: authWords,
    why: authWords
      ? 'response is a login / session-expired page, not an image'
      : looksHtml
        ? 'response is HTML or JSON, not an image'
        : 'response is not a recognised image format',
    head: head.slice(0, 300),
  };
}

export const TOO_SMALL_BYTES = 3000;

export function parseUrlList(text, startAt = 1) {
  const out = new Map();
  let auto = startAt;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\d+)[\s,]+(\S+)$/);
    const n = m ? Number(m[1]) : auto++;
    const url = m ? m[2] : line;
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`not a URL: ${line.slice(0, 120)}`);
    }
    if (out.has(n)) throw new Error(`page ${n} listed twice`);
    out.set(n, url);
  }
  if (!out.size) throw new Error('url list is empty');
  return out;
}

export function expandUrl(template, n) {
  if (!/\{n(:\d+)?\}/.test(template)) {
    throw new Error(`--url template contains no {n} placeholder: ${template}`);
  }
  return template.replace(/\{n(?::(\d+))?\}/g, (_, width) =>
    width ? String(n).padStart(Number(width), '0') : String(n)
  );
}

export function pad(n, width = 4) {
  return String(n).padStart(width, '0');
}

export function loadState(outDir) {
  const p = join(outDir, STATE_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(`checkpoint ${p} is unreadable (${err.message}) — move it aside to start over`);
  }
}

export function saveState(outDir, state) {
  const p = join(outDir, STATE_FILE);
  const tmp = `${p}.tmp`;
  state.updatedAt = new Date().toISOString();
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, p);
}

export function allPages(state) {
  if (Array.isArray(state.pageNumbers)) return [...state.pageNumbers].sort((a, b) => a - b);
  const out = [];
  for (let n = state.from; n <= state.to; n++) out.push(n);
  return out;
}

export function pendingPages(state) {
  return allPages(state).filter((n) => state.pages[String(n)]?.status !== 'done');
}

export function cookieHeader(cookies) {
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

function requireBrowserLock(what, io = {}) {
  const {
    dir = lockDir,
    metaFile = lockMetaFile,
    log = console.error,
    exit = process.exit,
    actualHolder = process.env.BROWSER_LOCK_HOLDER,
  } = io;
  if (existsSync(dir)) {
    let meta = null;
    try {
      meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    } catch {

    }
    if (actualHolder && meta?.holder && actualHolder !== meta.holder) {
      log(`browser lock HELD by ${meta.holder} since ${meta.since ?? '?'} — but this session is ${actualHolder}.`);
      log(`Refusing to ${what}: the mutex belongs to ${meta.holder}, and every research site shares ONE debug`);
      log('Chrome on port 9222 — driving it now would interleave with their navigations.');
      log(`Wait for ${meta.holder} to release it — or, if you ARE the holder, set BROWSER_LOCK_HOLDER to the exact`);
      log('name you passed to `acquire`.');
      return exit(2);
    }
    log(`browser lock HELD by ${meta?.holder ?? 'unknown'} since ${meta?.since ?? '?'} — proceeding`);

    return acquireDriverSlot('register-batch', { slotDir: driverSlotDirFor(dir), log, exit });
  }
  log(`browser lock is FREE — refusing to ${what} without it.`);
  log('Every research site shares ONE debug Chrome on port 9222.');
  log('  ged-tools browser-lock acquire registers --wait 900');
  log('  …then: ged-tools browser-lock release registers');
  log('  …and export BROWSER_LOCK_HOLDER=registers so this check can tell your lock from a sibling’s.');
  return exit(1);
}

async function grabCookies(domain) {
  requireBrowserLock('read cookies out of the shared debug Chrome');

  let tab;
  const res = await fetch(`${CDP_ORIGIN}/json/new?url=about:blank`, { method: 'PUT' }).catch((err) => {
    console.error(`could not reach Chrome's debug endpoint at ${CDP_ORIGIN}: ${err.message}`);
    console.error('Start Chrome with --remote-debugging-port=9222 --user-data-dir="$HOME/.mh-chrome-debug"');
    process.exit(1);
  });
  if (!res.ok) {
    console.error(`PUT ${CDP_ORIGIN}/json/new failed: HTTP ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  tab = await res.json();

  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  const cookies = await new Promise((resolve, reject) => {
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}) =>
      new Promise((r, j) => {
        const mid = ++id;
        pending.set(mid, { r, j });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    ws.onopen = async () => {
      try {
        await send('Network.enable');
        const urls = [`https://${domain}/`, `https://www.${domain}/`];
        const { cookies: got } = await send('Network.getCookies', { urls });
        resolve(got ?? []);
      } catch (err) {
        reject(err);
      }
    };
    ws.onerror = () => reject(new Error(`CDP websocket error on ${tab.webSocketDebuggerUrl}`));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { r, j } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? j(new Error(msg.error.message)) : r(msg.result);
      }
    };
  }).finally(() => {
    try {
      ws.close();
    } catch {

    }
    fetch(`${CDP_ORIGIN}/json/close/${tab.id}`).catch(() => {});
  });

  return cookies;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AuthLost extends Error {}

async function fetchOne(url, cookies, referer) {
  const res = await fetch(url, {
    headers: {
      ...(cookies ? { cookie: cookies } : {}),

      ...(referer ? { referer } : {}),
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(120000),
  });

  if (res.status === 401 || res.status === 403) {
    throw new AuthLost(`HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf };
}

async function runFetch(opts) {
  const { outDir, urlMap, cookiesFile, concurrency, delayMs, referer } = opts;
  let { url, from, to } = opts;
  if (urlMap) {
    const keys = [...urlMap.keys()].sort((a, b) => a - b);
    from = keys[0];
    to = keys[keys.length - 1];

    url = `list:${createHash('sha256').update([...urlMap.values()].join('\n')).digest('hex').slice(0, 16)}`;
  }
  mkdirSync(outDir, { recursive: true });

  let cookies = null;
  if (cookiesFile) {
    if (!existsSync(cookiesFile)) {
      console.error(`cookie file not found: ${cookiesFile}`);
      console.error('Grab one first:  ged-tools register-batch cookies <domain> --out <file>');
      process.exit(1);
    }
    const raw = JSON.parse(readFileSync(cookiesFile, 'utf8'));
    cookies = cookieHeader(Array.isArray(raw) ? raw : (raw.cookies ?? []));
    if (!cookies) {
      console.error(`cookie file ${cookiesFile} contains no cookies — the Chrome session may not be signed in`);
      process.exit(1);
    }
  }

  let state = loadState(outDir);
  if (state && (state.url !== url || state.from !== from || state.to !== to)) {
    console.error(`checkpoint in ${outDir} is for a different job:`);
    console.error(`  existing: ${state.url} [${state.from}..${state.to}]`);
    console.error(`  requested: ${url} [${from}..${to}]`);
    console.error('Use a different --out directory, or move the existing one aside.');
    process.exit(1);
  }
  if (!state) state = { url, from, to, pages: {}, createdAt: new Date().toISOString() };
  if (urlMap) state.pageNumbers = [...urlMap.keys()].sort((a, b) => a - b);

  const todo = pendingPages(state);
  const total = allPages(state).length;
  const already = total - todo.length;
  if (already) console.log(`resuming: ${already}/${total} already downloaded`);
  if (!todo.length) {
    console.log(`nothing to do — all ${total} pages present in ${outDir}`);
    return 0;
  }
  console.log(`fetching ${todo.length} page(s) into ${outDir} (concurrency ${concurrency}, ${delayMs}ms apart)`);

  let stopped = null;
  let done = 0;
  const queue = [...todo];

  const worker = async () => {
    while (queue.length && !stopped) {
      const n = queue.shift();
      const pageUrl = urlMap ? urlMap.get(n) : expandUrl(url, n);
      if (!pageUrl) continue;
      try {
        const { res, buf } = await fetchOne(pageUrl, cookies, referer);
        const kind = sniff(buf);

        if (!kind.ok) {
          if (kind.auth || res.status >= 400) throw new AuthLost(kind.why);

          state.pages[String(n)] = { status: 'failed', why: kind.why, http: res.status };
          saveState(outDir, state);
          console.error(`  p${pad(n)}  SKIPPED — ${kind.why} (HTTP ${res.status})`);
          continue;
        }
        if (buf.length < TOO_SMALL_BYTES) {
          state.pages[String(n)] = { status: 'failed', why: `only ${buf.length} bytes`, http: res.status };
          saveState(outDir, state);
          console.error(`  p${pad(n)}  SKIPPED — image is only ${buf.length} bytes, too small to be a frame`);
          continue;
        }

        const name = `p${pad(n)}.${kind.type}`;
        const tmp = join(outDir, `.${name}.part`);
        writeFileSync(tmp, buf);
        renameSync(tmp, join(outDir, name));
        state.pages[String(n)] = {
          status: 'done',
          file: name,
          bytes: buf.length,
          sha256: createHash('sha256').update(buf).digest('hex'),
        };
        saveState(outDir, state);
        done++;
        console.log(`  p${pad(n)}  ${kind.type} ${(buf.length / 1024).toFixed(0)}KB`);
      } catch (err) {
        if (err instanceof AuthLost) {
          stopped = stopped ?? { n, why: err.message };
          return;
        }
        state.pages[String(n)] = { status: 'failed', why: err.message };
        saveState(outDir, state);
        console.error(`  p${pad(n)}  ERROR — ${err.message}`);
      }
      if (delayMs) await sleep(delayMs);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  const remaining = pendingPages(state).length;
  if (stopped) {
    console.error('');
    console.error(`SESSION LOST at page ${stopped.n} — ${stopped.why}`);
    console.error(`Downloaded ${done} page(s) this run; ${remaining} still to go.`);
    console.error('');
    console.error('Sign back in in the debug Chrome, then re-grab cookies and re-run the SAME command:');
    console.error('  ged-tools browser-lock acquire registers --wait 900');
    console.error(`  ged-tools register-batch cookies <domain> --out ${cookiesFile ?? '<file>'}`);
    console.error('  ged-tools browser-lock release registers');
    console.error('It resumes from the checkpoint — nothing already downloaded is fetched again.');
    return 2;
  }

  console.log('');
  console.log(`done: ${done} page(s) this run, ${total - remaining}/${total} present`);
  if (remaining) console.log(`${remaining} page(s) failed and were skipped — re-run to retry just those`);
  return remaining ? 1 : 0;
}

function runStatus(outDir) {
  const state = loadState(outDir);
  if (!state) {
    console.error(`no checkpoint in ${outDir}`);
    return 1;
  }
  const total = allPages(state).length;
  const pending = pendingPages(state);
  const failed = Object.entries(state.pages).filter(([, r]) => r.status === 'failed');
  console.log(`${outDir}`);
  console.log(`  ${state.url} [${state.from}..${state.to}]`);
  console.log(`  ${total - pending.length}/${total} downloaded, updated ${state.updatedAt ?? '?'}`);
  if (failed.length) {
    console.log(`  ${failed.length} failed:`);
    for (const [n, r] of failed.slice(0, 20)) console.log(`    p${pad(Number(n))}  ${r.why}`);
    if (failed.length > 20) console.log(`    …and ${failed.length - 20} more`);
  }
  return pending.length ? 1 : 0;
}

function usage() {
  console.error(`register-batch.js — resumable batch download of register page images

  cookies <domain> --out <file>       read the signed-in cookies out of the shared
                                      debug Chrome (REQUIRES the browser lock)

  fetch --urls <file> --out <dir> [--cookies <file>]
                                      download an explicit list of urls, one per
                                      line (or "N<TAB>url"). Use this when pages
                                      are not numbered — FamilySearch gives every
                                      image its own ark, so there is no template.

  fetch --url <template> --from N --to M --out <dir> [--cookies <file>]
        [--concurrency ${DEFAULT_CONCURRENCY}] [--delay ${DEFAULT_DELAY_MS}] [--referer <url>]
                                      download pages; resumable; does NOT need the lock

  status --out <dir>                  how far the last run got

  --self-test                         run the built-in tests

The url template must contain {n} (or {n:4} to zero-pad). Nothing that is not
an image is ever written, and the first auth failure stops the run.`);
}

function arg(argv, name, fallback = undefined) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`${name} needs a value`);
    process.exit(1);
  }
  return v;
}

async function main(argv) {
  if (argv.includes('--self-test')) return selfTest();

  const cmd = argv[0];

  let outArg = arg(argv, '--out');
  if (outArg) outArg = resolveCacheOut(outArg);

  if (cmd === 'cookies') {
    const domain = argv[1];
    if (!domain || domain.startsWith('--') || !outArg) {
      usage();
      process.exit(1);
    }
    const cookies = await grabCookies(domain.replace(/^www\./, ''));
    if (!cookies.length) {
      console.error(`no cookies for ${domain} in the debug Chrome — is it signed in there?`);
      process.exit(1);
    }
    mkdirSync(dirname(outArg), { recursive: true });
    writeFileSync(outArg, `${JSON.stringify(cookies, null, 2)}\n`);
    console.log(`wrote ${cookies.length} cookie(s) for ${domain} to ${outArg}`);
    console.error('This file is a live credential — keep it out of git.');
    return;
  }

  if (cmd === 'status') {
    if (!outArg) {
      usage();
      process.exit(1);
    }
    process.exit(runStatus(outArg));
  }

  if (cmd === 'fetch') {
    const urlsFile = arg(argv, '--urls');
    const url = arg(argv, '--url');
    if (urlsFile && url) {
      console.error('--urls and --url are alternatives; pass one');
      process.exit(1);
    }
    let urlMap = null;
    let from;
    let to;
    if (urlsFile) {
      if (!existsSync(urlsFile)) {
        console.error(`url list not found: ${urlsFile}`);
        process.exit(1);
      }
      try {
        urlMap = parseUrlList(readFileSync(urlsFile, 'utf8'), Number(arg(argv, '--from', 1)));
      } catch (err) {
        console.error(`${urlsFile}: ${err.message}`);
        process.exit(1);
      }
      console.log(`${urlMap.size} url(s) from ${urlsFile}`);
    } else {
      from = Number(arg(argv, '--from'));
      to = Number(arg(argv, '--to'));
      if (!url || !Number.isInteger(from) || !Number.isInteger(to)) {
        usage();
        process.exit(1);
      }
      if (to < from) {
        console.error(`--to (${to}) is before --from (${from})`);
        process.exit(1);
      }
    }
    if (!outArg) {
      usage();
      process.exit(1);
    }
    const code = await runFetch({
      outDir: outArg,
      urlMap,
      url,
      from,
      to,
      cookiesFile: arg(argv, '--cookies'),
      concurrency: Math.max(1, Number(arg(argv, '--concurrency', DEFAULT_CONCURRENCY))),
      delayMs: Math.max(0, Number(arg(argv, '--delay', DEFAULT_DELAY_MS))),
      referer: arg(argv, '--referer'),
    });
    process.exit(code);
  }

  usage();
  process.exit(1);
}
export { STATE_FILE, main, arg, usage, DEFAULT_CONCURRENCY, DEFAULT_DELAY_MS, grabCookies, requireBrowserLock, CDP_ORIGIN, runStatus, runFetch, fetchOne, AuthLost, sleep };

function selfTest() { throw new Error("Run npm test in the ged-tools source checkout; private fixtures are not distributed."); }
