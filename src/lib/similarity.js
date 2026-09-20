// Similarity scoring adapted from the design of elliotchance/gedcom.
// Algorithm reference: https://github.com/elliotchance/gedcom
export const DEFAULT_MINIMUM_SIMILARITY = 0.733;

export const DEFAULT_MAX_YEARS = 3;

export const DEFAULT_JARO_BOOST_THRESHOLD = 0.0;

export const DEFAULT_JARO_PREFIX_SIZE = 8;

export const DEFAULT_NAME_TO_DATE_RATIO = 0.5;

export const DEFAULT_DUPLICATE_THRESHOLD = 0.85;

function jaro(a, b) {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (!la || !lb) return 0;
  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatch = new Array(la).fill(false);
  const bMatch = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(lb - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!bMatch[j] && a[i] === b[j]) {
        aMatch[i] = true;
        bMatch[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;
  return (matches / la + matches / lb + (matches - transpositions) / matches) / 3;
}

export function jaroWinkler(
  a,
  b,
  boostThreshold = DEFAULT_JARO_BOOST_THRESHOLD,
  prefixSize = DEFAULT_JARO_PREFIX_SIZE
) {
  const j = jaro(a, b);
  if (j <= boostThreshold) return j;
  const max = Math.min(prefixSize, a.length, b.length);
  let prefix = 0;
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  return j + 0.1 * prefix * (1 - j);
}

export const foldName = (s) =>
  (s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export function stringSimilarity(a, b, opts = {}) {
  const {
    jaroBoostThreshold = DEFAULT_JARO_BOOST_THRESHOLD,
    jaroPrefixSize = DEFAULT_JARO_PREFIX_SIZE,
  } = opts;
  return jaroWinkler(
    foldName(a).replace(/ /g, ''),
    foldName(b).replace(/ /g, ''),
    jaroBoostThreshold,
    jaroPrefixSize
  );
}

export function nameSimilarity(a, b, opts = {}) {
  const fa = foldName(a);
  const fb = foldName(b);
  if (!fa && !fb) return 1;
  if (!fa || !fb) return 0;
  const direct = stringSimilarity(fa, fb, opts);
  const sorted =
    0.95 * stringSimilarity(fa.split(' ').sort().join(' '), fb.split(' ').sort().join(' '), opts);
  return Math.max(direct, sorted);
}

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

export function dateToDecimalYear(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s + 0.5 : null;
  const t = String(s).toUpperCase().trim();
  const range = t.match(/^(?:BET\.?|BETWEEN|FROM)\s+(.+?)\s+(?:AND|TO)\s+(.+)$/);
  if (range) {
    const a = dateToDecimalYear(range[1]);
    const b = dateToDecimalYear(range[2]);
    if (a != null && b != null) return (a + b) / 2;
    return a ?? b;
  }
  const years = [...t.matchAll(/\b(\d{3,4})\b/g)];
  if (!years.length) return null;
  const year = Number(years[years.length - 1][1]);
  const month = MONTHS[t.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/)?.[1]] ?? null;
  const day = Number(t.match(/\b(\d{1,2})\b/)?.[1]) || null;
  if (!month) return year + 0.5;
  return year + (month - 1 + ((day ?? 15) - 0.5) / 31) / 12;
}

export function yearSimilarity(a, b, maxYears = DEFAULT_MAX_YEARS) {
  if (a == null || b == null) return 0.5;
  const d = (a - b) / maxYears;
  const sim = 1 - d * d;
  return sim < 0 ? 0 : sim;
}

export function dateSimilarity(a, b, maxYears = DEFAULT_MAX_YEARS) {
  return yearSimilarity(dateToDecimalYear(a), dateToDecimalYear(b), maxYears);
}

export function personSimilarity(p1, p2, opts = {}) {
  const { nameToDateRatio = DEFAULT_NAME_TO_DATE_RATIO, maxYears = DEFAULT_MAX_YEARS } = opts;
  const name = nameSimilarity(p1.name, p2.name, opts);
  const birth = dateSimilarity(p1.birth, p2.birth, maxYears);
  const death = dateSimilarity(p1.death, p2.death, maxYears);
  const score = nameToDateRatio * name + (1 - nameToDateRatio) * ((birth + death) / 2);
  return { score, name, birth, death };
}

export function duplicateCandidates(people, opts = {}) {
  const {
    threshold = DEFAULT_DUPLICATE_THRESHOLD,
    maxYears = DEFAULT_MAX_YEARS,
  } = opts;
  const entries = [];
  const iter = people instanceof Map ? people.entries() : Object.entries(people);
  for (const [id, p] of iter) {
    if (!foldName(p.name)) continue;
    const birth = dateToDecimalYear(p.birth ?? '');
    const death = dateToDecimalYear(p.death ?? '');
    if (birth == null && death == null) continue;
    entries.push({ id, p, birth, death, surKey: surnameKey(p.name) });
  }

  const pairKeys = new Set();
  const pairs = [];
  const consider = (a, b) => {
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (pairKeys.has(key)) return;
    pairKeys.add(key);
    pairs.push([a, b]);
  };

  const bySurname = new Map();
  for (const e of entries) {
    if (!e.surKey) continue;
    (bySurname.get(e.surKey) ?? bySurname.set(e.surKey, []).get(e.surKey)).push(e);
  }
  for (const bucket of bySurname.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) consider(bucket[i], bucket[j]);
    }
  }
  for (const field of ['birth', 'death']) {
    const dated = entries.filter((e) => e[field] != null).sort((x, y) => x[field] - y[field]);
    for (let i = 0; i < dated.length; i++) {
      for (let j = i + 1; j < dated.length && dated[j][field] - dated[i][field] <= maxYears; j++) {
        consider(dated[i], dated[j]);
      }
    }
  }

  const out = [];
  for (const [a, b] of pairs) {
    const sim = personSimilarity(a.p, b.p, opts);
    if (sim.score >= threshold - 1e-9) out.push({ ids: [a.id, b.id], ...sim });
  }
  return out.sort((x, y) => y.score - x.score);
}

