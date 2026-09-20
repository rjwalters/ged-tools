// Tile-plane pacing: observed throttling after ~500 CUMULATIVE tiles.
// Keep per-tile pacing, bounded backoff, progress reporting, and stall detection.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { mainRoot, archionLockDir, archionLockMetaFile, resolveCacheOut } from '../lib/tools.js';
import { openTab, closeTab, connect, evaluate, requireBrowserLock, browserLockHint, touchBrowserLock } from './cdp-transport.js';
import { chromeLaunchHint } from './cdp-preflight.js';
import { safeDownloadPath } from './cdp-download-guard.js';
export const ORIGIN = 'https://www.archion.de';

export const BROWSE_BASE = '/de/alle-archive/';

export const LOGIN_PAGE = `${ORIGIN}/de/login`;

export const ARCHION_DEFAULT_PORT = 9223;

export const ARCHION_PROFILE_DIR = process.env.ARCHION_PROFILE_DIR || join(homedir(), '.archion-chrome-debug');

export const CHROME_BINARY = process.env.GENEALOGY_CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function resolveCdpPort(argv, env = process.env) {
  const flag = argOf(argv, '--port');
  const raw = flag ?? env.ARCHION_CDP_PORT;
  if (raw == null || raw === '') return ARCHION_DEFAULT_PORT;
  const p = Number(raw);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new Error(`not a CDP port: ${JSON.stringify(raw)} (from ${flag != null ? '--port' : 'ARCHION_CDP_PORT'})`);
  }
  return p;
}

export const cdpOriginFor = (port) => `http://127.0.0.1:${port}`;

export function archionLockIo(port) {
  if (port === 9222) return {};
  return { lockDir: archionLockDir, metaFile: archionLockMetaFile, hintSuffix: ' --browser archion' };
}

export function archionLaunchHint(port = ARCHION_DEFAULT_PORT) {
  return `Launch the dedicated Archion Chrome with:\n  ged-tools archion chrome-up\nor by hand:\n${chromeLaunchHint(port, ARCHION_PROFILE_DIR)}`;
}

let CDP_PORT = ARCHION_DEFAULT_PORT;

