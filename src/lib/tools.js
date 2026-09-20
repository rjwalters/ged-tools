import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { buildModel } from './gedcom.js';
import { loadConfig } from './config.js';
export const root = resolve(process.env.GENEALOGY_PROJECT_ROOT || process.cwd());

const config = loadConfig(root);

export const gedPath = config.gedPath;

export const recordsDir = config.recordsDir;

export const worklistPath = config.worklistPath;

function resolveMainRoot() {
  let gitCommonDir;
  try {
    gitCommonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return root;
  }
  return dirname(gitCommonDir);
}

export const mainRoot = resolveMainRoot();

export const browserStateDir = resolve(process.env.GENEALOGY_BROWSER_STATE_DIR || join(homedir(), '.local', 'state', 'ged-tools'));
export const lockDir = join(browserStateDir, '.browser-lock');

export const lockMetaFile = join(lockDir, 'holder.json');

export const archionLockDir = join(browserStateDir, '.browser-lock-9223');

export const archionLockMetaFile = join(archionLockDir, 'holder.json');

export const REGISTER_CACHE_DIRNAME = '.register-cache';

export function resolveRegisterCacheDir(env = process.env, main = mainRoot) {
  const override = env.REGISTER_CACHE_DIR;
  if (override !== undefined && override !== '') {
    if (!isAbsolute(override)) {
      throw new Error(
        `REGISTER_CACHE_DIR must be an ABSOLUTE path, got ${JSON.stringify(override)}. ` +
          'A relative override would resolve against whatever cwd the fetcher happens to ' +
          'have — which is the cwd-dependence this setting exists to remove (#534).'
      );
    }
    return normalize(override).replace(/\/+$/, '') || sep;
  }
  return join(main, REGISTER_CACHE_DIRNAME);
}

export const registerCacheDir = resolveRegisterCacheDir();

export function resolveCacheOut(p, { cwd = process.cwd(), cacheDir = registerCacheDir } = {}) {
  if (typeof p !== 'string' || p.trim() === '') {
    throw new Error(`--out must be a non-empty string, got ${JSON.stringify(p)}`);
  }
  if (isAbsolute(p)) return normalize(p).replace(/(.)\/+$/, '$1');
  const parts = normalize(p)
    .split(sep)
    .filter((s) => s !== '' && s !== '.');
  if (parts[0] === REGISTER_CACHE_DIRNAME) return join(cacheDir, ...parts.slice(1));
  return resolve(cwd, p);
}

export function withinCacheDir(abs, cacheDir = registerCacheDir) {
  const base = cacheDir.replace(/\/+$/, '');
  return abs === base || abs.startsWith(base + sep);
}

export function loadModel() {
  return buildModel(readFileSync(gedPath, 'utf8'));
}

export function loadWorklist() {
  return JSON.parse(readFileSync(worklistPath, 'utf8'));
}

export function saveWorklist(worklist) {
  writeFileSync(worklistPath, JSON.stringify(worklist, null, 1));
}

export function decodeText(s) {
  let t = s;
  for (let i = 0; i < 3 && /&(amp|lt|gt|quot|#39|nbsp);/.test(t); i++) {
    t = t
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ');
  }
  return t
    .replace(/<br\s*\/?>/gi, '; ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function personLine(model, id) {
  const p = model.people[id];
  if (!p) return `${id}  <unknown id>`;
  const b = p.birth?.date || (p.birth?.year ? String(p.birth.year) : null);
  const d = p.death?.date || (p.death?.year ? String(p.death.year) : null);
  const span = b || d ? ` (${b ? 'b. ' + b : ''}${b && d ? ' – ' : ''}${d ? 'd. ' + d : ''})` : '';
  const dec = p.deceased && !d ? ' †' : '';
  return `${p.id}  ${p.name}${span}${dec}`;
}
export { config, resolveMainRoot };
