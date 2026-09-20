import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, mainRoot, lockDir, lockMetaFile } from '../lib/tools.js';
import { ensureCdpTarget, closeCdpTarget, DEFAULT_CDP_ORIGIN } from './cdp-preflight.js';
export const openTab = ensureCdpTarget;

export const closeTab = closeCdpTarget;

export { DEFAULT_CDP_ORIGIN };

export const CDP_ORIGIN = DEFAULT_CDP_ORIGIN;

export const CDP_CONNECT_TIMEOUT_MS = 10000;

export const CDP_SEND_TIMEOUT_MS = 30000;

const describe = (err) => (err?.cause?.message ? `${err.message} (${err.cause.message})` : (err?.message ?? String(err)));

export function connect(wsUrl, connectTimeoutMs = CDP_CONNECT_TIMEOUT_MS, sendTimeoutMs = CDP_SEND_TIMEOUT_MS, heartbeat = touchBrowserLock) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    let settled = false;
    const pending = new Map();
    const listeners = [];
    const failPending = (err) => {
      for (const { rej, timer } of pending.values()) {
        clearTimeout(timer);
        rej(err);
      }
      pending.clear();
    };
    const handshakeTimer = setTimeout(() => {
      if (settled) return;
      settled = true;

      try {
        ws.close();
      } catch {

      }
      reject(new Error(`CDP connect to ${wsUrl} timed out after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);

    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(handshakeTimer);
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {

            try {
              heartbeat();
            } catch {

            }
            const mid = ++id;
            const timer = setTimeout(() => {
              pending.delete(mid);
              rej(new Error(`CDP ${method} (message ${mid}) timed out after ${sendTimeoutMs}ms`));
            }, sendTimeoutMs);
            pending.set(mid, { res, rej, timer });
            try {
              ws.send(JSON.stringify({ id: mid, method, params }));
            } catch (err) {
              clearTimeout(timer);
              pending.delete(mid);
              rej(new Error(`CDP ${method} could not be sent: ${describe(err)}`));
            }
          }),
        on: (fn) => listeners.push(fn),
        close: () => ws.close(),

        pendingCount: () => pending.size,
      });
    };
    ws.onerror = (ev) => {
      const err = new Error(`CDP websocket error on ${wsUrl}${ev?.message ? `: ${ev.message}` : ''}`);
      if (!settled) {
        settled = true;
        clearTimeout(handshakeTimer);
        reject(err);
      }
      failPending(err);
    };
    ws.onclose = (ev) => {
      const err = new Error(`CDP websocket closed (code ${ev?.code ?? '?'}) before the reply arrived`);
      if (!settled) {
        settled = true;
        clearTimeout(handshakeTimer);
        reject(err);
      }
      failPending(err);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        msg.error ? rej(new Error(`${msg.error.message} (CDP ${msg.error.code})`)) : res(msg.result);
      } else if (msg.method) {

        for (const fn of listeners) {
          try {
            fn(msg);
          } catch {

          }
        }
      }
    };
  });
}

export const evaluate = async (cdp, expression) => {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'Runtime.evaluate threw');
  return result?.value;
};

export const LOCK_DIR = lockDir;

export const LOCK_META_FILE = lockMetaFile;

export const LOCK_SCRIPT = 'browser-lock';

export function browserLockHint(holderName, cliSuffix = '') {
  return [
    `  ged-tools ${LOCK_SCRIPT} acquire ${holderName}${cliSuffix} --wait 900`,
    `  …then: ged-tools ${LOCK_SCRIPT} release ${holderName}${cliSuffix}`,
  ];
}

export function browserLockStatus(lockDir = LOCK_DIR, metaFile = LOCK_META_FILE) {
  if (!existsSync(lockDir)) return { held: false, holder: null, since: null };
  try {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    return { held: true, holder: meta?.holder ?? null, since: meta?.since ?? null };
  } catch {

    return { held: true, holder: null, since: null };
  }
}

export function browserLockRefusal(holderName, cliSuffix = '') {
  return [
    'browser lock is FREE — refusing to drive the shared debug Chrome without it.',
    'Two agents on port 9222 interleave navigations and silently cross-contaminate results.',
    'Acquire it first, and hold it across your whole batch:',
    ...browserLockHint(holderName, cliSuffix),
    `  …and export BROWSER_LOCK_HOLDER=${holderName} so this check can tell your lock from a sibling’s.`,
  ];
}

export function browserLockMismatchRefusal(actualHolder, status) {
  return [
    `browser lock HELD by ${status.holder} since ${status.since ?? '?'} — but this session is ${actualHolder}.`,
    `Refusing: the mutex belongs to ${status.holder}, and driving the shared debug Chrome now would interleave`,
    'navigations with theirs and silently cross-contaminate both sides of the results.',
    `Wait for ${status.holder} to release it — or, if you ARE the holder, set BROWSER_LOCK_HOLDER to the exact`,
    'name you passed to `acquire` (the mismatch above is the only thing being reported).',
  ];
}

export const LOCK_HEARTBEAT_THROTTLE_MS = 60_000;

const heartbeatClock = { last: 0 };

export function touchBrowserLock(io = {}) {
  const {
    lockDir = LOCK_DIR,
    metaFile = LOCK_META_FILE,
    actualHolder = process.env.BROWSER_LOCK_HOLDER,
    throttleMs = LOCK_HEARTBEAT_THROTTLE_MS,
    clock = heartbeatClock,
    now = Date.now(),
  } = io;
  if (!actualHolder) return false;
  if (now - clock.last < throttleMs) return false;
  try {
    if (!existsSync(lockDir)) return false;
    const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
    if (meta?.holder !== actualHolder) return false;
    utimesSync(lockDir, now / 1000, now / 1000);
    clock.last = now;
    return true;
  } catch {
    return false;
  }
}

export const DRIVER_SLOT_EXIT_CODE = 75;

export const DRIVER_SLOT_STALE_FALLBACK_MS = 20 * 60_000;

export function driverSlotDirFor(lockDirPath = LOCK_DIR) {
  return `${lockDirPath}-driver`;
}

export const DRIVER_SLOT_DIR = driverSlotDirFor(LOCK_DIR);

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function driverSlotStatus(slotDir = DRIVER_SLOT_DIR) {
  if (!existsSync(slotDir)) return { occupied: false, pid: null, script: null, since: null, readable: false };
  try {
    const meta = JSON.parse(readFileSync(join(slotDir, 'slot.json'), 'utf8'));
    const pid = Number.isInteger(meta?.pid) ? meta.pid : null;
    return { occupied: true, pid, script: meta?.script ?? null, since: meta?.since ?? null, readable: pid !== null };
  } catch {
    return { occupied: true, pid: null, script: null, since: null, readable: false };
  }
}

export function driverSlotRefusal(scriptName, slotDir, status) {
  return [
    `another CDP driver is already live on this browser: ${status.script ?? 'unknown script'} (pid ${status.pid ?? '?'}) since ${status.since ?? '?'}.`,
    `Refusing to run ${scriptName} concurrently with it — two drivers on one Chrome is what killed the shared`,
    'browser on 2026-08-19 (#441), lock or no lock; the browser lock only guards between holders.',
    `Rerun sequentially: wait for pid ${status.pid ?? '?'} to finish, then retry. A crashed driver's slot is`,
    `reclaimed automatically by the next attempt (PID liveness). The slot is ${slotDir}.`,
  ];
}

export function driverSlotUnreadableRefusal(slotDir, staleFallbackMs) {
  return [
    `the driver slot ${slotDir} is occupied but its slot.json is unreadable — refusing conservatively.`,
    'A driver may be mid-acquire, or the slot may be wreckage. If no CDP script is running, remove the',
    `directory by hand; otherwise it self-clears once its mtime ages past ${Math.round(staleFallbackMs / 60_000)} minutes.`,
  ];
}

const acquiredSlotDirs = new Set();

let slotExitHookInstalled = false;

function recordSlotAcquired(slotDir) {
  acquiredSlotDirs.add(slotDir);
  if (slotExitHookInstalled) return;
  slotExitHookInstalled = true;
  process.on('exit', () => {
    for (const dir of acquiredSlotDirs) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, 'slot.json'), 'utf8'));
        if (meta?.pid === process.pid) rmSync(dir, { recursive: true, force: true });
      } catch {

      }
    }
  });
}

