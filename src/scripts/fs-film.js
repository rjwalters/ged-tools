import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { root, mainRoot, resolveCacheOut } from '../lib/tools.js';
import { safeDownloadPath } from './cdp-download-guard.js';
import {
  openTab,
  closeTab,
  connect,
  evaluate,
  requireBrowserLock,
  LOCK_DIR,
  LOCK_META_FILE,
} from './cdp-transport.js';
import {
  isAuthUrl,
  hasLoginForm,
  hasRestrictedPanel,
  hasViewerChrome,
  makeAuthWatch,
  VIEWER_LOAD_FLOOR_MS,
  NO_DOWNLOAD_FLOOR_MS,
  RECOVERY_HINT,
} from '../lib/fs-classify.js';
import { filmsInCatalog, selectCatalog } from '../lib/fs-film-data.js';
export const RESTRICTED_MESSAGE = 'roll is RESTRICTED — FamilySearch Center / affiliate only';

export const NO_DOWNLOAD_MESSAGE =
  'film is VIEWABLE but download is DISABLED — needs tile capture, which this script does not do';

export function stopAdvice(why) {
  if (String(why).includes(RESTRICTED_MESSAGE)) {
    return [
      'Nothing here will open it from home; re-run at a Center, or find another copy',
      'of the same records (fs-catalog.js lists the films in the catalogue).',
    ];
  }

  if (String(why).includes(NO_DOWNLOAD_MESSAGE)) {
    return [
      'The session is fine and the pages render — this film just has no download button,',
      'so the click-and-take-the-file mechanism has nothing to click. Re-running changes',
      'nothing. Read it at the screen in the debug Chrome, or capture it by stitching the',
      'viewer\'s deep-zoom tiles — a separate, deferred piece of work (see #365); this',
      'script deliberately does not fetch tiles.',
    ];
  }
  const lines = [
    'If that was a sign-out: sign back in in the debug Chrome and re-run the same command.',
    'It resumes from the checkpoint and re-fetches nothing.',
  ];
  if (/signed out/i.test(why)) lines.push(RECOVERY_HINT);
  return lines;
}

const STATE_FILE = '_film.json';

export const NEXT_SELECTORS = [
  'button[aria-label="Next Image"]',
  '[role=button][aria-label="Next Image"]',
  'button[aria-label*="next image" i]',
  'button[aria-label*="next" i]',
  '[data-testid*="next" i]',
];

export const DOWNLOAD_SELECTOR = '[data-testid=download-image-button]';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sniff(buf) {
  if (!buf || buf.length < 4) return { type: null, ok: false, why: 'empty or truncated' };
  const b = buf;
  const starts = (...bytes) => bytes.every((v, i) => b[i] === v);
  if (starts(0xff, 0xd8, 0xff)) return { type: 'jpg', ok: true };
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { type: 'png', ok: true };
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return { type: 'tif', ok: true };
  if (b.length > 11 && starts(0x52, 0x49, 0x46, 0x46) && b.slice(8, 12).toString('latin1') === 'WEBP') {
    return { type: 'webp', ok: true };
  }
  const head = b.slice(0, 4096).toString('latin1');
  const auth =
    /\b(sign in|signin|log ?in|anmelden|passwor[dt]|session (has )?(expired|timed out)|unauthori[sz]ed|access denied)\b/i.test(
      head
    );
  return { type: null, ok: false, auth, why: auth ? 'login / session-expired page, not an image' : 'not an image' };
}

export const TOO_SMALL_BYTES = 3000;

export function filmKey(url, arks) {
  if (arks && arks.length) {
    return `arks:${createHash('sha256').update(arks.join('\n')).digest('hex').slice(0, 16)}`;
  }
  return String(url).replace(/([?&])i=\d+&?/, '$1').replace(/[?&]$/, '');
}

export { filmsInCatalog };

export function indexFromUrl(url) {
  const m = String(url).match(/[?&]i=(\d+)/);
  return m ? Number(m[1]) : null;
}

