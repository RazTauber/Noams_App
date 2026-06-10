/**
 * Cloudflare Worker entry point.
 *
 * Routes /api/maps POST requests to the Maps proxy handler (which keeps the
 * Google Maps API key server-side).  All other requests are served from the
 * static Vite build via the ASSETS binding configured in wrangler.json.
 */

import mapsHandler from './api/maps.js';

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/api/maps') {
            return mapsHandler(request, env);
        }

        return env.ASSETS.fetch(request);
    },
};
