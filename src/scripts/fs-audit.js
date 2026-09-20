import { controls } from '../lib/controls.js';
import { statusLines } from './browser-lock.js';
import { DEFAULT_CDP_ORIGIN } from './cdp-preflight.js';
import { recordsDir } from '../lib/tools.js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { loadChromium } from '../lib/playwright.js';
import { loadGed } from '../lib/ged-edit.js';
import { gedPath } from '../lib/tools.js';
import { classifySlot, stripName } from '../lib/similarity.js';
import { ensureCdpTarget, closeCdpTarget } from './cdp-preflight.js';
import { acquireDriverSlot } from './cdp-transport.js';
import { root } from '../lib/tools.js';

const REPORT_DIR = join(recordsDir, 'fs-tree-audit');

const CACHE = join(REPORT_DIR, '.fs-audit-cache.json');

const yearOf = (d) => {
  const m = (d || '').match(/\b(\d{4})\b/);
  return m ? Number(m[1]) : null;
};

function localPerson(ged, id) {
  if (!ged.has(id)) return null;
  return {
    id,
    name: stripName(ged.value(id, 'NAME')),
    birth: yearOf(ged.value(id, 'BIRT.DATE')),
    death: yearOf(ged.value(id, 'DEAT.DATE')),
  };
}

function localParents(ged, id) {
  const fams = ged.pointers(id, 'FAMC');
  if (!fams.length) return { father: null, mother: null };
  const fam = fams[0];
  const h = ged.pointers(fam, 'HUSB')[0] ?? null;
  const w = ged.pointers(fam, 'WIFE')[0] ?? null;
  return { father: h && localPerson(ged, h), mother: w && localPerson(ged, w) };
}

function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE, 'utf8'));
  } catch {
    return {};
  }
}

async function fetchFsPerson(page, pid) {
  await page.goto(`https://www.familysearch.org/tree/person/details/${pid}`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await page.waitForTimeout(7000);
  return page.evaluate(() => {

    const t = document.title.match(/^(.*?) \(([^)]*)\) • Person/);
    const text = document.body.innerText;

    const sect = text.split(/Parents and Siblings/)[1] || '';
    const blocks = [];
    const re = /([^\n]+)\n(Male|Female|Unknown sex)\n([^\n•]*)\n?•\n([A-Z0-9]{4}-[A-Z0-9]{2,4})/g;
    let m;
    while ((m = re.exec(sect)) && blocks.length < 2) {
      blocks.push({ name: m[1].trim(), sex: m[2], lifespan: m[3].trim(), pid: m[4] });
    }
    return {
      name: t ? t[1] : null,
      lifespan: t ? t[2] : null,
      signedIn: !/Sign In/i.test(text.slice(0, 400)),
      father: blocks.find((b) => b.sex === 'Male') ?? null,
      mother: blocks.find((b) => b.sex === 'Female') ?? null,
    };
  });
}

export function parseLockStatus(statusText) {
  const m = /^HELD by (.+?) since (.+)$/m.exec(statusText ?? '');
  if (m) return { held: true, holder: m[1], since: m[2] };
  return { held: /HELD/.test(statusText ?? ''), holder: null, since: null };
}

export function browserLockPreflight(statusText, declared = process.env.BROWSER_LOCK_HOLDER, io = {}) {
  const { log = console.error, exit = process.exit, slot = {} } = io;
  const status = parseLockStatus(statusText);
  if (!status.held) {
    log('refusing: the shared-browser mutex is not held. Acquire it first:');
    log('  ged-tools browser-lock acquire fs-audit --wait 900');
    log('  …and export BROWSER_LOCK_HOLDER=fs-audit so this check can tell your lock from a sibling’s.');
    return exit(1);
  }
  if (declared && status.holder && declared !== status.holder) {
    log(`browser lock HELD by ${status.holder} since ${status.since ?? '?'} — but this session is ${declared}.`);
    log(`Refusing: the mutex belongs to ${status.holder}, and driving the shared debug Chrome now would interleave`);
    log('navigations with theirs and silently cross-contaminate both sides of the results.');
    log(`Wait for ${status.holder} to release it — or, if you ARE the holder, set BROWSER_LOCK_HOLDER to the exact`);
    log('name you passed to `acquire`.');
    return exit(2);
  }

  return acquireDriverSlot('fs-audit', { log, exit, ...slot });
}

