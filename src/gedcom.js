// GEDCOM 5.5.1 parser with support for MyHeritage export conventions.
// Produces a compact, lossy reading model; use the editor to preserve raw bytes.

/**
 * Parse raw GEDCOM text into a flat list of level-0 records, each a node tree.
 * A node is { level, tag, xref, value, children }.
 */
export function parseRecords(text) {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);

  const root = { level: -1, tag: 'ROOT', xref: null, value: '', children: [] };
  const stack = [root];

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const m = raw.match(/^(\d+)\s(.*)$/);
    if (!m) {
      const cur = stack[stack.length - 1];
      if (cur && cur.level >= 0) cur.value += '\n' + raw.trim();
      continue;
    }
    const level = parseInt(m[1], 10);
    let rest = m[2];

    let xref = null;
    let tag;
    let value = '';
    const xrefMatch = rest.match(/^@([^@]+)@\s+(\S+)(?:\s(.*))?$/);
    if (xrefMatch) {
      xref = xrefMatch[1];
      tag = xrefMatch[2];
      value = xrefMatch[3] ?? '';
    } else {
      const tagMatch = rest.match(/^(\S+)(?:\s(.*))?$/);
      if (!tagMatch) continue;
      tag = tagMatch[1];
      value = tagMatch[2] ?? '';
    }
    value = unescapeAt(value);

    const ptr = value.match(/^@([^@]+)@$/);
    if (ptr) value = ptr[1];

    while (stack.length > level + 1) stack.pop();
    const parent = stack[stack.length - 1] || root;

    if (tag === 'CONC') {
      parent.value += value;
      continue;
    }
    if (tag === 'CONT') {
      parent.value += '\n' + value;
      continue;
    }

    const node = { level, tag, xref, value, children: [] };
    parent.children.push(node);
    stack.push(node);
  }

  return root.children;
}

function unescapeAt(s) {
  return s.includes('@@') ? s.replace(/@@/g, '@') : s;
}

