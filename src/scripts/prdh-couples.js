import { DEFAULT_CDP_ORIGIN } from './cdp-preflight.js';
import { recordsDir } from '../lib/tools.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ensureCdpTarget, closeCdpTarget } from './cdp-preflight.js';
import { lockDir, lockMetaFile } from '../lib/tools.js';
import { acquireDriverSlot, driverSlotDirFor } from './cdp-transport.js';
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

const FREE_AREA = 'Gratuit';

const MEMBER_AREA = 'Membership';

const COUPLE_LIST_PATH = 'Liste/Couple';

export const COUPLE_LIST_PARAMS = ['nh', 'ph', 'nf', 'pf', 'amin', 'amax', 'pg'];

export const RECORD_KINDS = ['famille', 'union', 'acte', 'individu'];

export function coupleListUrl({ nh = '', ph = '', nf = '', pf = '', amin = '', amax = '', pg = 1, member = false } = {}) {
  const raw = { nh, ph, nf, pf, amin, amax, pg };
  const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());
  if (!clean(nh) && !clean(nf)) {
    throw new Error('a couple-list query needs at least a husband surname (--nh) or a wife surname (--nf)');
  }
  const params = new URLSearchParams();
  for (const k of COUPLE_LIST_PARAMS) params.set(k, clean(raw[k]));
  return `${PRDH_ORIGIN}/${member ? MEMBER_AREA : FREE_AREA}/en/PRDH/${COUPLE_LIST_PATH}?${params}`;
}

const FREE_SURFACE_PATH = new RegExp(`^\\/(?:${FREE_AREA}|${MEMBER_AREA})\\/en\\/PRDH\\/${COUPLE_LIST_PATH.replace('/', '\\/')}$`);

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
      `refusing to fetch ${u.pathname} — scripts/prdh-couples.js drives PRDH's FREE couple list only. ` +
        'Opening a record file spends a hit; that is scripts/prdh-record.js’s job.'
    );
  }
  return url;
}

const CELL_ORDER = ['date', 'type', 'parish', 'role', 'husbandAge', 'husbandSurname', 'husbandGiven', 'wifeAge', 'wifeSurname', 'wifeGiven'];

const ACT_ID_HREF_SEGMENTS = ['proposition-abonnement', 'Acte'];

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

const row = (actId, cells) => {
  const c = Object.fromEntries(CELL_ORDER.map((k, i) => [k, cells[i] ?? '']));
  return {
    actId: actId ?? null,
    date: c.date,
    type: c.type,
    parish: c.parish,
    role: c.role,
    husbandSurname: c.husbandSurname,
    husbandGiven: c.husbandGiven,
    husbandAge: c.husbandAge,
    wifeSurname: c.wifeSurname,
    wifeGiven: c.wifeGiven,
    wifeAge: c.wifeAge,
  };
};

export function actIdFromRowHtml(rowHtml) {
  const src = String(rowHtml ?? '');
  const th = src.match(/<th\b[^>]*>\s*(\d+)\s*<\/th>/i);
  if (th) return th[1];
  const anchor = src.match(/<a\b[^>]*class="date"[^>]*>/i);
  const href = (anchor ? anchor[0] : src).match(new RegExp(`href="[^"]*?\\/(?:${ACT_ID_HREF_SEGMENTS.join('|')})\\/(\\d+)"`, 'i'));
  return href ? href[1] : null;
}

export function parseCoupleRowsFromHtml(html) {
  const src = String(html ?? '');
  const rows = [];
  for (const m of src.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)) {
    const tr = m[0];

    if (!/class="date"/i.test(tr)) continue;
    const cells = [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cellText(c[1]));
    if (cells.length < CELL_ORDER.length) continue;
    rows.push(row(actIdFromRowHtml(tr), cells));
  }
  return rows;
}

export function parseCoupleRowsFromText(text) {
  const lines = String(text ?? '').split(/\r\n|\r|\n/);
  const head = lines.findIndex((l) => /^(?:idActe\t)?date\ttype\t/.test(l));
  if (head === -1) return [];
  const member = lines[head].startsWith('idActe');
  const width = CELL_ORDER.length + (member ? 1 : 0);
  const rows = [];
  for (const line of lines.slice(head + 1)) {
    const fields = line.split('\t').map((f) => f.trim());
    if (fields.length < width) break;
    rows.push(row(member ? fields[0] : null, fields.slice(member ? 1 : 0, width)));
  }
  return rows;
}

export const detectMode = (text) => (/\bHello,/.test(String(text ?? '')) || /^idActe\t/m.test(String(text ?? '')) ? 'member' : 'anonymous');

