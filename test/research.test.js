import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveConfig } from '../src/lib/config.js';
import { decideWritePair } from '../src/lib/capture-guard.js';
import { selectCatalog } from '../src/lib/fs-film-data.js';
import { classify as groClassify } from '../src/lib/gro-classify.js';
import { verifyControl } from '../src/lib/freebmd.js';
import { coupleListUrl, assertFreeSurface } from '../src/scripts/prdh-couples.js';
import { familleListUrl, assertFreeSurface as assertFamilyList } from '../src/scripts/prdh-familles.js';
import { budgetGate, recordDownload, reconcileVerdict, resolvePending } from '../src/scripts/archion.js';
import { sessionVerdict } from '../src/scripts/fs-fulltext.js';
import { tryAcquire, releaseLock, renewLock } from '../src/scripts/browser-lock.js';
import { acquireDriverSlot, releaseDriverSlot, requireBrowserLock, connect } from '../src/scripts/cdp-transport.js';
import { safeDownloadPath } from '../src/scripts/cdp-download-guard.js';
import { resolveCacheDest } from '../src/scripts/register-cache.js';
import { runPool } from '../src/lib/tab-pool.js';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ged-tools-research-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('configuration resolves caller paths and rejects unknown keys', () => {
  const root = resolve('synthetic-project');
  const conf = resolveConfig(root, { gedPath: 'custom.ged' }, { GENEALOGY_RECORDS_DIR: 'captures' });
  assert.equal(conf.gedPath, join(root, 'custom.ged'));
  assert.equal(conf.recordsDir, join(root, 'captures'));
  assert.throws(() => resolveConfig(root, { typo: 'x' }), /unknown key/);
});

test('capture pair refuses partial or differing overwrite', () => {
  assert.equal(decideWritePair({ parts: [{ exists: true, bytesMatch: true }, { exists: false }] }), 'refuse');
  assert.equal(decideWritePair({ parts: [{ exists: true, bytesMatch: true }, { exists: true, bytesMatch: true }] }), 'skip-unchanged');
});

test('FamilySearch chooses the requested catalog instead of the first one', () => {
  const catalog = n => ({ data: { titleno: n, title: 'Synthetic catalog', film_note: [{ digital_film_no: n, text: 'Synthetic film' }] } });
  const found = selectCatalog({ catalogs: [catalog('111'), catalog('222')] }, 'koha:222');
  assert.equal(found.matched, true);
  assert.equal(found.index, 1);
  assert.equal(found.films[0].dgs, '222');
});

test('FamilySearch sign-out and missing routes cannot report alive', () => {
  assert.equal(sessionVerdict({ status: 401 }), 'SIGNED_OUT');
  assert.equal(sessionVerdict({ status: 404, body: '{}' }), 'INCONCLUSIVE');
  assert.equal(sessionVerdict({ status: 200, body: '{"users":[]}' }), 'ALIVE');
});

test('PRDH list URLs cannot navigate to metered record endpoints', () => {
  assert.doesNotThrow(() => assertFreeSurface(coupleListUrl({ nh: 'Synthetic' })));
  assert.doesNotThrow(() => assertFamilyList(familleListUrl({ nf: 'Synthetic' })));
  for (const guard of [assertFreeSurface, assertFamilyList]) {
    assert.throws(() => guard('https://www.prdh-igd.com/Membership/en/PRDH/acte/123'));
    assert.throws(() => guard('https://example.invalid/Liste/Couple'));
  }
});

test('GRO forms and login redirects are not empty results', () => {
  assert.equal(groClassify({ text: 'Search indexes' }), 'FORM');
  assert.equal(groClassify({ text: 'Results: 0 Record(s) Found' }), 'OK');
  assert.equal(groClassify({ finalUrl: 'https://example.invalid/login', url: 'https://example.invalid/search' }), 'LOGIN');
});

test('FreeBMD controls must be nonempty and match all expected records', () => {
  assert.throws(() => verifyControl([], []), /known-positive/);
  assert.throws(() => verifyControl([], [{}]), /known-positive/);
  const expected = [{ surname: 'Synthetic', given: 'Alpha', page: '1' }];
  assert.equal(verifyControl([], expected).passed, false);
  assert.equal(verifyControl(expected, expected).passed, true);
});

test('Archion pending downloads consume budget until positively reconciled', () => {
  let state = { windows: [{ start: '2000-01-01', cap: 1, downloads: [] }] };
  state = recordDownload(state, '2000-01-02', { token: 'synthetic', pending: true });
  assert.equal(budgetGate(state, '2000-01-02').ok, false);
  assert.equal(reconcileVerdict({ docStatus: 500 }), 'keep');
  assert.equal(reconcileVerdict({ docStatus: 404 }), 'unrecord');
  assert.equal(reconcileVerdict({ fileArrived: true }), 'resolve');
  const reconciled = resolvePending(state, 'synthetic');
  assert.equal(reconciled.windows[0].downloads.length, 1);
  assert.equal(budgetGate(reconciled, '2000-01-02').ok, false);
});

