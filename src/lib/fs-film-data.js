export function padDgs(dgs) {
  const d = String(dgs).replace(/\D/g, '');
  return d.padStart(9, '0');
}

export function bareCatalogId(cat) {
  const m = String(cat ?? '').match(/(?:koha:)?(\d{2,9})\s*$/i);
  return m ? m[1] : '';
}

export function filmDataExpr(dgs, { cat = null, withImages = true } = {}) {
  const catId = bareCatalogId(cat);
  const imagesField = withImages ? 'images: j.images || [],' : '';
  return `(async () => {
    const body = { type: 'film-data', loggedIn: true, sessionId: null,
      args: { dgsNum: ${JSON.stringify(padDgs(dgs))}, locale: 'en',
        state: { cat: ${JSON.stringify(catId)}, imageOrFilmUrl: '', catalogContext: ${JSON.stringify(catId)}, viewMode: 'i', selectedImageIndex: -1 } } };
    const r = await fetch('/search/filmdatainfo/film-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status !== 200) return JSON.stringify({ error: 'HTTP ' + r.status });
    const j = await r.json();
    return JSON.stringify({ ${imagesField} catalogs: j.catalogs || [] });
  })()`;
}

export function selectCatalog(json, catalogId = null) {
  const cats = Array.isArray(json?.catalogs) ? json.catalogs : [];
  const requested = bareCatalogId(catalogId) || null;
  const idOf = (c) => bareCatalogId(c?.data?.titleno) || bareCatalogId(c?.path) || null;

  let index = cats.length ? 0 : -1;
  let matched = false;
  if (requested) {
    const found = cats.findIndex((c) => idOf(c) === requested);
    if (found !== -1) {
      index = found;
      matched = true;
    }
  }
  const catalog = index === -1 ? null : cats[index];
  const notes = catalog?.data?.film_note;
  return {
    catalog,
    index,
    count: cats.length,
    requested,
    matched,
    titleno: idOf(catalog),
    title: catalog?.data?.title ?? catalog?.data?.display_title ?? null,
    films: Array.isArray(notes) ? notes.map(filmNote) : [],
  };
}

function filmNote(n) {
  return {
    seq: n.seq,
    film: n.filmno,
    dgs: n.digital_film_no,
    text: n.text ?? '',
    items: n.items ?? '',
    location: n.location ?? n.copy_location ?? n.copy_location_ex?.copy_location_name ?? null,
  };
}

export function filmsInCatalog(json, catalogId = null) {
  return selectCatalog(json, catalogId).films;
}
export { filmNote };