async function probeChrome(origin) {
  try {
    const res = await fetch(`${origin}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function cmdChromeUp() {
  if (CDP_PORT === 9222) {
    console.error('chrome-up refuses port 9222 — that is the SHARED research Chrome (profile ~/.mh-chrome-debug),');
    console.error('not the Archion one. Drop --port/ARCHION_CDP_PORT, or launch the shared Chrome by hand.');
    return 1;
  }
  const origin = cdpOriginFor(CDP_PORT);
  const already = await probeChrome(origin);
  if (already) {
    console.error(`Archion Chrome already up at ${origin} (${already.Browser ?? 'unknown build'}, profile ${ARCHION_PROFILE_DIR})`);
    return 0;
  }
  if (!existsSync(CHROME_BINARY)) {
    console.error(`Chrome binary not found at ${CHROME_BINARY} — launch by hand:\n${archionLaunchHint(CDP_PORT)}`);
    return 1;
  }
  const { spawn } = await import('node:child_process');
  const child = spawn(
    CHROME_BINARY,
    [
      `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${ARCHION_PROFILE_DIR}`, '--no-first-run', '--no-default-browser-check',

      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(500);
    const v = await probeChrome(origin);
    if (v) {
      console.error(`Archion Chrome up at ${origin} (${v.Browser ?? '?'}, profile ${ARCHION_PROFILE_DIR})`);
      return 0;
    }
  }
  console.error(`spawned Chrome but ${origin}/json/version did not answer within 15 s — check by hand:\n${archionLaunchHint(CDP_PORT)}`);
  return 1;
}

export function viewerUrl(volumeId) {
  const id = String(volumeId ?? '').trim();
  if (!/^\d+$/.test(id)) throw new Error(`not an Archion volume id (want digits, got ${JSON.stringify(volumeId)})`);
  return `${ORIGIN}/de/viewer/?no_cache=1&type=churchRegister&uid=${id}`;
}

export const BROWSE_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ENV_FILE = process.env.ARCHION_ENV_FILE || join(mainRoot, '.env');

export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1].startsWith('#')) continue;
    if (/^\s*#/.test(line)) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function redactSecrets(text, secrets = []) {
  let s = String(text ?? '');
  for (const secret of secrets) {
    if (!secret) continue;

    let form = String(secret);
    const forms = [form];
    for (let depth = 0; depth < 3; depth++) {
      form = JSON.stringify(form).slice(1, -1);
      if (!forms.includes(form)) forms.push(form);
    }
    for (const f of forms.sort((a, b) => b.length - a.length)) s = s.split(f).join('[REDACTED]');
  }
  return s;
}

function readCredentials() {
  if (!existsSync(ENV_FILE)) {
    throw new Error(`no ${ENV_FILE} — put ARCHION_USERNAME/ARCHION_PASSWORD there (gitignored; see your source-access notes § Archion)`);
  }
  const env = parseEnvFile(readFileSync(ENV_FILE, 'utf8'));
  const user = env.ARCHION_USERNAME;
  const pass = env.ARCHION_PASSWORD;
  if (!user || !pass) throw new Error(`${ENV_FILE} is missing ARCHION_USERNAME and/or ARCHION_PASSWORD`);
  return { user, pass };
}

export function browseUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return `${ORIGIN}${BROWSE_BASE}`;
  if (/^https?:\/\//i.test(raw)) {
    const u = new URL(raw);
    if (!/(^|\.)archion\.de$/.test(u.hostname)) throw new Error(`not an archion.de URL: ${raw}`);
    return u.href;
  }
  let path = raw.replace(/^\/+/, '');
  path = path.replace(/^de\/alle-archive\//, '').replace(/^alle-archive\//, '');
  return `${ORIGIN}${BROWSE_BASE}${path}`;
}

const collapseWs = (s) => String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

export function parseBrowseTree(html) {
  const src = String(html ?? '');
  const volumes = [];
  const seenVolumeIds = new Set();
  const liRe = /<li id="(\d+)" class="item([^"]*)"[\s\S]*?<span class="d-inline-block">([\s\S]*?)<\/span>\s*<\/a>/g;
  for (const m of src.matchAll(liRe)) {
    const [, id, cls, body] = m;
    if (seenVolumeIds.has(id)) continue;
    seenVolumeIds.add(id);
    const title = collapseWs(body.split(/<br\s*\/?>/i)[0]);
    const years = title.match(/\d{4}(?:\s*[-–]\s*\d{4})?/g)?.join(', ') ?? '';
    const digitized = !/notdigitallyavailable/.test(cls);
    const ocr = /completelyocred/.test(cls);
    const href = m[0].match(/href="([^"]+)"/)?.[1] ?? null;
    volumes.push({ id, title, years, digitized, ocr, href });
  }
  const children = [];
  const seen = new Set();
  const aRe = /<a[^>]*href="(\/de\/alle-archive\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of src.matchAll(aRe)) {
    const href = m[1].replace(/\/+$/, '');
    const name = collapseWs(m[2]);
    const path = href.replace(/^\/de\/alle-archive\//, '');
    if (!name || seen.has(href)) continue;
    if (/^(de|en)$/i.test(name)) continue;
    if (/^\d+$/.test(href.split('/').pop())) continue;
    seen.add(href);
    children.push({ name, path, href });
  }
  return { volumes, children };
}

async function cmdBrowse(argv) {
  const grep = argOf(argv, '--grep');
  const asJson = argv.includes('--json');
  const target = positionals(argv)[0] ?? '';
  const url = browseUrl(target);
  const res = await fetch(url, { headers: { 'user-agent': BROWSE_UA }, signal: AbortSignal.timeout(30000), redirect: 'follow' });
  if (!res.ok) {
    console.error(`GET ${url} → HTTP ${res.status}`);
    return 1;
  }
  let { volumes, children } = parseBrowseTree(await res.text());
  if (grep) {
    const g = grep.toLowerCase();
    volumes = volumes.filter((v) => `${v.id} ${v.title}`.toLowerCase().includes(g));
    children = children.filter((c) => c.name.toLowerCase().includes(g) || c.path.toLowerCase().includes(g));
  }
  if (asJson) {
    console.log(JSON.stringify({ url, volumes, children }, null, 2));
    return 0;
  }
  console.error(`# ${url}`);
  if (volumes.length) {
    console.log('id      | flags | title');
    for (const v of volumes) {
      const flags = v.ocr ? 'D+OCR' : v.digitized ? 'D    ' : '-    ';
      console.log(`${v.id.padEnd(7)} | ${flags} | ${v.title}`);
    }
    console.error(`${volumes.length} volume(s) — D = digitized, OCR = fully text-indexed (transkribiert), - = not digitized`);
  }
  if (children.length) {
    for (const c of children) console.log(`${c.path}  —  ${c.name}`);
    console.error(`${children.length} child path(s) — pass one back to \`browse\` to descend`);
  }
  if (!volumes.length && !children.length) {
    console.error('nothing recognisable on that page — wrong path, or the markup changed (fix parseBrowseTree)');
    return 1;
  }
  return 0;
}

export function sessionVerdict({ hasLoginForm, hasLogout, hasChallenge, url, error } = {}) {
  if (error) return 'INCONCLUSIVE';
  if (hasChallenge) return 'CHALLENGE';
  if (hasLogout) return 'ALIVE';
  if (hasLoginForm) return 'SIGNED_OUT';
  if (!url) return 'INCONCLUSIVE';
  return 'INCONCLUSIVE';
}

export function verdictExitCode(verdict) {
  if (verdict === 'ALIVE') return 0;
  if (verdict === 'SIGNED_OUT') return 2;
  if (verdict === 'CHALLENGE') return 4;
  return 3;
}

export function sessionProbeExpr() {
  return `(() => {
  const q = (s) => !!document.querySelector(s);
  const scope = document.querySelector('.account-nav')?.textContent ?? '';
  return JSON.stringify({
    url: location.href,
    title: document.title,
    hasLoginForm: q('form input[name="pass"]'),
    hasLogout: q('input[name="logintype"][value="logout"]') || /abmelden|logout/i.test(scope)
      || q('a[href*="logintype=logout"]'),
    hasChallenge: q('iframe[src*="captcha" i]') || q('[class*="captcha" i]') || q('[id*="captcha" i]')
      || /zwei-faktor|two-factor|verifizierungscode/i.test((document.body?.innerText ?? '').slice(0, 4000)),
  });
})()`;
}

export const DOWNLOAD_CAP = 50;

export const BUDGET_FILE = process.env.ARCHION_BUDGET_FILE || join(mainRoot, '.archion-downloads.json');

export const isoDay = (d = new Date()) => d.toISOString().slice(0, 10);

export function windowEnd(startIso) {
  const m = String(startIso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`not a YYYY-MM-DD date: ${JSON.stringify(startIso)}`);
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const lastOfTarget = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  const end = new Date(Date.UTC(y, mo, Math.min(day, lastOfTarget)));
  return end.toISOString().slice(0, 10);
}

export const windowSpent = (w) => (w?.seed ?? 0) + (w?.downloads?.length ?? 0);

export function activeWindow(state, nowIso) {
  const windows = state?.windows ?? [];
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i];
    if (w?.start && nowIso >= w.start && nowIso < windowEnd(w.start)) return w;
  }
  return null;
}

export function budgetLine(state, nowIso, cap = DOWNLOAD_CAP) {
  const w = activeWindow(state, nowIso);
  if (!w) return `budget: no active pass window (ledger ${BUDGET_FILE}; \`budget --init <start> [--spent N]\` or the first download opens one)`;
  const spent = windowSpent(w);
  const capHere = w.cap ?? cap;
  const seed = w.seed ? ` (${w.seed} seeded from the account counter + ${w.downloads?.length ?? 0} ledgered)` : '';
  return `budget: ${spent}/${capHere} downloads spent${seed}, ${Math.max(0, capHere - spent)} remaining (pass ${w.start} → ${windowEnd(w.start)})`;
}

export function budgetGate(state, nowIso, { cap = DOWNLOAD_CAP, force = false } = {}) {
  const w = activeWindow(state, nowIso);
  const spent = windowSpent(w);
  const capHere = w?.cap ?? cap;
  if (spent < capHere) return { ok: true, reason: null };
  if (force) return { ok: true, reason: `OVER CAP by --force (${spent}/${capHere} already spent)` };
  return {
    ok: false,
    reason: `download budget EXHAUSTED: ${spent}/${capHere} spent in the pass ${w.start} → ${windowEnd(w.start)}. ` +
      'Each download is real, irrevocable quota. Re-run with --force ONLY if the operator has confirmed the overage.',
  };
}

export function recordDownload(state, nowIso, meta = {}) {
  const next = { windows: (state?.windows ?? []).map((w) => ({ ...w, downloads: [...(w.downloads ?? [])] })) };
  let w = activeWindow(next, nowIso);
  if (!w) {
    w = { start: nowIso, cap: DOWNLOAD_CAP, downloads: [] };
    next.windows.push(w);
  }
  w.downloads.push({ at: new Date().toISOString(), ...meta });
  return next;
}

