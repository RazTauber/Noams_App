/**
 * Local development API server — replaces `vercel dev` for the Maps proxy.
 *
 * Wraps api/maps.js (Vercel Edge Function format) in a plain Node.js HTTP server
 * so you can run `npm run dev:full` without the Vercel CLI.
 *
 * Reads environment variables from .env automatically.
 * Listens on port 3000 (matches the Vite proxy target in vite.config.js).
 */

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ── Load .env ─────────────────────────────────────────────────────────────────
const envPath = resolve(import.meta.dirname, '.env');
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!(key in process.env)) process.env[key] = val;
    }
}

// ── Import handler ────────────────────────────────────────────────────────────
const { default: mapsHandler } = await import('./api/maps.js');

// ── HTTP server ───────────────────────────────────────────────────────────────
const PORT = 3000;

const server = createServer(async (req, res) => {
    // CORS preflight for Vite dev server cross-origin requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    if (req.url === '/api/maps' && req.method === 'POST') {
        try {
            // Collect request body
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const rawBody = Buffer.concat(chunks).toString('utf8');

            // Build a Web API Request (matches what api/maps.js expects)
            const webRequest = new Request('http://localhost/api/maps', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: rawBody,
            });

            const webResponse = await mapsHandler(webRequest);
            const responseBody = await webResponse.text();

            res.writeHead(webResponse.status, {
                'Content-Type': 'application/json',
            });
            res.end(responseBody);
        } catch (err) {
            console.error('[dev-server] Handler error:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

server.listen(PORT, () => {
    const hasKey = !!(
        process.env.GOOGLE_MAPS_API_KEY &&
        process.env.GOOGLE_MAPS_API_KEY !== 'your_google_maps_api_key_here'
    );
    console.log(`\n  Maps API server  →  http://localhost:${PORT}`);
    console.log(`  Google Maps key: ${hasKey ? '✓ configured' : '✗ missing — will use mock travel times'}\n`);
});
