import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
const SEEK_FILE = '_seek.json';

export function parseDate(s) {
  const m = String(s).trim().match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
  if (!m) throw new Error(`not an ISO date (YYYY, YYYY-MM or YYYY-MM-DD): ${s}`);
  const y = Number(m[1]);
  const mo = m[2] === undefined ? null : Number(m[2]);
  const d = m[3] === undefined ? null : Number(m[3]);
  if (mo !== null && (mo < 1 || mo > 12)) throw new Error(`month out of range: ${s}`);
  if (d !== null && (d < 1 || d > 31)) throw new Error(`day out of range: ${s}`);
  const key = (yy, mm, dd) => yy * 10000 + mm * 100 + dd;
  if (mo === null) return { lo: key(y, 1, 1), hi: key(y, 12, 31), text: String(y) };
  if (d === null) return { lo: key(y, mo, 1), hi: key(y, mo, 31), text: `${m[1]}-${String(mo).padStart(2, '0')}` };
  const k = key(y, mo, d);
  return { lo: k, hi: k, text: `${m[1]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

export function relation(observed, target) {
  if (observed.hi < target.lo) return 'before';
  if (observed.lo > target.hi) return 'after';
  return 'overlaps';
}

export function loadSeek(dir) {
  const p = join(dir, SEEK_FILE);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function saveSeek(dir, state) {
  const p = join(dir, SEEK_FILE);
  const tmp = `${p}.tmp`;
  state.updatedAt = new Date().toISOString();
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, p);
}

export function nextFrame(state) {
  if (state.hit != null) return null;
  if (state.lo > state.hi) return null;
  return Math.floor((state.lo + state.hi) / 2);
}

export function applyObservation(state, frame, observedText) {
  const target = parseDate(state.target);
  const observed = parseDate(observedText);
  if (frame < state.origLo || frame > state.origHi) {
    throw new Error(`frame ${frame} is outside the item range ${state.origLo}-${state.origHi}`);
  }

  for (const [f, d] of Object.entries(state.observations)) {
    const other = parseDate(d);
    const fn = Number(f);
    if (fn < frame && other.lo > observed.hi) {
      throw new Error(
        `frame ${frame} (${observed.text}) is EARLIER than frame ${fn} (${other.text}), which comes before it.\n` +
          `A chronological run cannot do that. Either the range ${state.origLo}-${state.origHi} crosses an item ` +
          `boundary — a film roll holds several registers, each starting its dates over — or one of the two frames ` +
          `was misread. Check both before continuing; re-run init with a corrected --range if the boundary is wrong.`
      );
    }
    if (fn > frame && other.hi < observed.lo) {
      throw new Error(
        `frame ${frame} (${observed.text}) is LATER than frame ${fn} (${other.text}), which comes after it.\n` +
          `A chronological run cannot do that. Either the range ${state.origLo}-${state.origHi} crosses an item ` +
          `boundary, or one of the two frames was misread.`
      );
    }
  }

  state.observations[String(frame)] = observed.text;
  const rel = relation(observed, target);
  if (rel === 'before') state.lo = Math.max(state.lo, frame + 1);
  else if (rel === 'after') state.hi = Math.min(state.hi, frame - 1);
  else state.hit = frame;
  return rel;
}

export function frameFile(dir, n) {
  if (!existsSync(dir)) return null;
  const want = `p${String(n).padStart(4, '0')}.`;
  const hit = readdirSync(dir).find((f) => f.startsWith(want));
  return hit ? join(dir, hit) : null;
}

function cmdInit(dir, argv) {
  const range = arg(argv, '--range');
  const target = arg(argv, '--target');
  if (!range || !target) {
    console.error('init needs --range <lo>-<hi> and --target <YYYY[-MM[-DD]]>');
    console.error('');
    console.error('--range is REQUIRED and is one ITEM, not the whole roll: a film holds several');
    console.error('registers end to end, each restarting its dates, and bisecting across them');
    console.error('compares dates from different registers and converges on the wrong frame.');
    process.exit(1);
  }
  const m = range.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) {
    console.error(`--range must look like 145-288, got: ${range}`);
    process.exit(1);
  }
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (hi < lo) {
    console.error(`--range end (${hi}) is before its start (${lo})`);
    process.exit(1);
  }
  parseDate(target);

  mkdirSync(dir, { recursive: true });
  const state = {
    target: parseDate(target).text,
    label: arg(argv, '--label', ''),
    origLo: lo,
    origHi: hi,
    lo,
    hi,
    hit: null,
    observations: {},
    createdAt: new Date().toISOString(),
  };
  saveSeek(dir, state);
  const span = hi - lo + 1;
  console.log(`seeking ${state.target}${state.label ? ` in ${state.label}` : ''} across frames ${lo}-${hi} (${span})`);
  console.log(`at most ${Math.ceil(Math.log2(span + 1))} frames need looking at`);
  report(dir, state);
}

function report(dir, state) {
  if (state.hit != null) {
    const f = frameFile(dir, state.hit);
    console.log('');
    console.log(`FOUND: frame ${state.hit} covers ${state.target}`);
    console.log(f ? `  ${f}` : `  (frame ${state.hit} is not in ${dir} — download it)`);
    return 0;
  }
  const n = nextFrame(state);
  if (n === null) {
    console.log('');
    console.log(`bracket is empty — ${state.target} is not in frames ${state.origLo}-${state.origHi}.`);
    console.log('Either the item range is wrong, or this register does not cover that date.');
    return 1;
  }
  const remaining = state.hi - state.lo + 1;
  console.log('');
  console.log(`open frame ${n}   (bracket ${state.lo}-${state.hi}, ${remaining} frame(s) left)`);
  const f = frameFile(dir, n);
  console.log(f ? `  ${f}` : `  NOT DOWNLOADED — frame ${n} is missing from ${dir}`);
  console.log('');
  console.log(`then: ged-tools register-seek mark --dir ${dir} --frame ${n} --date <YYYY[-MM[-DD]]>`);
  return 0;
}

function arg(argv, name, fallback = undefined) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    console.error(`${name} needs a value`);
    process.exit(1);
  }
  return v;
}

function usage() {
  console.error(`register-seek.js — binary-search a downloaded register roll for a date

  init   --dir <frames> --range <lo>-<hi> --target <YYYY[-MM[-DD]]> [--label <text>]
  next   --dir <frames>
  mark   --dir <frames> --frame <n> --date <YYYY[-MM[-DD]]>
  status --dir <frames>
  --self-test

--range is ONE ITEM of the film, not the whole roll. A roll holds several
registers end to end and each restarts its dates; bisecting across them
converges on the wrong frame with no symptom.`);
}

function main(argv) {
  if (argv.includes('--self-test')) return selfTest();
  const cmd = argv[0];
  const dir = arg(argv, '--dir');
  if (!cmd || !dir) {
    usage();
    process.exit(1);
  }

  if (cmd === 'init') return cmdInit(dir, argv);

  const state = loadSeek(dir);
  if (!state) {
    console.error(`no search in progress in ${dir} — run init first`);
    process.exit(1);
  }

  if (cmd === 'next' || cmd === 'status') {
    if (cmd === 'status') {
      console.log(`target ${state.target}${state.label ? ` — ${state.label}` : ''}`);
      console.log(`item range ${state.origLo}-${state.origHi}`);
      const obs = Object.entries(state.observations).sort((a, b) => Number(a[0]) - Number(b[0]));
      for (const [f, d] of obs) console.log(`  frame ${f}: ${d}`);
      if (!obs.length) console.log('  (nothing looked at yet)');
    }
    process.exit(report(dir, state));
  }

  if (cmd === 'mark') {
    const frame = Number(arg(argv, '--frame'));
    const date = arg(argv, '--date');
    if (!Number.isInteger(frame) || !date) {
      usage();
      process.exit(1);
    }
    let rel;
    try {
      rel = applyObservation(state, frame, date);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    saveSeek(dir, state);
    console.log(`frame ${frame} = ${date} — ${rel} the target`);
    process.exit(report(dir, state));
  }

  usage();
  process.exit(1);
}
export { SEEK_FILE, main, arg, usage, cmdInit, report };

function selfTest() { throw new Error("Run npm test in the ged-tools source checkout; private fixtures are not distributed."); }