export const pendingDownloadToken = () => `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export function reconcileVerdict({ fileArrived = false, docStatus = null } = {}) {
  if (fileArrived) return 'resolve';
  if (docStatus === 404) return 'unrecord';
  return 'keep';
}

export function resolvePending(state, token, meta = {}) {
  return {
    windows: (state?.windows ?? []).map((w) => ({
      ...w,
      downloads: (w.downloads ?? []).map((d) => {
        if (d.token !== token) return d;
        const { pending, ...rest } = d;
        return { ...rest, ...meta };
      }),
    })),
  };
}

export function unrecordPending(state, token) {
  return {
    windows: (state?.windows ?? []).map((w) => ({
      ...w,
      downloads: (w.downloads ?? []).filter((d) => d.token !== token),
    })),
  };
}

export function syncWindow(state, nowIso, spent) {
  const n = Number(spent);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--sync wants a non-negative integer (got ${JSON.stringify(spent)})`);
  const next = { windows: (state?.windows ?? []).map((w) => ({ ...w, downloads: [...(w.downloads ?? [])] })) };
  const w = activeWindow(next, nowIso);
  if (!w) throw new Error('no active pass window to sync — open one first (budget --init <start> --spent N)');
  const ledgered = w.downloads.length;
  if (n < ledgered) {
    throw new Error(`--sync ${n} is LESS than the ${ledgered} downloads this ledger has recorded — the account cannot have spent fewer than we watched it spend; re-read the account counter`);
  }
  w.seed = n - ledgered;
  w.seedNote = `synced to the account counter (${n} spent) on ${nowIso}`;
  if (w.seed === 0) {
    delete w.seed;
    delete w.seedNote;
  }
  return next;
}

function loadBudget() {
  if (!existsSync(BUDGET_FILE)) return { windows: [] };
  try {
    return JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));
  } catch (e) {

    throw new Error(`${BUDGET_FILE} is unreadable (${e.message}) — fix or move it before downloading`);
  }
}

const saveBudget = (state) => writeFileSync(BUDGET_FILE, `${JSON.stringify(state, null, 2)}\n`);

function cmdBudget(argv) {
  const init = argOf(argv, '--init');
  const spentArg = argOf(argv, '--spent');
  const sync = argOf(argv, '--sync');
  let state = loadBudget();
  if (init) {
    windowEnd(init);
    if (activeWindow(state, init)) {
      console.error(`a window already covers ${init} — nothing to init (use --sync to adjust its count)`);
    } else {
      const seed = spentArg == null ? 0 : Number(spentArg);
      if (!Number.isInteger(seed) || seed < 0) {
        console.error(`--spent wants a non-negative integer (got ${JSON.stringify(spentArg)})`);
        return 1;
      }
      const w = { start: init, cap: DOWNLOAD_CAP, downloads: [] };
      if (seed > 0) {
        w.seed = seed;
        w.seedNote = `seeded at init: ${seed} already spent outside this ledger (the account counter is the truth)`;
      }
      state = { windows: [...(state.windows ?? []), w] };
      saveBudget(state);
      console.error(`opened pass window ${init} → ${windowEnd(init)} (cap ${DOWNLOAD_CAP}${seed ? `, ${seed} already spent` : ''})`);
    }
  }
  if (sync != null) {
    state = syncWindow(state, isoDay(), sync);
    saveBudget(state);
    console.error('synced to the account counter');
  }
  console.log(budgetLine(state, isoDay()));
  return 0;
}

export function zeroControlVerdict(hits, controlHits) {
  if (hits > 0) return { exit: 0, message: `${hits} hit(s)` };
  if (controlHits == null) {
    return { exit: 1, message: '0 hits, but NO control was run — a zero is only reportable with --control <term-known-present> (FreeBMD/#86 rule)' };
  }
  if (controlHits > 0) {
    return { exit: 0, message: `verified zero: 0 hits, and the control term hit ${controlHits} time(s), so the search surface works` };
  }
  return { exit: 6, message: 'UNREPORTABLE: 0 hits AND the control term hit 0 — the search surface is not working (dead session? wrong volume?); this is not a finding' };
}

async function withTab(url, settleMs, fn) {
  let tab = null;
  let cdp = null;
  const open = async () => {

    tab = await openTab(cdpOriginFor(CDP_PORT), archionLaunchHint(CDP_PORT));
    cdp = await connect(tab.webSocketDebuggerUrl, undefined, undefined, () => touchBrowserLock(archionLockIo(CDP_PORT)));
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url });
    await sleep(settleMs);
  };
  const close = async () => {
    try {
      cdp?.close();
    } catch {

    }
    try {
      if (tab) await closeTab(tab, cdpOriginFor(CDP_PORT));
    } catch {

    }
    cdp = null;
    tab = null;
  };
  await open();
  try {
    return await fn({
      eval: (expr) => evaluate(cdp, expr),
      send: (method, params) => cdp.send(method, params),
      on: (handler) => cdp.on(handler),
      reopen: async () => {
        await close();
        await open();
      },
    });
  } finally {
    await close();
  }
}

async function probeSession(h) {
  try {
    return JSON.parse(await h.eval(sessionProbeExpr()));
  } catch (e) {
    return { error: String(e.message ?? e) };
  }
}

function reportVerdict(verdict, probe) {
  const where = probe?.url ? ` at ${probe.url}` : '';
  if (verdict === 'ALIVE') console.error(`session ALIVE${where} — signed in`);
  else if (verdict === 'SIGNED_OUT') console.error(`session SIGNED OUT${where} — run \`ged-tools archion login\``);
  else if (verdict === 'CHALLENGE') {
    console.error(`CHALLENGE${where} — archion.de is showing a captcha / 2FA wall.`);
    console.error('STOP: this needs the operator, in the real browser. Never automate past it (#342).');
  } else console.error(`session INCONCLUSIVE${where} — could not classify the page (${probe?.error ?? 'no signals'})`);
  return verdictExitCode(verdict);
}

async function cookiePersistenceLine(h) {
  try {
    const { cookies } = await h.send('Network.getCookies', {});
    const c = (cookies ?? []).find((k) => typeof k.name === 'string' && k.name.startsWith('fe_typo_user'));
    if (!c) return null;
    return c.session
      ? `${c.name} cookie: SESSION-SCOPED — "Angemeldet bleiben" was not ticked; this session may drop within minutes (#463)`
      : `${c.name} cookie: persistent (expires ${new Date(c.expires * 1000).toISOString().slice(0, 10)})`;
  } catch {
    return null;
  }
}

async function cmdSession(argv) {
  const settleMs = settleOf(argv);
  return withTab(LOGIN_PAGE, settleMs, async (h) => {
    const probe = await probeSession(h);
    const verdict = sessionVerdict(probe);
    const cookieLine = await cookiePersistenceLine(h);
    if (cookieLine) console.error(cookieLine);
    console.error(budgetLine(loadBudget(), isoDay()));
    return reportVerdict(verdict, probe);
  });
}

