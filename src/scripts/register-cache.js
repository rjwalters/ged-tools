import { execFileSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import {
  REGISTER_CACHE_DIRNAME,
  registerCacheDir,
  resolveCacheOut,
  resolveRegisterCacheDir,
  withinCacheDir,
} from '../lib/tools.js';
export function resolveCacheDest(dest, { cacheDir, srcBase = null } = {}) {
  if (typeof cacheDir !== 'string' || !isAbsolute(cacheDir)) {
    throw new Error(`cacheDir must be an absolute path, got ${JSON.stringify(cacheDir)}`);
  }
  const base = cacheDir.replace(/\/+$/, '');
  let d = typeof dest === 'string' ? dest.trim() : '';

  if (isAbsolute(d)) {

    throw new Error(
      `destination ${JSON.stringify(dest)} is absolute. Give a path RELATIVE to the ` +
        `cache root (${base}) — e.g. "register/image.pdf". Run ` +
        '`ged-tools register-cache root` if you need the absolute root.'
    );
  }

  const wantsDir = d.endsWith('/') || d === '' || d === '.';
  const parts = normalize(d)
    .split(sep)
    .filter((s) => s !== '' && s !== '.');
  if (parts[0] === REGISTER_CACHE_DIRNAME) parts.shift();

  if (parts.includes('..')) {
    throw new Error(
      `destination ${JSON.stringify(dest)} escapes the cache root with "..". ` +
        `Everything this command writes must stay under ${base}.`
    );
  }

  let abs = parts.length ? join(base, ...parts) : base;
  if ((wantsDir || abs === base) && srcBase !== null) abs = join(abs, srcBase);

  if (!withinCacheDir(abs, base)) {
    throw new Error(`destination ${JSON.stringify(dest)} resolves outside the cache root ${base}`);
  }
  if (abs === base) {
    throw new Error(
      'destination resolves to the cache root itself — name a file or a subdirectory ' +
        'under it (e.g. "register/image.pdf").'
    );
  }
  return abs;
}

export function isIgnoredByGit(abs, runGit = defaultRunGit) {
  const res = runGit(['check-ignore', '-q', '--no-index', '--', abs], dirname(abs));
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  return true;
}

function defaultRunGit(args, cwd) {
  try {
    execFileSync('git', args, { cwd, stdio: 'ignore' });
    return { status: 0 };
  } catch (err) {
    return { status: typeof err.status === 'number' ? err.status : 128 };
  }
}

export function depositFile(src, absDest, { cacheDir = registerCacheDir, copy = false, force = false } = {}) {
  const st = lstatSync(src);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new Error(`${src} is not a regular file (refusing to deposit it)`);
  }
  if (!withinCacheDir(absDest, cacheDir)) {
    throw new Error(`${absDest} is not under the cache root ${cacheDir} (refusing to write there)`);
  }

  mkdirSync(dirname(absDest), { recursive: true });

  const realParent = realpathSync(dirname(absDest));
  const realRoot = realpathSync(cacheDir);
  if (!withinCacheDir(join(realParent, basename(absDest)), realRoot)) {
    throw new Error(
      `${absDest} resolves through a symlink to ${realParent}, which is outside the cache root ` +
        `${realRoot}. Refusing to write there.`
    );
  }

  if (!isIgnoredByGit(absDest)) {
    throw new Error(
      `${absDest} is NOT ignored by git. This command only writes gitignored cache paths — ` +
        'that is what makes it safe to run against the main checkout from a worktree. ' +
        'A tracked destination belongs in a commit, made from your worktree, not here.'
    );
  }

  if (existsSync(absDest) && !force) {
    throw new Error(`${absDest} already exists — pass --force to replace it.`);
  }

  const tmp = `${absDest}.partial-${process.pid}`;
  copyFileSync(src, tmp);
  const fd = openSync(tmp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, absDest);
  if (!copy) unlinkSync(src);

  return { src, dest: absDest, bytes: statSync(absDest).size, moved: !copy };
}

export function listFilesRecursive(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFilesRecursive(join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);

  }
  return out;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function cmdRoot() {
  console.log(registerCacheDir);
}

function cmdPath(rest) {
  const [p] = rest;
  if (!p) fail('path wants a cache-relative path, e.g. `path lavnrw-lb0033-01/LB_0033-01_S001.jpg`');
  console.log(resolveCacheDest(p, { cacheDir: registerCacheDir }));
}

function cmdPut(rest) {
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const pos = rest.filter((a) => !a.startsWith('--'));
  const [src, dest = ''] = pos;
  if (!src) fail('put wants <src> [<dest>]');
  if (!existsSync(src)) fail(`${src}: no such file or directory`);
  const copy = flags.has('--copy');
  const force = flags.has('--force');
  const unknown = [...flags].filter((f) => !['--copy', '--force'].includes(f));
  if (unknown.length) fail(`unknown flag(s): ${unknown.join(', ')} (put takes --copy and --force)`);

  const srcStat = statSync(src);
  let results;
  try {
    if (srcStat.isDirectory()) {
      const files = listFilesRecursive(src);
      if (!files.length) fail(`${src} holds no regular files`);
      const destDir = dest === '' ? basename(src.replace(/\/+$/, '')) : dest;
      results = files.map((rel) =>
        depositFile(join(src, rel), resolveCacheDest(`${destDir.replace(/\/+$/, '')}/${rel}`, {
          cacheDir: registerCacheDir,
        }), { copy, force })
      );
      if (!copy) rmSync(src, { recursive: true, force: true });
    } else {
      results = [
        depositFile(src, resolveCacheDest(dest, { cacheDir: registerCacheDir, srcBase: basename(src) }), {
          copy,
          force,
        }),
      ];
    }
  } catch (err) {
    fail(err.message);
  }

  const bytes = results.reduce((n, r) => n + r.bytes, 0);
  for (const r of results) {
    console.log(`${r.moved ? 'moved ' : 'copied'} ${r.dest}  (${r.bytes.toLocaleString()} bytes)`);
  }
  if (results.length > 1) {
    console.log(`${results.length} files, ${bytes.toLocaleString()} bytes total`);
  }
}

function usage() {
  console.log(`register-cache.js — deposit into and address the shared frame cache

  ged-tools register-cache root
  ged-tools register-cache path <cache-relative-path>
  ged-tools register-cache put  <src> [<dest>] [--copy] [--force]
  ged-tools register-cache --self-test

cache root: ${registerCacheDir}
  (override with an absolute $REGISTER_CACHE_DIR)`);
}
export { defaultRunGit, cmdRoot, cmdPath, fail, cmdPut, usage };

export function main(argv = process.argv.slice(2)) {
  const [verb, ...rest] = argv;
  if (verb === 'root') return cmdRoot();
  if (verb === 'path') return cmdPath(rest);
  if (verb === 'put') return cmdPut(rest);
  if (!verb || ['--help', '-h', 'help'].includes(verb)) return usage();
  throw new Error(`Unknown cache command: ${verb}`);
}
