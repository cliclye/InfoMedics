import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';

const EXT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const read = (f) => fs.readFileSync(path.join(EXT, f), 'utf8');

// ---- a fake server pipeline so the extension talks to the real HTTP server with canned evidence ----
const PAPER = { id: 'pm1', kind: 'pubmed', pmid: '1', title: 'Vitamin C for colds <b>', journal: 'Cochrane', year: 2013, design: 'Meta-analysis', abstract: 'abs', conclusion: 'No benefit found.', tone: 'no_benefit', url: 'https://pubmed.ncbi.nlm.nih.gov/1/' };
const TOPIC = { id: 'mp1', kind: 'medlineplus', title: 'Common Cold', url: 'https://medlineplus.gov/commoncold.html', organization: 'NLM', summary: 'A mild infection.' };
const DEPS = {
  aiEnabled: () => true,
  searchPubMed: async (s) => ({ articles: [PAPER], total: 18, query: s.pubmedQuery }),
  searchMedlinePlus: async () => [TOPIC],
  searchNhs: async () => [],
  planSearches: async (c) => ({ plans: c.map(() => null), usage: null }),
  judgeClaim: async () => ({ verdict: 'unsupported', explanation: 'Reviews found no benefit for preventing colds.', confidence: { level: 'High', note: 'Reviews agree.' }, redFlags: [], evidenceNotes: [{ id: 'pm1', stance: 'contradicts', note: 'No effect.' }], model: 'claude-opus-5-5' })
};

let server;
let serverUrl;
before(async () => {
  server = createApp({ deps: DEPS });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  serverUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

// Load an extension script into an isolated context like a browser would.
function load(files, extra = {}) {
  const context = vm.createContext({
    console, setTimeout, clearTimeout, URL, TextDecoder, AbortController, fetch, JSON,
    ...extra
  });
  context.globalThis = context;
  for (const f of files) vm.runInContext(read(f), context, { filename: f });
  return context;
}

test('manifest pins the extension ID the server allows', async () => {
  const manifest = JSON.parse(read('manifest.json'));
  const { createHash } = await import('node:crypto');
  const der = Buffer.from(manifest.key, 'base64');
  const id = createHash('sha256').update(der).digest('hex').slice(0, 32).replace(/./g, (c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16)));
  const { EXTENSION_ORIGIN } = await import('../server.js');
  assert.equal(EXTENSION_ORIGIN, `chrome-extension://${id}`);
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.host_permissions.includes('http://localhost:3000/*'));
  for (const f of manifest.content_scripts[0].js) assert.ok(fs.existsSync(path.join(EXT, f)), f);
});

test('normalizeServerUrl accepts http(s) origins only', () => {
  const { InfomedicsClient: C } = load(['client.js']);
  assert.equal(C.normalizeServerUrl('http://localhost:3000/some/path'), 'http://localhost:3000');
  assert.equal(C.normalizeServerUrl(' https://infomedics.example.com '), 'https://infomedics.example.com');
  assert.equal(C.normalizeServerUrl('ftp://x.com'), null);
  assert.equal(C.normalizeServerUrl('javascript:alert(1)'), null);
  assert.equal(C.normalizeServerUrl('nope'), null);
});

test('streamCheck streams events from the real server', async () => {
  const { InfomedicsClient: C } = load(['client.js']);
  const events = [];
  await C.streamCheck(serverUrl, 'Vitamin C cures the common cold', (e) => events.push(e));
  assert.equal(events[0].type, 'plan');
  assert.equal(events.at(-1).type, 'result');
  assert.equal(events.at(-1).result.claims[0].verdict, 'unsupported');
});

test('streamCheck gives friendly errors for unreachable servers and HTTP failures', async () => {
  const { InfomedicsClient: C } = load(['client.js']);
  await assert.rejects(C.streamCheck('http://127.0.0.1:9', 'x', () => {}), /Could not reach the Infomedics server at http:\/\/127\.0\.0\.1:9/);
  const tooLong = await new Promise((resolve) => {
    C.streamCheck(serverUrl, 'a'.repeat(100_000), () => {}).catch(resolve);
  });
  assert.match(tooLong.message, /too (large|long)/i);
});

