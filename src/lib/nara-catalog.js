// National Archives Catalog (catalog.archives.gov) — pure core.
//
// The public API (`/api/v2`) wants a key. The catalog's own web app reads two
// keyless JSON endpoints on the same host, and those answer plain HTTP:
//
//   GET /proxy/v3/records/search?q=<query>&limit=N&page=P   full-text search
//   GET /proxy/v3/records/search?naId_is=<NAID>             one record by NAID
//
// A record's `digitalObjects[]` carries each image's direct `objectUrl`
// (/medialive/… full-resolution JPEG), its byte size, and — for the
// Fold3-scanned series such as the Confederate compiled service records
// (M251 etc.) — the Fold3 document number in `objectDesignator`. So a file
// unit can be listed and downloaded with no browser, no account and no key.
//
// THE TRAP this module exists to close: when a path is wrong, the host does
// not 404 — CloudFront serves the single-page app's HTML shell with HTTP 200
// (measured 2026-10-20 on /api/v2 without a key). A caller that reads "200"
// as "answered" and finds no hits records a false negative. classifyResponse
// refuses any non-JSON body, whatever the status.

export const ORIGIN = 'https://catalog.archives.gov';
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export const POLITE_DELAY_MS = 500;

export class NaraError extends Error {
  constructor(message, { code = 2 } = {}) {
    super(message);
    this.name = 'NaraError';
    this.code = code;
  }
}

export function buildSearchUrl(query, { limit = 20, page = 1 } = {}) {
  if (!query || !String(query).trim()) throw new NaraError('search needs a query', { code: 1 });
  const p = new URLSearchParams({ q: String(query), limit: String(limit), page: String(page) });
  return `${ORIGIN}/proxy/v3/records/search?${p}`;
}

export function buildRecordUrl(naId) {
  const id = String(naId ?? '').trim();
  if (!/^\d+$/.test(id)) throw new NaraError(`not a NAID: ${JSON.stringify(naId)}`, { code: 1 });
  return `${ORIGIN}/proxy/v3/records/search?naId_is=${id}&allowLegacyOrgNames=true`;
}

/** Parse a response body, refusing anything that is not the catalog's JSON envelope. */
export function classifyResponse(status, contentType, body) {
  const ct = String(contentType ?? '');
  if (!/json/i.test(ct) || /^\s*</.test(body)) {
    throw new NaraError(`HTTP ${status} returned ${ct || 'no content-type'}, not JSON — the catalog served its web-app shell, so the path or parameters are wrong. This is NOT an empty result.`);
  }
  if (status !== 200) throw new NaraError(`HTTP ${status} from the catalog: ${String(body).slice(0, 200)}`);
  let json;
  try {
    json = JSON.parse(body);
  } catch (err) {
    throw new NaraError(`unparseable JSON from the catalog: ${err.message}`);
  }
  const hits = json?.body?.hits;
  if (!hits || !Array.isArray(hits.hits)) throw new NaraError('JSON without body.hits.hits — the response shape has changed');
  return json;
}

const totalOf = (hits) => (typeof hits.total === 'object' ? hits.total?.value : hits.total) ?? hits.hits.length;

function summarize(record) {
  const parent = (record.ancestors ?? []).at(-1);
  return {
    naId: String(record.naId),
    title: record.title ?? '',
    level: record.levelOfDescription ?? '',
    parent: parent?.title ?? '',
    objectCount: (record.digitalObjects ?? []).length,
  };
}

export function parseSearch(json) {
  const hits = json.body.hits;
  return { total: totalOf(hits), results: hits.hits.map((h) => summarize(h._source?.record ?? {})) };
}

export function parseRecord(json, naId) {
  const hit = json.body.hits.hits.find((h) => String(h._source?.record?.naId) === String(naId));
  if (!hit) throw new NaraError(`no record with NAID ${naId}`, { code: 4 });
  const record = hit._source.record;
  return {
    ...summarize(record),
    objects: (record.digitalObjects ?? []).map((o) => ({
      filename: o.objectFilename,
      url: o.objectUrl,
      size: o.objectFileSize ?? null,
      designator: o.objectDesignator ?? '',
      objectId: o.objectId ?? '',
      type: o.objectType ?? '',
    })),
  };
}

/** Local file name for an object: NAID + the catalog's own file name, path-safe. */
export function objectFileName(naId, object) {
  const base = String(object.filename || object.objectId || 'object').replace(/[^A-Za-z0-9._-]/g, '_');
  return `nara-${naId}-${base}`;
}
