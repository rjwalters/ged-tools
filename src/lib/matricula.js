import { createHash, createCipheriv } from 'node:crypto';
export const SITE = 'https://data.matricula-online.eu';

export const IMG_HOST = 'https://img.data.matricula-online.eu';

export const USER_AGENT =
  'ged-tools/0.2 (genealogy research; +https://github.com/rjwalters/ged-tools)';

export const POLITE_DELAY_MS = 2000;

export const KEY_CTRL = Buffer.from('pG58&Qj$?.d=(<.[v!kJkm_XNbsa6e.f', 'latin1');

export const KEY_TILE = Buffer.from('dGhpcyBpcyBubyBr', 'latin1');

export const KEY_ROTATION_HINT =
  'This is a TOOLING error, never a research negative: the page was not read, ' +
  'so nothing can be said about its contents. The AES keys in lib/matricula.js ' +
  'are point-in-time extractions (2026-08-18) from the site-served ' +
  'matricula-imageview-compiled*.js — they may have rotated. Re-derive KEY_CTRL ' +
  '(32 bytes, AES-256) and KEY_TILE (16 bytes, AES-128) from that file and ' +
  'update lib/matricula.js before re-running.';

export class MatriculaError extends Error {}

export function aesEcbHex(key, data) {
  const cipher = createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]).toString('hex');
}

export function buildPageUrl(filePath, csrf, imgHost = IMG_HOST) {
  if (!filePath || !String(filePath).startsWith('/')) {
    throw new MatriculaError(`filePath must be a host-relative path starting with "/" (got ${JSON.stringify(filePath)})`);
  }
  if (!csrf || !String(csrf).trim()) {
    throw new MatriculaError('csrf is required — it is the csrftoken cookie the register page sets');
  }
  const b = `${filePath}?csrf=${csrf}`;

  const digest = createHash('md5').update(b, 'utf8').digest();
  return `${imgHost}${b}&ctrl=${aesEcbHex(KEY_CTRL, digest)}`;
}

