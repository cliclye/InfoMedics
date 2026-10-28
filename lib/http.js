// Fetching: a hardened fetch for user-supplied URLs, and a plain one for the fixed APIs we call.
//
// User-supplied URLs are an SSRF risk (someone could point us at localhost or a cloud metadata
// address). We guard by (1) only allowing http(s) on ports 80/443, (2) checking every resolved
// address at connection time with a custom `lookup`, which also covers redirects and DNS
// rebinding, and (3) capping time, redirects and body size.

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';

export const USER_AGENT = 'InfomedicsBot/0.2 (+https://github.com/cliclye/InfoMedics; health-claim checker)';

export class FetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FetchError';
    this.code = code; // blocked | invalid_url | not_found | forbidden | timeout | too_big | unsupported | network | http
  }
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    const dotted = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) return isPrivateIp(dotted[1]);
    const hex = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff');
  }
  return true; // anything we can't parse is not worth the risk
}

export function makeLookup(allowPrivate) {
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    dns.lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err);
      const addresses = Array.isArray(address) ? address.map((a) => a.address) : [address];
      if (!allowPrivate && addresses.some(isPrivateIp)) {
        return callback(new FetchError('blocked', 'That address is not allowed.'));
      }
      callback(null, address, family);
    });
  };
}

export function parseUserUrl(raw, { allowPrivate = false } = {}) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { throw new FetchError('invalid_url', 'That does not look like a valid link.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FetchError('invalid_url', 'Only http and https links can be checked.');
  }
  if (url.username || url.password) throw new FetchError('invalid_url', 'Links with a username or password are not supported.');
  if (!allowPrivate && url.port && url.port !== '80' && url.port !== '443') {
    throw new FetchError('blocked', 'Only standard web ports are allowed.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate) {
    if (net.isIP(host) && isPrivateIp(host)) throw new FetchError('blocked', 'That address is not allowed.');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new FetchError('blocked', 'That address is not allowed.');
    }
  }
  return url;
}

function requestOnce(url, { timeoutMs, maxBytes, allowPrivate, signal }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };

    const req = lib.request(url, {
      method: 'GET',
      lookup: makeLookup(allowPrivate),
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.1',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept-Language': 'en'
      }
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return done(resolve, { redirect: new URL(res.headers.location, url).toString(), status });
      }

      let stream = res;
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      let size = 0;
      let truncated = false;
      stream.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          truncated = true;
          chunks.push(chunk.subarray(0, chunk.length - (size - maxBytes)));
          stream.destroy();
          res.destroy();
          return done(resolve, { status, headers: res.headers, body: Buffer.concat(chunks), truncated });
        }
        chunks.push(chunk);
      });
      stream.on('end', () => done(resolve, { status, headers: res.headers, body: Buffer.concat(chunks), truncated }));
      stream.on('error', (err) => done(reject, err));
      res.on('error', (err) => done(reject, err));
    });

    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new FetchError('timeout', 'The page took too long to respond.'));
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) { req.destroy(); return done(reject, new FetchError('network', 'Cancelled.')); }
      signal.addEventListener('abort', () => { req.destroy(); done(reject, new FetchError('network', 'Cancelled.')); }, { once: true });
    }
    req.on('error', (err) => done(reject, err));
    req.end();
  });
}

function decodeBody(buffer, contentType) {
  let charset = (/charset=([^;\s]+)/i.exec(contentType || '') || [])[1];
  if (!charset) {
    const head = buffer.subarray(0, 4096).toString('latin1');
    charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1];
  }
  try { return new TextDecoder(charset || 'utf-8').decode(buffer); } catch { return new TextDecoder('utf-8').decode(buffer); }
}

/**
 * Fetch a web page the user pointed us at. Returns { finalUrl, html, contentType, truncated }.
 * `allowPrivate` exists for tests only; the server never sets it.
 */
export async function fetchPage(rawUrl, { maxBytes = 1_500_000, timeoutMs = 12_000, maxRedirects = 4, allowPrivate = false, signal } = {}) {
  let url = parseUserUrl(rawUrl, { allowPrivate });
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res;
    try {
      res = await requestOnce(url, { timeoutMs, maxBytes, allowPrivate, signal });
    } catch (err) {
      if (err instanceof FetchError) throw err;
      if (err && err.code === 'ENOTFOUND') throw new FetchError('network', 'We could not find that website.');
      if (err && /blocked|not allowed/i.test(err.message || '')) throw new FetchError('blocked', 'That address is not allowed.');
      throw new FetchError('network', 'We could not connect to that page.');
    }
    if (res.redirect) {
      url = parseUserUrl(res.redirect, { allowPrivate });
      continue;
    }
    const { status, headers, body, truncated } = res;
    if (status === 404 || status === 410) throw new FetchError('not_found', 'That page was not found (HTTP ' + status + ').');
    if (status === 401 || status === 403 || status === 429) {
      throw new FetchError('forbidden', `That site would not let Infomedics read the page (HTTP ${status}). Paste the text instead.`);
    }
    if (status >= 400) throw new FetchError('http', `The site returned an error (HTTP ${status}).`);
    const contentType = String(headers['content-type'] || '');
    if (!/text\/html|application\/xhtml|text\/plain/i.test(contentType)) {
      throw new FetchError('unsupported', 'That link is not a web page we can read (PDFs and files are not supported yet).');
    }
    return { finalUrl: url.toString(), html: decodeBody(body, contentType), contentType, truncated };
  }
  throw new FetchError('http', 'That link redirected too many times.');
}

/**
 * GET from one of the fixed public APIs we use (PubMed, MedlinePlus). Retries once on 429/5xx.
 */
export async function getText(url, { timeoutMs = 12_000, signal, retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (signal) signals.push(signal);
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.any(signals) });
      if (res.status === 429 || res.status >= 500) {
        lastError = new FetchError('http', `Service returned HTTP ${res.status}.`);
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new FetchError('http', `Service returned HTTP ${res.status}.`);
      return await res.text();
    } catch (err) {
      if (signal && signal.aborted) throw new FetchError('network', 'Cancelled.');
      lastError = err instanceof FetchError ? err : new FetchError('network', 'Could not reach a research service.');
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastError;
}