async function audit({ rootPid, rootGed, generations }) {
  const ged = loadGed(gedPath);
  if (!ged.has(rootGed)) throw new Error(`no local record @${rootGed}@`);

  const lockState = statusLines().join('\n');
  browserLockPreflight(lockState);

  mkdirSync(REPORT_DIR, { recursive: true });
  const cache = loadCache();
  const rows = [];
  const tab = await ensureCdpTarget();
  const browser = await (await loadChromium()).connectOverCDP(DEFAULT_CDP_ORIGIN);
  try {
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();

    const queue = [{ pid: rootPid, gedId: rootGed, generation: 0, lineage: 'root' }];
    while (queue.length) {
      const slot = queue.shift();
      let fs = cache[slot.pid];
      if (!fs) {
        process.stderr.write(`fetching ${slot.pid} (${slot.lineage})…\n`);
        fs = await fetchFsPerson(page, slot.pid);
        if (!fs.name) {
          rows.push({ ...slot, verdict: 'FETCH-FAILED', detail: 'person page did not render a title — session dead? re-auth and re-run (cache resumes)' });
          continue;
        }
        cache[slot.pid] = fs;
        writeFileSync(CACHE, JSON.stringify(cache, null, 1));
      }
      const local = localPerson(ged, slot.gedId);
      const { verdict, detail, score } = classifySlot({ ...fs, pid: slot.pid }, local, slot.childSurname);
      rows.push({ ...slot, fs, local, verdict, detail, score });
      if (verdict !== 'MATCH' || slot.generation >= generations) continue;
      const lp = localParents(ged, slot.gedId);
      for (const [role, fsParent, localParent] of [
        ['father', fs.father, lp.father],
        ['mother', fs.mother, lp.mother],
      ]) {
        const lineage = `${slot.lineage}/${role}`;
        const childSurname = fs.name.split(' ').pop();
        if (fsParent && localParent) {
          queue.push({ pid: fsParent.pid, gedId: localParent.id, generation: slot.generation + 1, lineage, childSurname });
        } else if (fsParent || localParent) {
          rows.push({
            lineage,
            generation: slot.generation + 1,
            pid: fsParent?.pid,
            fs: fsParent,
            local: localParent,
            ...classifySlot(fsParent, localParent, childSurname),
          });
        }
      }
    }
    await page.close();
  } finally {
    await browser.close();
    await closeCdpTarget(tab);
  }
  return rows;
}

function report(rows, { rootPid, rootGed, generations }) {
  const out = [];
  out.push(`# FamilySearch tree audit — ${rootPid} vs @${rootGed}@, ${generations} generation(s) up`);
  out.push('');
  out.push('| Slot | FS person | Local person | Verdict | Score | Detail |');
  out.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    const fsCell = r.fs
      ? `[${r.fs.name}](https://www.familysearch.org/tree/person/details/${r.pid}) (${r.fs.lifespan ?? '?'})`
      : '—';
    const localCell = r.local ? `${r.local.id} ${r.local.name} (${r.local.birth ?? '?'}–${r.local.death ?? '?'})` : '—';
    const scoreCell = r.score != null ? r.score.toFixed(2) : '—';
    out.push(`| ${r.lineage} | ${fsCell} | ${localCell} | **${r.verdict}** | ${scoreCell} | ${r.detail || ''} |`);
  }
  const counts = {};
  for (const r of rows) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  out.push('');
  out.push(Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', '));
  out.push('');
  out.push('A MISMATCH prunes its branch: everyone above a wrong person is wrong-tree, so the');
  out.push('FS ancestors beyond that slot are deliberately not walked or compared.');
  out.push('');
  out.push('Score: weighted similarity (surname 0.5 with married/maiden-name allowances,');
  out.push('given 0.15, birth 0.175, death 0.175 — lib/similarity.js); MATCH at ≥ 0.75.');
  return out.join('\n');
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  let rootPid = controls.familysearchRoot?.pid ?? null;
  let rootGed = controls.familysearchRoot?.gedId ?? null;
  let generations = 4;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') {
      const [p, g] = (argv[++i] || '').split('=');
      if (!p || !g) {
        console.error('usage: --root <FS-PID>=<GED-ID>');
        process.exit(1);
      }
      rootPid = p;
      rootGed = g;
    } else if (argv[i] === '--generations') generations = Number(argv[++i]);
  }
  if (!rootPid || !rootGed) throw new Error('Supply --root <FS-PID>=<GED-ID>');
  return audit({ rootPid, rootGed, generations })
    .then((rows) => console.log(report(rows, { rootPid, rootGed, generations })))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
export { main, audit, root, REPORT_DIR, loadCache, CACHE, fetchFsPerson, localPerson, yearOf, localParents, report };

function selfTest() { throw new Error("Run npm test in the ged-tools source checkout; private fixtures are not distributed."); }
