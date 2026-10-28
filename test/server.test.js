import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, EXTENSION_ORIGIN } from '../server.js';

const FAKE = {
  aiEnabled: () => false,
  searchPubMed: async (s) => ({ articles: [], total: 0, query: s.pubmedQuery }),
  searchMedlinePlus: async () => []
};

let server;
let base;
let host;

async function start(options = {}) {
  const s = createApp({ deps: FAKE, ...options });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return s;
}

before(async () => {
  server = await start();
  host = `127.0.0.1:${server.address().port}`;
  base = `http://${host}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

const post = (body, headers = {}) => fetch(base + '/api/check', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body)
});
const events = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));

test('serves the app with security headers', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await res.text(), /Is that health claim actually true/);
  assert.equal((await fetch(base + '/app.js')).status, 200);
  assert.equal((await fetch(base + '/styles.css')).status, 200);
});

test('refuses path traversal and unknown files', async () => {
  for (const p of ['/%2e%2e/package.json', '/../package.json', '/..%2fpackage.json', '/public/../../package.json']) {
    const res = await fetch(base + p);
    assert.ok([403, 404].includes(res.status), p + ' -> ' + res.status);
    assert.doesNotMatch(await res.text(), /"name": "infomedics"/);
  }
  assert.equal((await fetch(base + '/%E0%A4%A')).status, 400);
  assert.equal((await fetch(base + '/nope.txt')).status, 404);
  const raw = await fetch(base + '/..%2f..%2fetc/passwd');
  assert.ok([403, 404].includes(raw.status));
});

test('/api/status reports mode without leaking secrets', async () => {
  const body = await (await fetch(base + '/api/status')).json();
  assert.equal(body.ok, true);
  assert.equal(body.ai, false);
  assert.equal(JSON.stringify(body).includes('sk-'), false);
});

test('POST /api/check streams plan, steps, and a final result', async () => {
  const res = await post({ input: 'Vitamin C cures the common cold' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /x-ndjson/);
  const evs = await events(res);
  assert.equal(evs[0].type, 'plan');
  assert.equal(evs.at(-1).type, 'result');
  assert.equal(evs.at(-1).result.claims[0].verdict, 'unclear');
  assert.ok(evs.some((e) => e.type === 'step' && e.id === 'evidence' && e.status === 'done'));
});

test('user errors arrive as an error event', async () => {
  const evs = await events(await post({ input: '   ' }));
  assert.equal(evs.at(-1).type, 'error');
  assert.equal(evs.at(-1).code, 'empty');
  const blocked = await events(await post({ input: 'http://169.254.169.254/latest/meta-data' }));
  assert.equal(blocked.at(-1).type, 'error');
  assert.equal(blocked.at(-1).code, 'fetch_blocked');
  const local = await events(await post({ input: 'http://localhost:3000/' }));
  assert.equal(local.at(-1).code, 'fetch_blocked');
});

test('rejects wrong content type, bad JSON, wrong method, cross-origin posts, and oversized bodies', async () => {
  assert.equal((await fetch(base + '/api/check', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hi' })).status, 415);
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post({ nope: 1 })).status, 400);
  assert.equal((await fetch(base + '/api/check')).status, 405);
  assert.equal((await post({ input: 'x' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ input: 'x' }, { Origin: base })).status, 200);
  assert.equal((await post({ input: 'a'.repeat(100_000) })).status, 413);
});

test('the Infomedics extension origin is allowed, other extensions and sites are not', async () => {
  assert.equal((await post({ input: 'Vitamin C cures colds' }, { Origin: EXTENSION_ORIGIN })).status, 200);
  assert.equal((await post({ input: 'x' }, { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })).status, 403);
  assert.equal((await post({ input: 'x' }, { Origin: 'https://evil.example' })).status, 403);
});

test('rate limiting returns 429 after the limit', async () => {
  const s = await start({ rateLimit: { max: 2, windowMs: 60_000 } });
  const url = `http://127.0.0.1:${s.address().port}/api/check`;
  const go = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: '   ' }) });
  assert.equal((await go()).status, 200);
  assert.equal((await go()).status, 200);
  const third = await go();
  assert.equal(third.status, 429);
  assert.ok(third.headers.get('retry-after'));
  s.closeAllConnections?.(); s.close();
});

test('client disconnect aborts the check', async () => {
  let aborted = false;
  const slow = {
    ...FAKE,
    searchPubMed: (s, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    })
  };
  const s = await start({ deps: slow });
  const controller = new AbortController();
  const p = fetch(`http://127.0.0.1:${s.address().port}/api/check`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'Vitamin C cures the common cold' }), signal: controller.signal
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  controller.abort();
  await p;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(aborted, true);
  s.closeAllConnections?.(); s.close();
});