// ---- the background worker, driven through its port the way a page would ----
function startBackground() {
  const storage = {};
  const listeners = { connect: [], message: [], installed: [], menu: [] };
  const chrome = {
    runtime: {
      getURL: (f) => f,
      onInstalled: { addListener: (f) => listeners.installed.push(f) },
      onConnect: { addListener: (f) => listeners.connect.push(f) },
      onMessage: { addListener: (f) => listeners.message.push(f) }
    },
    contextMenus: { removeAll: (cb) => cb && cb(), create: () => {}, onClicked: { addListener: (f) => listeners.menu.push(f) } },
    tabs: { sendMessage: async () => {} },
    scripting: { executeScript: async () => {} },
    storage: { local: {
      get: async (k) => (typeof k === 'string' ? { [k]: storage[k] } : { ...storage }),
      set: async (o) => Object.assign(storage, o),
      remove: async (k) => { delete storage[k]; }
    } }
  };
  const context = load(['render.js'], { chrome, importScripts: () => {} });
  vm.runInContext(read('client.js'), context);
  vm.runInContext(read('background.js'), context, { filename: 'background.js' });
  return { storage, listeners, chrome, context };
}

function connect(bg) {
  const received = [];
  let onMsg;
  let onDisc;
  const port = {
    name: 'check',
    onMessage: { addListener: (f) => { onMsg = f; } },
    onDisconnect: { addListener: (f) => { onDisc = f; } },
    postMessage: (m) => received.push(m),
    disconnect: () => {}
  };
  bg.listeners.connect[0](port);
  return { received, send: (m) => onMsg(m), hangup: () => onDisc && onDisc(), port };
}

