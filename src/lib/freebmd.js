import { controls } from './controls.js';
export const SEARCH_URL = 'https://www.freebmd.org.uk/cgi/search.pl';

export const USER_AGENT =
  'ged-tools/0.2 (genealogy research; +https://github.com/rjwalters/ged-tools)';

export const POLITE_DELAY_MS = 3000;

export class FreeBMDError extends Error {}

export const TYPES = { births: 'Births', marriages: 'Marriages', deaths: 'Deaths' };

export const QUARTERS = { 1: 'Mar', 2: 'Jun', 3: 'Sep', 4: 'Dec' };

export const DETAIL_LABELS = {
  Births: "mother's maiden surname (blank before Sep 1911)",
  Marriages: 'spouse surname',
  Deaths: 'age at death',
};

export function extractHiddenFields(html) {
  const out = new Map();
  for (const m of String(html).matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/type\s*=\s*["']?hidden/i.test(tag)) continue;
    const name = tag.match(/\bname\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const value = tag.match(/\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!name) continue;
    const n = name[1] ?? name[2] ?? name[3];
    const v = value ? (value[1] ?? value[2] ?? value[3]) : '';
    if (!out.has(n)) out.set(n, v);
  }
  return out;
}

export function extractTokens(html) {
  const hidden = extractHiddenFields(html);
  const db = hidden.get('db');
  const v = hidden.get('v');
  if (!db || !v) {
    throw new FreeBMDError(
      'no db/v tokens found — this is not the FreeBMD search form. ' +
        `Fetch a fresh GET of ${SEARCH_URL} for every search; the tokens are per-session hidden inputs.`,
    );
  }
  return { db, v };
}

const EMPTY_DISTRICT_TRAP =
  'refusing to send an empty %s: FreeBMD crashes its SQL on an empty districtid ' +
  '(a MySQL syntax-error page comes back) and croaks on any non-`all` label. ' +
  'Omit the field or pass the literal string "all". ' +
  '(Empty values must be omitted from the request.)';

export function assertNoEmptyValues(fields) {
  for (const [name, value] of fields) {
    if (value === '' || value == null) {
      throw new FreeBMDError(
        `field "${name}" is empty — FreeBMD must never be sent a blank field; omit it entirely ` +
          '(omit districtid when no district is selected).',
      );
    }
  }
  return fields;
}

export function buildSearchFields(query, tokens) {
  const {
    type,
    surname,
    given,
    sSurname,
    startYear,
    endYear,
    startQuarter = 1,
    endQuarter = 4,
    countyid = 'all',
    districtid = 'all',
  } = query ?? {};

  if (!tokens?.db || !tokens?.v) {
    throw new FreeBMDError('buildSearchFields needs the db/v tokens from a fresh form GET (extractTokens)');
  }
  if (!Object.values(TYPES).includes(type)) {
    throw new FreeBMDError(`type must be one of ${Object.values(TYPES).join('/')} (got ${JSON.stringify(type)})`);
  }
  if (!surname || !String(surname).trim()) throw new FreeBMDError('surname is required');
  for (const [label, y] of [['startYear', startYear], ['endYear', endYear]]) {
    if (!/^\d{4}$/.test(String(y))) throw new FreeBMDError(`${label} must be a 4-digit year (got ${JSON.stringify(y)})`);
  }
  for (const [label, q] of [['startQuarter', startQuarter], ['endQuarter', endQuarter]]) {
    if (!QUARTERS[q]) throw new FreeBMDError(`${label} must be 1–4 (Mar/Jun/Sep/Dec), got ${JSON.stringify(q)}`);
  }
  for (const [label, value] of [['districtid', districtid], ['countyid', countyid]]) {
    if (value === '' || value == null) {
      throw new FreeBMDError(EMPTY_DISTRICT_TRAP.replace('%s', label));
    }
  }

  const fields = [
    ['db', tokens.db],
    ['v', tokens.v],
    ['type', type],
    ['surname', String(surname).trim().toUpperCase()],
  ];

  if (given && String(given).trim()) {
    fields.push(['given', String(given).trim()], ['exactgiven', 'on']);
  }
  if (sSurname && String(sSurname).trim()) {
    fields.push(['s_surname', String(sSurname).trim().toUpperCase()]);
  }
  fields.push(
    ['start', String(startYear)],
    ['sq', String(startQuarter)],
    ['end', String(endYear)],
    ['eq', String(endQuarter)],
    ['countyid', String(countyid)],
    ['districtid', String(districtid)],
    ['action', 'Find'],
  );
  return assertNoEmptyValues(fields);
}

export function encodeMultipart(fields, boundary = `----ged-tools-freebmd-${Date.now().toString(36)}`) {
  assertNoEmptyValues(fields);
  const parts = fields.map(
    ([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: parts.join('') + `--${boundary}--\r\n`,
  };
}

export function classifyPage(html) {
  const s = String(html);
  if (/error in your SQL syntax|DBD::mysql|mysql_error/i.test(s)) return 'sql-error';
  if (/Software error/i.test(s) && /CGI::Carp|croak|contact the (web)?site admin/i.test(s)) return 'croak';
  if (/Software error/i.test(s)) return 'croak';
  if (/var\s+searchData\s*=\s*new\s+Array/i.test(s)) return 'searchdata';
  if (/<th>\s*Surname/i.test(s)) return 'table';
  return 'unrecognized';
}

const stripTags = (s) =>
  String(s)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;| /g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const decodeField = (s) => {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, ' ')).trim();
  } catch {
    return String(s).trim();
  }
};

export function parseSearchData(html) {
  const m = String(html).match(/var\s+searchData\s*=\s*new\s+Array\s*\(([\s\S]*?)\)\s*;/i);
  if (!m) return [];
  const rows = [];
  let ctx = { type: null, typeCode: null, quarter: null, year: null };
  let lastSurname = '';
  for (const sm of m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const fields = sm[1].split(';').map(decodeField);
    if (fields.length < 8) {

      ctx = {
        type: null,
        typeCode: fields[1] ?? null,
        quarter: QUARTERS[fields[2]] ?? `quarter-code-${fields[2]}`,
        year: fields[3] ?? null,
      };
      continue;
    }
    const surname = fields[1] || lastSurname;
    lastSurname = surname;
    rows.push({
      type: ctx.type,
      typeCode: ctx.typeCode,
      quarter: ctx.quarter,
      year: ctx.year,
      surname,
      given: fields[2],
      detail: fields[3],
      district: fields[5],
      volume: fields[6],
      page: fields[7],
    });
  }
  return rows;
}

const looksLikeVolume = (s) => /^(\d{1,2}[a-z]?|[ivxlcdm]{1,6})$/i.test(s);

const looksLikePage = (s) => /^\d{1,5}$/.test(s);

export function parseResultsTable(html) {
  const rows = [];
  let ctx = { type: null, quarter: null, year: null };
  let lastSurname = '';
  for (const chunk of String(html).split(/<tr[^>]*>/i).slice(1)) {
    const header = chunk.match(/<th\s+colspan=6>[\s\S]*?(Births|Marriages|Deaths)\s+(Mar|Jun|Sep|Dec)\s*(\d{4})/i);
    if (header) {
      ctx = { type: header[1], quarter: header[2], year: header[3] };
      continue;
    }
    if (!ctx.type) continue;
    const cells = chunk
      .split(/<td[^>]*>/i)
      .slice(1)
      .map(stripTags);
    if (cells.length < 6) continue;
    if (!looksLikeVolume(cells[4]) || !looksLikePage(cells[5])) continue;
    const surname = cells[0] || lastSurname;
    lastSurname = surname;
    rows.push({
      type: ctx.type,
      quarter: ctx.quarter,
      year: ctx.year,
      surname,
      given: cells[1],
      detail: cells[2],
      district: cells[3],
      volume: cells[4],
      page: cells[5],
    });
  }
  return rows;
}

export function parseSearchPage(html) {
  const kind = classifyPage(html);
  switch (kind) {
    case 'sql-error':
      return {
        status: 'error',
        reason: 'sql-error',
        message:
          'FreeBMD returned a MySQL syntax-error page — the empty-field crash. ' +
          'Some field (classically districtid) went out blank; omit unused fields entirely.',
      };
    case 'croak':
      return {
        status: 'error',
        reason: 'croak',
        message:
          'FreeBMD returned a CGI::Carp "Software error" page (with HTTP 200). ' +
          'districtid/countyid must be the literal string "all" or a real id from the form.',
      };
    case 'unrecognized':
      return {
        status: 'error',
        reason: 'unrecognized',
        message:
          'unrecognized page — neither a searchData array nor a results table. ' +
          'This CANNOT be read as "no results"; treat it as a tooling error.',
      };
    case 'searchdata':
    case 'table': {

      const table = parseResultsTable(html);
      if (table.length) return { status: 'results', source: 'table', rows: table };
      const sd = parseSearchData(html);
      if (sd.length) return { status: 'results', source: 'searchdata', rows: sd };
      return { status: 'results', source: kind, rows: [] };
    }

    default:
      throw new FreeBMDError(`unhandled page classification ${kind}`);
  }
}

export const CONTROL_QUERY = controls.freebmd?.query ?? null;

export const CONTROL_EXPECT = controls.freebmd?.expected ?? [];

const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

export function verifyControl(rows, expected = CONTROL_EXPECT) {
  if (!Array.isArray(expected) || !expected.length || expected.some(e => !e || typeof e !== 'object' || !Object.keys(e).length)) {
    throw new Error('A known-positive FreeBMD control with nonempty expected rows is required');
  }
  const missing = expected.filter(
    (e) => !rows.some((r) => Object.entries(e).every(([k, want]) => same(r[k], want))),
  );
  return { passed: missing.length === 0, missing };
}
export { EMPTY_DISTRICT_TRAP, decodeField, stripTags, looksLikeVolume, looksLikePage, same };