export function parseCoupleRows({ html = '', text = '' } = {}) {
  const fromHtml = parseCoupleRowsFromHtml(html);
  return fromHtml.length ? fromHtml : parseCoupleRowsFromText(text);
}

export function slugFor({ nh = '', ph = '', nf = '', pf = '', amin = '', amax = '', pg = 1 } = {}) {
  return ['couple', nh, ph, nf, pf, amin, amax, String(pg) === '1' ? '' : `pg${pg}`]
    .filter((p) => p !== '' && p !== undefined && p !== null)
    .join('-')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function requireBrowserLock(io = {}) {
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
    } catch (err) {
      log(`browser lock held, but ${metaFile} is unreadable: ${err.message}`);
    }
    if (actualHolder && meta?.holder && actualHolder !== meta.holder) {
      log(`browser lock HELD by ${meta.holder} since ${meta.since ?? '?'} — but this session is ${actualHolder}.`);
      log(`Refusing: the mutex belongs to ${meta.holder}, and driving the shared debug Chrome now would interleave`);
      log('navigations with theirs and silently cross-contaminate both sides of the results.');
      log(`Wait for ${meta.holder} to release it — or, if you ARE the holder, set BROWSER_LOCK_HOLDER to the exact`);
      log('name you passed to `acquire`.');
      return exit(2);
    }
    log(`browser lock HELD by ${meta?.holder ?? 'unknown'} since ${meta?.since ?? '?'} — proceeding`);

    return acquireDriverSlot('prdh-couples', { slotDir: driverSlotDirFor(dir), log, exit });
  }
  log('browser lock is FREE — refusing to drive the shared debug Chrome without it.');
  log('Two agents on port 9222 interleave navigations and silently cross-contaminate results.');
  log('Acquire it first, and hold it across your whole batch:');
  log('  ged-tools browser-lock acquire <holder> --wait 900');
  log('  …then: ged-tools browser-lock release <holder>');
  log('  …and export BROWSER_LOCK_HOLDER=<holder> so this check can tell your lock from a sibling’s.');
  log('Pass --no-lock-check to override for an interactive one-off.');
  return exit(1);
}

const CDP_ORIGIN = DEFAULT_CDP_ORIGIN;

const CDP_CONNECT_TIMEOUT_MS = 10000;

const CDP_SEND_TIMEOUT_MS = 30000;