export function arksFromFilmData(json) {
  const images = json?.images;
  if (!Array.isArray(images) || !images.length) throw new Error('film-data has no images[]');
  return images.map((u) => {
    const m = String(u).match(/ark:\/\d+\/([\w:-]+)/);
    if (!m) throw new Error(`film-data entry is not an ark url: ${String(u).slice(0, 80)}`);
    return m[1];
  });
}

export function viewerUrl(templateUrl, ark, i) {
  const base = templateUrl.replace(/ark:\/(\d+)\/[\w:-]+/, `ark:/$1/${ark}`);
  return urlAtIndex(base, i);
}

export function urlAtIndex(url, i) {
  return /[?&]i=\d+/.test(url) ? url.replace(/([?&]i=)\d+/, `$1${i}`) : `${url}${url.includes('?') ? '&' : '?'}i=${i}`;
}

export function pad(n, w = 4) {
  return String(n).padStart(w, '0');
}

export function loadState(dir) {
  const p = join(dir, STATE_FILE);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

export function saveState(dir, state) {
  const p = join(dir, STATE_FILE);
  const tmp = `${p}.tmp`;
  state.updatedAt = new Date().toISOString();
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, p);
}

export function haveFrame(dir, n) {
  if (!existsSync(dir)) return false;
  const want = `p${pad(n)}.`;
  return readdirSync(dir).some((f) => f.startsWith(want));
}

async function clickNext(cdp) {
  const expr = `(() => {
    const sels = ${JSON.stringify(NEXT_SELECTORS)};
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        if (!el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.offsetParent !== null) {
          el.click(); return s;
        }
      }
    }
    return null;
  })()`;
  return evaluate(cdp, expr);
}

export const NEXT_STATE_EXPR = `(() => {
  const sels = ${JSON.stringify(NEXT_SELECTORS)};
  return sels.map((s) => {
    const els = Array.from(document.querySelectorAll(s));
    return {
      selector: s,
      matches: els.length,
      disabled: els.map((el) => el.disabled === true),
      ariaDisabled: els.map((el) => el.getAttribute('aria-disabled')),
      visible: els.map((el) => el.offsetParent !== null),
    };
  });
})()`;

