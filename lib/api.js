// HTTP API pieces shared by the Node server (server.js) and the Netlify function
// (netlify/functions/api.mjs): headers, origin rules, rate limiting, and a Web-standard
// Request -> Response handler for /api/status and the streamed /api/check.

import { runCheck, UserError, MAX_INPUT_CHARS } from './pipeline.js';
import { aiEnabled, hasApiKey, modelName } from './judge.js';

export const VERSION = '0.4.0';

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

// The Infomedics browser extension has a fixed ID (its manifest pins a public key), so its origin can be
// allowed without opening the API to arbitrary websites. More origins: INFOMEDICS_ALLOWED_ORIGINS=a,b
export const EXTENSION_ORIGIN = 'chrome-extension://lcegaobephfoomldladmepmjimegeehi';

export function allowedOriginsFromEnv() {
  const extra = (process.env.INFOMEDICS_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return new Set([EXTENSION_ORIGIN, ...extra]);
}

/** Same-origin requests, the extension, and non-browser clients (no Origin header) are allowed. */
export function originAllowed(origin, host, allowedOrigins) {
  if (!origin) return true;
  if (allowedOrigins.has(origin)) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

/** Sliding-window limiter. Returns limited(key) -> true when the key is over its limit. */
export function createLimiter({ max, windowMs }) {
  const hits = new Map();
  return function limited(key) {
    const now = Date.now();
    if (hits.size > 5000) { // forget addresses that have gone quiet
      for (const [k, times] of hits) if (!times.length || now - times[times.length - 1] >= windowMs) hits.delete(k);
    }
    const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (recent.length >= max) { hits.set(key, recent); return true; }
    recent.push(now);
    hits.set(key, recent);
    return false;
  };
}

export function statusBody() {
  const ai = aiEnabled();
  return { ok: true, version: VERSION, ai, paused: hasApiKey() && !ai, model: ai ? modelName() : null, maxChars: MAX_INPUT_CHARS };
}

const BODY_LIMIT = 24 * 1024;

/**
 * Handler for platforms that speak Web Request/Response (Netlify Functions, Deno, Workers...).
 * @param {{deps?: object, rateLimit?: {max: number, windowMs: number}, allowedOrigins?: Set<string>, deadlineMs?: number}} options
 *   deadlineMs: stop a check and report a friendly error after this long (0 = no limit). Serverless
 *   platforms kill long requests abruptly, so this lets the user see a real message instead.
 */
export function createWebHandler({ deps, rateLimit = { max: 20, windowMs: 60_000 }, allowedOrigins = allowedOriginsFromEnv(), deadlineMs = 0 } = {}) {
  const limited = createLimiter(rateLimit);
  const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra }
  });

  return async function handle(req, context = {}) {
    const url = new URL(req.url);

    if (url.pathname === '/api/status') {
      return req.method === 'GET' ? json(200, statusBody()) : json(405, { error: 'Use GET.' }, { Allow: 'GET' });
    }
    if (url.pathname !== '/api/check') return json(404, { error: 'Not found' });
    if (req.method !== 'POST') return json(405, { error: 'Use POST.' }, { Allow: 'POST' });

    const host = req.headers.get('host') || url.host;
    if (!originAllowed(req.headers.get('origin'), host, allowedOrigins) && !originAllowed(req.headers.get('origin'), url.host, allowedOrigins)) {
      return json(403, { error: 'Cross-origin requests are not allowed.' });
    }
    if (!/^application\/json/i.test(req.headers.get('content-type') || '')) return json(415, { error: 'Send JSON.' });

    const ip = context.ip || req.headers.get('x-nf-client-connection-ip') || (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
    if (limited(ip)) return json(429, { error: 'Too many checks in a short time. Please wait a moment.' }, { 'Retry-After': '30' });

    if (Number(req.headers.get('content-length')) > BODY_LIMIT) return json(413, { error: 'That request is too large.' });
    let body;
    try {
      const text = await req.text();
      if (text.length > BODY_LIMIT) return json(413, { error: 'That request is too large.' });
      body = JSON.parse(text);
    } catch { return json(400, { error: 'Invalid request.' }); }
    if (!body || typeof body.input !== 'string') return json(400, { error: 'Missing "input".' });
    if (body.input.length > MAX_INPUT_CHARS * 2) return json(413, { error: 'That is too long.' });

    const abort = new AbortController();
    const encoder = new TextEncoder();
    let closed = false;
    let timer;
    let controllerRef;
    const send = (event) => {
      if (closed) return;
      try { controllerRef.enqueue(encoder.encode(JSON.stringify(event) + '\n')); } catch { closed = true; }
    };
    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try { controllerRef.close(); } catch { /* already closed */ }
    };

    const stream = new ReadableStream({
      async start(controller) {
        controllerRef = controller;
        if (deadlineMs > 0) {
          timer = setTimeout(() => {
            send({ type: 'error', code: 'timeout', message: 'This check took too long and was stopped. Try a shorter text, or a different link.' });
            abort.abort();
            finish();
          }, deadlineMs);
        }
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
          finish();
        }
      },
      cancel() { closed = true; clearTimeout(timer); abort.abort(); }
    });

    return new Response(stream, {
      status: 200,
      headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' }
    });
  };
}
