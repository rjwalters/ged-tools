// Apply caller-supplied additions and overrides to a compact GEDCOM model.
// Mutates the model and wires the added family relationships in both directions.

export function blankPerson(p) {
  return {
    id: p.id,
    name: p.name || [p.given, p.surname].filter(Boolean).join(' ').trim() || 'Unknown',
    given: p.given || '',
    surname: p.surname || '',
    sex: p.sex || null,
    deceased: !!p.deceased,
    provisional: !!p.provisional,
    birth: p.birth || null,
    death: p.death || null,
    address: p.address || null,
    emails: p.emails || [],
    phones: p.phones || [],
    note: p.note || null,
    famc: [],
    fams: [],
  };
}

export function applyPatches(model, patches) {
  if (!patches) return model;

  for (const p of patches.additions?.people || []) {
    if (!p.id) continue;
    model.people[p.id] = { ...blankPerson(p), ...(model.people[p.id] || {}), ...blankPerson(p) };
    model.people[p.id].famc = [];
    model.people[p.id].fams = [];
  }

  for (const f of patches.additions?.families || []) {
    if (!f.id) continue;
    const fam = { id: f.id, husband: f.husband || null, wife: f.wife || null, children: f.children || [], marriage: f.marriage || null };
    model.families[f.id] = fam;
    for (const spouse of [fam.husband, fam.wife]) {
      if (spouse && model.people[spouse] && !model.people[spouse].fams.includes(f.id)) {
        model.people[spouse].fams.push(f.id);
      }
    }
    for (const c of fam.children) {
      if (model.people[c] && !model.people[c].famc.includes(f.id)) model.people[c].famc.push(f.id);
    }
  }

  for (const [id, patch] of Object.entries(patches.overrides || {})) {
    if (!model.people[id]) continue;
    Object.assign(model.people[id], patch);
  }

  return model;
}