export const tileChecksum = (pageUrl) =>
  [...String(pageUrl)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 100;

export const padTilePlain = (plain) =>
  plain.length % 16 ? plain + '*'.repeat(16 - (plain.length % 16)) : plain;

export function buildTileUrl(pageUrl, z, x, y) {
  const plain = padTilePlain(`${tileChecksum(pageUrl)}|${z}|${x}|${y}`);
  return `${pageUrl}/${aesEcbHex(KEY_TILE, Buffer.from(plain, 'utf8'))}`;
}

export function csrfFromSetCookies(setCookies = []) {
  for (const c of setCookies) {
    const m = String(c).match(/(?:^|;\s*)csrftoken=([^;]+)/i);
    if (m) return m[1];
  }
  return null;
}

export function csrfFromHtml(html) {
  const s = String(html);
  const input = s.match(/name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)["']/i)
    ?? s.match(/value=["']([^"']+)["'][^>]*name=["']csrfmiddlewaretoken["']/i);
  if (input) return input[1];
  const inline = s.match(/["']csrf["']\s*[:=]\s*["']([^"']+)["']/);
  return inline ? inline[1] : null;
}

export function extractJsonArray(src, key) {
  const s = String(src);
  const at = s.search(new RegExp(`["']${key}["']\\s*:`));
  if (at === -1) return null;
  const open = s.indexOf('[', at);
  if (open === -1) return null;
  let depth = 0;
  let inStr = null;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return s.slice(open, i + 1);
  }
  return null;
}

const IMAGE_PATH_RE = /^\/[^\s"'<>]+\.(?:jpe?g|png|gif|tiff?|webp)$/i;

export function parseRegisterPage(html) {
  const s = String(html);
  const hostMatch = s.match(/["'](https?:\/\/img\.[^"']+?)["'\/]/) ?? s.match(/["']path["']\s*:\s*["'](https?:\/\/[^"']+?)\/?["']/);
  const imgHost = (hostMatch ? hostMatch[1] : IMG_HOST).replace(/\/+$/, '');

  let files = [];
  let source = null;
  const arr = extractJsonArray(s, 'files');
  if (arr) {
    try {
      const parsed = JSON.parse(arr);
      files = parsed
        .map((f) => (typeof f === 'string' ? f : f?.path ?? f?.file ?? f?.src ?? f?.url ?? null))
        .filter((p) => typeof p === 'string' && IMAGE_PATH_RE.test(p));
      if (files.length) source = 'files-array';
    } catch {

    }
  }
  if (!files.length) {
    const seen = new Set();
    const harvested = [];
    for (const m of s.matchAll(/["']((?:\\\/|\/)[^"']*?\.(?:jpe?g|png|gif|tiff?|webp))["']/gi)) {
      const p = m[1].replace(/\\\//g, '/');
      if (IMAGE_PATH_RE.test(p) && !seen.has(p)) {
        seen.add(p);
        harvested.push(p);
      }
    }

    if (harvested.length) {
      const dirOf = (p) => p.slice(0, p.lastIndexOf('/'));
      const counts = new Map();
      for (const p of harvested) counts.set(dirOf(p), (counts.get(dirOf(p)) ?? 0) + 1);
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      files = harvested.filter((p) => dirOf(p) === best);
      source = 'path-harvest';
    }
  }
  return { files, source, imgHost, csrf: csrfFromHtml(s) };
}

export function assertFiles(parsed, url) {
  if (!parsed.files.length) {
    throw new MatriculaError(
      `no page-image paths found in the register page at ${url} — the viewer's ` +
        'file-list embedding has changed (it was never measured live; see the ' +
        'lib/matricula.js header) or this is not a register viewer page. ' +
        'This CANNOT be read as "the register has no pages"; update ' +
        'parseRegisterPage() after inspecting the live HTML.',
    );
  }
  return parsed.files;
}

const stripTags = (s) =>
  String(s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;| /g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const decodePath = (p) => {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};

export function parseParishPage(html, parishPath) {
  const base = `/${String(parishPath).replace(/^\/+|\/+$/g, '')}/`;
  const found = new Map();
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const consider = (href, label, context) => {
    const decoded = decodePath(href.startsWith('http') ? href.replace(/^https?:\/\/[^/]+/, '') : href);
    if (!decoded.startsWith(base) || decoded.replace(/\/+$/, '') === base.replace(/\/+$/, '')) return;
    if (!found.has(href)) found.set(href, { href, label: stripTags(label), context });
  };
  for (const row of String(html).split(/<tr[^>]*>/i).slice(1)) {
    const context = stripTags(row.split(/<\/tr>/i)[0]);
    for (const a of row.matchAll(anchorRe)) consider(a[1], a[2], context);
  }
  if (!found.size) {
    for (const a of String(html).matchAll(anchorRe)) consider(a[1], a[2], stripTags(a[2]));
  }
  return [...found.values()];
}

const MAGIC = [
  { format: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { format: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { format: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { format: 'webp/riff', bytes: [0x52, 0x49, 0x46, 0x46] },
  { format: 'tiff-le', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { format: 'tiff-be', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
];

export function imageFormat(bytes) {
  const buf = Buffer.from(bytes ?? []);
  for (const { format, bytes: sig } of MAGIC) {
    if (buf.length >= sig.length && sig.every((b, i) => buf[i] === b)) return format;
  }
  return null;
}

export function classifyImageResponse({ status, contentType = '', bytes } = {}) {
  if (status === 403) {
    return { verdict: 'forbidden', message: `HTTP 403 from the image host. ${KEY_ROTATION_HINT}` };
  }
  if (status !== 200) {
    return {
      verdict: 'http-error',
      message: `HTTP ${status} from the image host — a tooling error, not a statement about the page's contents.`,
    };
  }
  const format = imageFormat(bytes);
  if (format) return { verdict: 'image', format };
  const looksHtml = /text\/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(Buffer.from(bytes ?? []).slice(0, 200).toString('latin1'));
  return {
    verdict: looksHtml ? 'html' : 'not-image',
    message:
      (looksHtml
        ? 'the image host answered HTML where an image belongs (an error/interstitial page with HTTP 200). '
        : `the response carries no known image magic bytes (content-type ${JSON.stringify(contentType)}). `) +
      KEY_ROTATION_HINT,
  };
}
export { IMAGE_PATH_RE, decodePath, stripTags, MAGIC };