function child(node, tag) {
  return node.children.find((c) => c.tag === tag);
}
function children(node, tag) {
  return node.children.filter((c) => c.tag === tag);
}

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
function parseDate(value) {
  if (!value) return null;
  const display = value.replace(/\b(ABT|EST|CAL|BEF|AFT|BET|AND|FROM|TO)\b/gi, (s) => s.toLowerCase()).trim();
  const years = value.match(/\d{4}/g);
  const year = years ? parseInt(years[years.length - 1], 10) : null;
  const mon = value.match(/\b(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\b/i);
  const day = value.match(/\b(\d{1,2})\b/);
  const month = mon ? MONTHS[mon[1].toUpperCase()] : 0;
  const d = day ? parseInt(day[1], 10) : 0;
  const sort = year != null ? year * 10000 + month * 100 + (d <= 31 ? d : 0) : null;
  return { raw: value, display, year, sort };
}

function addrText(addrNode) {
  if (!addrNode) return null;
  const adr1 = child(addrNode, 'ADR1');
  const adr2 = child(addrNode, 'ADR2');
  const parts = [];
  if (adr1 && adr1.value) parts.push(adr1.value);
  if (adr2 && adr2.value) parts.push(adr2.value);
  if (parts.length) return parts.join(', ');
  return addrNode.value || null;
}

function collectDescendants(node, tag, out = []) {
  for (const c of node.children) {
    if (c.tag === tag && c.value) out.push(c.value.trim());
    collectDescendants(c, tag, out);
  }
  return out;
}

function parseName(node) {
  const nameNode = child(node, 'NAME');
  let given = '';
  let surname = '';
  let married = '';
  let display = '';
  if (nameNode) married = child(nameNode, '_MARNM')?.value?.trim() || '';
  if (nameNode) {
    const givn = child(nameNode, 'GIVN');
    const surn = child(nameNode, 'SURN');
    given = givn?.value || '';
    surname = surn?.value || '';
    const raw = nameNode.value || '';
    const slash = raw.match(/^(.*?)\/([^/]*)\/(.*)$/);
    if (slash) {
      if (!given) given = slash[1].trim();
      if (!surname) surname = slash[2].trim();
      const suffix = slash[3].trim();
      display = [slash[1].trim(), slash[2].trim(), suffix].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    } else {
      display = raw.trim();
      if (!given) given = raw.trim();
    }
  }
  if (!display) display = [given, surname].filter(Boolean).join(' ').trim() || 'Unknown';
  return { display, given, surname, married };
}

function parseEvent(node, tag) {
  const ev = child(node, tag);
  if (!ev) return null;
  const dateNode = child(ev, 'DATE');
  const placeNode = child(ev, 'PLAC');
  const date = dateNode ? parseDate(dateNode.value) : null;
  const place = placeNode?.value || null;
  if (!date && !place && ev.value !== 'Y') return null;
  return { date, place };
}

function bestAddress(node) {
  const entries = [];
  for (const resi of children(node, 'RESI')) {
    const addrNode = child(resi, 'ADDR');
    const text = addrText(addrNode);
    if (!text) continue;
    const dateNode = child(resi, 'DATE');
    const date = dateNode ? parseDate(dateNode.value) : null;
    entries.push({ text, sort: date?.sort ?? null, dateDisplay: date?.display ?? null });
  }
  if (!entries.length) return null;
  const dated = entries.filter((e) => e.sort != null);
  if (dated.length) {
    dated.sort((a, b) => a.sort - b.sort);
    return dated[dated.length - 1];
  }
  return entries[entries.length - 1];
}

function uniq(arr) {
  return [...new Set(arr)];
}

const LATIN_ENTITIES = {
  Aacute: 'Á', aacute: 'á', Agrave: 'À', agrave: 'à', Acirc: 'Â', acirc: 'â', Auml: 'Ä', auml: 'ä',
  Eacute: 'É', eacute: 'é', Egrave: 'È', egrave: 'è', Ecirc: 'Ê', ecirc: 'ê', Euml: 'Ë', euml: 'ë',
  Iacute: 'Í', iacute: 'í', Icirc: 'Î', icirc: 'î', Iuml: 'Ï', iuml: 'ï',
  Oacute: 'Ó', oacute: 'ó', Ocirc: 'Ô', ocirc: 'ô', Ouml: 'Ö', ouml: 'ö',
  Uacute: 'Ú', uacute: 'ú', Ucirc: 'Û', ucirc: 'û', Uuml: 'Ü', uuml: 'ü',
  Ntilde: 'Ñ', ntilde: 'ñ', Ccedil: 'Ç', ccedil: 'ç', szlig: 'ß', deg: '°', frac12: '½', frac14: '¼',
};

function stripHtml(s) {
  if (!/[<&]/.test(s)) return s;
  let t = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&rsquo;|&#8217;/gi, '’')
    .replace(/&lsquo;|&#8216;/gi, '‘')
    .replace(/&rdquo;|&#8221;/gi, '”')
    .replace(/&ldquo;|&#8220;/gi, '“')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&hellip;/gi, '…')
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([A-Za-z]+);/g, (m, name) => LATIN_ENTITIES[name] ?? m);
  return t
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parsePerson(node) {
  const { display, given, surname, married } = parseName(node);
  const sex = child(node, 'SEX')?.value || null;
  const birth = parseEvent(node, 'BIRT');
  const death = parseEvent(node, 'DEAT');
  const deceased = !!child(node, 'DEAT') || !!child(node, 'BURI');
  const address = bestAddress(node);
  const emails = uniq(collectDescendants(node, 'EMAIL').map((e) => e.trim()).filter(Boolean));
  const phones = uniq(collectDescendants(node, 'PHON').map((p) => p.trim()).filter(Boolean));
  const notes = collectDescendants(node, 'NOTE').map((n) => stripHtml(n.trim())).filter(Boolean);
  const famc = children(node, 'FAMC').map((c) => c.value).filter(Boolean);
  const fams = children(node, 'FAMS').map((c) => c.value).filter(Boolean);

  return {
    id: node.xref,
    name: display,
    given,
    surname,
    married: married || null,
    sex,
    deceased,
    birth: birth ? { date: birth.date?.display || null, year: birth.date?.year ?? null, place: birth.place } : null,
    death: death ? { date: death.date?.display || null, year: death.date?.year ?? null, place: death.place } : null,
    address: address ? { text: address.text, asOf: address.dateDisplay } : null,
    emails,
    phones,
    note: notes.length ? notes.join('\n\n') : null,
    famc,
    fams,
  };
}

function parseFamily(node) {
  const marr = parseEvent(node, 'MARR');
  return {
    id: node.xref,
    husband: child(node, 'HUSB')?.value || null,
    wife: child(node, 'WIFE')?.value || null,
    children: children(node, 'CHIL').map((c) => c.value).filter(Boolean),
    marriage: marr ? { date: marr.date?.display || null, place: marr.place } : null,
  };
}

/** Parse GEDCOM text into the compact { people, families } model. */
export function buildModel(text) {
  const records = parseRecords(text);
  const people = {};
  const families = {};
  for (const rec of records) {
    if (rec.tag === 'INDI' && rec.xref) {
      people[rec.xref] = parsePerson(rec);
    } else if (rec.tag === 'FAM' && rec.xref) {
      families[rec.xref] = parseFamily(rec);
    }
  }
  return { people, families };
}
