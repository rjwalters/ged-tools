import { readFileSync, writeFileSync } from 'node:fs';
import { openTab, closeTab, connect, evaluate, requireBrowserLock, browserLockHint } from './cdp-transport.js';
import { sessionProbeExpr, sessionVerdict, verdictExitCode } from './fs-fulltext.js';
import { resolveCacheOut } from '../lib/tools.js';
export const ARK_PREFIX = '/ark:/61903/';

export const DAS_ORIGIN = 'https://sg30p0.familysearch.org';

export const DAS_PATH = '/service/records/storage/dascloud/das/v2';

export const DEFAULT_UA_CHAIN = 'ged-tools/fs-image';

const SEARCH_PAGE = 'https://www.familysearch.org/search/';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizeArk(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('empty ark');
  const m = raw.match(/(\d:\d:[A-Z0-9-]+)/i);
  if (!m) throw new Error(`not an image ark (want 3:1:XXXX-XXXX, got ${raw.slice(0, 60)})`);
  return m[1].toUpperCase();
}

export function arkJsonPath(ark) {
  return `${ARK_PREFIX}${normalizeArk(ark)}`;
}

export function normalizeApid(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('empty apid');
  if (!/^[A-Za-z0-9._~-]+$/.test(raw)) throw new Error(`not an apid (one opaque path segment, got ${raw.slice(0, 60)})`);
  return raw;
}

export function dasUrl(apid) {
  return `${DAS_ORIGIN}${DAS_PATH}/${normalizeApid(apid)}/dist.jpg`;
}

export function arkJsonExpr(ark) {
  return `(async () => {
  const r = await fetch(${JSON.stringify(arkJsonPath(ark))}, { credentials: 'include', headers: { accept: 'application/json' } });
  const t = await r.text();
  let apid = null;
  try { apid = JSON.parse(t).apid ?? null; } catch { /* not JSON: a sign-in page, reported below */ }
  return { status: r.status, url: r.url, apid, body: apid ? '' : t.slice(0, 300) };
})()`;
}

export function dasFetchExpr(apid, uaChain = DEFAULT_UA_CHAIN) {
  const chain = String(uaChain ?? '').trim();
  if (!chain) throw new Error('FS-User-Agent-Chain must be non-empty — the DAS host answers 400 without it');
  return `(async () => {
  const m = document.cookie.match(/fssessionid=([^;]+)/);
  if (!m) return { status: 'no-session-cookie' };
  const r = await fetch(${JSON.stringify(dasUrl(apid))}, {
    headers: { Authorization: 'Bearer ' + m[1], 'FS-User-Agent-Chain': ${JSON.stringify(chain)} },
  });
  if (!r.ok) return { status: r.status, body: (await r.text()).slice(0, 200) };
  const buf = await r.arrayBuffer();
  const u8 = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return { status: r.status, len: buf.byteLength, b64: btoa(s) };
})()`;
}

async function withPage(settleMs, fn) {
  const tab = await openTab();
  let cdp = null;
  try {
    cdp = await connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url: SEARCH_PAGE });
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

export function isAuthDenial(status) {
  return status === 401 || status === 403;
}

export function denialExitCode(status, verdict) {
  if (status === 401) return 2;
  if (verdict === 'ALIVE') return 4;
  return verdictExitCode(verdict);
}

async function probeSessionVerdict(cdp) {
  let probe;
  try {
    probe = JSON.parse(await evaluate(cdp, sessionProbeExpr()));
  } catch (e) {
    probe = { error: String(e.message ?? e) };
  }
  return sessionVerdict(probe || {});
}

async function reportDenial(cdp, status) {
  const verdict = status === 401 ? null : await probeSessionVerdict(cdp);
  const code = denialExitCode(status, verdict);
  if (code === 2) {
    console.error('Signed out: sign in once in the shared debug Chrome and re-run.');
  } else if (code === 4) {
    console.error('The session is ALIVE: signed in, but access to this artifact is denied — a');
    console.error('restricted image (e.g. home/affiliate-restricted microfilm). A genuine negative');
    console.error('for this route, not a session failure.');
  } else {
    console.error('Session probe INCONCLUSIVE — this denial is unverified: it could be a dead');
    console.error('session or a restricted artifact. Re-run once the tab can reach FamilySearch.');
  }
  return code;
}

async function resolveApid(cdp, ark) {
  const res = await evaluate(cdp, arkJsonExpr(ark));
  if (res?.apid) return { apid: res.apid };
  console.error(`ark ${normalizeArk(ark)}: HTTP ${res?.status ?? '?'} with no apid — ${String(res?.body ?? '').slice(0, 160)}`);
  if (/ident\.familysearch\.org|\/identity\/login/i.test(String(res?.url ?? ''))) {
    console.error('That is the sign-in wall: sign in once in the shared debug Chrome and re-run.');
    return { code: 2 };
  }
  if (!isAuthDenial(res?.status)) return { code: 4 };
  return { code: await reportDenial(cdp, res.status) };
}