async function nextControlState(cdp) {
  try {
    return await evaluate(cdp, NEXT_STATE_EXPR);
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

export function describeNextControls(states) {
  if (!Array.isArray(states)) {
    return `  next-control state unavailable: ${states?.error ?? 'not probed'}`;
  }
  if (!states.length) return '  next-control state: nothing probed';
  return states
    .map((s) => {
      const head = `  ${String(s.matches).padStart(2)} match(es)  ${s.selector}`;
      if (!s.matches) return head;
      const aria = (s.ariaDisabled ?? []).map((v) => (v === null || v === undefined ? 'null' : v)).join(',');
      return `${head}  disabled=[${(s.disabled ?? []).join(',')}] aria-disabled=[${aria}] visible=[${(s.visible ?? []).join(',')}]`;
    })
    .join('\n');
}

export function classifyStop({ frameNo, arksLength, reason }) {
  const label =
    reason === 'no-selector'
      ? 'no enabled "next" control found'
      : 'clicked next but the viewer did not advance';
  if (arksLength !== null && arksLength !== undefined) {
    const remaining = arksLength - frameNo - 1;
    if (remaining > 0) {
      return {
        certainty: 'error',
        exitCode: 3,
        message:
          `${label} at frame ${frameNo}, but the --arks manifest lists ${arksLength} frames — ` +
          `${remaining} frame(s) unaccounted for. NOT end-of-roll: the viewer hung, the session ` +
          'dropped, or the click was swallowed. Re-run the same command to resume from the checkpoint.',
      };
    }
    return {
      certainty: 'end-of-roll',
      exitCode: 0,
      message:
        `${label} at frame ${frameNo}, the last frame in the --arks manifest ` +
        `(${arksLength} total) — confirmed end of roll.`,
    };
  }
  return {
    certainty: 'unverified',
    exitCode: 4,
    message:
      `${label} at frame ${frameNo}. No --arks manifest was supplied, so this CANNOT be ` +
      'distinguished from a hung viewer, a dropped session, or a swallowed click. Pass ' +
      '--arks <film-data.json> for an authoritative roll length.',
  };
}

async function currentUrl(cdp) {
  return evaluate(cdp, 'location.href');
}

export function isSignedOut(url) {
  return isAuthUrl(url);
}

async function waitForViewer(cdp, timeoutMs, expectArk = null, { now = Date.now } = {}) {
  const deadline = Date.now() + Math.max(timeoutMs, VIEWER_LOAD_FLOOR_MS);
  const watch = makeAuthWatch(now);
  let url = '';
  while (Date.now() < deadline) {
    url = await currentUrl(cdp).catch(() => '');
    const arkOk = expectArk === null || arkFromUrl(url) === expectArk;
    if (arkOk && (await downloadButtonPresent(cdp).catch(() => false))) return { ready: true, url };

    const text = await evaluate(cdp, "document.body ? document.body.innerText.slice(0, 40000) : ''").catch(() => '');
    const onAuth = isAuthUrl(url);
    const verdict = watch.sample({
      url,
      formSeen: onAuth ? hasLoginForm(text) : false,

      restrictedSeen: onAuth || !arkOk ? false : hasRestrictedPanel(text),
      chromeSeen: onAuth || !arkOk ? false : hasViewerChrome(text),
    });
    if (verdict === 'SIGNED_OUT') return { ready: false, signedOut: true, restricted: false, noDownload: false, url };

    if (verdict === 'RESTRICTED') return { ready: false, signedOut: false, restricted: true, noDownload: false, url };

    if (verdict === 'NO_DOWNLOAD') return { ready: false, signedOut: false, restricted: false, noDownload: true, url };
    await sleep(1000);
  }
  url = await currentUrl(cdp).catch(() => '');
  return { ready: false, signedOut: isAuthUrl(url), restricted: false, noDownload: false, url };
}

export function arkFromUrl(url) {
  const m = String(url).match(/ark:\/\d+\/([\w:-]+)/);
  return m ? m[1] : null;
}

async function downloadButtonPresent(cdp) {
  return evaluate(cdp, `!!document.querySelector(${JSON.stringify(DOWNLOAD_SELECTOR)})`);
}

async function waitForAdvance(cdp, beforeArk, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const watch = makeAuthWatch();
  let sawNewArk = false;
  while (Date.now() < deadline) {
    await sleep(300);
    const url = await currentUrl(cdp);
    const ark = arkFromUrl(url);
    if (ark && ark !== beforeArk) sawNewArk = true;
    if (sawNewArk && (await downloadButtonPresent(cdp))) return { advanced: true, url, ark };

    const formSeen = isAuthUrl(url)
      ? hasLoginForm(await evaluate(cdp, "document.body ? document.body.innerText.slice(0, 40000) : ''").catch(() => ''))
      : false;
    if (watch.sample({ url, formSeen }) === 'SIGNED_OUT') return { advanced: false, url, ark: null };
  }
  return { advanced: false, url: await currentUrl(cdp), ark: null };
}

async function captureFrame(cdp, downloadDir, timeoutMs, downloads) {
  const before = new Set(existsSync(downloadDir) ? readdirSync(downloadDir) : []);
  const seenGuids = new Set(downloads.keys());
  const newGuid = () => [...downloads.keys()].find((g) => !seenGuids.has(g));

  const clickIt = () =>
    evaluate(
      cdp,
      `(() => { const el = document.querySelector(${JSON.stringify(DOWNLOAD_SELECTOR)});
                if (!el) return false; el.click(); return true; })()`
    );

  const ATTEMPTS = 4;
  const ACK_MS = 6000;
  let began = false;
  for (let attempt = 1; attempt <= ATTEMPTS && !began; attempt++) {
    if (!(await clickIt())) return { ok: false, why: 'no download control on the page' };
    const ackBy = Date.now() + ACK_MS;
    while (Date.now() < ackBy) {
      await sleep(250);
      if (newGuid()) {
        began = true;
        break;
      }
    }
    if (!began && process.env.FSDEBUG) console.error(`    [dbg] no ack after click ${attempt}, retrying`);
  }
  if (!began) return { ok: false, why: `download never started after ${ATTEMPTS} clicks` };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(300);

    for (const [guid, rec] of downloads) {
      if (seenGuids.has(guid) || rec.state !== 'completed') continue;
      const path = join(downloadDir, guid);
      if (existsSync(path)) return { ok: true, buf: readFileSync(path), path, guid };
    }

    const now = existsSync(downloadDir) ? readdirSync(downloadDir) : [];
    for (const f of now) {
      if (before.has(f) || f.endsWith('.crdownload') || f.startsWith('.')) continue;
      const path = join(downloadDir, f);
      const x = readFileSync(path);
      await sleep(250);
      const y = readFileSync(path);
      if (x.length === y.length && y.length > 0) return { ok: true, buf: y, path };
    }
  }
  if (process.env.FSDEBUG) console.error(`    [dbg] downloads: ${JSON.stringify([...downloads])}`);
  return { ok: false, why: `download began but did not complete within ${Math.round(timeoutMs / 1000)}s` };
}

async function walk(opts) {
  const { outDir, startUrl, max, settleMs, timeoutMs, arks, step } = opts;
  requireBrowserLock('fs-film');
  mkdirSync(outDir, { recursive: true });

  const dlDir = safeDownloadPath(join(outDir, 'incoming'), '--out/incoming');
  mkdirSync(dlDir, { recursive: true });

  let state = loadState(outDir) ?? { startUrl, frames: {}, createdAt: new Date().toISOString() };
  const key = filmKey(startUrl, arks);

  if (state.filmKey && state.filmKey !== key) {
    console.error(`checkpoint in ${outDir} is for a different film:`);
    console.error(`  checkpoint: ${state.filmKey}  (${state.startUrl})`);
    console.error(`  requested:  ${key}  (${startUrl})`);
    console.error('Use a different --out directory.');
    process.exit(1);
  }
  if (!state.filmKey && filmKey(state.startUrl, arks) !== key && !arks) {
    console.error(`checkpoint in ${outDir} is for a different film:\n  ${state.startUrl}\n  ${startUrl}`);
    console.error('Use a different --out directory.');
    process.exit(1);
  }
  state.filmKey = key;

  const tab = await openTab();
  let cdp;
  try {
    cdp = await connect(tab.webSocketDebuggerUrl);
  } catch (err) {

    await closeTab(tab);
    throw err;
  }
  const cleanup = async () => {
    try {
      cdp.close();
    } catch {

    }

    await closeTab(tab);
  };

  const downloads = new Map();
  cdp.on((msg) => {
    if (process.env.FSDEBUG && /download|Download/.test(msg.method)) console.error(`    [ev] ${msg.method}`);
    if (msg.method === 'Browser.downloadWillBegin') {
      downloads.set(msg.params.guid, { name: msg.params.suggestedFilename, state: 'begin' });
    } else if (msg.method === 'Browser.downloadProgress') {
      const rec = downloads.get(msg.params.guid) ?? {};
      rec.state = msg.params.state;
      downloads.set(msg.params.guid, rec);
    }
  });

  const recordStop = async ({ reason, frameNo }) => {
    const controls = await nextControlState(cdp);
    const where = await currentUrl(cdp).catch(() => '');
    const signedOut = isSignedOut(where);
    const verdict = classifyStop({ frameNo, arksLength: arks ? arks.length : null, reason });
    state.lastStop = {
      at: new Date().toISOString(),
      frame: frameNo,
      reason,
      url: where || null,
      signedOut,
      certainty: signedOut ? 'auth-loss' : verdict.certainty,
      exitCode: signedOut ? 2 : verdict.exitCode,
      arksLength: arks ? arks.length : null,
      nextControls: controls,
    };
    try {
      saveState(outDir, state);
    } catch (err) {
      console.error(`  (could not persist lastStop: ${err.message})`);
    }
    return {
      frame: frameNo,
      why: signedOut ? `signed out — the browser is at ${where}` : verdict.message,
      exitCode: state.lastStop.exitCode,
      controls,
    };
  };

  let saved = 0;
  let stopped = null;
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');

    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: dlDir,
      eventsEnabled: true,
    });

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const done = new Set(Object.keys(state.frames).map(Number));
    const base = indexFromUrl(startUrl) ?? 0;

    const wanted = [];
    for (let i = base; wanted.length < max && (!arks || i < arks.length); i += step) {
      if (!done.has(i)) wanted.push(i);
    }
    if (!wanted.length) {
      console.log('nothing to do — every frame in this range is already downloaded');
      return 0;
    }
    if (step > 1 && !arks) {
      console.error('--step needs --arks: without the ark list a jump can only be made by clicking');
      console.error('through the frames it is meant to skip, which defeats the point.');
      return 1;
    }
    console.log(`${wanted.length} frame(s) to fetch${step > 1 ? `, every ${step}th` : ''}`);
    const first = wanted[0];

    const startAt =
      arks && arks[first] ? viewerUrl(startUrl, arks[first], first) : urlAtIndex(startUrl, first);
    if (first > 0 && !(arks && arks[first])) {
      console.error(`warning: resuming at frame ${first} by rewriting i= only — without --arks the`);
      console.error('viewer may not land on that frame. Pass --arks <film-data.json>.');
    }
    await cdp.send('Page.navigate', { url: startAt });

    const load = await waitForViewer(cdp, timeoutMs);
    if (!load.ready) {
      if (load.signedOut) {
        console.error('SIGNED OUT — the debug Chrome is on a FamilySearch sign-in page.');
        console.error(`  ${load.url}`);
        console.error(RECOVERY_HINT);
        return 2;
      }
      if (load.restricted) {

        console.error(`${RESTRICTED_MESSAGE} — last at ${load.url}`);
        for (const line of stopAdvice(RESTRICTED_MESSAGE)) console.error(line);
        return 5;
      }
      if (load.noDownload) {

        console.error(`${NO_DOWNLOAD_MESSAGE} — at ${load.url}`);
        for (const line of stopAdvice(NO_DOWNLOAD_MESSAGE)) console.error(line);
        return 6;
      }
      console.error(`viewer never finished loading — last at ${load.url}`);
      return 2;
    }

    for (let w = 0; w < wanted.length; w++) {
      const frameNo = wanted[w];
      const url = await currentUrl(cdp);
      const ark = arkFromUrl(url);

      if (haveFrame(outDir, frameNo)) {
        console.log(`  p${pad(frameNo)}  already have it`);
      } else {
        const got = await captureFrame(cdp, dlDir, timeoutMs, downloads);
        if (!got.ok) {

          const where = await currentUrl(cdp);
          stopped = isSignedOut(where)
            ? { frame: frameNo, why: `signed out — the browser is at ${where}` }
            : { frame: frameNo, why: got.why };
          break;
        }
        const kind = sniff(got.buf);
        if (!kind.ok) {
          stopped = { frame: frameNo, why: kind.why };
          break;
        }
        if (got.buf.length < TOO_SMALL_BYTES) {
          stopped = { frame: frameNo, why: `download was only ${got.buf.length} bytes` };
          break;
        }
        const name = `p${pad(frameNo)}.${kind.type}`;
        renameSync(got.path, join(outDir, name));
        state.frames[String(frameNo)] = {
          file: name,
          bytes: got.buf.length,
          ark,
          sha256: createHash('sha256').update(got.buf).digest('hex'),
        };
        saveState(outDir, state);
        console.log(`  p${pad(frameNo)}  ${kind.type} ${(got.buf.length / 1024 / 1024).toFixed(1)}MB  ${ark ?? ''}`);
        saved++;
      }

      const nextFrame = wanted[w + 1];
      if (nextFrame === undefined) break;

      if (nextFrame === frameNo + 1) {

        const sel = await clickNext(cdp);
        if (!sel) {
          stopped = await recordStop({ reason: 'no-selector', frameNo });
          break;
        }
        if (w === 0) console.log(`  (next control: ${sel})`);
        const adv = await waitForAdvance(cdp, ark, timeoutMs);
        if (!adv.advanced) {
          stopped = await recordStop({ reason: 'no-advance', frameNo });
          break;
        }
      } else {

        await cdp.send('Page.navigate', { url: viewerUrl(startUrl, arks[nextFrame], nextFrame) });

        const jump = await waitForViewer(cdp, timeoutMs, arks[nextFrame]);
        if (!jump.ready) {
          if (jump.signedOut) {
            stopped = { frame: nextFrame, why: `signed out — the browser is at ${jump.url}` };
          } else if (jump.restricted) {

            stopped = { frame: nextFrame, why: `${RESTRICTED_MESSAGE} — at ${jump.url}`, exitCode: 5 };
          } else if (jump.noDownload) {

            stopped = { frame: nextFrame, why: `${NO_DOWNLOAD_MESSAGE} — at ${jump.url}`, exitCode: 6 };
          } else {
            stopped = { frame: nextFrame, why: 'viewer did not load after jumping to the next sampled frame' };
          }
          break;
        }
      }
      await sleep(settleMs);
    }
  } finally {
    await cleanup();
  }

  console.log('');
  console.log(`saved ${saved} frame(s) into ${outDir}`);
  if (stopped) {
    console.error(`stopped at frame ${stopped.frame}: ${stopped.why}`);
    if (stopped.controls) {
      console.error('next-control DOM state at the stop (recorded in _film.json as lastStop):');
      console.error(describeNextControls(stopped.controls));
    }

    for (const line of stopAdvice(stopped.why)) console.error(line);

    if (/login|expired|unauthori|signed out/i.test(stopped.why)) return 2;
    return stopped.exitCode ?? 0;
  }
  return 0;
}

