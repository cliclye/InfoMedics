// Infomedics web server: serves the UI from ./public and runs checks at POST /api/check.
// No framework: Node's http module only.

import './lib/env.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCheck, UserError, MAX_INPUT_CHARS } from './lib/pipeline.js';
import { aiEnabled, modelName } from './lib/judge.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const VERSION = '0.2.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

function sendJson(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req, limit = 24 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new UserError('too_long', 'That request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new UserError('bad_request', 'Invalid request.'); }
}

// The Infomedics browser extension has a fixed ID (its manifest pins a public key), so its origin can be
// allowed without opening the API to arbitrary websites. More origins: INFOMEDICS_ALLOWED_ORIGINS=a,b
export const EXTENSION_ORIGIN = 'chrome-extension://lcegaobephfoomldladmepmjimegeehi';

function defaultAllowedOrigins() {
  const extra = (process.env.INFOMEDICS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return new Set([EXTENSION_ORIGIN, ...extra]);
}

function originAllowed(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl) and same-origin GET-like requests
  if (allowedOrigins.has(origin)) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return sendJson(res, 400, { error: 'Bad request' }); }
  if (rel.includes('\0')) return sendJson(res, 400, { error: 'Bad request' });
  if (rel === '/') rel = '/index.html';
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    const data = await fs.readFile(target);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

/**
 * @param {{deps?: object, rateLimit?: {max: number, windowMs: number}, maxConcurrent?: number, allowedOrigins?: Set<string>}} options
 */
export function createApp({ deps, rateLimit = { max: 20, windowMs: 60_000 }, maxConcurrent = 6, allowedOrigins = defaultAllowedOrigins() } = {}) {
  const hits = new Map(); // ip -> timestamps
  let running = 0;

  function limited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < rateLimit.windowMs);
    if (recent.length >= rateLimit.max) { hits.set(ip, recent); return true; }
    recent.push(now);
    hits.set(ip, recent);
    return false;
  }

  async function handleCheck(req, res) {
    if (!originAllowed(req, allowedOrigins)) return sendJson(res, 403, { error: 'Cross-origin requests are not allowed.' });
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'Send JSON.' });
    if (limited(req.socket.remoteAddress || 'unknown')) {
      res.setHeader('Retry-After', '30');
      return sendJson(res, 429, { error: 'Too many checks in a short time. Please wait a moment.' });
    }
    if (running >= maxConcurrent) return sendJson(res, 503, { error: 'Busy right now. Please try again in a few seconds.' });

    let body;
    try { body = await readJsonBody(req); } catch (err) {
      return sendJson(res, err instanceof UserError && err.code === 'too_long' ? 413 : 400, { error: err.message });
    }
    if (typeof body.input !== 'string') return sendJson(res, 400, { error: 'Missing "input".' });
    if (body.input.length > MAX_INPUT_CHARS * 2) return sendJson(res, 413, { error: 'That is too long.' });

    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no'
    });
    const send = (event) => { if (!res.writableEnded) res.write(JSON.stringify(event) + '\n'); };

    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });

    running++;
    try {
      const result = await runCheck(body.input, { emit: send, signal: abort.signal, deps });
      send({ type: 'result', result });
    } catch (err) {
      if (err instanceof UserError) {
        if (err.code !== 'cancelled') send({ type: 'error', code: err.code, message: err.message });
      } else {
        console.error('Unexpected error during check:', err);
        send({ type: 'error', code: 'internal', message: 'Something went wrong while checking. Please try again.' });
      }
    } finally {
      running--;
      res.end();
    }
  }

  return http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/api/status' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, version: VERSION, ai: aiEnabled(), model: aiEnabled() ? modelName() : null, maxChars: MAX_INPUT_CHARS });
      }
      if (pathname === '/api/check') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST.' });
        return await handleCheck(req, res);
      }
      if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res, pathname);
      return sendJson(res, 405, { error: 'Method not allowed.' });
    } catch (err) {
      console.error('Request error:', err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Server error.' });
      else res.end();
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  createApp().listen(port, host, () => {
    console.log(`Infomedics running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(aiEnabled()
      ? `AI verdicts: ON (${modelName()})`
      : 'AI verdicts: OFF (evidence-only mode). Set ANTHROPIC_API_KEY in .env to enable.');
  });
}
