export const hasResults = (text) => /Results\s*:/.test(text);

export const LOGIN_PATH = /login/i;

export const isLoginUrl = (finalUrl, requestedUrl) => {
  const login = (u) => {
    try {
      return LOGIN_PATH.test(new URL(u).pathname);
    } catch {
      return false;
    }
  };
  return login(finalUrl) && !login(requestedUrl ?? '');
};

export const classify = ({ html: _html = '', text = '', finalUrl = '', url = '' } = {}) => {
  if (isLoginUrl(finalUrl, url)) return 'LOGIN';
  if (hasResults(text)) return 'OK';
  return 'FORM';
};

export const terminal = (verdict) => verdict !== 'OK';

export const aborts = (verdict) => verdict === 'LOGIN';

export const exitCodeFor = (verdicts) => {
  if (verdicts.some(aborts)) return 2;
  if (verdicts.some((v) => v !== 'OK')) return 1;
  return 0;
};

export const relPathFor = (slug, verdict) =>
  verdict === 'OK' ? `${slug}.txt` : `rejected/${slug}.${verdict}.txt`;

// GRO's form refuses a search with no sex ("A valid sex must be selected")
// by re-rendering the form, which reads as a FORM verdict, not as a usage
// error. Check it before a browser is involved.
export const normalizeSex = (sex) => {
  const s = String(sex ?? '').trim().toUpperCase();
  return s === 'M' || s === 'F' ? s : null;
};

// The form has a single-name First Forename box (Forename1) and a Second
// Forename box (Forename2). "Mary Ann" typed into Forename1 matches nothing,
// while Forename1=Mary finds every MARY ANN.
export const splitForename = (forename) => {
  const words = String(forename ?? '').trim().split(/\s+/).filter(Boolean);
  return [words[0] ?? '', words.slice(1).join(' ')];
};

// "93 Record(s) Found - Showing Page 1 of 2"
export const pageInfo = (text) => {
  const m = /(\d+)\s+Record\(s\) Found(?:\s*-\s*Showing Page\s+(\d+)\s+of\s+(\d+))?/.exec(text);
  if (!m) return { count: null, page: 1, pages: 1 };
  return { count: Number(m[1]), page: Number(m[2] ?? 1), pages: Number(m[3] ?? 1) };
};

// District names carry commas and ampersands ("KENSINGTON, PADDINGTON, AND
// FULHAM", "BOSMERE & CLAYDON UNION"), so the district is everything up to
// "Volume". Each result is a tab-separated "NAME <tab> MOTHER'S MAIDEN SURNAME" line
// followed by its "GRO Reference: ..." line.
export const parseResults = (text) => {
  const tail = text.slice(text.lastIndexOf('Results:'));
  const refRe = /GRO Reference:\s*(\d{4})\s+(\w+)\s+Quarter\s+in\s+(.+?)\s+Volume\s+(\S+)\s+Page\s+(\S+)/;
  const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean);
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    const m = refRe.exec(lines[i]);
    if (!m) continue;
    const parts = (lines[i - 1] || '').split('\t').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    records.push({
      name: parts[0] || '(unparsed)',
      mothersMaidenSurname: parts[1] || '(none listed)',
      year: m[1], quarter: m[2], district: m[3].trim(), volume: m[4], page: m[5],
    });
  }
  return records;
};
