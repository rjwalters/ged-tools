// Byte-preserving GEDCOM editor. Untouched lines retain their original bytes.
// New lines use the dominant LF/CRLF terminator. Input paths are always explicit.
// set() replaces an occurrence; appendFact() adds one. Use addPointer() and
// removePointer() for relationship lists. Callers must verify referential integrity.

import { readFileSync, writeFileSync } from 'node:fs';

export class RefusedError extends Error {}

function dominantEol(lines) {
  let crlf = 0;
  let lf = 0;
  for (const l of lines) {
    if (l.eol === '\r\n') crlf++;
    else if (l.eol === '\n') lf++;
  }
  return crlf > lf ? '\r\n' : '\n';
}

export const NOTE_WIDTH = 100;

/** GEDCOM 5.5.1's line cap, counted in bytes because the file is bytes. */
export const GEDCOM_MAX_LINE = 255;

const PROSE_TAGS = new Set(['NOTE', 'TEXT']);

/** The wrap width for a tag when the caller did not name one. */
export const widthForTag = (tag) => (PROSE_TAGS.has(tag) ? NOTE_WIDTH : GEDCOM_MAX_LINE);

const byteLength = (s) => Buffer.byteLength(s, 'utf8');

function hardBreak(word, width) {
  if (byteLength(word) <= width) return [word];
  const out = [];
  let piece = '';
  let used = 0;
  for (const cp of word) {
    const b = byteLength(cp);
    if (piece && used + b > width) {
      out.push(piece);
      piece = '';
      used = 0;
    }
    piece += cp;
    used += b;
  }
  if (piece) out.push(piece);
  return out;
}

export function wrapNote(text, width = NOTE_WIDTH) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    let used = 0;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      for (const piece of hardBreak(word, width)) {
        const b = byteLength(piece);
        if (!line) {
          line = piece;
          used = b;
        } else if (used + 1 + b <= width) {
          line += ' ' + piece;
          used += 1 + b;
        } else {
          out.push(line);
          line = piece;
          used = b;
        }
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

function valueWidth(level, tag, width) {
  const prefix = Math.max(`${level} ${tag} `.length, `${level + 1} CONT `.length);
  return Math.max(1, Math.min(width, GEDCOM_MAX_LINE - prefix));
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      const hasCR = i > 0 && text[i - 1] === '\r';
      lines.push({ text: text.slice(start, hasCR ? i - 1 : i), eol: hasCR ? '\r\n' : '\n' });
      start = i + 1;
    }
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: '' });
  return lines;
}

function parseLine(text) {
  const m = text.match(/^(\d+)\s+(?:@([^@]+)@\s+)?(\S+)(?:\s(.*))?$/);
  if (!m) return null; // continuation of a literal-newline NOTE value
  return { level: parseInt(m[1], 10), xref: m[2] ?? null, tag: m[3], value: m[4] ?? '' };
}

const toBytes = (s) => Buffer.from(s, 'utf8').toString('latin1');

export const toDisplay = (s) => Buffer.from(s, 'latin1').toString('utf8');

