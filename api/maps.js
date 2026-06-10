/**
 * Server-side proxy for Google Maps API.
 *
 * Keeps the API key out of the browser bundle.
 * Adds a server-side in-memory cache shared across all users and sessions
 * (Vercel Fluid Compute keeps warm instances alive, so this cache persists
 * across many requests for the same warm instance).
 *
 * Cache key normalizes arrival_time to the hour so that "8:03 AM" and
 * "8:47 AM" both reuse the same cached result, matching the client-side
 * cache bucket strategy in cacheService.js.
 */

const CACHE_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours — covers a full shooting day

const serverCache = new Map(); // { key → { value, expiresAt } }
let callsThisInstance = 0;

function normalizeToDayHour(unixSeconds) {
    const d = new Date(unixSeconds * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${d.getHours()}`;
}

function buildCacheKey(type, params) {
    const hour = params.arrival_time
        ? normalizeToDayHour(parseInt(params.arrival_time, 10))
        : 'no-time';

    if (type === 'distancematrix') {
        return `dm|${params.origins}|${params.destinations}|${hour}`;
    }
    if (type === 'directions') {
        const waypoints = params.waypoints || '';
        return `dir|${params.origin}|${params.destination}|${waypoints}|${hour}`;
    }
    return null;
}

function getFromCache(key) {
    const entry = serverCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
        serverCache.delete(key);
        return null;
    }
    return entry.value;
}

function setInCache(key, value) {
    serverCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });

    // Evict entries older than TTL to prevent unbounded growth
    if (serverCache.size > 2000) {
        const now = Date.now();
        for (const [k, entry] of serverCache) {
            if (now > entry.expiresAt) serverCache.delete(k);
        }
    }
}

const MAPS_URLS = {
    distancematrix: 'https://maps.googleapis.com/maps/api/distancematrix/json',
    directions: 'https://maps.googleapis.com/maps/api/directions/json',
};

export default async function handler(req) {
    if (req.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
    if (!API_KEY) {
        return Response.json(
            { error: 'GOOGLE_MAPS_API_KEY not configured on server' },
            { status: 503 }
        );
    }

    let body;
    try {
        body = await req.json();
    } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { type, ...params } = body;

    if (!MAPS_URLS[type]) {
        return Response.json(
            { error: `Unknown type "${type}". Use "distancematrix" or "directions".` },
            { status: 400 }
        );
    }

    // Check server-side cache first
    const cacheKey = buildCacheKey(type, params);
    if (cacheKey) {
        const hit = getFromCache(cacheKey);
        if (hit) {
            return Response.json({ ...hit, _serverCacheHit: true });
        }
    }

    // Build query — server adds the key, client never sends it
    const query = new URLSearchParams({
        ...params,
        key: API_KEY,
        language: 'he',
        region: 'il',
    });

    callsThisInstance++;

    let googleResponse;
    try {
        googleResponse = await fetch(`${MAPS_URLS[type]}?${query}`);
    } catch (networkErr) {
        console.error('[maps proxy] Network error reaching Google:', networkErr.message);
        return Response.json({ error: 'Network error reaching Google Maps' }, { status: 502 });
    }

    if (!googleResponse.ok) {
        console.error('[maps proxy] Google returned HTTP', googleResponse.status);
        return Response.json(
            { error: `Google Maps HTTP error: ${googleResponse.status}` },
            { status: 502 }
        );
    }

    let data;
    try {
        data = await googleResponse.json();
    } catch {
        return Response.json({ error: 'Unparseable response from Google Maps' }, { status: 502 });
    }

    // Cache successful responses
    if (cacheKey && data.status === 'OK') {
        setInCache(cacheKey, data);
    }

    return Response.json(data);
}
