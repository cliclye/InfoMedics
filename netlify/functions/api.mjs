// Netlify Function: serves /api/check (streamed) and /api/status. The web app in ./public is static.
// All the logic lives in lib/api.js and lib/pipeline.js, shared with the local Node server.

import { createWebHandler } from '../../lib/api.js';

// Streaming functions may run for 60 seconds. A check normally takes 5 to 8; one that hangs on a slow
// source is ended with a clear message long before the platform would cut it off.
// Set INFOMEDICS_DEADLINE_MS in the site's environment variables to change it.
const handler = createWebHandler({ deadlineMs: Number(process.env.INFOMEDICS_DEADLINE_MS) || 25000 });

export default (request, context) => handler(request, context);

export const config = { path: ['/api/check', '/api/status'] };
