import { DEFAULT_CDP_ORIGIN } from './cdp-preflight.js';
import { recordsDir } from '../lib/tools.js';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadChromium } from '../lib/playwright.js';
import { ensureCdpTarget, closeCdpTarget } from './cdp-preflight.js';
import { requireBrowserLock } from './cdp-transport.js';
import { root } from '../lib/tools.js';
import { classify, exitCodeFor, isLoginUrl, relPathFor } from '../lib/gro-classify.js';
import { decideWrite, exitCodeForWrite } from '../lib/capture-guard.js';
export async function main(inputArgs = process.argv.slice(2)) {

const outDir = join(recordsDir, 'sources', 'raw', 'gro');
const rel = (p) => p.replace(root + '/', '');
mkdirSync(outDir, { recursive: true });

const argvAll = inputArgs;
const force = argvAll.includes('--force');

const argv = argvAll.filter((a) => a !== '--force');
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const surname = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--')));
const forename = flag('forename');
const sex = (flag('sex') || '').toUpperCase();
const year = flag('year');
const range = flag('range', '1');
const district = flag('district');
const mmn = flag('mmn');
const index = flag('index', 'birth').toLowerCase();

if (!surname || !year) {
  console.error('usage: ged-tools gro-search <surname> --year YYYY [--forename X] [--sex M|F] [--range 0|1|2] [--district X] [--mmn X] [--index birth|death] [--force]');
  process.exit(1);
}

if (!['0', '1', '2'].includes(String(range))) {
  console.error(`--range must be 0, 1 or 2 (got "${range}") — the GRO form offers no wider window.`);
  process.exit(1);
}
if (!/^\d{4}$/.test(String(year))) {
  console.error(`--year must be a 4-digit year (got "${year}")`);
  process.exit(1);
}

requireBrowserLock('gro-search');

const SEARCH = 'https://www.gro.gov.uk/gro/content/certificates/indexes_search.asp';

const preflight = await ensureCdpTarget();
const browser = await (await loadChromium()).connectOverCDP(DEFAULT_CDP_ORIGIN).catch(async (err) => {
  await closeCdpTarget(preflight);
  throw err;
});
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = ctx.pages().find((p) => p.url().includes('gro.gov.uk')) ?? (await ctx.newPage());
try {
  await page.goto(SEARCH, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);
  if (isLoginUrl(page.url(), SEARCH)) {
    console.error('NOT SIGNED IN — sign in to gro.gov.uk in the debug Chrome window, then re-run.');
    await closeCdpTarget(preflight);
    process.exit(2);
  }

  await page.check(index === 'death' ? '#EW_Death' : '#EW_Birth');
  await page.waitForTimeout(900);
  await page.selectOption('#Year', String(year));
  await page.waitForTimeout(900);
  await page.selectOption('#Range', String(range));
  await page.waitForTimeout(1200);

  await page.fill('input[name=Surname]', surname);
  if (forename) await page.fill('input[name=Forename1]', forename);
  if (sex) await page.selectOption('select[name=Gender]', sex);
  if (district) await page.fill('input[name=District]', district);
  if (mmn) await page.fill('input[name=MothersSurname]', mmn);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    page.click('input[name=SearchIndexes]'),
  ]);
  await page.waitForTimeout(2500);

  const raw = await page.evaluate(() => document.body.innerText);
  const text = raw.replace(/ /g, ' ');

  const verdict = classify({ text, finalUrl: page.url(), url: SEARCH });
  const slug = [surname, forename, sex, year, district].filter(Boolean).join('-')
    .replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase();
  const file = join(outDir, relPathFor(slug, verdict));

  const exists = existsSync(file);
  const decision = decideWrite({ exists, bytesMatch: exists && readFileSync(file, 'utf8') === text, force });
  if (decision === 'write' || decision === 'overwrite') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  process.exitCode = exitCodeForWrite(decision) || exitCodeFor([verdict]);
  const note = {
    write: `saved ${rel(file)}`,
    overwrite: `OVERWROTE ${rel(file)} — previous capture discarded (--force)`,
    'skip-unchanged': `unchanged, kept ${rel(file)}`,
    refuse: `NOT SAVED — ${rel(file)} already exists with different bytes`,
  }[decision];
  console.log(`VERDICT ${verdict}  ${page.url()}  (${note}, ${text.length} bytes)`);
  if (decision === 'refuse') {
    console.error(`  refusing to overwrite ${rel(file)} — read it, move it aside, or re-run with --force to replace it.`);
  }
  if (verdict === 'LOGIN') {
    console.error('session lapsed mid-search — sign back in to gro.gov.uk in the debug Chrome window, then re-run.');
  } else if (verdict !== 'OK') {
    console.error('the Results: section never rendered (the search form came back instead) — nothing parsed, page quarantined.');
  } else {
    const tail = text.slice(text.lastIndexOf('Results:'));

    const refRe = /GRO Reference:\s*(\d{4})\s+(\w+)\s+Quarter\s+in\s+([A-Z .'-]+?)\s+Volume\s+(\S+)\s+Page\s+(\S+)/g;
    const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean);
    const records = [];
    for (let i = 0; i < lines.length; i++) {
      const m = refRe.exec(lines[i]);
      refRe.lastIndex = 0;
      if (!m) continue;
      const prev = lines[i - 1] || '';
      const parts = prev.split('\t').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
      records.push({
        name: parts[0] || '(unparsed)',
        mothersMaidenSurname: parts[1] || '(none listed)',
        year: m[1], quarter: m[2], district: m[3].trim(), volume: m[4], page: m[5],
      });
    }

    const count = (tail.match(/(\d+)\s+Record\(s\) Found/) || [])[1];
    console.log(`query: ${surname}${forename ? ' / ' + forename : ''} ${sex || ''} ${year} +/-${range}${district ? ' / ' + district : ''}`);
    console.log(`records found: ${count ?? (records.length || 0)}`);
    for (const r of records) {
      console.log(`  ${r.name}`);
      console.log(`    mother's maiden surname: ${r.mothersMaidenSurname}`);
      console.log(`    ${r.year} ${r.quarter} quarter, ${r.district}, vol ${r.volume} page ${r.page}`);
    }
    if (!records.length) console.log('  (no rows parsed — see the saved .txt)');
  }
} finally {
  await browser.close();
  await closeCdpTarget(preflight);
}

}
