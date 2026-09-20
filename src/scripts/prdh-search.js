import { DEFAULT_CDP_ORIGIN } from './cdp-preflight.js';
import { recordsDir } from '../lib/tools.js';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { loadChromium } from '../lib/playwright.js';
import { ensureCdpTarget, closeCdpTarget } from './cdp-preflight.js';
import { requireBrowserLock } from './cdp-transport.js';
import { root } from '../lib/tools.js';
import { classify, exitCodeFor, relPathFor } from '../lib/prdh-classify.js';
import { decideWritePair, exitCodeForWrite } from '../lib/capture-guard.js';
export async function main(inputArgs = process.argv.slice(2)) {

const outDir = join(recordsDir, 'sources', 'raw', 'prdh');
const rel = (p) => p.replace(root + '/', '');
mkdirSync(outDir, { recursive: true });

const argv = inputArgs;
const member = argv.includes('--member');
const force = argv.includes('--force');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const page_ = flag('--page') ?? '1';
const surnom = flag('--surnom');
const rs = flag('--rs') ?? (surnom ? 'OU' : undefined);
const args = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--page' && argv[i - 1] !== '--surnom' && argv[i - 1] !== '--rs');
const [surname, given, yearMin, yearMax] = args;
if (!surname) {
  console.error('usage: ged-tools prdh-search <surname> [given] [yearMin] [yearMax] [--member] [--page N] [--surnom NAME] [--rs ET|OU] [--force]');
  process.exit(1);
}

requireBrowserLock('prdh-search');

const base = member
  ? 'https://www.prdh-igd.com/Membership/en/PRDH/Liste/acte'
  : 'https://www.prdh-igd.com/Gratuit/en/PRDH/Liste/acte';
const params = new URLSearchParams();
params.set('n', surname);
if (surnom) params.set('s', surnom);
if (rs) params.set('rs', rs);
if (given) {
  const tokens = given.split(/[-\s]+/).filter(Boolean);
  if (tokens.length > 1) console.log(`note: compound given "${given}" — searching first token "${tokens[0]}" (PRDH first names are single tokens)`);
  params.set('p', tokens[0]);
}
if (yearMin) params.set('amin', String(yearMin));
if (yearMax) params.set('amax', String(yearMax));
params.set('pg', page_);
const url = `${base}?${params}`;

const preflight = await ensureCdpTarget();
const browser = await (await loadChromium()).connectOverCDP(DEFAULT_CDP_ORIGIN).catch(async (err) => {
  await closeCdpTarget(preflight);
  throw err;
});
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = await ctx.newPage();
try {
  console.log(`mode: ${member ? 'MEMBER' : 'FREE'} | ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  const text = await page.evaluate(() => document.body.innerText);
  const loggedIn = /Hello,/.test(text);
  console.log(`session: ${loggedIn ? (text.match(/Hello,\s*\S+\s*\(Hits: \d+\)/)?.[0] ?? 'logged in') : 'NOT logged in'}`);
  if (member && !loggedIn) {
    console.error('member search needs a logged-in prdh-igd.com session in the debug Chrome profile');
    await closeCdpTarget(preflight);
    process.exit(2);
  }

  const count = text.match(/(\d+) to (\d+) on (\d+)/);
  if (count) console.log(`results: ${count[0]} (page ${page_})`);
  else if (text.includes('No data')) console.log('results: none ("No data :/")');

  const slug = [surname, given, yearMin, yearMax, surnom, page_ !== '1' ? `pg${page_}` : '']
    .filter(Boolean)
    .join('-')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .toLowerCase();
  const stamp = createHash('sha1').update(url).digest('hex').slice(0, 8);
  const html = await page.content();

  const verdict = classify({ html, text, finalUrl: page.url(), url });
  const file = join(outDir, relPathFor(`${slug}-${stamp}`, verdict));
  const txtFile = file.replace(/\.html$/, '.txt');

  const part = (f, content) => {
    const exists = existsSync(f);
    return { exists, bytesMatch: exists && readFileSync(f, 'utf8') === content };
  };
  const decision = decideWritePair({ parts: [part(file, html), part(txtFile, text)], force });
  if (decision === 'write' || decision === 'overwrite') {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, html);
    writeFileSync(txtFile, text);
  }
  process.exitCode = exitCodeForWrite(decision) || exitCodeFor([verdict]);
  const note = {
    write: `saved ${rel(file)} + .txt`,
    overwrite: `OVERWROTE ${rel(file)} + .txt — previous capture discarded (--force)`,
    'skip-unchanged': `unchanged, kept ${rel(file)} + .txt`,
    refuse: `NOT SAVED — ${rel(file)} (or its .txt) already exists with different bytes`,
  }[decision];
  console.log(`VERDICT ${verdict}  ${url}  (${note}, ${html.length} bytes)`);
  if (decision === 'refuse') {
    console.error(`  refusing to overwrite ${rel(file)} — read it, move it aside, or re-run with --force to replace it.`);
  }
  if (verdict === 'LOGIN') console.error('subscribers interstitial served in place of the list (#79) — quarantined, do not retry until the session is re-established');
  console.log('===TEXT===');
  console.log(text);
  console.log('===END===');
} finally {
  await page.close();
  await browser.close();
  await closeCdpTarget(preflight);
}

}