export function loginFillExpr(user, pass) {
  return `(() => {
  const u = document.querySelector('input[name="user"]');
  const p = document.querySelector('input[name="pass"]');
  if (!u || !p || !u.form) return 'no-form';
  u.value = ${JSON.stringify(String(user))};
  u.dispatchEvent(new Event('input', { bubbles: true }));
  p.value = ${JSON.stringify(String(pass))};
  p.dispatchEvent(new Event('input', { bubbles: true }));
  const remember = u.form.querySelector('input[name="permalogin"][type="checkbox"], input[type="checkbox"]');
  if (remember && !remember.checked) remember.click();
  const btn = u.form.querySelector('input[type="submit"], button[type="submit"]');
  if (!btn) return 'no-submit';
  btn.click();
  return remember ? 'submitted' : 'submitted-no-remember';
})()`;
}

async function cmdLogin(argv) {
  const settleMs = settleOf(argv);
  const { user, pass } = readCredentials();
  const redact = (s) => redactSecrets(s, [pass]);
  return withTab(LOGIN_PAGE, settleMs, async (h) => {
    const before = await probeSession(h);
    const verdictBefore = sessionVerdict(before);
    if (verdictBefore === 'ALIVE') {
      console.error('already signed in — nothing to do');
      console.error(budgetLine(loadBudget(), isoDay()));
      return 0;
    }
    if (verdictBefore === 'CHALLENGE') return reportVerdict('CHALLENGE', before);
    if (verdictBefore === 'INCONCLUSIVE') return reportVerdict('INCONCLUSIVE', before);
    let filled;
    try {
      filled = await h.eval(loginFillExpr(user, pass));
    } catch (e) {

      console.error(redact(`login fill failed: ${e.message ?? e}`));
      return 3;
    }
    if (filled !== 'submitted' && filled !== 'submitted-no-remember') {
      console.error(`login form not usable (${filled}) — the /de/login markup may have changed`);
      return 3;
    }
    if (filled === 'submitted-no-remember') {
      console.error('warning: no "Angemeldet bleiben" checkbox on the login form — submitted anyway, '
        + 'but the session cookie may not persist across navigations (#463)');
    }
    await sleep(settleMs);
    const after = await probeSession(h);
    const verdictAfter = sessionVerdict(after);
    if (verdictAfter === 'ALIVE') {
      console.error(`signed in as ${user}`);
      console.error(budgetLine(loadBudget(), isoDay()));
      return 0;
    }
    if (verdictAfter === 'SIGNED_OUT') {
      console.error(redact('login FAILED — the form came back signed out (wrong credentials, or the site rejected the submit)'));
      return 2;
    }
    return reportVerdict(verdictAfter, after);
  });
}

export const OCR_PACING_MS = 2500;

export function parseViewerSettings(text) {
  const out = {};
  for (const m of String(text ?? '').matchAll(/([A-Za-z]\w*Baseurl|uid|type|pageId)\s*:\s*(?:'([^']*)'|(\d+))/g)) {
    out[m[1]] = m[3] ?? m[2].replace(/&amp;/g, '&');
    if (m[1].endsWith('Baseurl') && m[2] != null) out[`${m[1]}Raw`] = m[2];
  }
  return out;
}

export function inlineSettingsExpr() {
  return `[...document.querySelectorAll('script:not([src])')].map((s) => s.textContent).filter((t) => t.includes('Baseurl')).join('\\n')`;
}

export function pagesUrl(settings) {
  if (!settings?.ajaxBaseurl || !settings?.uid || !settings?.type) {
    throw new Error('viewer settings incomplete (want ajaxBaseurl/uid/type) — not a viewer page, or the markup changed');
  }
  return `${settings.ajaxBaseurl}?tx_sparchiondocuments_spdocumentviewer[action]=getViewerDocumentPages&uid=${settings.uid}&type=${settings.type}`;
}

export function fetchPagesExpr(settings) {
  return `(async () => {
  const r = await fetch(${JSON.stringify(pagesUrl(settings))}, { credentials: 'include' });
  return await r.text();
})()`;
}

export function ocrFetchExpr(settings, pageId) {
  if (!settings?.ocrtextBaseurl) throw new Error('viewer settings lack ocrtextBaseurl — not a viewer page, or the markup changed');
  const body = `uid=${settings.uid}&type=${settings.type}&pageId=${pageId}`;
  return `(async () => {
  const r = await fetch(${JSON.stringify(settings.ocrtextBaseurl)}, { method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: ${JSON.stringify(body)} });
  return await r.text();
})()`;
}

export function summarizePages(pages) {
  const count = Array.isArray(pages) ? pages.length : 0;
  const ocr = (Array.isArray(pages) ? pages : []).filter((p) => p.ocrTextAvailable).length;
  return { count, ocr, browseOnly: count > 0 && ocr === 0 };
}

export function ocrHtmlToText(html) {
  const text = String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.replace(/^Schließen Erkannter Text Der erkannte Text ist KI-basiert[\s\S]*?einzublenden\.\s*/u, '');
}

export function isTooFast(text) {
  return /"reason"\s*:\s*"toofast"|Die Zugriffe erfolgen in zu kurzen Abständen/i.test(String(text ?? ''));
}

export function countHits(text, term) {
  const t = String(term ?? '').toLowerCase();
  if (!t) return 0;
  const s = String(text ?? '').toLowerCase();
  let n = 0;
  let i = 0;
  while ((i = s.indexOf(t, i)) !== -1) {
    n++;
    i += t.length;
  }
  return n;
}

export function pageRange(pages, range) {
  if (!range) return pages;
  const m = String(range).match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new Error(`--pages wants N or A-B (got ${JSON.stringify(range)})`);
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return pages.filter((p) => p.position >= a && p.position <= b);
}

export function downloadDoUrl(settings, page, { coords = null, degree = 0 } = {}) {
  const base = settings?.downloadDoBaseurlRaw ?? settings?.downloadDoBaseurl;
  if (!base) throw new Error('viewer settings lack downloadDoBaseurl — not a viewer page, or the markup changed');
  const c = coords ?? [0, 0, page.width, page.height];
  return `${base}&uid=${settings.uid}&type=${settings.type}&pageId=${page.id}&coords=${c.join(',')}&degree=${degree}`;
}

export function tileGrid(page, { tileSize = 255, overlap = 1 } = {}) {
  const w = Number(page?.width);
  const h = Number(page?.height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new Error(`page has no usable width/height (got ${JSON.stringify({ width: page?.width, height: page?.height })})`);
  }
  const levels = Math.ceil(Math.log2(Math.max(w, h))) + 1;
  return { level: levels - 1, levels, cols: Math.ceil(w / tileSize), rows: Math.ceil(h / tileSize), tileSize, overlap, width: w, height: h };
}

