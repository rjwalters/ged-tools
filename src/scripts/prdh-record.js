import { DEFAULT_CDP_ORIGIN } from './cdp-preflight.js';
import { recordsDir } from '../lib/tools.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadChromium } from '../lib/playwright.js';
import { ensureCdpTarget, closeCdpTarget } from './cdp-preflight.js';
import { requireBrowserLock } from './cdp-transport.js';
import { root } from '../lib/tools.js';
import { classify, exitCodeFor, relPathFor } from '../lib/prdh-classify.js';
export async function main(inputArgs = process.argv.slice(2)) {

const outDir = join(recordsDir, 'sources', 'raw', 'prdh');
mkdirSync(outDir, { recursive: true });

const KINDS = ['famille', 'union', 'acte', 'individu'];
const [kind, id] = inputArgs;
if (!KINDS.includes(kind) || !/^\d+$/.test(id ?? '')) {
  console.error(`usage: ged-tools prdh-record <${KINDS.join('|')}> <id>`);
  process.exit(1);
}

const stem = `${kind}-${id}`;
const outFile = join(outDir, `${stem}.txt`);
if (existsSync(outFile)) {
  console.error(`already saved: records/sources/raw/prdh/${stem}.txt — read it instead of re-spending a hit`);
  process.exit(3);
}

requireBrowserLock('prdh-record');

const url = `https://www.prdh-igd.com/Membership/en/PRDH/${kind}/${id}`;
const hitsOf = (t) => Number(t.match(/Hits:\s*(\d+)/)?.[1] ?? NaN);

const preflight = await ensureCdpTarget();
const browser = await (await loadChromium()).connectOverCDP(DEFAULT_CDP_ORIGIN).catch(async (err) => {
  await closeCdpTarget(preflight);
  throw err;
});
const ctx = browser.contexts()[0] ?? (await browser.newContext());
const page = await ctx.newPage();
try {

  const balanceUrl = 'https://www.prdh-igd.com/Membership/en/PRDH/Liste/Famille?nh=Example&pg=1';
  await page.goto(balanceUrl, { waitUntil: 'networkidle', timeout: 60000 });
  const preText = await page.evaluate(() => document.body.innerText);

  if (classify({ text: preText, finalUrl: page.url(), url: balanceUrl }) === 'LOGIN') {
    console.error('subscribers interstitial on the free list page (#79) — session is walled, not spending the hit');
    await closeCdpTarget(preflight);
    process.exit(2);
  }
  const before = hitsOf(preText);
  if (!Number.isFinite(before)) {
    console.error('could not read the hit balance — is the debug Chrome logged in to prdh-igd.com?');
    await closeCdpTarget(preflight);
    process.exit(2);
  }
  console.log(`hits before: ${before}`);

  console.log(`opening ${url}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  const text = await page.evaluate(() => document.body.innerText);
  const html = await page.content();
  const after = hitsOf(text);
  console.log(`hits after: ${after} (cost ${before - after})`);

  const verdict = classify({ html, text, finalUrl: page.url(), url });
  const file = join(outDir, relPathFor(stem, verdict));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, html);
  writeFileSync(file.replace(/\.html$/, '.txt'), text);
  console.log(`VERDICT ${verdict}  ${url}  (saved ${file.replace(root + '/', '')}, ${html.length} bytes)`);
  if (verdict === 'LOGIN') console.error('subscribers interstitial served in place of the record (#79) — quarantined; the canonical file was not written, so re-running after re-auth will re-fetch');
  console.log('===TEXT===');
  console.log(text);
  console.log('===END===');
  process.exitCode = exitCodeFor([verdict]);
} finally {
  await page.close();
  await browser.close();
  await closeCdpTarget(preflight);
}

}