function status(dir) {
  const state = loadState(dir);
  if (!state) {
    console.error(`no walk in progress in ${dir}`);
    return 1;
  }
  const nums = Object.keys(state.frames).map(Number).sort((a, b) => a - b);
  console.log(dir);
  console.log(`  ${state.startUrl}`);
  console.log(`  ${nums.length} frame(s), ${nums.length ? `${nums[0]}..${nums[nums.length - 1]}` : 'none'}`);
  console.log(`  updated ${state.updatedAt ?? '?'}`);
  const missing = nums.length ? nums.filter((n, i) => i && n !== nums[i - 1] + 1) : [];
  if (missing.length) console.log(`  gaps before: ${missing.join(', ')}`);
  return 0;
}

function arg(argv, name, fallback) {
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
  console.error(`fs-film.js — walk a FamilySearch film by clicking "next", saving each image

  walk --start <viewer url> --out <dir> [--arks film-data.json]
       [--step 5] [--max 672] [--settle 1200] [--timeout 120]

--step N samples every Nth frame (needs --arks). Survey the roll first, bracket
the dates with register-seek.js, then re-run with --step 1 over the stretch
that matters.
--timeout 120 is the practical floor: the sign-in redirect chain has measured
~50s on a HEALTHY session (2026-08-04), so viewer-load waits are floored at
120s regardless of a lower --timeout. A real sign-out is detected early (the
rendered login form / a 90s park on ident.familysearch.org — lib/fs-classify.js)
so raising the timeout does not make a dead session slower to report.
  status --out <dir>
  films  --manifest <film-data.json> [--cat koha:NNNNN]
         list every film in the same catalogue. A manifest can hold more than
         one catalogue (a roll can belong to several); --cat picks the one you
         mean, and without it the first is listed, as before (#409)
  --self-test

EXIT CODES for walk
  0  clean finish — every wanted frame saved; or a stop at the last frame the
     --arks manifest lists, which is a CONFIRMED end of roll
  1  bad arguments, or a checkpoint for a different film
  2  signed out / the viewer never loaded — sign in and re-run the same command
  3  ERROR: the walk stopped early. The --arks manifest says more frames exist
     past the frame it stopped on, so this is a hung viewer, a dropped session
     or a swallowed click — NOT the end of the film. Re-run to resume.
  4  UNVERIFIED: the walk stopped and no --arks manifest was supplied, so
     end-of-roll cannot be told apart from a hang. Pass --arks to get 0 or 3.
  5  RESTRICTED: the viewer rendered "Image Restricted" — this roll is
     FamilySearch Center / affiliate only. A real answer, not an error: the
     page loaded fine and re-running from home cannot change it. Same code
     fs-catalog.js returns for the same verdict.
  6  NO-DOWNLOAD: the opposite of 5 — the film IS viewable (it painted, no
     restriction panel) but the viewer offers no download control, so the
     click-and-take-the-file mechanism has nothing to click. Also a real
     answer, not an error, and also not worth re-running. Read it at the
     screen, or capture it by stitching the viewer's deep-zoom tiles — a
     separate, deferred piece of work that this script does NOT do (#365).

Requires the browser lock (it drives the shared debug Chrome):
  ged-tools browser-lock acquire fs-film --wait 900`);
}

