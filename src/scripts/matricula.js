import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  SITE,
  IMG_HOST,
  USER_AGENT,
  POLITE_DELAY_MS,
  KEY_ROTATION_HINT,
  MatriculaError,
  buildPageUrl,
  buildTileUrl,
  tileChecksum,
  padTilePlain,
  csrfFromSetCookies,
  csrfFromHtml,
  parseRegisterPage,
  parseParishPage,
  assertFiles,
  extractJsonArray,
  imageFormat,
  classifyImageResponse,
} from '../lib/matricula.js';
import { decideWrite, exitCodeForWrite } from '../lib/capture-guard.js';
const HERE = dirname(fileURLToPath(import.meta.url));

import { root as ROOT } from '../lib/tools.js';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function toPath(urlOrSlug) {
  const s = String(urlOrSlug).trim();
  if (/^https?:\/\//i.test(s)) return new URL(s).pathname;
  return '/' + s.replace(/^\/+/, '');
}

export async function getPage(url, { fetchImpl = globalThis.fetch, ua = USER_AGENT } = {}) {
  const res = await fetchImpl(url, { method: 'GET', headers: { 'User-Agent': ua, Accept: 'text/html' } });
  const html = await res.text();
  if (res.status !== 200) {
    throw new MatriculaError(`HTTP ${res.status} from ${url}\n${html.slice(0, 300)}`);
  }
  const setCookies = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const csrf = csrfFromSetCookies(setCookies) ?? csrfFromHtml(html);
  return { html, csrf, url };
}

export async function getImage(pageUrl, { referer, fetchImpl = globalThis.fetch, ua = USER_AGENT } = {}) {
  const res = await fetchImpl(pageUrl, {
    method: 'GET',
    headers: { 'User-Agent': ua, Accept: 'image/*', ...(referer ? { Referer: referer } : {}) },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const classified = classifyImageResponse({
    status: res.status,
    contentType: res.headers?.get?.('content-type') ?? '',
    bytes: buf,
  });
  return { ...classified, bytes: buf, url: pageUrl };
}

export async function listRegisters(parishArg, deps = {}) {
  const path = toPath(parishArg);
  const url = `${SITE}${path.replace(/\/+$/, '')}/`;
  const { html } = await getPage(url, deps);
  const registers = parseParishPage(html, path);
  return { url, registers };
}

export async function listPages(registerArg, deps = {}) {
  const path = toPath(registerArg);
  const url = `${SITE}${path.replace(/\/+$/, '')}/`;
  const { html, csrf } = await getPage(url, deps);
  const parsed = parseRegisterPage(html);

  parsed.csrf = csrf ?? parsed.csrf;
  assertFiles(parsed, url);
  return { url, csrf: parsed.csrf, ...parsed };
}

export function pageRange(spec, total) {
  if (!spec) return Array.from({ length: total }, (_, i) => i + 1);
  const m = String(spec).match(/^(\d+)(?:-(\d+))?$/);
  if (!m) throw new MatriculaError(`--pages must be N or N-M (got ${JSON.stringify(spec)})`);
  const lo = parseInt(m[1], 10);
  const hi = m[2] ? parseInt(m[2], 10) : lo;
  if (lo < 1 || hi < lo) throw new MatriculaError(`--pages range invalid: ${spec}`);
  const out = [];
  for (let p = lo; p <= Math.min(hi, total); p++) out.push(p);
  return out;
}

export function slugForRegister(registerArg) {
  return toPath(registerArg)
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase();
}

export function parseArgs(argv) {
  const opts = { verb: null, target: null, pages: null, slug: null, force: false, ua: USER_AGENT, selfTest: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--self-test': opts.selfTest = true; break;
      case '--pages': opts.pages = argv[++i]; break;
      case '--slug': opts.slug = argv[++i]; break;
      case '--force': opts.force = true; break;
      case '--browser-ua': opts.ua = BROWSER_UA; break;
      default:
        if (a.startsWith('--')) throw new MatriculaError(`unknown option ${a}`);
        rest.push(a);
    }
  }
  if (opts.selfTest) return opts;
  [opts.verb, opts.target] = rest;
  if (!['registers', 'pages', 'fetch'].includes(opts.verb) || !opts.target) {
    throw new MatriculaError(
      'usage: ged-tools matricula <registers|pages|fetch> <url-or-slug> ' +
        '[--pages N-M] [--slug NAME] [--force] [--browser-ua] | --self-test',
    );
  }
  return opts;
}

async function captureDir() {
  const { loadConfig } = await import('../lib/config.js');
  return join(loadConfig(ROOT).recordsDir, 'sources', 'raw', 'matricula');
}

async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (opts.selfTest) return selfTest();

  console.log(`Matricula — ${opts.verb} ${opts.target}`);
  console.log('  free, no login; plain HTTP with a descriptive User-Agent;');
  console.log(`  ${POLITE_DELAY_MS / 1000}s pauses between requests. No browser, no mutex, no metered spend.\n`);

  try {
    if (opts.verb === 'registers') {
      const { url, registers } = await listRegisters(opts.target, { ua: opts.ua });
      console.log(`${registers.length} register link(s) under ${url}:\n`);
      for (const r of registers) console.log(`  ${r.href}${r.context ? `  — ${r.context}` : ''}`);
      return;
    }
    if (opts.verb === 'pages') {
      const { url, files, source, imgHost } = await listPages(opts.target, { ua: opts.ua });
      console.log(`${files.length} page image(s) [${source}] via ${imgHost}, register ${url}:\n`);
      files.forEach((f, i) => console.log(`  ${String(i + 1).padStart(4)}  ${f}`));
      return;
    }

    const { url, files, csrf, imgHost } = await listPages(opts.target, { ua: opts.ua });
    const wanted = pageRange(opts.pages, files.length);
    const slug = opts.slug ?? slugForRegister(opts.target);
    const outDir = join(await captureDir(), slug);
    mkdirSync(outDir, { recursive: true });
    console.log(`fetching ${wanted.length} of ${files.length} page(s) into records/sources/raw/matricula/${slug}/\n`);

    let refused = 0;
    let walls = 0;
    for (const n of wanted) {
      await defaultSleep(POLITE_DELAY_MS);
      const filePath = files[n - 1];
      const pageUrl = buildPageUrl(filePath, csrf, imgHost);
      const img = await getImage(pageUrl, { referer: url, ua: opts.ua });
      if (img.verdict !== 'image') {
        walls++;
        console.error(`  p${n}: ${img.verdict} — ${img.message}`);
        continue;
      }
      const dest = join(outDir, `p${String(n).padStart(4, '0')}.${img.format === 'png' ? 'png' : 'jpg'}`);
      const exists = existsSync(dest);
      const bytesMatch = exists && Buffer.compare(readFileSync(dest), img.bytes) === 0;
      const decision = decideWrite({ exists, bytesMatch, force: opts.force });
      if (decision === 'write' || decision === 'overwrite') {
        writeFileSync(dest, img.bytes);
        console.log(`  p${n}: ${decision} ${dest} (${img.format}, ${img.bytes.length} bytes)`);
      } else if (decision === 'skip-unchanged') {
        console.log(`  p${n}: unchanged, kept ${dest}`);
      } else {
        refused++;
        console.error(`  p${n}: REFUSE — ${dest} differs on disk; pass --force to overwrite (the #343 guard)`);
      }
    }
    if (walls) {
      console.error(`\n${walls} page(s) hit a wall (403/HTML/non-image). NOT a research negative.`);
      console.error(`  ${KEY_ROTATION_HINT}`);
    }
    process.exitCode = exitCodeForWrite(refused ? 'refuse' : 'write') || (walls ? 2 : 0);
    return;
  } catch (err) {
    console.error(err instanceof MatriculaError ? err.message : err.stack || err.message);
    process.exit(2);
  }
}
export { BROWSER_UA, main, captureDir, ROOT, HERE, defaultSleep };

function selfTest() { throw new Error("Run npm test in the ged-tools source checkout; private fixtures are not distributed."); }