export function loadGed(path) {
  const raw = readFileSync(path, 'latin1'); // byte-preserving
  const BOM = 'ï»¿';
  const bom = raw.startsWith(BOM) ? BOM : '';
  const lines = splitLines(bom ? raw.slice(3) : raw);
  const EOL = dominantEol(lines);
  const dirtyIds = new Set();

  function indexRecords() {
    const index = new Map(); // xref -> { start, end } line range, end exclusive
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      const p = parseLine(lines[i].text);
      if (p && p.level === 0) {
        if (cur) index.get(cur).end = i;
        if (p.xref) {
          index.set(p.xref, { start: i, end: lines.length });
          cur = p.xref;
        } else {
          cur = null;
        }
      }
    }
    return index;
  }

  let index = indexRecords();

  function range(id) {
    const r = index.get(id);
    if (!r) throw new Error(`no record @${id}@ in GEDCOM`);
    return r;
  }

  function nodes(id) {
    const { start, end } = range(id);
    const out = [];
    for (let i = start + 1; i < end; i++) {
      const p = parseLine(lines[i].text);
      if (p) out.push({ i, level: p.level, tag: p.tag, value: p.value });
    }
    return out;
  }

  function subtreeEnd(id, i) {
    const { end } = range(id);
    const root = parseLine(lines[i].text);
    for (let j = i + 1; j < end; j++) {
      const p = parseLine(lines[j].text);
      if (p && p.level <= root.level) return j;
    }
    return end;
  }

  function find(id, path) {
    const segs = path.split('.').map((s) => {
      const m = s.match(/^(\w+)(?:\[(\d+)\])?$/);
      if (!m) throw new Error(`bad path segment: ${s}`);
      return { tag: m[1], occ: m[2] ? parseInt(m[2], 10) : 1 };
    });
    let parentLine = null; // line idx of current parent node
    let level = 1;
    let searchStart = range(id).start + 1;
    let searchEnd = range(id).end;
    for (const seg of segs) {
      let n = 0;
      let found = -1;
      for (let i = searchStart; i < searchEnd; i++) {
        const p = parseLine(lines[i].text);
        if (!p) continue;
        if (p.level < level) break;
        if (p.level === level && p.tag === seg.tag && ++n === seg.occ) {
          found = i;
          break;
        }
      }
      if (found === -1) return { i: -1, parent: parentLine, missing: segs.slice(segs.indexOf(seg)) };
      parentLine = found;
      searchStart = found + 1;
      searchEnd = subtreeEnd(id, found);
      level++;
    }
    return { i: parentLine };
  }

  function insertLines(at, newLines) {
    lines.splice(at, 0, ...newLines.map((text) => ({ text, eol: EOL })));
    index = indexRecords();
  }

  function value(id, path) {
    const { i } = find(id, path);
    return i === -1 ? null : parseLine(lines[i].text).value;
  }

  function set(id, path, val) {
    const last = path.split('.').pop().match(/^([A-Za-z0-9_]+)(\[\d+\])?$/);
    if (
      last &&
      !last[2] &&
      ['FAMC', 'FAMS', 'CHIL', 'HUSB', 'WIFE'].includes(last[1]) &&
      typeof val === 'string' &&
      /^@[^@]+@$/.test(val)
    ) {
      throw new RefusedError(
        `set() refuses the bare pointer tag ${last[1]}: it would rewrite occurrence 1 in place ` +
          `and destroy an unrelated link. Use addPointer/removePointer (value-addressed), or ` +
          `name the occurrence explicitly (${last[1]}[n]) for deliberate surgery.`
      );
    }
    val = val ? toBytes(val) : val;
    const r = find(id, path);
    if (r.i !== -1) {
      const p = parseLine(lines[r.i].text);
      lines[r.i].text = `${p.level} ${p.tag}${val ? ' ' + val : ''}`;
      dirtyIds.add(id);
      return r.i;
    }
    let at;
    let level;
    if (r.parent != null) {
      const seg = r.missing[0];
      const childLevel = parseLine(lines[r.parent].text).level + 1;
      let existing = 0;
      for (let i = r.parent + 1; i < subtreeEnd(id, r.parent); i++) {
        const p = parseLine(lines[i].text);
        if (p && p.level === childLevel && p.tag === seg.tag) existing++;
      }
      if (seg.occ > existing + 1) {
        throw new RefusedError(
          `cannot create ${seg.tag}[${seg.occ}] at ${path} on @${id}@ — only ${existing} ` +
            `${seg.tag} occurrence(s) exist under that parent, so the new node would resolve ` +
            `as ${seg.tag}[${existing + 1}], not the ordinal asked for`
        );
      }
      at = subtreeEnd(id, r.parent);
      level = childLevel;
    } else {
      const seg = r.missing[0];
      const existing = nodes(id).filter((n) => n.level === 1 && n.tag === seg.tag);
      if (seg.occ > existing.length + 1) {
        throw new RefusedError(
          `cannot create ${seg.tag}[${seg.occ}] on @${id}@ — only ${existing.length} ` +
            `${seg.tag} occurrence(s) exist, so the new node would resolve as ` +
            `${seg.tag}[${existing.length + 1}], not the ordinal asked for`
        );
      }
      at = existing.length ? subtreeEnd(id, existing[existing.length - 1].i) : insertionPoint(id);
      level = 1;
    }
    for (let k = 1; k < r.missing.length; k++) {
      if (r.missing[k].occ > 1) {
        throw new RefusedError(
          `cannot create ${r.missing[k].tag}[${r.missing[k].occ}] at ${path} on @${id}@ — its ` +
            `parent ${r.missing[k - 1].tag} is being created by this same call, so only ` +
            `${r.missing[k].tag}[1] can exist under it`
        );
      }
    }
    const newLines = [];
    r.missing.forEach((seg, k) => {
      const last = k === r.missing.length - 1;
      newLines.push(`${level + k} ${seg.tag}${last && val ? ' ' + val : ''}`);
    });
    insertLines(at, newLines);
    dirtyIds.add(id);
    return at + newLines.length - 1;
  }

  function continuationLines(id, i) {
    const end = subtreeEnd(id, i);
    const root = parseLine(lines[i].text);
    const run = [];
    for (let j = i + 1; j < end; j++) {
      const p = parseLine(lines[j].text);
      if (p === null) {
        run.push(j); // a literal newline inside the value, not a GEDCOM line
        continue;
      }
      if (p.level === root.level + 1 && (p.tag === 'CONT' || p.tag === 'CONC')) {
        run.push(j);
        continue;
      }
      break;
    }
    return run;
  }

  function setWrapped(id, path, text, width = null) {
    const r = find(id, path);
    let level;
    let tag;
    if (r.i !== -1) {
      const p = parseLine(lines[r.i].text);
      level = p.level;
      tag = p.tag;
      const run = continuationLines(id, r.i);
      if (run.length) {
        lines.splice(run[0], run.length); // the run is contiguous by construction
        index = indexRecords();
        dirtyIds.add(id);
      }
    } else {
      const segs = path.split('.');
      level = segs.length;
      tag = segs[segs.length - 1].replace(/\[\d+\]$/, '');
    }
    const budget = valueWidth(level, tag, width ?? widthForTag(tag));
    const [first, ...rest] = wrapNote(text, budget);
    const i = set(id, path, first);
    if (!rest.length) return 1;
    insertLines(
      i + 1,
      rest.map((line) => `${level + 1} CONT${line ? ' ' + toBytes(line) : ''}`)
    );
    dirtyIds.add(id);
    return 1 + rest.length;
  }

  const TRAILING = new Set(['FAMC', 'FAMS', 'RIN', '_UID', 'CHAN']);
  function insertionPoint(id) {
    for (const n of nodes(id)) {
      if (n.level === 1 && TRAILING.has(n.tag)) return n.i;
    }
    return range(id).end;
  }

  function removeAt(id, i) {
    const end = subtreeEnd(id, i);
    const removed = lines.slice(i, end).map((l) => l.text);
    lines.splice(i, end - i);
    index = indexRecords();
    dirtyIds.add(id);
    return removed;
  }

  function removeFact(id, tag, occurrence = 1) {
    const r = find(id, `${tag}[${occurrence}]`);
    if (r.i === -1) throw new RefusedError(`@${id}@ has no ${tag}[${occurrence}]`);
    return removeAt(id, r.i);
  }

  function removePath(id, path) {
    const r = find(id, path);
    if (r.i === -1) throw new RefusedError(`@${id}@ has no ${path}`);
    return removeAt(id, r.i);
  }

  function appendFact(id, tag, text, width = null) {
    const existing = nodes(id).filter((n) => n.level === 1 && n.tag === tag).length;
    return setWrapped(id, `${tag}[${existing + 1}]`, text, width);
  }

  const ptrValue = (target) => `@${String(target).replace(/^@|@$/g, '')}@`;

  function pointerLines(id, tag, target) {
    const want = ptrValue(target);
    const hits = [];
    for (const n of nodes(id)) {
      if (n.level === 1 && n.tag === tag && n.value.trim() === want) hits.push(n.i);
    }
    return hits;
  }

  function hasPointer(id, tag, target) {
    return pointerLines(id, tag, target).length > 0;
  }

  function pointers(id, tag) {
    const out = [];
    for (const n of nodes(id)) {
      if (n.level !== 1 || n.tag !== tag) continue;
      const m = n.value.trim().match(/^@([^@]+)@$/);
      if (m) out.push(m[1]);
    }
    return out;
  }

  function removePointer(id, tag, target) {
    const hits = pointerLines(id, tag, target);
    const removed = [];
    for (let k = hits.length - 1; k >= 0; k--) {
      const i = hits[k];
      const end = subtreeEnd(id, i);
      removed.unshift(...lines.slice(i, end).map((l) => l.text));
      lines.splice(i, end - i);
      index = indexRecords();
    }
    if (removed.length) dirtyIds.add(id);
    return removed;
  }

  function spouseInsertionPoint(id, tag) {
    if ((tag !== 'HUSB' && tag !== 'WIFE') || kind(id) !== 'FAM') return null;
    const otherTag = tag === 'WIFE' ? 'HUSB' : 'WIFE';
    const other = nodes(id).find((n) => n.level === 1 && n.tag === otherTag);
    if (!other) return null;
    return tag === 'WIFE' ? subtreeEnd(id, other.i) : other.i;
  }

  function addPointer(id, tag, target) {
    if (hasPointer(id, tag, target)) return false;
    const existing = nodes(id).filter((n) => n.level === 1 && n.tag === tag);
    const at = existing.length
      ? subtreeEnd(id, existing[existing.length - 1].i)
      : (spouseInsertionPoint(id, tag) ?? insertionPoint(id));
    insertLines(at, [`1 ${tag} ${ptrValue(target)}`]);
    dirtyIds.add(id);
    return true;
  }

  function kind(id) {
    return parseLine(lines[range(id).start].text)?.tag ?? null;
  }

  function block(id) {
    const { start, end } = range(id);
    return lines.slice(start, end).map((l) => l.text);
  }

  function nextXref(prefix) {
    let max = 0;
    const re = new RegExp(`^${prefix}(\\d+)$`);
    for (const id of index.keys()) {
      const m = id.match(re);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${prefix}${max + 1}`;
  }

  function appendRecord(recordLines) {
    const head = parseLine(recordLines[0]);
    if (!head || head.level !== 0 || !head.xref) {
      throw new Error(`appendRecord needs a "0 @XREF@ TAG" first line, got: ${recordLines[0]}`);
    }
    if (index.has(head.xref)) throw new Error(`@${head.xref}@ already exists`);
    const trlr = lines.findIndex((l) => /^0\s+TRLR\s*$/.test(l.text));
    insertLines(trlr === -1 ? lines.length : trlr, recordLines.map(toBytes));
    dirtyIds.add(head.xref);
    return head.xref;
  }

  function removeRecord(id) {
    const { start, end } = range(id);
    const removed = lines.slice(start, end).map((l) => toDisplay(l.text));
    lines.splice(start, end - start);
    index = indexRecords();
    dirtyIds.delete(id);
    return removed;
  }

  function save(path) {
    writeFileSync(path, bom + lines.map((l) => l.text + l.eol).join(''), 'latin1');
  }

  return {
    has: (id) => index.has(id),
    ids: () => [...index.keys()],
    kind,
    nodes,
    find,
    value,
    set,
    setWrapped,
    removeFact,
    removePath,
    appendFact,
    addPointer,
    removePointer,
    hasPointer,
    pointers,
    block,
    save,
    nextXref,
    appendRecord,
    removeRecord,
    dirty: () => [...dirtyIds],
  };
}
