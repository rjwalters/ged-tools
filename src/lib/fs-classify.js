export const AUTH_URL = /ident\.familysearch\.org|accounts\.google\.com|\/identity\/login|\/auth\/familysearch\/login/i;

export const isAuthUrl = (url) => AUTH_URL.test(String(url));

export const LOGIN_FORM_TEXT = 'continue with google';

export const hasLoginForm = (text) => String(text).toLowerCase().includes(LOGIN_FORM_TEXT);

export const RESTRICTED_TEXT = /image restricted/i;

export const hasRestrictedPanel = (text) => RESTRICTED_TEXT.test(String(text));

export const VIEWER_CHROME_TEXT = /\b\d[\d,]*\s+images?\b/i;

export const hasViewerChrome = (text) => VIEWER_CHROME_TEXT.test(String(text));

export const FORM_SIGHTINGS_REQUIRED = 2;

export const AUTH_PARK_FLOOR_MS = 90_000;

export const NO_DOWNLOAD_FLOOR_MS = 30_000;

export const VIEWER_LOAD_FLOOR_MS = 120_000;

export const RECOVERY_HINT =
  'Recovery without typing a credential: on that login page click "Continue with Google"\n' +
  'and pick the already-signed-in account. Then re-run this exact command; it resumes\n' +
  'from the checkpoint. That click is the OPERATOR\'s — an unattended sweep stops here\n' +
  'and reports the sign-out; it never drives the desktop GUI to stage it.';

export const classify = ({
  hasViewer = false,
  url = '',
  authParkedMs = 0,
  formSightings = 0,
  restrictedSeen = false,
  chromeDwellMs = 0,
} = {}) => {
  if (hasViewer) return 'VIEWER';
  if (!isAuthUrl(url)) {
    if (restrictedSeen) return 'RESTRICTED';
    if (chromeDwellMs >= NO_DOWNLOAD_FLOOR_MS) return 'NO_DOWNLOAD';
    return 'LOADING';
  }
  if (formSightings >= FORM_SIGHTINGS_REQUIRED) return 'SIGNED_OUT';
  if (authParkedMs >= AUTH_PARK_FLOOR_MS) return 'SIGNED_OUT';
  return 'REDIRECTING';
};

export const makeAuthWatch = (now = Date.now) => {
  let authSince = null;
  let sightings = 0;
  let chromeSince = null;
  return {
    sample({ hasViewer = false, url = '', formSeen = false, restrictedSeen = false, chromeSeen = false } = {}) {
      if (hasViewer || !isAuthUrl(url)) {
        authSince = null;
        sightings = 0;
        if (hasViewer || !chromeSeen) chromeSince = null;
        else if (chromeSince === null) chromeSince = now();
        return classify({
          hasViewer,
          url,
          restrictedSeen,
          chromeDwellMs: chromeSince === null ? 0 : now() - chromeSince,
        });
      }
      chromeSince = null;
      if (authSince === null) authSince = now();
      sightings = formSeen ? sightings + 1 : 0;
      return classify({ url, authParkedMs: now() - authSince, formSightings: sightings });
    },
  };
};
