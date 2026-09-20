import { basename, isAbsolute, resolve } from 'node:path';
export function safeDownloadPath(downloadPath, what = 'downloadPath') {
  if (typeof downloadPath !== 'string' || downloadPath.trim() === '') {
    throw new Error(
      `${what} must be a non-empty string, got ${JSON.stringify(downloadPath)}. ` +
        'Chrome treats an unusable downloadPath as a reason to fall back to the ' +
        'default download folder and stop emitting download events — silently.'
    );
  }

  const abs = resolve(downloadPath);
  const leaf = basename(abs);

  if (leaf.startsWith('.')) {
    throw new Error(
      `${what} resolves to ${abs}, whose leaf directory "${leaf}" is dot-prefixed (hidden).\n` +
        'Chrome accepts Browser.setDownloadBehavior with a hidden download directory, ' +
        'reports the transfer through to downloadProgress { state: "completed" }, and ' +
        'writes NOTHING there. There is no error anywhere in the CDP event stream; the ' +
        'only symptom is a file that never arrives.\n' +
        `Use a non-hidden leaf instead (e.g. "${leaf.replace(/^\.+/, '') || 'incoming'}"). ` +
        'A hidden ANCESTOR is fine — it is only the directory Chrome writes into that ' +
        'must be visible.\n' +
        'See scripts/cdp-download-guard.js for the full set of CDP download facts.'
    );
  }

  return abs;
}
