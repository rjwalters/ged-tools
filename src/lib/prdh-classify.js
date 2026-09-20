export const isSubscribersWall = (text) => /access\s+limited\s+to\s+subscribers/i.test(text);

export const SUBSCRIBERS_PATH = /(^|\/)proposition-abonnement(\/|$)/i;

export const isSubscribersUrl = (finalUrl, requestedUrl) => {
  const pitch = (u) => {
    try {
      return SUBSCRIBERS_PATH.test(new URL(u).pathname);
    } catch {
      return false;
    }
  };
  return pitch(finalUrl) && !pitch(requestedUrl ?? '');
};

export const LOGIN_PATH = /^\/Login$/i;

export const isLoginRedirect = (finalUrl, requestedUrl) => {
  const login = (u) => {
    try {
      return LOGIN_PATH.test(new URL(u).pathname);
    } catch {
      return false;
    }
  };
  return login(finalUrl) && !login(requestedUrl ?? '');
};

export const rendered = (text) => /\d+\s+to\s+\d+\s+on\s+\d+/.test(text) || /No\s+data/i.test(text);

export const classify = ({ html: _html = '', text = '', finalUrl = '', url = '' } = {}) => {
  if (isSubscribersWall(text)) return 'LOGIN';
  if (isSubscribersUrl(finalUrl, url)) return 'LOGIN';
  if (isLoginRedirect(finalUrl, url)) return 'LOGIN';
  return 'OK';
};

export const terminal = (verdict) => verdict === 'LOGIN';

export const aborts = (verdict) => verdict === 'LOGIN';

export const TALLY_ORDER = ['OK', 'LOGIN', 'FAILED'];

export const exitCodeFor = (verdicts) => {
  if (verdicts.some(aborts)) return 2;
  if (verdicts.some((v) => v !== 'OK')) return 1;
  return 0;
};

export const summarize = (verdicts, skipped = 0) => {
  const counts = Object.fromEntries(TALLY_ORDER.map((v) => [v, 0]));
  for (const v of verdicts) counts[v] = (counts[v] ?? 0) + 1;
  const parts = TALLY_ORDER.filter((v) => v !== 'FAILED' || counts.FAILED > 0).map((v) => `${counts[v]} ${v}`);
  const tail = skipped ? ` — aborted with ${skipped} page${skipped === 1 ? '' : 's'} unfetched` : '';
  return `${parts.join(', ')}${tail}`;
};

export const relPathFor = (slug, verdict) =>
  verdict === 'OK' ? `${slug}.html` : `rejected/${slug}.${verdict}.html`;
