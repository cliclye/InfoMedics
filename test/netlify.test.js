import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWebHandler, EXTENSION_ORIGIN } from '../lib/api.js';

const PAPER = { id: 'pm1', kind: 'pubmed', pmid: '1', title: 'Vitamin C for colds', journal: 'Cochrane', year: 2013, design: 'Meta-analysis', abstract: 'abs', conclusion: 'No benefit found.', tone: 'no_benefit', url: 'https://pubmed.ncbi.nlm.nih.gov/1/' };
const deps = {
  aiEnabled: () => false,
  searchPubMed: async (s) => ({ articles: [PAPER], total: 3, query: s.pubmedQuery }),
  searchMedlinePlus: async () => [],
  searchNhs: async () => []
};
const SITE = 'https://infomedics.example.app';
const post = (handler, body, headers = {}, ctx = { ip: '1.2.3.4' }) => handler(new Request(`${SITE}/api/check`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body)
}), ctx);
const events = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));

test('netlify.toml publishes public/ and the function claims the API paths', async () => {
  const toml = fs.readFileSync(new URL('../netlify.toml', import.meta.url), 'utf8');
  assert.match(toml, /publish = "public"/);
  assert.match(toml, /directory = "netlify\/functions"/);
  const source = fs.readFileSync(new URL('../netlify/functions/api.mjs', import.meta.url), 'utf8');
  assert.match(source, /path: \['\/api\/check', '\/api\/status'\]/);
  assert.ok(fs.existsSync(new URL('../public/index.html', import.meta.url)));
});

test('status and a streamed check work through the Web handler', async () => {
  const handler = createWebHandler({ deps });
  const status = await handler(new Request(`${SITE}/api/status`), {});
  assert.equal(status.status, 200);
  assert.equal((await status.json()).ok, true);

  const res = await post(handler, { input: 'Vitamin C cures the common cold' });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /ndjson/);
  const evs = await events(res);
  assert.equal(evs[0].type, 'plan');
  assert.equal(evs.at(-1).type, 'result');
  assert.equal(evs.at(-1).result.claims[0].evidence.length, 1);
});

test('rejects bad requests the same way the Node server does', async () => {
  const handler = createWebHandler({ deps, rateLimit: { max: 3, windowMs: 60_000 } });
  assert.equal((await post(handler, '{}', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(handler, '{}', { Origin: SITE })).status, 400);
  assert.equal((await post(handler, 'null')).status, 400);
  assert.equal((await post(handler, 'not json')).status, 400);
  assert.equal((await post(handler, { input: 'x' }, { 'Content-Type': 'text/plain' })).status, 415);
  const get = await handler(new Request(`${SITE}/api/check`), {});
  assert.equal(get.status, 405);
});

test('the extension origin is allowed, other sites are not, and the rate limit applies per address', async () => {
  const handler = createWebHandler({ deps, rateLimit: { max: 2, windowMs: 60_000 } });
  assert.equal((await post(handler, { input: 'Vitamin C cures the common cold' }, { Origin: EXTENSION_ORIGIN })).status, 200);
  assert.equal((await post(handler, { input: 'Vitamin C cures the common cold' }, { Origin: SITE })).status, 200);
  const third = await post(handler, { input: 'Vitamin C cures the common cold' });
  assert.equal(third.status, 429);
  assert.equal((await post(handler, { input: 'Vitamin C cures the common cold' }, {}, { ip: '9.9.9.9' })).status, 200);
});

test('a check that runs past the deadline ends with a clear error instead of hanging', async () => {
  const slow = { ...deps, searchPubMed: (s, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) };
  const handler = createWebHandler({ deps: slow, deadlineMs: 150 });
  const started = Date.now();
  const evs = await events(await post(handler, { input: 'Vitamin C cures the common cold' }));
  assert.ok(Date.now() - started < 2000);
  assert.equal(evs.at(-1).type, 'error');
  assert.equal(evs.at(-1).code, 'timeout');
});