export function tileNames(grid) {
  const names = [];
  for (let row = 0; row < grid.rows; row++) for (let col = 0; col < grid.cols; col++) names.push(`${col},${row}`);
  return names;
}

export function tilesFetchExpr(settings, pageId, level, names) {
  if (!settings?.ajaxBaseurl || !settings?.uid || !settings?.type) {
    throw new Error('viewer settings incomplete (want ajaxBaseurl/uid/type) — not a viewer page, or the markup changed');
  }
  const url = `${settings.ajaxBaseurl}?tx_sparchiondocuments_spdocumentviewer[action]=getViewerDocumentPageTiles` +
    `&uid=${settings.uid}&type=${settings.type}&pageId=${pageId}`;
  const body = `level=${Number(level)}&tiles=${encodeURIComponent(names.join('|'))}`;
  return `(async () => {
  const r = await fetch(${JSON.stringify(url)}, { method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }, body: ${JSON.stringify(body)} });
  return await r.text();
})()`;
}

export function parseTilesResponse(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ''));
  } catch {
    throw new Error(`getViewerDocumentPageTiles did not answer JSON (${String(text ?? '').slice(0, 120) || 'empty body'})`);
  }
  if (data?.result !== 'success' || !Array.isArray(data?.tiles)) {
    throw new Error(`getViewerDocumentPageTiles did not answer success (${JSON.stringify({ result: data?.result, reason: data?.reason }).slice(0, 120)})`);
  }
  if (!data.baseurl) throw new Error('getViewerDocumentPageTiles answered without a baseurl — the response shape changed');
  const tiles = data.tiles.map((t, i) => {
    const m = String(t?.tile ?? '').match(/^(\d+),(\d+)$/);
    if (!m || !t?.src) throw new Error(`tile ${i} is not {tile:'col,row', src}-shaped (keys: ${Object.keys(t ?? {}).join(', ')})`);
    return { col: Number(m[1]), row: Number(m[2]), src: t.src };
  });
  return { baseurl: data.baseurl, tiles };
}

export function stitchTilesExpr(parsed, grid) {
  return `(() => {
  const tiles = ${JSON.stringify(parsed.tiles)};
  const base = ${JSON.stringify(parsed.baseurl)};
  const t = ${Number(grid.tileSize)}, o = ${Number(grid.overlap)};
  window.__archionView = null;
  const st = window.__archionViewState = { done: false, error: null, tilesDone: 0, total: tiles.length, length: 0, phase: 'tiles', at: Date.now(), lastGapMs: null };
  (async () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = ${Number(grid.width)};
      canvas.height = ${Number(grid.height)};
      const g = canvas.getContext('2d');
      const pause = (ms) => new Promise((res) => setTimeout(res, ms));
      let prevTileAt = Date.now();
      for (const tile of tiles) {
        let r = null;
        for (const backoff of [0, 5000, 30000, 120000, 240000]) {
          if (backoff) { st.at = Date.now(); await pause(backoff); }
          r = await fetch(base + tile.src, { credentials: 'include' });
          if (r.ok) break;
        }
        if (!r.ok) {
          st.error = 'tile-http-' + r.status + ':' + tile.col + ',' + tile.row;
          st.done = true;
          return;
        }
        const bmp = await createImageBitmap(await r.blob());
        g.drawImage(bmp, tile.col * t - tile.col * o, tile.row * t - tile.row * o);
        bmp.close();
        st.tilesDone++;
        const now = Date.now();
        st.lastGapMs = now - prevTileAt;
        prevTileAt = now;
        st.at = now;
        await pause(150);
      }
      st.phase = 'encode';
      st.at = Date.now();
      window.__archionView = canvas.toDataURL('image/png');
      st.length = window.__archionView.length;
    } catch (e) {
      st.error = String((e && e.message) || e);
    }
    st.done = true;
  })();
  return 'started';
})()`;
}

export const stitchStateExpr = () => `JSON.stringify(window.__archionViewState ?? null)`;

export const STITCH_DEADLINE_DEFAULT_MS = 600000;

export const STITCH_STALE_MS = 330000;

export function classifyStitchStall(state, { now, deadlineAt, staleMs = STITCH_STALE_MS } = {}) {
  if (state == null) {
    return { stage: 'context lost', message: 'stitch context lost — the in-page state object vanished mid-stitch (tab reloaded or navigated); retry' };
  }
  const stage = state.phase === 'encode' ? 'canvas encode' : 'tile fetch';
  const progress = stage === 'canvas encode'
    ? `all ${state.tilesDone ?? 0} tile(s) drawn, no dataURL yet`
    : `${state.tilesDone ?? 0} of ${state.total ?? '?'} tile(s) drawn`;
  const hbAge = Number.isFinite(state.at) ? now - state.at : null;
  const timing = hbAge == null
    ? 'no heartbeat field'
    : `heartbeat ${Math.round(hbAge / 1000)} s ago`
      + (Number.isFinite(state.lastGapMs) ? `, last inter-tile gap ${(state.lastGapMs / 1000).toFixed(1)} s` : '');
  if (hbAge != null && hbAge > staleMs) {
    return { stage, message: `stitch heartbeat stale in ${stage} (${progress}; ${timing}; threshold ${Math.round(staleMs / 1000)} s > the 240 s ladder step) — the detached stitch is dead or clamped` };
  }
  if (now > deadlineAt) {
    return { stage, message: `stitch deadline exceeded in ${stage} (${progress}; ${timing})` };
  }
  return null;
}

async function awaitStitch(h, deadlineAt, label = 'stitch') {
  let lastProgressAt = Date.now();
  for (;;) {
    await sleep(2000);
    const state = JSON.parse(await h.eval(stitchStateExpr()));
    if (state?.done) return state;
    const now = Date.now();
    const stall = classifyStitchStall(state, { now, deadlineAt });
    if (stall) return { ...state, done: false, timedOut: true, stage: stall.stage, error: stall.message };
    if (now - lastProgressAt >= 30000) {
      lastProgressAt = now;
      const hb = Number.isFinite(state?.at) ? `${Math.round((now - state.at) / 1000)} s ago` : 'n/a';
      console.error(`${label}: ${state?.tilesDone ?? 0}/${state?.total ?? '?'} tiles drawn (phase ${state?.phase ?? '?'}, heartbeat ${hb}, deadline in ${Math.max(0, Math.round((deadlineAt - now) / 1000))} s)`);
    }
  }
}

