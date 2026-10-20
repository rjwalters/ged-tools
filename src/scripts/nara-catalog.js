import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  USER_AGENT,
  POLITE_DELAY_MS,
  NaraError,
  buildSearchUrl,
  buildRecordUrl,
  classifyResponse,
  parseSearch,
  parseRecord,
  objectFileName,
} from '../lib/nara-catalog.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function usage() {
  console.log(`nara-catalog — National Archives Catalog search, records and image download (plain HTTP)

  search <query> [--limit N=20] [--page P=1] [--json]
      full-text catalog search; prints NAID, digital-object count and title
  record <naId> [--json]
      one record: title, parent series, and every digital object
      (file name, size, Fold3 designator where the scan came from Fold3)
  get <naId> --out <dir> [--json]
      download every digital object of the record into <dir> as
      nara-<naId>-<file>; an existing file of the catalog's stated size is
      skipped, a size mismatch after download is an error

No key, no account, no browser: these are the keyless /proxy/v3 endpoints
the catalog's own web app reads. A non-JSON answer (the web-app shell, which
the host serves with HTTP 200 for any wrong path) is refused, never read as
"no results".

EXIT CODES: 0 answered · 1 bad arguments · 2 request failed or refused ·
            4 answered, but nothing matched`);
}

async function getJson(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  } catch (err) {
    throw new NaraError(`request failed: ${url}: ${err.message}`);
  }
  return classifyResponse(res.status, res.headers.get('content-type'), await res.text());
}

export async function search(query, opts = {}, fetchImpl = fetch) {
  return parseSearch(await getJson(buildSearchUrl(query, opts), fetchImpl));
}

export async function record(naId, fetchImpl = fetch) {
  return parseRecord(await getJson(buildRecordUrl(naId), fetchImpl), naId);
}

export async function download(naId, outDir, { fetchImpl = fetch, delayMs = POLITE_DELAY_MS, log = console.log } = {}) {
  const rec = await record(naId, fetchImpl);
  if (!rec.objects.length) throw new NaraError(`NAID ${naId} has no digital objects`, { code: 4 });
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const [i, o] of rec.objects.entries()) {
    const dest = join(outDir, objectFileName(naId, o));
    let existing = null;
    try { existing = statSync(dest).size; } catch { /* absent */ }
    if (existing !== null && o.size && existing === o.size) {
      log(`skip  ${dest} (${existing} bytes, matches catalog)`);
      written.push({ ...o, path: dest, skipped: true });
      continue;
    }
    if (i > 0) await sleep(delayMs);
    let res;
    try {
      res = await fetchImpl(o.url, { headers: { 'User-Agent': USER_AGENT } });
    } catch (err) {
      throw new NaraError(`download failed: ${o.url}: ${err.message}`);
    }
    if (res.status !== 200) throw new NaraError(`HTTP ${res.status} for ${o.url}`);
    const ct = res.headers.get('content-type') ?? '';
    if (/html/i.test(ct)) throw new NaraError(`${o.url} answered HTML, not an image — refused`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (o.size && buf.length !== o.size) {
      throw new NaraError(`${o.filename}: got ${buf.length} bytes, catalog says ${o.size} — not written`);
    }
    writeFileSync(dest, buf);
    log(`wrote ${dest} (${buf.length} bytes)`);
    written.push({ ...o, path: dest, skipped: false });
  }
  return { ...rec, written };
}

function flag(args, name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
}

export async function main(args = process.argv.slice(2)) {
  const [verb, target] = args;
  const json = args.includes('--json');
  try {
    if (verb === 'search') {
      if (!target) { usage(); return 1; }
      const r = await search(target, { limit: Number(flag(args, '--limit', 20)), page: Number(flag(args, '--page', 1)) });
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`total: ${r.total}`);
        for (const x of r.results) console.log(`${x.naId.padEnd(10)} ${String(x.objectCount).padStart(5)} obj  ${x.title}`);
      }
      return r.results.length ? 0 : 4;
    }
    if (verb === 'record') {
      if (!target) { usage(); return 1; }
      const r = await record(target);
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`${r.naId}  ${r.title}\n  series: ${r.parent}\n  ${r.objects.length} digital object(s)`);
        for (const o of r.objects) console.log(`  ${o.filename}  ${o.size ?? '?'} bytes  ${o.designator}  ${o.url}`);
      }
      return 0;
    }
    if (verb === 'get') {
      const out = flag(args, '--out');
      if (!target || !out) { usage(); return 1; }
      const r = await download(target, resolve(out));
      if (json) console.log(JSON.stringify(r, null, 2));
      return 0;
    }
    usage();
    return 1;
  } catch (err) {
    if (err instanceof NaraError) {
      console.error(err.message);
      return err.code;
    }
    throw err;
  }
}