const until = async (fn, ms = 4000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

test('background: runs a check against the server, relays progress, and saves history', async () => {
  const bg = startBackground();
  bg.storage.serverUrl = serverUrl;
  const conn = connect(bg);
  conn.send({ type: 'check', text: 'Vitamin C cures the common cold' });
  await until(() => conn.received.some((m) => m.type === 'result'));

  const types = conn.received.map((m) => m.type);
  assert.ok(types.includes('plan') && types.includes('step'));
  const done = conn.received.find((m) => m.type === 'result');
  assert.equal(done.serverUrl, serverUrl);
  assert.equal(done.result.claims[0].verdict, 'unsupported');
  assert.equal(bg.storage.history.length, 1);
  assert.equal(bg.storage.history[0].id, done.result.id);
});

test('background: a history store that cannot be written does not hide the result', async () => {
  const bg = startBackground();
  bg.storage.serverUrl = serverUrl;
  bg.chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  const conn = connect(bg);
  conn.send({ type: 'check', text: 'Vitamin C cures the common cold' });
  await until(() => conn.received.some((m) => m.type === 'result' || m.type === 'error'));
  assert.equal(conn.received.at(-1).type, 'result');
});

test('background: server errors and empty text come back as error messages, nothing saved', async () => {
  const bg = startBackground();
  bg.storage.serverUrl = serverUrl;
  const a = connect(bg);
  a.send({ type: 'check', text: 'http://127.0.0.1:80/' });
  await until(() => a.received.some((m) => m.type === 'error'));
  assert.match(a.received.find((m) => m.type === 'error').message, /not allowed|port/i);

  const b = connect(bg);
  b.send({ type: 'check', text: '   ' });
  await until(() => b.received.some((m) => m.type === 'error'));

  const c = connect(bg);
  bg.storage.serverUrl = 'http://127.0.0.1:9';
  c.send({ type: 'check', text: 'Vitamin C cures colds' });
  await until(() => c.received.some((m) => m.type === 'error'));
  assert.match(c.received.find((m) => m.type === 'error').message, /Could not reach/);
  assert.equal(bg.storage.history, undefined);
});

test('background: disconnecting cancels the in-flight request and sends nothing more', async () => {
  const slowServer = createApp({ deps: { ...DEPS, searchPubMed: (s, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) } });
  await new Promise((r) => slowServer.listen(0, '127.0.0.1', r));
  const bg = startBackground();
  bg.storage.serverUrl = `http://127.0.0.1:${slowServer.address().port}`;
  const conn = connect(bg);
  conn.send({ type: 'check', text: 'Vitamin C cures the common cold' });
  await until(() => conn.received.some((m) => m.type === 'step'));
  conn.hangup();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(conn.received.some((m) => m.type === 'result' || m.type === 'error'), false);
  assert.equal(bg.storage.history, undefined);
  slowServer.closeAllConnections?.(); slowServer.close();
});

test('background serves the panel CSS to content scripts', async () => {
  const bg = startBackground();
  bg.context.fetch = async (f) => ({ text: async () => fs.readFileSync(path.join(EXT, f), 'utf8') });
  const css = await new Promise((resolve) => {
    const keep = bg.listeners.message[0]({ type: 'get-css' }, {}, resolve);
    assert.equal(keep, true);
  });
  assert.equal(css.ok, true);
  assert.match(css.css, /\.fab/);
  assert.match(css.css, /\.im-card/);
});

// ---- rendering ----
test('renderResult shows verdict, evidence, flags, links, and escapes everything', async () => {
  const { InfomedicsClient: C } = load(['client.js']);
  const { InfomedicsRender: R } = load(['render.js']);
  let result;
  await C.streamCheck(serverUrl, 'Vitamin C cures the common cold <img src=x onerror=alert(1)>', (e) => { if (e.type === 'result') result = e.result; });
  const html = R.renderResult(result, { serverUrl });
  assert.match(html, /Unsupported/);
  assert.match(html, /What the evidence says/);
  assert.match(html, /Contradicts the claim/);
  assert.match(html, /Meta-analysis/);
  assert.match(html, /Miracle-cure language/);
  assert.match(html, /High confidence/);
  assert.match(html, /AI verdict by claude-haiku-5-5/);
  assert.match(html, /does not provide medical advice/);
  assert.match(html, /href="https:\/\/medlineplus\.gov\/commoncold\.html"/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /Vitamin C for colds &lt;b&gt;/);
});

test('renderResult handles evidence-only, page, multi-claim, and emergency results', () => {
  const { InfomedicsRender: R } = load(['render.js']);
  const claim = (over) => ({
    claim: 'A claim', emergency: false, rated: false, grounded: true, verdict: 'unclear', explanation: 'We found papers. No AI model is connected.',
    confidence: { level: 'Low', note: 'Not rated.' }, redFlags: [], evidence: [], evidenceSummary: {}, references: { topics: [], search: [{ name: 'PubMed', url: 'https://pubmed.ncbi.nlm.nih.gov/?term=x', note: 'Research' }] }, warnings: ['PubMed could not be reached.'], ...over
  });
  const page = { host: 'blog.example.com', title: 'My <script>blog</script>', domain: { tier: 'unknown' }, signals: [{ id: 'a', label: 'Author', status: 'warn', detail: 'No author.' }] };
  const html = R.renderResult({ mode: 'evidence', model: null, page, claims: [claim(), claim({ emergency: true, verdict: 'doctor' })] }, {});
  assert.match(html, /Not rated/);
  assert.match(html, /Needs a doctor/);
  assert.match(html, /Claim 1 of 2/);
  assert.match(html, /Page checked/);
  assert.match(html, /My &lt;script&gt;blog&lt;\/script&gt;/);
  assert.match(html, /emergency number/);
  assert.match(html, /Evidence-only mode/);
  assert.match(html, /PubMed could not be reached/);
  assert.match(html, /No matching research/);
});

test('links with unsafe schemes are neutralised', () => {
  const { InfomedicsRender: R } = load(['render.js']);
  const evil = { id: 'x', kind: 'pubmed', title: 't', design: 'Study', year: 2020, url: 'javascript:alert(1)', conclusion: 'c' };
  const html = R.renderResult({ mode: 'ai', model: 'm', claims: [{
    claim: 'c', verdict: 'mixed', rated: true, grounded: true, explanation: 'e', confidence: { level: 'Medium', note: 'n' }, redFlags: [], evidence: [evil],
    references: { topics: [{ title: 't', url: 'javascript:alert(2)' }], search: [] }, warnings: []
  }] }, {});
  assert.doesNotMatch(html, /javascript:/);
});