export function stitchDeadlineMs(argv) {
  const raw = argOf(argv, '--stitch-deadline', null);
  if (raw == null) return STITCH_DEADLINE_DEFAULT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--stitch-deadline wants minutes > 0 (got ${raw})`);
  return n * 60000;
}

export function readViewChunkExpr(offset, size) {
  return `window.__archionView.slice(${Number(offset)}, ${Number(offset) + Number(size)})`;
}

export function dataUrlToPngBuffer(dataUrl) {
  const m = String(dataUrl ?? '').match(/^data:image\/png;base64,(.+)$/s);
  if (!m) throw new Error(`not a PNG dataURL (starts ${String(dataUrl ?? '').slice(0, 40)})`);
  return Buffer.from(m[1], 'base64');
}

async function readStitchedView(h, length, chunkSize = 1 << 20) {
  let dataUrl = '';
  for (let off = 0; off < length; off += chunkSize) {
    dataUrl += await h.eval(readViewChunkExpr(off, chunkSize));
  }
  return dataUrlToPngBuffer(dataUrl);
}

async function fetchViewerContext(h) {
  const settings = parseViewerSettings(await h.eval(inlineSettingsExpr()));
  const raw = await h.eval(fetchPagesExpr(settings));
  if (isTooFast(raw)) throw new Error('rate-limited ("toofast") on the pages list — wait a moment and retry');
  let pages;
  try {
    pages = JSON.parse(raw);
  } catch {
    throw new Error(`getViewerDocumentPages did not answer JSON (${raw.slice(0, 120) || 'empty body'}) — wrong volume id, or signed out`);
  }
  if (!Array.isArray(pages)) throw new Error('getViewerDocumentPages did not return a page list');
  return { settings, pages };
}

async function harvestOcr(h, ctx, entries) {
  const texts = [];
  let recovered = false;
  for (let i = 0; i < entries.length; i++) {
    const page = entries[i];
    if (i > 0) await sleep(OCR_PACING_MS);
    let raw;
    try {
      raw = await h.eval(ocrFetchExpr(ctx.settings, page.id));
    } catch (e) {
      if (recovered) throw e;
      recovered = true;
      console.error(`tab lost mid-harvest at Bild ${page.position} (${e.message ?? e}) — reopening (the measured recovery path)`);
      await h.reopen();
      raw = await h.eval(ocrFetchExpr(ctx.settings, page.id));
    }
    if (isTooFast(raw)) {
      console.error(`rate-limited ("toofast") at Bild ${page.position} — backing off 10 s`);
      await sleep(10000);
      raw = await h.eval(ocrFetchExpr(ctx.settings, page.id));
      if (isTooFast(raw)) throw new Error('still rate-limited after the backoff — stop and retry later');
    }
    texts.push({ position: page.position, id: page.id, text: ocrHtmlToText(raw) });
  }
  return texts;
}

async function cmdView(argv) {
  const settleMs = settleOf(argv);
  const [volumeId, pageArg] = positionals(argv);

  const saveViewRaw = argOf(argv, '--save-view');
  const saveView = saveViewRaw ? resolveCacheOut(saveViewRaw) : saveViewRaw;

  const stitchBudgetMs = saveView ? stitchDeadlineMs(argv) : null;
  const url = viewerUrl(volumeId);
  return withTab(url, settleMs, async (h) => {
    const session = await probeSession(h);
    const sv = sessionVerdict(session);
    if (sv === 'SIGNED_OUT' || sv === 'CHALLENGE') return reportVerdict(sv, session);
    console.error(budgetLine(loadBudget(), isoDay()));
    let ctx;
    try {
      ctx = await fetchViewerContext(h);
    } catch (e) {
      console.error(`viewer context unreadable: ${e.message ?? e}`);
      return 3;
    }
    const sum = summarizePages(ctx.pages);
    console.log(`volume ${volumeId}: ${sum.count} image(s), ${sum.ocr} with OCR text${sum.browseOnly ? ' — BROWSE-ONLY (find entries by paging)' : ''}`);
    if (argv.includes('--dump')) console.log(JSON.stringify({ settings: ctx.settings, pages: ctx.pages }, null, 2));
    if (pageArg == null) return 0;
    const page = ctx.pages.find((p) => Number(p.position) === Number(pageArg));
    if (!page) {
      console.error(`no Bild ${pageArg} in this volume (1–${sum.count})`);
      return 1;
    }
    console.log(`Bild ${page.position}: pageId ${page.id}, ${page.width}×${page.height} px, OCR ${page.ocrTextAvailable ? 'available' : 'NOT available (read the image in the viewer, or --save-view for a free working copy)'}`);
    if (page.ocrTextAvailable) {
      const raw = await h.eval(ocrFetchExpr(ctx.settings, page.id));
      if (isTooFast(raw)) {
        console.error('rate-limited ("toofast") — wait a moment and retry');
        return 3;
      }
      console.log('--- OCR text (KI-transcribed — read the image before citing anything) ---');
      console.log(ocrHtmlToText(raw));
    }
    if (saveView) {

      const grid = tileGrid(page);
      const deadlineAt = Date.now() + stitchBudgetMs;
      console.error(`stitching the tile plane: level ${grid.level}, ${grid.cols}×${grid.rows} tiles of ${grid.tileSize} px (hard deadline ${Math.round(stitchBudgetMs / 60000)} min — --stitch-deadline)…`);
      const rawTiles = await h.eval(tilesFetchExpr(ctx.settings, page.id, grid.level, tileNames(grid)));
      if (isTooFast(rawTiles)) {
        console.error('rate-limited ("toofast") on the tile list — wait a moment and retry');
        return 3;
      }
      const parsed = parseTilesResponse(rawTiles);

      try { await h.send('Page.bringToFront'); } catch {                                                                 }
      await h.eval(stitchTilesExpr(parsed, grid));
      let state = await awaitStitch(h, deadlineAt);
      if (state.error && /^tile-http-/.test(state.error)) {

        if (Date.now() + 60000 >= deadlineAt) {
          console.error(`tile fetch refused mid-stitch (${state.error}) — no room left under the --stitch-deadline for the 60 s cool-down + retry`);
        } else {
          console.error(`tile fetch refused mid-stitch (${state.error}) — cooling down 60 s and retrying once with fresh signatures`);
          await sleep(60000);
          const retryTiles = await h.eval(tilesFetchExpr(ctx.settings, page.id, grid.level, tileNames(grid)));
          if (!isTooFast(retryTiles)) {
            await h.eval(stitchTilesExpr(parseTilesResponse(retryTiles), grid));
            state = await awaitStitch(h, deadlineAt, 'stitch (retry)');
          }
        }
      }
      if (state.timedOut) {

        console.error(`stitch aborted [stage: ${state.stage}]: ${state.error}`);
        console.error(`nothing written, no quota spent — retry later, or raise --stitch-deadline (this run's budget was ${Math.round(stitchBudgetMs / 60000)} min)`);
        return 3;
      }
      if (state.error || !state.length) {
        console.error(`tile stitch failed in-page (${state.error ?? 'no dataURL'}; ${state.tilesDone ?? 0} tile(s) drawn) — wait a minute and retry`);
        return 3;
      }
      mkdirSync(saveView, { recursive: true });
      const viewFile = join(saveView, `archion-${volumeId}-p${page.position}-view.png`);
      writeFileSync(viewFile, await readStitchedView(h, state.length));
      console.error(`wrote ${viewFile} — WORKING COPY from the free tile plane (no quota spent);`);
      console.error('NOT a substitute for the metered archival download of a provenance-bearing page.');
    }
    return 0;
  });
}

