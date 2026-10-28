// Infomedics web server: serves the UI from ./public and runs checks at POST /api/check.
// No framework: Node's http module only.

import './lib/env.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCheck, UserError, MAX_INPUT_CHARS } from './lib/pipeline.js';
import { aiEnabled, modelName } from './lib/judge.js';
import { SECURITY_HEADERS, EXTENSION_ORIGIN, allowedOriginsFromEnv, originAllowed as originOk, createLimiter, statusBody } from './lib/api.js';

export { EXTENSION_ORIGIN };

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

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

function originAllowed(req, allowedOrigins) {
  return originOk(req.headers.origin, req.headers.host, allowedOrigins);
}

// DNS rebinding: a hostile site can point its own domain at 127.0.0.1, which makes its requests look
// same-origin. A server that listens only on loopback therefore also insists on a loopback Host header.
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/i;
function isLoopbackBind(host) {
  return !host || host === 'localhost' || host === '::1' || /^127\./.test(host);
}
function hostAllowed(req, allowedHosts) {
  const host = String(req.headers.host || '');
  if (allowedHosts === null) return true;
  return LOOPBACK_HOST.test(host) || allowedHosts.has(host.toLowerCase());
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
export function createApp({
  deps, rateLimit = { max: 20, windowMs: 60_000 }, maxConcurrent = 6, allowedOrigins = allowedOriginsFromEnv(),
  // null turns the Host check off (for servers deliberately exposed on a network).
  allowedHosts = isLoopbackBind(process.env.HOST) ? new Set() : null
} = {}) {
  const limited = createLimiter(rateLimit);
  let running = 0;

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
    if (!body || typeof body.input !== 'string') return sendJson(res, 400, { error: 'Missing "input".' });
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
      if (!hostAllowed(req, allowedHosts)) return sendJson(res, 403, { error: 'Unknown host. Open Infomedics at http://localhost.' });
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname === '/api/status' && req.method === 'GET') {
        return sendJson(res, 200, statusBody());
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
