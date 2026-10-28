// Netlify Function: serves /api/check (streamed) and /api/status. The web app in ./public is static.
// All the logic lives in lib/api.js and lib/pipeline.js, shared with the local Node server.

import { createWebHandler } from '../../lib/api.js';

// Netlify stops long requests abruptly, so end a check with a clear message a little before that.
// Set INFOMEDICS_DEADLINE_MS in the site's environment variables to change it.
const handler = createWebHandler({ deadlineMs: Number(process.env.INFOMEDICS_DEADLINE_MS) || 9000 });

export default (request, context) => handler(request, context);

export const config = { path: ['/api/check', '/api/status'] };