async function cmdSearch(argv) {
  const settleMs = settleOf(argv);
  const control = argOf(argv, '--control');
  const save = argOf(argv, '--save');
  const range = argOf(argv, '--pages');
  const [volumeId, term] = positionals(argv);
  if (!term) throw new UsageError('search wants <volume-id> <term>');
  return withTab(viewerUrl(volumeId), settleMs, async (h) => {
    const session = await probeSession(h);
    const sv = sessionVerdict(session);
    if (sv === 'SIGNED_OUT' || sv === 'CHALLENGE') return reportVerdict(sv, session);
    console.error(budgetLine(loadBudget(), isoDay()));
    let ctx;
    try {
      ctx = await fetchViewerContext(h);
    } catch (e) {
      console.error(`viewer context unreadable: ${e.message ?? e}`);
      return 3;
    }
    const sum = summarizePages(ctx.pages);
    if (sum.count === 0) {
      console.error('the volume has no pages — wrong volume id?');
      return 3;
    }
    if (sum.browseOnly) {
      console.error(`volume ${volumeId} is BROWSE-ONLY (${sum.count} images, none OCR-indexed) — in-volume search cannot work here; page it with \`view\` instead. This is NOT a zero.`);
      return 3;
    }
    const entries = pageRange(ctx.pages.filter((p) => p.ocrTextAvailable), range);
    if (sum.ocr < sum.count) console.error(`note: only ${sum.ocr}/${sum.count} images carry OCR text — the others are invisible to this search`);
    console.error(`harvesting ocrText for ${entries.length} page(s) at ${OCR_PACING_MS / 1000} s pacing (~${Math.ceil((entries.length * OCR_PACING_MS) / 60000)} min)…`);
    const harvest = await harvestOcr(h, ctx, entries);
    if (save) {
      writeFileSync(save, `${JSON.stringify({ volumeId: String(volumeId), harvestedAt: new Date().toISOString(), pages: harvest }, null, 2)}\n`);
      console.error(`harvest saved to ${save} — grep it offline instead of re-harvesting`);
    }
    let hits = 0;
    let controlHits = control ? 0 : null;
    for (const p of harvest) {
      const n = countHits(p.text, term);
      if (n > 0) {
        hits += n;
        console.log(`Bild ${p.position}: ${n} hit(s) — …${contextSnippet(p.text, term)}…`);
      }
      if (control) controlHits += countHits(p.text, control);
    }
    const verdict = zeroControlVerdict(hits, controlHits);
    console.log(`search "${term}" in volume ${volumeId} (${entries.length} OCR page(s)): ${verdict.message}`);
    return verdict.exit;
  });
}

export function contextSnippet(text, term, width = 60) {
  const i = String(text ?? '').toLowerCase().indexOf(String(term ?? '').toLowerCase());
  if (i === -1) return '';
  return String(text).slice(Math.max(0, i - width / 2), i + String(term).length + width / 2).trim();
}

async function cmdDownload(argv) {
  const settleMs = settleOf(argv);

  const outRaw = argOf(argv, '--out');
  const out = outRaw ? resolveCacheOut(outRaw) : outRaw;
  const force = argv.includes('--force');
  const degree = Number(argOf(argv, '--degree', '0'));
  const [volumeId, page] = positionals(argv);
  if (!volumeId || !page || !out) throw new UsageError('download wants <volume-id> <page> --out <dir>');
  const url = viewerUrl(volumeId);

  const state = loadBudget();
  const nowIso = isoDay();
  console.error(budgetLine(state, nowIso));
  const gate = budgetGate(state, nowIso, { force });
  if (!gate.ok) {
    console.error(gate.reason);
    return 5;
  }
  if (gate.reason) console.error(gate.reason);

  const incoming = safeDownloadPath(join(out, 'incoming'), '--out/incoming');
  mkdirSync(incoming, { recursive: true });

  return withTab(url, settleMs, async (h) => {
    const session = await probeSession(h);
    const sv = sessionVerdict(session);
    if (sv === 'SIGNED_OUT' || sv === 'CHALLENGE') return reportVerdict(sv, session);

    let ctx;
    try {
      ctx = await fetchViewerContext(h);
    } catch (e) {
      console.error(`viewer context unreadable: ${e.message ?? e} — nothing was spent`);
      return 3;
    }
    const entry = ctx.pages.find((p) => Number(p.position) === Number(page));
    if (!entry) {
      console.error(`no Bild ${page} in volume ${volumeId} (1–${ctx.pages.length}) — nothing was spent`);
      return 1;
    }

    await h.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: incoming,
      eventsEnabled: true,
    });

    await h.send('Network.enable');
    const events = { begun: null, done: null, docStatus: null };
    h.on((msg) => {
      if (msg.method === 'Browser.downloadWillBegin') events.begun = msg.params;
      if (msg.method === 'Browser.downloadProgress' && msg.params.state === 'completed') events.done = msg.params;
      if (msg.method === 'Browser.downloadProgress' && msg.params.state === 'canceled') events.done = msg.params;
      if (msg.method === 'Network.responseReceived' && msg.params.type === 'Document') events.docStatus = msg.params.response?.status ?? null;
    });

    const token = pendingDownloadToken();
    saveBudget(recordDownload(loadBudget(), nowIso, { volume: String(volumeId), page: Number(page), pending: true, token }));

    await h.eval(`location.href = ${JSON.stringify(downloadDoUrl(ctx.settings, entry, { degree }))}`);

    const deadline = Date.now() + 120000;
    while (!events.done && Date.now() < deadline) await sleep(500);

    const guid = events.done?.guid ?? events.begun?.guid ?? null;
    let src = guid ? join(incoming, guid) : null;
    if ((!events.done || events.done.state !== 'completed') && !(src && existsSync(src))) {
      const arrived = readdirSync(incoming);
      if (arrived.length === 1) {
        src = join(incoming, arrived[0]);
        console.error('progress events lost (tab vanished?) but exactly one file arrived — treating it as the download');
      } else if (reconcileVerdict({ fileArrived: false, docStatus: events.docStatus }) === 'unrecord') {

        saveBudget(unrecordPending(loadBudget(), token));
        console.error('downloadDo answered HTTP 404 (the site 404 page, no download) — measured to spend NOTHING; the write-ahead record was removed');
        console.error('if this repeats, the cHash/URL arithmetic has drifted again — verify against the account counter before retrying');
        return 3;
      } else {
        console.error(`download did not complete (${events.done?.state ?? 'no progress events'}, ${arrived.length} file(s) in ${incoming}) — the write-ahead ledger KEEPS this as spent (only a confirmed 404 is free).`);
        console.error('Read archion.de\'s own "N von 50 verbleibend" counter and reconcile with: ged-tools archion budget --sync <50 minus N>');
        console.error(budgetLine(loadBudget(), nowIso));
        return 3;
      }
    }
    const suggested = events.begun?.suggestedFilename ?? '';
    const ext = suggested.match(/\.[A-Za-z0-9]+$/)?.[0] ?? '.pdf';
    const dst = join(out, `archion-${volumeId}-p${page}${ext}`);
    if (src && existsSync(src)) renameSync(src, dst);
    else console.error(`completed but no file at ${src} — check ${incoming} by hand`);

    const next = resolvePending(loadBudget(), token, { file: dst });
    saveBudget(next);
    console.error(`wrote ${dst}`);
    console.error(budgetLine(next, nowIso));
    return 0;
  });
}