async function pullImage(cdp, apid, out, uaChain) {
  const res = await evaluate(cdp, dasFetchExpr(apid, uaChain));
  if (res?.status === 'no-session-cookie') {
    console.error('no fssessionid cookie in the shared Chrome — sign in to FamilySearch there first.');
    return 2;
  }
  if (!res?.b64) {
    console.error(`DAS ${apid}: HTTP ${res?.status ?? '?'} ${String(res?.body ?? '').slice(0, 160)}`);
    if (!isAuthDenial(res?.status)) return 4;
    return reportDenial(cdp, res.status);
  }
  writeFileSync(out, Buffer.from(res.b64, 'base64'));
  console.error(`wrote ${out} (${res.len} bytes)`);
  return 0;
}

function arg(argv, name, fallback = null) {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) return fallback;
  return argv[i + 1];
}

function usage() {
  console.error(`fs-image.js — full-resolution FamilySearch page images (DAS dist.jpg) by ark

  get   <ark> <out.jpg>     ark → apid → dist.jpg, end to end
  apid  <ark>               print the DAS apid only
  fetch <apid> <out.jpg>    pull dist.jpg for an apid you already have
  --ua-chain <s>            FS-User-Agent-Chain (default ${DEFAULT_UA_CHAIN});
                            the header may say anything but must not be empty —
                            the DAS host answers HTTP 400 without it
  --settle N                seconds to let the landing page settle (default 4)
  --self-test               pure-function tests; no browser, no lock

  <ark> may be bare (3:1:XXXX-XXXX), prefixed (ark:/61903/3:1:…) or a whole
  viewer URL — they are the same ark and all three are accepted:
    ged-tools fs-image get 3:1:XXXX-XXXX image.jpg

  Two origins, two authentications: the ark's JSON is same-origin and
  cookie-authenticated; the image itself lives on ${new URL(DAS_ORIGIN).host} and
  wants \`Authorization: Bearer <fssessionid cookie>\` plus FS-User-Agent-Chain —
  a credentialed cross-origin fetch there is refused. The bearer is read live
  from the page's own cookie jar on every run; none is stored here.

EXIT CODES: 0 answered · 1 bad args · 2 signed out/unauthorised ·
            3 session inconclusive (denial unverified) · 4 no image (genuine negative)

  A 403 is ambiguous — signed-out sessions AND restricted artifacts both answer
  it — so a denial triggers fs-fulltext.js's session probe in the same tab and
  the verdict decides: SIGNED_OUT⇒2, ALIVE⇒4 (artifact restricted for this
  session — a genuine negative), INCONCLUSIVE⇒3 (never reported as a clean 4).

Requires the browser lock, held across your whole batch:
${browserLockHint('fs-image').join('\n')}`);
}

async function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') {
    usage();
    return cmd ? 0 : 1;
  }
  const o = {
    uaChain: arg(argv, '--ua-chain', DEFAULT_UA_CHAIN),
    settleMs: Number(arg(argv, '--settle', '4')) * 1000,
  };

  let ark = null;
  let apid = null;
  let out = null;
  try {
    if (cmd === 'get') {
      ark = normalizeArk(argv[1]);
      out = argv[2];
      if (!out || out.startsWith('--')) throw new Error('get wants <ark> <out.jpg>');
    } else if (cmd === 'apid') {
      ark = normalizeArk(argv[1]);
    } else if (cmd === 'fetch') {
      apid = normalizeApid(argv[1]);
      out = argv[2];
      if (!out || out.startsWith('--')) throw new Error('fetch wants <apid> <out.jpg>');
    } else {
      usage();
      return 1;
    }

    if (out) out = resolveCacheOut(out);
    dasFetchExpr(apid ?? 'TH-probe', o.uaChain);
  } catch (e) {
    console.error(String(e.message ?? e));
    return 1;
  }

  requireBrowserLock('fs-image');
  return withPage(o.settleMs, async (cdp) => {
    if (cmd === 'fetch') return pullImage(cdp, apid, out, o.uaChain);
    const step1 = await resolveApid(cdp, ark);
    if (step1.code) return step1.code;
    if (cmd === 'apid') {
      console.log(step1.apid);
      return 0;
    }
    console.error(`apid ${step1.apid}`);
    return pullImage(cdp, step1.apid, out, o.uaChain);
  });
}
export { main, usage, arg, withPage, SEARCH_PAGE, sleep, pullImage, reportDenial, probeSessionVerdict, resolveApid };

function selfTest() { throw new Error("Run npm test in the ged-tools source checkout; private fixtures are not distributed."); }
