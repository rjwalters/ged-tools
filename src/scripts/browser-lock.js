import { dirname } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, utimesSync } from 'node:fs';
import {
  lockDir as defaultLockDir,
  lockMetaFile as defaultMetaFile,
  archionLockDir,
  archionLockMetaFile,
} from '../lib/tools.js';
export const DEFAULT_STALE_MS = 20 * 60 * 1000;

export function staleMsFromEnv(env = process.env) {
  const v = Number(env.BROWSER_LOCK_STALE_MS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_STALE_MS;
}

const STALE_MS = staleMsFromEnv();

export function lockPathsForBrowser(selector, paths = {}) {
  const {
    defaultDir = defaultLockDir,
    defaultMeta = defaultMetaFile,
    archionDir = archionLockDir,
    archionMeta = archionLockMetaFile,
  } = paths;
  const s = selector == null ? null : String(selector);
  if (s === null || s === 'default' || s === 'mh' || s === '9222') {
    return { browser: 'default', lockDir: defaultDir, metaFile: defaultMeta };
  }
  if (s === 'archion' || s === '9223') {
    return { browser: 'archion', lockDir: archionDir, metaFile: archionMeta };
  }
  throw new Error(`unknown browser selector ${JSON.stringify(selector)} — want --browser archion|default or --port 9222|9223`);
}

const defaultIo = () => ({ lockDir: defaultLockDir, metaFile: defaultMetaFile, staleMs: STALE_MS, log: console.error });

const readMeta = (io = defaultIo()) => {
  try {
    return JSON.parse(readFileSync(io.metaFile, 'utf8'));
  } catch {
    return null;
  }
};

function lockAgeMs(io = defaultIo()) {
  if (!existsSync(io.lockDir)) return null;
  return Date.now() - statSync(io.lockDir).mtimeMs;
}

function breakIfStale(io = defaultIo()) {
  const age = lockAgeMs(io);
  if (age === null) return;
  if (age > io.staleMs) {
    const meta = readMeta(io);
    io.log(`breaking stale lock held by ${meta?.holder ?? 'unknown'} — no heartbeat for ${Math.round(age / 60000)}m`);
    rmSync(io.lockDir, { recursive: true, force: true });
  }
}

function tryAcquire(holder, io = defaultIo()) {
  breakIfStale(io);
  try {
    mkdirSync(dirname(io.lockDir), { recursive: true });
    mkdirSync(io.lockDir);
  } catch {
    return false;
  }
  writeFileSync(io.metaFile, JSON.stringify({ holder, pid: process.pid, since: new Date().toISOString() }));
  return true;
}

function renewLock(holder, io = defaultIo()) {
  if (!existsSync(io.lockDir)) {
    return { ok: false, message: 'refusing to renew: lock is free — renew never creates a lock, acquire it instead' };
  }
  const meta = readMeta(io);
  if (meta && holder && meta.holder !== holder) {
    return { ok: false, message: `refusing to renew: held by ${meta.holder}, not ${holder}` };
  }
  const now = new Date();
  utimesSync(io.lockDir, now.getTime() / 1000, now.getTime() / 1000);
  writeFileSync(
    io.metaFile,
    JSON.stringify({ ...(meta ?? {}), holder: meta?.holder ?? holder, since: meta?.since ?? now.toISOString(), renewed: now.toISOString() })
  );
  return { ok: true, message: `lock renewed by ${holder}` };
}

function releaseLock(holder, io = defaultIo()) {
  const meta = readMeta(io);
  if (meta && holder && meta.holder !== holder) {
    return { ok: false, message: `refusing to release: held by ${meta.holder}, not ${holder}` };
  }
  rmSync(io.lockDir, { recursive: true, force: true });
  return { ok: true, message: 'lock released' };
}

function statusLines(io = defaultIo()) {
  const meta = readMeta(io);
  const age = lockAgeMs(io);
  if (age === null) return ['free'];
  const lines = [`HELD by ${meta?.holder ?? 'unknown'} since ${meta?.since ?? '?'}`];
  if (age > io.staleMs) {
    lines.push(
      `STALE: no heartbeat for ${Math.round(age / 60000)}m (> ${Math.round(io.staleMs / 60000)}m) — the next acquire will break this lock`
    );
  }
  return lines;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shellSingleQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function usage() {
  console.error('usage: ged-tools browser-lock <acquire|release|renew|status> [holder] [--wait N] [--browser NAME | --port PORT]');
  console.error('');
  console.error('  acquire <holder> [--wait N]  take the lock; breaks one whose last heartbeat/renew');
  console.error('                               is older than STALE_MS (20 min) before trying');
  console.error('  release <holder>             drop the lock (refuses a sibling’s)');
  console.error('  renew <holder>               refresh a held lock’s timestamp (refuses free/foreign);');
  console.error('                               live CDP batches renew automatically via cdp-transport.js,');
  console.error('                               so this is for long OFFLINE stretches between batches');
  console.error('  status                       read-only: reports holder and staleness, never breaks');
  console.error('');
  console.error('  --browser archion | --port 9223   operate on the DEDICATED Archion Chrome\'s lock');
  console.error('                               (.browser-lock-9223/) instead of the shared :9222 one.');
  console.error('                               The two locks are independent — one per browser (#453).');
  process.exit(2);
}

function parseCliArgs(argv) {
  const args = [...argv];
  let selector = null;
  for (const flag of ['--browser', '--port']) {
    const i = args.indexOf(flag);
    if (i === -1) continue;
    if (i + 1 >= args.length) throw new Error(`${flag} wants a value — --browser archion|default or --port 9222|9223`);
    if (selector !== null) throw new Error('give --browser or --port once, not both');
    selector = args[i + 1];
    args.splice(i, 2);
  }
  return { args, ...lockPathsForBrowser(selector) };
}

export async function main(inputArgs = process.argv.slice(2)) {
let cli;
try {
  cli = parseCliArgs(inputArgs);
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(2);
}
const [cmd, holder] = cli.args;

const io = { ...defaultIo(), lockDir: cli.lockDir, metaFile: cli.metaFile };
if (cli.browser !== 'default' && ['acquire', 'release', 'renew', 'status'].includes(cmd)) {
  console.error(`(${cli.browser} browser lock: ${io.lockDir})`);
}
const waitArg = cli.args.indexOf('--wait');
const waitSecs = waitArg !== -1 ? Number(cli.args[waitArg + 1]) : 0;

if (cmd === 'acquire') {
  if (!holder) {
    console.error('usage: ged-tools browser-lock acquire <holder> [--wait SECONDS] [--browser NAME | --port PORT]');
    process.exit(2);
  }
  const deadline = Date.now() + waitSecs * 1000;
  let got = tryAcquire(holder, io);
  while (!got && Date.now() < deadline) {
    await sleep(5000);
    got = tryAcquire(holder, io);
  }
  if (got) {
    console.log(`lock acquired by ${holder}`);

    console.log(`export BROWSER_LOCK_HOLDER=${shellSingleQuote(holder)}   # so the scripts refuse a sibling's lock, and the CDP heartbeat keeps yours alive`);
    process.exit(0);
  }
  const meta = readMeta(io);
  console.error(`BUSY — held by ${meta?.holder ?? 'unknown'} since ${meta?.since ?? '?'}`);
  process.exit(1);
} else if (cmd === 'release') {
  const { ok, message } = releaseLock(holder, io);
  if (!ok) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
} else if (cmd === 'renew') {
  if (!holder) {
    console.error('usage: ged-tools browser-lock renew <holder> [--browser NAME | --port PORT]');
    process.exit(2);
  }
  const { ok, message } = renewLock(holder, io);
  if (!ok) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
} else if (cmd === 'status') {

  for (const line of statusLines(io)) console.log(line);
} else if (cmd === '--self-test') {
  await selfTest();
} else {
  usage();
}

}
export { parseCliArgs, defaultIo, STALE_MS, tryAcquire, breakIfStale, lockAgeMs, readMeta, sleep, shellSingleQuote, releaseLock, renewLock, statusLines, usage };

function selfTest() { throw new Error("Run npm test in the ged-tools source checkout; private fixtures are not distributed."); }