export function acquireDriverSlot(scriptName, io = {}) {
  const {
    lockDir = LOCK_DIR,
    slotDir = driverSlotDirFor(lockDir),
    log = console.error,
    exit = process.exit,
    pid = process.pid,
    isAlive = pidAlive,
    staleFallbackMs = DRIVER_SLOT_STALE_FALLBACK_MS,
    now = Date.now(),
  } = io;
  const metaFile = join(slotDir, 'slot.json');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(slotDir);
      writeFileSync(metaFile, JSON.stringify({ pid, script: scriptName, since: new Date(now).toISOString() }));
      recordSlotAcquired(slotDir);
      return true;
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        log(`the driver slot ${slotDir} could not be created (${err?.message ?? err}) — refusing to drive Chrome without it.`);
        return exit(DRIVER_SLOT_EXIT_CODE);
      }
    }
    const status = driverSlotStatus(slotDir);
    if (!status.occupied) continue;
    if (status.readable) {
      if (status.pid === pid) {

        recordSlotAcquired(slotDir);
        return true;
      }
      if (!isAlive(status.pid)) {

        try {
          rmSync(slotDir, { recursive: true, force: true });
        } catch {

        }
        continue;
      }
      for (const line of driverSlotRefusal(scriptName, slotDir, status)) log(line);
      return exit(DRIVER_SLOT_EXIT_CODE);
    }

    let mtimeMs = null;
    try {
      mtimeMs = statSync(slotDir).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtimeMs > staleFallbackMs) {
      try {
        rmSync(slotDir, { recursive: true, force: true });
      } catch {

      }
      continue;
    }
    for (const line of driverSlotUnreadableRefusal(slotDir, staleFallbackMs)) log(line);
    return exit(DRIVER_SLOT_EXIT_CODE);
  }

  for (const line of driverSlotRefusal(scriptName, slotDir, driverSlotStatus(slotDir))) log(line);
  return exit(DRIVER_SLOT_EXIT_CODE);
}