function connect(wsUrl, connectTimeoutMs = CDP_CONNECT_TIMEOUT_MS, sendTimeoutMs = CDP_SEND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    let settled = false;
    const pending = new Map();
    const failPending = (err) => {
      for (const { rej, timer } of pending.values()) {
        clearTimeout(timer);
        rej(err);
      }
      pending.clear();
    };
    const handshakeTimer = setTimeout(() => {
      if (settled) return;
      settled = true;

      try {
        ws.close();
      } catch {

      }
      reject(new Error(`CDP connect to ${wsUrl} timed out after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimer);
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const mid = ++id;
            const timer = setTimeout(() => {
              pending.delete(mid);
              rej(new Error(`CDP ${method} (message ${mid}) timed out after ${sendTimeoutMs}ms`));
            }, sendTimeoutMs);
            pending.set(mid, { res, rej, timer });
            try {
              ws.send(JSON.stringify({ id: mid, method, params }));
            } catch (err) {
              clearTimeout(timer);
              pending.delete(mid);
              rej(new Error(`CDP ${method} could not be sent: ${describe(err)}`));
            }
          }),
        close: () => ws.close(),

        pendingCount: () => pending.size,
      });
    };
    ws.onerror = (ev) => {
      const err = new Error(`CDP websocket error on ${wsUrl}${ev?.message ? `: ${ev.message}` : ''}`);
      if (!settled) {
        settled = true;
        clearTimeout(handshakeTimer);
        reject(err);
      }
      failPending(err);
    };
    ws.onclose = (ev) => {
      const err = new Error(`CDP websocket closed (code ${ev?.code ?? '?'}) before the reply arrived`);
      if (!settled) {
        settled = true;
        clearTimeout(handshakeTimer);
        reject(err);
      }
      failPending(err);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        msg.error ? rej(new Error(`${msg.error.message} (CDP code ${msg.error.code})`)) : res(msg.result);
      }
    };
  });
}

async function fetchCoupleList(url, timeoutMs) {
  assertFreeSurface(url);
  let tab;
  try {
    tab = await ensureCdpTarget(CDP_ORIGIN);
    const cdp = await connect(tab.webSocketDebuggerUrl);
    try {
      await cdp.send('Page.enable');
      await cdp.send('Page.navigate', { url });

      const evaluate = async (expression) => (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result.value ?? '';
      const getHtml = () => evaluate('document.documentElement ? document.documentElement.outerHTML : ""');
      const getText = () => evaluate('document.body ? document.body.innerText : ""');

      const getUrl = () => evaluate('location.href');

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
        console.error('(waiting for the couple list to render)');
      }
      return { html, text, finalUrl, verdict };
    } finally {
      cdp.close();
    }
  } finally {
    await closeCdpTarget(tab, CDP_ORIGIN);
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
      [r.actId ?? '?', r.date, r.type, r.role, `${r.husbandSurname} ${r.husbandGiven}`.trim(), `${r.wifeSurname} ${r.wifeGiven}`.trim(), r.parish]
        .join('\t')
    );
  }
  console.log('===END===');
};

const USAGE = [
  'usage: ged-tools prdh-couples --nh SURNAME [--ph GIVEN] [--nf SURNAME] [--pf GIVEN]',
  '                                    [--amin YEAR] [--amax YEAR] [--page N|N-M]',
  '                                    [--member] [--timeout SECS] [--no-lock-check] [--json]',
  '       ged-tools prdh-couples --self-test',
].join('\n');

export function parsePageSpec(spec) {
  const s = String(spec ?? '1').trim();
  const range = s.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) {
    const [from, to] = [Number(range[1]), Number(range[2])];
    if (from < 1 || to < from) throw new Error(`bad --page range ${JSON.stringify(s)}`);
    if (to - from + 1 > 20) throw new Error(`--page ${s} asks for ${to - from + 1} pages; 20 is the most this will fetch in one run`);
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  if (!/^\d+$/.test(s) || Number(s) < 1) throw new Error(`bad --page ${JSON.stringify(s)} — expected N or N-M`);
  return [Number(s)];
}

const KNOWN_FLAGS = new Set([
  '--nh', '--ph', '--nf', '--pf', '--amin', '--amax', '--page',
  '--member', '--json', '--no-lock-check', '--timeout', '--self-test',
]);

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
    amin: flag('--amin') ?? '',
    amax: flag('--amax') ?? '',
    pages: parsePageSpec(flag('--page') ?? '1'),
    member: argv.includes('--member'),
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
    urls = q.pages.map((pg) => assertFreeSurface(coupleListUrl({ ...q, pg })));
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(1);
  }

  if (!q.noLockCheck) requireBrowserLock();
  console.log(`mode: ${q.member ? 'MEMBER' : 'FREE'} (both are free — only record files cost a hit)`);

  const verdicts = [];
  let skipped = 0;
  for (const [i, url] of urls.entries()) {
    const pg = q.pages[i];
    const stem = `${slugFor({ ...q, pg })}-${createHash('sha1').update(url).digest('hex').slice(0, 8)}`;
    console.log(`\n===URL=== ${url}`);
    let page;
    try {
      page = await fetchCoupleList(url, q.timeoutMs);
    } catch (err) {
      console.error(`FAILED ${url}: ${describe(err)}`);
      verdicts.push('FAILED');
      continue;
    }
    const rel = save(stem, page.html, page.text, page.verdict);
    console.log(`VERDICT ${page.verdict}  ${url}  (saved ${rel}, ${page.html.length} bytes)`);
    verdicts.push(page.verdict);
    if (aborts(page.verdict)) {
      console.error('subscribers interstitial — aborting the batch rather than quarantining page after page (#79).');
      skipped = urls.length - i - 1;
      break;
    }
    const rows = parseCoupleRows(page);
    console.log(`mode: ${detectMode(page.text)} | rows: ${rows.length} | act ids: ${rows.filter((r) => r.actId).length}`);
    if (q.json) console.log(JSON.stringify(rows, null, 1));
    else printRows(rows);
  }

  console.log(`\n${summarize(verdicts, skipped)}`);
  process.exit(exitCodeFor(verdicts));
}
export { PRDH_ORIGIN, PRDH_HOST, MEMBER_AREA, FREE_AREA, COUPLE_LIST_PATH, FREE_SURFACE_PATH, ACT_ID_HREF_SEGMENTS, cellText, decodeEntities, CELL_ORDER, row, main, parseArgs, KNOWN_FLAGS, USAGE, requireBrowserLock, fetchCoupleList, CDP_ORIGIN, connect, CDP_CONNECT_TIMEOUT_MS, CDP_SEND_TIMEOUT_MS, describe, sleep, save, outDir, root, printRows };