export const stripName = (n) => (n || '').replace(/\//g, '').replace(/\s+/g, ' ').trim();

export function surnameKey(name) {
  const toks = stripName(name)
    .split(' ')
    .filter((t) => !/^(sr\.?|jr\.?|i{2,3}|iv)$/i.test(t));
  let s = (toks[toks.length - 1] || '').toLowerCase();
  s = s
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z]/g, '');

  s = s.replace(/zsch/g, 'sch');
  return s;
}

function givenPart(name) {
  const toks = stripName(name)
    .split(' ')
    .filter((t) => !/^(sr\.?|jr\.?|i{2,3}|iv)$/i.test(t));
  return toks.slice(0, -1).join(' ');
}

export function lifespanYears(s) {
  const m = (s || '').match(/(\d{4})?\s*[–-]\s*(\d{4}|Living|Deceased)?/);
  return {
    birth: m && m[1] ? Number(m[1]) : null,
    death: m && m[2] && /^\d{4}$/.test(m[2]) ? Number(m[2]) : null,
  };
}

export const CLASSIFY_WEIGHTS = { surname: 0.5, given: 0.15, birth: 0.175, death: 0.175 };

export const DEFAULT_CLASSIFY_THRESHOLD = 0.75;

export const CLASSIFY_MAX_YEARS = { birth: 3, death: 2 };

export const SURNAME_DRIFT_BAND = 0.85;

export function classifySlot(fs, local, childSurname = null, opts = {}) {
  if (!fs && !local) return null;
  if (!fs) return { verdict: 'FS-MISSING', detail: `local ${local.id} ${local.name} has no FS counterpart in this slot` };
  if (!local) return { verdict: 'LOCAL-MISSING', detail: `FS ${fs.pid ?? ''} ${fs.name} (${fs.lifespan ?? '?'}) is not in the .ged` };
  const {
    weights = CLASSIFY_WEIGHTS,
    threshold = DEFAULT_CLASSIFY_THRESHOLD,
    maxYears = CLASSIFY_MAX_YEARS,
  } = opts;

  const fsYears = lifespanYears(fs.lifespan);
  const surFs = surnameKey(fs.name);
  const surLocal = surnameKey(local.name);
  const notes = [];
  const clashes = [];

  let surname;
  if (!surFs || !surLocal) {
    surname = 0.5;
  } else if (surFs === surLocal) {
    surname = 1;
  } else if (childSurname && surFs === surnameKey(childSurname)) {
    surname = 1;
    notes.push(`FS records the married name ${fs.name.split(' ').pop()}`);
  } else if (childSurname && surLocal === surnameKey(childSurname)) {
    surname = 1;
    notes.push(`FS records a maiden name (${fs.name.split(' ').pop()}) where the .ged has the married one — LEAD`);
  } else {
    const jw = jaroWinkler(surFs, surLocal);
    surname = jw >= SURNAME_DRIFT_BAND ? jw : jw * 0.5;
    clashes.push(`surname ${surFs} vs ${surLocal}`);
  }

  const gFs = givenPart(fs.name);
  const gLocal = givenPart(local.name);
  const given = gFs && gLocal ? nameSimilarity(gFs, gLocal, opts) : 0.5;

  const birth = yearSimilarity(fsYears.birth, local.birth, maxYears.birth);
  const death = yearSimilarity(fsYears.death, local.death, maxYears.death);
  const diffs = [];
  for (const [k, fsY, loY] of [['birth', fsYears.birth, local.birth], ['death', fsYears.death, local.death]]) {
    if (fsY != null && loY != null && fsY !== loY) diffs.push(`${k} ${fsY} vs ${loY}`);
  }

  const components = { surname, given, birth, death };
  const score =
    weights.surname * surname + weights.given * given + weights.birth * birth + weights.death * death;
  const verdict = score >= threshold - 1e-9 ? 'MATCH' : 'MISMATCH';
  return { verdict, detail: [...notes, ...clashes, ...diffs].join('; '), score, components };
}
export { jaro, MONTHS, givenPart };