export function releaseDriverSlot(io = {}) {
  const { lockDir = LOCK_DIR, slotDir = driverSlotDirFor(lockDir), pid = process.pid } = io;
  const status = driverSlotStatus(slotDir);
  if (!status.occupied) {
    acquiredSlotDirs.delete(slotDir);
    return false;
  }
  if (status.readable && status.pid !== pid) return false;
  if (!status.readable && !acquiredSlotDirs.has(slotDir)) return false;
  try {
    rmSync(slotDir, { recursive: true, force: true });
  } catch {
    return false;
  }
  acquiredSlotDirs.delete(slotDir);
  return true;
}

export function requireBrowserLock(holderName, io = {}) {
  const {
    lockDir = LOCK_DIR,
    metaFile = LOCK_META_FILE,
    log = console.error,
    exit = process.exit,
    actualHolder = process.env.BROWSER_LOCK_HOLDER,
    hintSuffix = '',
    slotDir = driverSlotDirFor(lockDir),
    slot = {},
  } = io;
  const status = browserLockStatus(lockDir, metaFile);
  if (status.held) {
    if (actualHolder && status.holder && actualHolder !== status.holder) {
      for (const line of browserLockMismatchRefusal(actualHolder, status)) log(line);
      return exit(2);
    }
    log(`browser lock HELD by ${status.holder ?? 'unknown'} since ${status.since ?? '?'} — proceeding`);

    return acquireDriverSlot(holderName, { slotDir, log, exit, ...slot });
  }
  for (const line of browserLockRefusal(holderName, hintSuffix)) log(line);
  return exit(1);
}
export { heartbeatClock, describe, recordSlotAcquired, acquiredSlotDirs, slotExitHookInstalled };
