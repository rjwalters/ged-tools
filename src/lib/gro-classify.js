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
