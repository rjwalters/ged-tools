import test from 'node:test';
import assert from 'node:assert/strict';
import {
  challengeKind,
  parseArgs,
  truncate,
  formatOutput,
  saveResult,
  loadPastChallenge,
  extractExpr,
  fetchBytesExpr,
  DEFAULT_SETTLE_MS,
  DEFAULT_TIMEOUT_MS,
  PageTextError,
} from '../src/scripts/page-text.js';

test('Cloudflare interstitials are recognised by title or body text', () => {
  assert.equal(challengeKind({ title: 'Just a moment...', text: '' }), 'challenge');
  assert.equal(challengeKind({ title: 'example.invalid', text: 'Checking your browser before accessing example.invalid.' }), 'challenge');
  assert.equal(challengeKind({ title: '', text: 'Verifying you are human. This may take a few seconds.' }), 'challenge');
  assert.equal(challengeKind({ title: '', text: 'example.invalid needs to review the security of your connection before proceeding.' }), 'challenge');
  assert.equal(challengeKind({ title: 'Attention Required! | Cloudflare', text: 'Sorry, you have been blocked' }), 'blocked');
  assert.equal(challengeKind({ title: 'Parish register, 1850', text: 'Just a moment of silence was observed.' }), null, 'body text alone must match a challenge phrase, not any "just a moment"');
  assert.equal(challengeKind({}), null);
});

test('argument parsing: text mode defaults and options', () => {
  const o = parseArgs(['https://example.invalid/a?b=1', '--links', '--selector', 'main .entry', '--max-chars', '500', '--wait', '0']);
  assert.deepEqual(o, {
    mode: 'text', url: 'https://example.invalid/a?b=1', out: null, selector: 'main .entry', links: true,
    maxChars: 500, settleMs: 0, timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  assert.equal(parseArgs(['https://example.invalid/']).settleMs, DEFAULT_SETTLE_MS);
});

test('argument parsing: save mode and refusals', () => {
  const s = parseArgs(['save', 'https://example.invalid/i.jpg', 'out.jpg', '--timeout', '90000']);
  assert.equal(s.mode, 'save');
  assert.equal(s.out, 'out.jpg');
  assert.equal(s.timeoutMs, 90000);
  const bad = [
    [],
    ['not a url'],
    ['file:///etc/passwd'],
    ['save', 'https://example.invalid/i.jpg'],
    ['save', 'https://example.invalid/i.jpg', 'o.jpg', '--links'],
    ['https://example.invalid/', '--wait'],
    ['https://example.invalid/', '--wait', '-5'],
    ['https://example.invalid/', '--bogus'],
  ];
  for (const argv of bad) assert.throws(() => parseArgs(argv), (e) => e instanceof PageTextError && e.code === 1, argv.join(' '));
});

test('output: truncation and the link list', () => {
  assert.deepEqual(truncate('abcdef', 3), { text: 'abc', truncated: true });
  assert.deepEqual(truncate('abc', 0), { text: 'abc', truncated: false });
  const page = { text: 'Body text', links: [{ href: 'https://example.invalid/1', text: 'One' }, { href: 'https://example.invalid/2', text: '' }] };
  assert.equal(formatOutput(page).out, 'Body text\n--LINKS--\nhttps://example.invalid/1\tOne\nhttps://example.invalid/2\t');
  assert.equal(formatOutput({ text: 'Body text', links: null }, { maxChars: 4 }).out, 'Body');
});

test('in-page expressions are well-formed JavaScript', () => {
  // Compiled, not run: a syntax slip in a template string would otherwise surface only live.
  for (const src of [extractExpr(), extractExpr({ selector: 'a[href*="x"]', links: true }), fetchBytesExpr('https://example.invalid/i.jpg')]) {
    assert.doesNotThrow(() => new Function(`return ${src}`), src.slice(0, 80));
  }
  assert.match(extractExpr({ selector: 'div"; alert(1); "' }), /const sel = "div\\"; alert\(1\); \\"";/, 'the selector is embedded as a JSON string literal');
});

test('save: bytes are written only for a non-HTML success', () => {
  const ok = saveResult({ status: 200, type: 'image/jpeg', len: 3, b64: Buffer.from([0xff, 0xd8, 0xff]).toString('base64') }, 'u');
  assert.deepEqual([...ok.bytes], [0xff, 0xd8, 0xff]);
  assert.match(saveResult({ status: 200, type: 'text/html; charset=utf-8', body: '<title>Just a moment...</title>' }, 'u').error.message, /answered HTML/);
  assert.match(saveResult({ status: 403, type: 'application/json', body: 'denied' }, 'u').error.message, /HTTP 403/);
  assert.match(saveResult({ status: 200, type: 'image/jpeg', tooLarge: 99 }, 'u').error.message, /over the/);
});

function fakeBrowser(states) {
  const sent = [];
  let i = 0;
  const evals = [];
  return {
    sent,
    evals,
    cdp: { send: async (method, params) => { sent.push([method, params]); return {}; } },
    evalFn: async (_cdp, expr) => {
      evals.push(expr);
      if (expr === 'window.__gedToolsStale = true') return true;
      const s = states[Math.min(i++, states.length - 1)];
      if (s instanceof Error) throw s;
      return s;
    },
  };
}

function clock() {
  let t = 0;
  return { now: () => t, nap: async (ms) => { t += ms; } };
}

test('loadPastChallenge: waits out the stale page and the challenge, then returns', async () => {
  const logs = [];
  const b = fakeBrowser([
    { ready: 'complete', stale: true, url: 'about:blank', title: '', text: '' },
    new Error('Execution context was destroyed'),
    { ready: 'complete', stale: false, url: 'https://example.invalid/p', title: 'Just a moment...', text: '' },
    { ready: 'loading', stale: false, url: 'https://example.invalid/p', title: '', text: '' },
    { ready: 'complete', stale: false, url: 'https://example.invalid/p', title: 'Register', text: 'Page text' },
  ]);
  const c = clock();
  const r = await loadPastChallenge(b.cdp, 'https://example.invalid/p', { timeoutMs: 60_000, log: (m) => logs.push(m), evalFn: b.evalFn, ...c });
  assert.equal(r.state.title, 'Register');
  assert.equal(r.waited, true);
  assert.deepEqual(b.sent, [['Page.navigate', { url: 'https://example.invalid/p' }]]);
  assert.equal(b.evals[0], 'window.__gedToolsStale = true', 'the old document is marked before navigating');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /nothing is solved or bypassed/);
});

test('loadPastChallenge: a check that never clears fails with code 2 and says a person must act', async () => {
  const b = fakeBrowser([{ ready: 'complete', stale: false, url: 'https://example.invalid/', title: 'Just a moment...', text: '' }]);
  await assert.rejects(
    loadPastChallenge(b.cdp, 'https://example.invalid/', { timeoutMs: 5000, log: () => {}, evalFn: b.evalFn, ...clock() }),
    (e) => e instanceof PageTextError && e.code === 2 && /did not clear within 5s/.test(e.message) && /a person must complete it/.test(e.message),
  );
  const slow = fakeBrowser([{ ready: 'loading', stale: false, url: 'https://example.invalid/', title: '', text: '' }]);
  await assert.rejects(
    loadPastChallenge(slow.cdp, 'https://example.invalid/', { timeoutMs: 3000, log: () => {}, evalFn: slow.evalFn, ...clock() }),
    /did not finish loading/,
  );
});