test('browser lock and driver slot enforce holder and process exclusion', t => {
  const dir = scratch(t), lockDir = join(dir, 'state', 'lock');
  const io = { lockDir, metaFile: join(lockDir, 'holder.json'), staleMs: 1200000, log: () => {} };
  assert.equal(tryAcquire('synthetic-a', io), true);
  assert.equal(tryAcquire('synthetic-b', io), false);
  assert.equal(renewLock('synthetic-b', io).ok, false);
  assert.equal(releaseLock('synthetic-b', io).ok, false);
  let exitCode;
  const slotDir = join(dir, 'slot');
  requireBrowserLock('synthetic-b', { ...io, slotDir, actualHolder: 'synthetic-b', exit: c => { exitCode = c; } });
  assert.equal(exitCode, 2);
  const slot = { lockDir, slotDir, pid: 12345, isAlive: () => true, log: () => {}, exit: c => { exitCode = c; } };
  assert.equal(acquireDriverSlot('synthetic-a', slot), true);
  acquireDriverSlot('synthetic-b', { ...slot, pid: 12346 });
  assert.equal(exitCode, 75);
  assert.equal(releaseDriverSlot({ ...slot, pid: 12346 }), false);
  assert.equal(releaseDriverSlot(slot), true);
  assert.equal(releaseLock('synthetic-a', io).ok, true);
});

test('download and cache path guards reject hidden leaves and escape paths', t => {
  const dir = scratch(t);
  assert.throws(() => safeDownloadPath(join(dir, '.hidden')), /hidden/);
  assert.equal(safeDownloadPath(join(dir, '.cache', 'incoming')), join(dir, '.cache', 'incoming'));
  assert.throws(() => resolveCacheDest('../escape', { cacheDir: dir }), /escape|outside/);
});

test('CDP transport rejects pending work on disconnect', async t => {
  const original = globalThis.WebSocket;
  let ws;
  globalThis.WebSocket = class {
    constructor() { ws = this; queueMicrotask(() => this.onopen()); }
    send() { queueMicrotask(() => this.onclose()); }
    close() {}
  };
  t.after(() => { globalThis.WebSocket = original; });
  const cdp = await connect('ws://synthetic.invalid', 100, 100, () => {});
  await assert.rejects(cdp.send('Runtime.evaluate'), /closed|disconnect/i);
  assert.ok(ws);
});

test('task pool abort skips queued work after a terminal result', async () => {
  const run = await runPool([1, 2, 3], async n => n, { concurrency: 1, shouldAbort: () => true });
  assert.equal(run.aborted, true);
  assert.equal(run.skipped, 2);
});

test('all runtime modules import without network in an unrelated directory', t => {
  const dir = scratch(t);
  const modules = ['lib', 'scripts'].flatMap(kind => readdirSync(new URL(`../src/${kind}/`, import.meta.url)).map(file => new URL(`../src/${kind}/${file}`, import.meta.url).href));
  const contextUrl = new URL('../src/lib/tools.js', import.meta.url).href;
  const code = `globalThis.fetch = () => { throw new Error('network forbidden'); }; for (const url of ${JSON.stringify(modules)}) await import(url); const context = await import(${JSON.stringify(contextUrl)}); console.log(JSON.stringify({ root: context.root, mainRoot: context.mainRoot, cache: context.registerCacheDir }));`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, encoding: 'utf8', env: { ...process.env, GENEALOGY_CONTROLS_PATH: '', GENEALOGY_PROJECT_ROOT: dir, REGISTER_CACHE_DIR: join(dir, 'shared-cache') } });
  const context = JSON.parse(output);
  assert.equal(context.root, dir);
  assert.equal(context.mainRoot, dir);
  assert.equal(context.cache, join(dir, 'shared-cache'));
  assert.deepEqual(readdirSync(dir), []);
});

test('Matricula parser accepts synthetic image paths and rejects missing pages', async () => {
  const { parseRegisterPage, assertFiles, buildPageUrl } = await import('../src/lib/matricula.js');
  const result = parseRegisterPage('<script>var files = ["/synthetic/one.jpg", "/synthetic/two.jpg"];</script>');
  assert.deepEqual(result.files, ['/synthetic/one.jpg', '/synthetic/two.jpg']);
  assert.throws(() => assertFiles({ files: [] }, 'https://example.invalid/register'), /no page-image/);
  assert.throws(() => buildPageUrl('', 'synthetic'), /path/i);
});

test('FreeBMD cannot confirm a negative without a configured live control', async () => {
  const { runSearch } = await import('../src/scripts/freebmd.js');
  const form = '<form><input type="hidden" name="db" value="synthetic"><input type="hidden" name="v" value="synthetic"></form>';
  const empty = '<table><tr><th>Surname</th><th>First name(s)</th><th>Age</th><th>District</th><th>Vol</th><th>Page</th></tr></table>';
  let calls = 0;
  await assert.rejects(runSearch({ type: 'Deaths', surname: 'Synthetic', startYear: '1900', endYear: '1900' }, {
    fetchImpl: async () => ({ status: 200, text: async () => ++calls === 1 ? form : empty }),
    sleep: async () => {}, controlQuery: null, controlExpected: [],
  }), /known-positive control/);
  assert.equal(calls, 2);
});

test('CLI help and missing private controls need no account or package-relative writes', t => {
  const dir = scratch(t);
  const bin = new URL('../bin/ged-tools.js', import.meta.url);
  const env = { ...process.env, GENEALOGY_PROJECT_ROOT: dir, GENEALOGY_CONTROLS_PATH: '' };
  const help = execFileSync(process.execPath, [bin.pathname, '--help'], { cwd: dir, env, encoding: 'utf8' });
  assert.match(help, /fs-catalog/);
  assert.match(help, /prdh-record/);
  try {
    execFileSync(process.execPath, [bin.pathname, 'freebmd', 'deaths', 'Synthetic', '--start', '1900', '--end', '1900'], { cwd: dir, env, stdio: 'pipe' });
    assert.fail('missing control must refuse');
  } catch (error) {
    assert.equal(error.status, 1);
    assert.match(error.stderr.toString(), /GENEALOGY_CONTROLS_PATH/);
  }
  assert.deepEqual(readdirSync(dir), []);
});
