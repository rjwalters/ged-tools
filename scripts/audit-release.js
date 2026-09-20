// A file-boundary check, not a proof that arbitrary text contains no personal data.
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const allowed = new Set([
  "LICENSE",
  ".gitignore",
  "PRIVACY.md",
  "README.md",
  "bin/ged-tools.js",
  "package.json",
  "scripts/audit-release.js",
  "src/ged-edit.js",
  "src/gedcom.js",
  "src/index.js",
  "src/lib/capture-guard.js",
  "src/lib/config.js",
  "src/lib/controls.js",
  "src/lib/freebmd.js",
  "src/lib/fs-classify.js",
  "src/lib/fs-film-data.js",
  "src/lib/ged-edit.js",
  "src/lib/gedcom.js",
  "src/lib/gro-classify.js",
  "src/lib/matricula.js",
  "src/lib/patches.js",
  "src/lib/playwright.js",
  "src/lib/prdh-classify.js",
  "src/lib/similarity.js",
  "src/lib/tab-pool.js",
  "src/lib/tools.js",
  "src/patches.js",
  "src/scripts/archion.js",
  "src/scripts/browser-lock.js",
  "src/scripts/cdp-download-guard.js",
  "src/scripts/cdp-preflight.js",
  "src/scripts/cdp-transport.js",
  "src/scripts/freebmd.js",
  "src/scripts/fs-audit.js",
  "src/scripts/fs-books.js",
  "src/scripts/fs-catalog.js",
  "src/scripts/fs-film.js",
  "src/scripts/fs-fulltext.js",
  "src/scripts/fs-image.js",
  "src/scripts/fs-personas.js",
  "src/scripts/gro-search.js",
  "src/scripts/matricula.js",
  "src/scripts/prdh-couples.js",
  "src/scripts/prdh-familles.js",
  "src/scripts/prdh-record.js",
  "src/scripts/prdh-search.js",
  "src/scripts/register-batch.js",
  "src/scripts/register-cache.js",
  "src/scripts/register-seek.js",
  "test/core.test.js",
  "test/research.test.js"
]);
const packed = new Set([
  "LICENSE",
  "PRIVACY.md",
  "README.md",
  "bin/ged-tools.js",
  "package.json",
  "src/ged-edit.js",
  "src/gedcom.js",
  "src/index.js",
  "src/lib/capture-guard.js",
  "src/lib/config.js",
  "src/lib/controls.js",
  "src/lib/freebmd.js",
  "src/lib/fs-classify.js",
  "src/lib/fs-film-data.js",
  "src/lib/ged-edit.js",
  "src/lib/gedcom.js",
  "src/lib/gro-classify.js",
  "src/lib/matricula.js",
  "src/lib/patches.js",
  "src/lib/playwright.js",
  "src/lib/prdh-classify.js",
  "src/lib/similarity.js",
  "src/lib/tab-pool.js",
  "src/lib/tools.js",
  "src/patches.js",
  "src/scripts/archion.js",
  "src/scripts/browser-lock.js",
  "src/scripts/cdp-download-guard.js",
  "src/scripts/cdp-preflight.js",
  "src/scripts/cdp-transport.js",
  "src/scripts/freebmd.js",
  "src/scripts/fs-audit.js",
  "src/scripts/fs-books.js",
  "src/scripts/fs-catalog.js",
  "src/scripts/fs-film.js",
  "src/scripts/fs-fulltext.js",
  "src/scripts/fs-image.js",
  "src/scripts/fs-personas.js",
  "src/scripts/gro-search.js",
  "src/scripts/matricula.js",
  "src/scripts/prdh-couples.js",
  "src/scripts/prdh-familles.js",
  "src/scripts/prdh-record.js",
  "src/scripts/prdh-search.js",
  "src/scripts/register-batch.js",
  "src/scripts/register-cache.js",
  "src/scripts/register-seek.js"
]);
const failures = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(root, path).replaceAll('\\', '/');
    if (rel === '.git' || rel === 'node_modules') continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { failures.push(`Symlink: ${rel}`); continue; }
    if (stat.isDirectory()) { walk(path); continue; }
    if (!allowed.has(rel)) failures.push(`Unreviewed file: ${rel}`);
    const text = readFileSync(path, 'utf8');
    if (/\/(?:Users|home)\/[^/\s]+\//.test(text)) failures.push(`Home path: ${rel}`);
    if (/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(text)) failures.push(`Key: ${rel}`);
  }
}
walk(root);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = JSON.parse(execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}));
const actual = new Set(result[0].files.map(f => f.path));
for (const path of actual) if (!packed.has(path)) failures.push(`Unreviewed package entry: ${path}`);
for (const path of packed) if (!actual.has(path)) failures.push(`Missing package entry: ${path}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else console.log(`Release boundary passed: ${allowed.size} repository files; ${actual.size} package files. Content review is still required.`);
