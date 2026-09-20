export const DEFAULT_CDP_ORIGIN = process.env.GENEALOGY_CDP_ORIGIN || 'http://127.0.0.1:9222';

const CDP_HTTP_TIMEOUT_MS = 5000;

export function chromeLaunchHint(port = 9222, profileDir = '$HOME/.mh-chrome-debug') {
  return (
    'Start Chrome with:\n' +
    '  /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome \\\n' +
    `    --remote-debugging-port=${port} --user-data-dir="${profileDir}"`
  );
}

const describe = (err) => {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return `timed out after ${CDP_HTTP_TIMEOUT_MS}ms`;
  return err?.cause?.message ? `${err.message} (${err.cause.message})` : (err?.message ?? String(err));
};

export async function ensureCdpTarget(origin = DEFAULT_CDP_ORIGIN, launchHint = chromeLaunchHint(), url = 'about:blank') {
  let res;
  try {
    res = await fetch(`${origin}/json/new?url=${encodeURIComponent(url)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(CDP_HTTP_TIMEOUT_MS),
    });
  } catch (err) {

    throw new Error(`could not reach Chrome's debug endpoint at ${origin}/json/new: ${describe(err)}\n${launchHint}`);
  }
  if (!res.ok) {

    throw new Error(`PUT ${origin}/json/new failed: HTTP ${res.status} ${res.statusText}`);
  }
  let tab;
  try {
    tab = await res.json();
  } catch (err) {
    throw new Error(`${origin}/json/new returned unparseable JSON: ${err.message}`);
  }
  if (!tab?.webSocketDebuggerUrl) {
    if (tab?.id) {
      await closeCdpTarget(tab, origin);
      throw new Error(`/json/new returned no webSocketDebuggerUrl (closed the tab it created): ${JSON.stringify(tab)}`);
    }

    throw new Error(`/json/new returned neither webSocketDebuggerUrl nor id — cannot close what it may have created: ${JSON.stringify(tab)}`);
  }
  return tab;
}

export async function closeCdpTarget(tab, origin = DEFAULT_CDP_ORIGIN) {
  if (!tab?.id) return;
  try {
    const res = await fetch(`${origin}/json/close/${encodeURIComponent(tab.id)}`, {
      signal: AbortSignal.timeout(CDP_HTTP_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`warning: closing preflight tab ${tab.id} answered HTTP ${res.status} ${res.statusText}`);
  } catch (err) {
    console.error(`warning: could not close preflight tab ${tab.id}: ${describe(err)}`);
  }
}
export { CDP_HTTP_TIMEOUT_MS, describe };
