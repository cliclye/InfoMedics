import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { isPrivateIp, parseUserUrl, fetchPage, FetchError, makeLookup } from '../lib/http.js';

let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const html = '<html><head><title>Hi</title></head><body><p>Hello world from the test server, with enough words to read.</p></body></html>';
    switch (req.url) {
      case '/gzip':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip' });
        return res.end(zlib.gzipSync(html));
      case '/redirect':
        res.writeHead(302, { Location: '/gzip' });
        return res.end();
      case '/loop':
        res.writeHead(302, { Location: '/loop' });
        return res.end();
      case '/pdf':
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        return res.end('%PDF-1.4');
      case '/big':
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<p>' + 'x'.repeat(3_000_000) + '</p>');
      case '/missing':
        res.writeHead(404); return res.end('no');
      case '/blocked':
        res.writeHead(403); return res.end('no');
      case '/slow':
        return; // never answers
      case '/latin1':
        res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' });
        return res.end(Buffer.from('<p>caf\xe9</p>', 'latin1'));
      default:
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(html);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); });

test('isPrivateIp covers loopback, private, link-local, metadata, and IPv6 forms', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '224.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
  assert.equal(isPrivateIp('not-an-ip'), true);
});

test('parseUserUrl rejects bad schemes, credentials, odd ports and private hosts', () => {
  for (const bad of ['file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)', 'http://user:pw@example.com', 'https://example.com:22', 'http://localhost', 'http://foo.localhost', 'http://127.0.0.1', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://printer.local', 'not a url']) {
    assert.throws(() => parseUserUrl(bad), FetchError, bad);
  }
  assert.doesNotThrow(() => parseUserUrl('https://www.nhs.uk/conditions/common-cold/'));
  assert.doesNotThrow(() => parseUserUrl('http://example.com:80/x'));
});

test('the DNS lookup guard refuses names that resolve to private addresses', async () => {
  const lookup = makeLookup(false);
  await assert.rejects(new Promise((resolve, reject) => lookup('localhost', {}, (err, addr) => (err ? reject(err) : resolve(addr)))), (e) => e instanceof FetchError && e.code === 'blocked');
  await assert.rejects(new Promise((resolve, reject) => lookup('localhost', { all: true }, (err, addr) => (err ? reject(err) : resolve(addr)))), (e) => e.code === 'blocked');
});

test('fetchPage refuses the local test server by default', async () => {
  await assert.rejects(fetchPage(base + '/'), (e) => e instanceof FetchError && e.code === 'blocked');
});

test('fetchPage reads gzip, follows redirects, decodes charsets (private allowed for tests)', async () => {
  const opts = { allowPrivate: true };
  const gz = await fetchPage(base + '/gzip', opts);
  assert.match(gz.html, /Hello world/);
  const redirected = await fetchPage(base + '/redirect', opts);
  assert.ok(redirected.finalUrl.endsWith('/gzip'));
  const latin = await fetchPage(base + '/latin1', opts);
  assert.match(latin.html, /café/);
});

test('fetchPage maps failures to friendly errors', async () => {
  const opts = { allowPrivate: true };
  await assert.rejects(fetchPage(base + '/missing', opts), (e) => e.code === 'not_found');
  await assert.rejects(fetchPage(base + '/blocked', opts), (e) => e.code === 'forbidden');
  await assert.rejects(fetchPage(base + '/pdf', opts), (e) => e.code === 'unsupported');
  await assert.rejects(fetchPage(base + '/loop', { ...opts, maxRedirects: 3 }), (e) => e.code === 'http');
  await assert.rejects(fetchPage(base + '/slow', { ...opts, timeoutMs: 200 }), (e) => e.code === 'timeout');
});

test('fetchPage caps the body size instead of reading everything', async () => {
  const res = await fetchPage(base + '/big', { allowPrivate: true, maxBytes: 100_000 });
  assert.equal(res.truncated, true);
  assert.ok(res.html.length <= 100_000);
});
