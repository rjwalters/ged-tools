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

// `PUT /json/new` opens its tab in the FOREGROUND: on macOS it activates
// Chrome and focuses the new tab's address bar, stealing focus from whatever
// the operator is doing — once per script run. `Target.createTarget` with
// `background: true`, sent over the browser-level socket, creates the same
// tab without activating anything. Tried first; any failure (no
// /json/version, no global WebSocket, an old Chrome, a timeout) falls back to
// /json/new, so the fallback path is exactly the historical behaviour.
// GENEALOGY_CDP_FOREGROUND=1 forces the old path.
async function createBackgroundTarget(origin, url) {
  if (process.env.GENEALOGY_CDP_FOREGROUND === '1' || typeof WebSocket !== 'function') return null;
  let browserWs;
  try {
    const res = await fetch(`${origin}/json/version`, { signal: AbortSignal.timeout(CDP_HTTP_TIMEOUT_MS) });
    if (!res.ok) return null;
    browserWs = (await res.json())?.webSocketDebuggerUrl;
  } catch {
    return null;
  }
  if (!browserWs) return null;

  let targetId;
  try {
    targetId = await new Promise((resolve, reject) => {
      const ws = new WebSocket(browserWs);
      const done = (fn, v) => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* already closed */ }
        fn(v);
      };
      const timer = setTimeout(() => done(reject, new Error('Target.createTarget timed out')), CDP_HTTP_TIMEOUT_MS);
      ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url, background: true } }));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        if (msg.id !== 1) return;
        if (msg.result?.targetId) done(resolve, msg.result.targetId);
        else done(reject, new Error(msg.error?.message ?? 'Target.createTarget returned no targetId'));
      };
      ws.onerror = () => done(reject, new Error('browser websocket error'));
    });
  } catch {
    return null;
  }

  // Same shape /json/new answers with, so callers cannot tell the difference.
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(CDP_HTTP_TIMEOUT_MS) })).json();
      const tab = list.find((t) => t.id === targetId);
      if (tab?.webSocketDebuggerUrl) return tab;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Created but never listed with a socket: take it back, then fall back.
  await closeCdpTarget({ id: targetId }, origin);
  return null;
}

export async function ensureCdpTarget(origin = DEFAULT_CDP_ORIGIN, launchHint = chromeLaunchHint(), url = 'about:blank') {
  const background = await createBackgroundTarget(origin, url);
  if (background) return background;
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