async function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const cmd = argv[0];

  let outDir = arg(argv, '--out');
  if (outDir) outDir = resolveCacheOut(outDir);
  if (cmd === 'films') {
    const f = arg(argv, '--manifest');
    if (!f || !existsSync(f)) {
      console.error(`--manifest <film-data.json> is required${f ? `; not found: ${f}` : ''}`);
      process.exit(1);
    }
    const json = JSON.parse(readFileSync(f, 'utf8'));

    const wanted = arg(argv, '--cat');
    const chosen = selectCatalog(json, wanted);
    if (wanted && !chosen.matched) {
      console.error(`warning: this manifest carries no catalogue ${wanted} — listing ` +
        `${chosen.titleno ? `koha:${chosen.titleno}` : 'the first catalogue'}` +
        `${chosen.title ? ` "${chosen.title}"` : ''}, the first of ${chosen.count}, instead (#409)`);
    }
    const title = chosen.catalog?.data?.display_title ?? chosen.title ?? '(untitled catalogue)';
    console.log(chosen.titleno ? `${title}  [koha:${chosen.titleno}]` : title);
    const summ = chosen.catalog?.data?.note?.find((n) => n.type === 'SUMM')?.text;
    if (summ) console.log(`  ${summ}`);
    for (const f2 of chosen.films) {
      console.log(`  seq ${String(f2.seq).padStart(3)}  film ${f2.film}  DGS ${f2.dgs}  ${f2.text}`);
    }
    process.exit(0);
  }

  if (cmd === 'status' && outDir) process.exit(status(outDir));
  if (cmd !== 'walk' || !outDir) {
    usage();
    process.exit(1);
  }
  const startUrl = arg(argv, '--start');
  if (!startUrl) {
    usage();
    process.exit(1);
  }
  process.exit(
    await walk({
      outDir,
      startUrl,
      arks: (() => {
        const f = arg(argv, '--arks');
        if (!f) return null;
        if (!existsSync(f)) {
          console.error(`--arks file not found: ${f}`);
          process.exit(1);
        }
        try {
          return arksFromFilmData(JSON.parse(readFileSync(f, 'utf8')));
        } catch (err) {
          console.error(`${f}: ${err.message}`);
          process.exit(1);
        }
      })(),
      max: Number(arg(argv, '--max', 1000)),
      step: Math.max(1, Number(arg(argv, '--step', 1))),
      settleMs: Number(arg(argv, '--settle', 1200)),

      timeoutMs: Number(arg(argv, '--timeout', 120)) * 1000,
    })
  );
}
export { STATE_FILE, main, arg, status, usage, walk, nextControlState, currentUrl, waitForViewer, downloadButtonPresent, sleep, captureFrame, clickNext, waitForAdvance };

async function selfTest() { throw new Error("Run npm test in the ged-tools source checkout; private fixtures are not distributed."); }