class UsageError extends Error {}

function argOf(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) return fallback;
  return argv[i + 1];
}

export const VALUE_FLAGS = new Set(['--settle', '--control', '--out', '--save', '--save-view', '--stitch-deadline', '--pages', '--degree', '--grep', '--init', '--spent', '--sync', '--port']);

export function positionals(argv) {
  return argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
}

const settleOf = (argv) => Number(argOf(argv, '--settle', '5')) * 1000;

function usage() {
  console.error(`archion.js — archion.de browse/session/login/search/view/download with a hard download-budget guard

  browse  [<path-or-url>] [--grep t] [--json]   public tree — plain HTTP, NO LOCK
  chrome-up                                     launch the DEDICATED Archion Chrome
                                                (:${ARCHION_DEFAULT_PORT}, profile ~/.archion-chrome-debug) —
                                                idempotent, lock-free
  session                                       logged-in probe (exit 0/2/3/4)
  login                                         fill the login form from .env
  search  <volume-id> '<term>' [--control '<term>'] [--pages A-B] [--save f.json]
              harvest the volume's per-page ocrText (2.5 s pacing) and grep it —
              OCR-indexed ("transkribiert") volumes only; a browse-only volume is
              exit 3, not a zero, and a zero needs its --control (free: same harvest)
  view    <volume-id> [<page>] [--dump] [--save-view <dir>] [--stitch-deadline <min>]
              page count + a page's OCR text; downloads NOTHING. --save-view
              stitches the page off the viewer's FREE tile plane into
              archion-<vol>-p<page>-view.png — a working copy (no quota spent),
              NOT the archival download. The stitch runs under a HARD deadline
              (--stitch-deadline, default 10 min, retry included) and aborts
              with a stage-naming verdict — never a silent hang (#470)
  download <volume-id> <page> --out <dir> [--degree N] [--force]
                                                SPENDS QUOTA (the measured downloadDo URL,
                                                full-page coords) — refused at the cap without --force;
                                                ledgered write-ahead, un-recorded only on a confirmed 404
  budget  [--init YYYY-MM-DD [--spent N]] [--sync N]
              spent/remaining for the active pass window; --spent/--sync seed the
              count already spent outside this ledger (archion.de shows
              "N von 50 verbleibend" — pass 50−N so the guard tells the account's truth)
  --settle N                                    seconds to let pages settle (default 5)
  --port N                                      CDP port (default ${ARCHION_DEFAULT_PORT}, the dedicated Archion
                                                Chrome; also ARCHION_CDP_PORT). --port 9222 falls back
                                                to the SHARED Chrome + the :9222 lock, debugging only
  --self-test                                   offline fixtures only; no network, no lock

EXIT CODES: 0 ok/alive · 1 bad args/infra · 2 signed out · 3 inconclusive ·
            4 captcha/2FA (operator-only — stop and report) · 5 budget refused ·
            6 zero-control failed (search surface not working)

Credentials: ARCHION_USERNAME / ARCHION_PASSWORD in the gitignored repo-root .env.
The password never appears in argv, logs, saved output, or CDP expression echoes.

Budget ledger: ${BUDGET_FILE} (gitignored, shared by all worktrees; cap ${DOWNLOAD_CAP}/pass).

Requires the ARCHION browser lock (independent of the shared :9222 lock) for
session/login/search/view/download, held across your whole batch (browse,
budget and chrome-up are lock-free):
${browserLockHint('archion', ' --browser archion').join('\n')}`);
}

async function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    return cmd ? 0 : 1;
  }
  const rest = argv.slice(1);
  try {

    if (cmd === 'browse') return await cmdBrowse(rest);
    if (cmd === 'budget') return cmdBudget(rest);
    if (cmd === 'chrome-up') {
      CDP_PORT = resolveCdpPort(rest);
      return await cmdChromeUp();
    }
    if (!['session', 'login', 'search', 'view', 'download'].includes(cmd)) {
      usage();
      return 1;
    }

    CDP_PORT = resolveCdpPort(rest);
    if (cmd === 'view' || cmd === 'search' || cmd === 'download') {
      viewerUrl(positionals(rest)[0]);
    }
  } catch (e) {
    console.error(String(e.message ?? e));
    return 1;
  }

  requireBrowserLock('archion', archionLockIo(CDP_PORT));
  try {
    if (cmd === 'session') return await cmdSession(rest);
    if (cmd === 'login') return await cmdLogin(rest);
    if (cmd === 'search') return await cmdSearch(rest);
    if (cmd === 'view') return await cmdView(rest);
    if (cmd === 'download') return await cmdDownload(rest);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      return 1;
    }
    throw e;
  }
  usage();
  return 1;
}
export { argOf, collapseWs, UsageError, main, usage, cmdBrowse, cmdBudget, loadBudget, saveBudget, CDP_PORT, cmdChromeUp, probeChrome, sleep, cmdSession, settleOf, withTab, probeSession, cookiePersistenceLine, reportVerdict, cmdLogin, readCredentials, cmdSearch, fetchViewerContext, harvestOcr, cmdView, awaitStitch, readStitchedView, cmdDownload };

function selfTest() { throw new Error("Run npm test in the ged-tools source checkout; private fixtures are not distributed."); }
