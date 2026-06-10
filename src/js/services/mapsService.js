/**
 * Google Maps Distance Matrix service wrapper.
 *
 * All requests are routed through /api/maps (a server-side proxy).
 * The API key never appears in the browser bundle — it lives in the
 * server environment as GOOGLE_MAPS_API_KEY.
 *
 * Client-side caching (cacheService.js) still applies and avoids
 * proxy round-trips entirely for results already seen in this session
 * or stored in localStorage from earlier today.
 */

import {
    getCachedTravelTime, cacheTravelTime,
    getCachedRouteDuration, cacheRouteDuration,
} from './cacheService.js';
import { loadPairMatrix, savePairMatrix } from './groupMemoryService.js';

let apiCallCounter = 0;
let proxyAvailable = null; // null = unchecked, true/false after first attempt

export function getApiCallCount() {
    return apiCallCounter;
}

export function resetApiCallCount() {
    apiCallCounter = 0;
}

/**
 * Returns true if the server-side proxy responded successfully.
 * Falls back gracefully to mock mode when running with plain `vite dev`
 * (no proxy) or when GOOGLE_MAPS_API_KEY is not set on the server.
 */
export function isApiConfigured() {
    // After the first real call we know; before that assume configured
    // so the app attempts the proxy and discovers availability naturally.
    return proxyAvailable !== false;
}

/**
 * POST to the /api/maps proxy with the given type and params.
 * Returns the parsed JSON from Google Maps, or throws on error.
 * Sets proxyAvailable based on whether the call succeeded.
 */
async function callProxy(type, params) {
    const response = await fetch('/api/maps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, ...params }),
    });

    if (!response.ok) {
        if (response.status === 503) {
            // Proxy exists but API key not configured server-side
            proxyAvailable = false;
            throw new Error('GOOGLE_MAPS_API_KEY not configured on server');
        }
        throw new Error(`Proxy HTTP error: ${response.status}`);
    }

    const data = await response.json();

    if (data.error) {
        throw new Error(`Proxy error: ${data.error}`);
    }

    proxyAvailable = true;
    return data;
}

/**
 * Get travel time in minutes between an origin address and the destination.
 * Uses Distance Matrix API with traffic prediction.
 *
 * @param {string} origin - Pickup address
 * @param {string} destination - Set address
 * @param {Date} arrivalTime - Desired arrival time (for traffic prediction)
 * @returns {Promise<{duration: number, status: string}>} duration in minutes
 */
export async function getTravelTime(origin, destination, arrivalTime) {
    if (!isApiConfigured()) {
        return getMockTravelTime(origin, destination);
    }

    const arrivalTimestamp = Math.floor(arrivalTime.getTime() / 1000);

    try {
        apiCallCounter++;
        const data = await callProxy('distancematrix', {
            origins: origin,
            destinations: destination,
            arrival_time: arrivalTimestamp.toString(),
        });

        if (data.status !== 'OK') {
            throw new Error(`Google API error: ${data.status} - ${data.error_message || ''}`);
        }

        const element = data.rows[0]?.elements[0];
        if (!element || element.status !== 'OK') {
            return { duration: null, status: 'ADDRESS_ERROR' };
        }

        return {
            duration: element.duration_in_traffic?.value
                ? element.duration_in_traffic.value / 60
                : element.duration.value / 60,
            status: 'OK',
        };
    } catch (error) {
        if (proxyAvailable === false) {
            return getMockTravelTime(origin, destination);
        }
        if (error.message.includes('API')) throw error;
        return { duration: null, status: 'NETWORK_ERROR' };
    }
}

/**
 * Get travel times for multiple origins to one destination in batch.
 *
 * @param {string[]} origins - Array of pickup addresses
 * @param {string} destination - Set address
 * @param {Date} arrivalTime - Desired arrival time
 * @returns {Promise<Array<{duration: number|null, status: string}>>}
 */
export async function getBatchTravelTimes(origins, destination, arrivalTime) {
    if (!isApiConfigured()) {
        return origins.map(origin => getMockTravelTime(origin, destination));
    }

    const arrivalHour = arrivalTime.getHours();
    const results = new Array(origins.length);
    const uncachedIndices = [];

    for (let i = 0; i < origins.length; i++) {
        const cached = getCachedTravelTime(origins[i], destination, arrivalHour);
        if (cached !== null) {
            results[i] = cached;
        } else {
            uncachedIndices.push(i);
        }
    }

    if (uncachedIndices.length === 0) return results;

    const uncachedOrigins = uncachedIndices.map(i => origins[i]);
    const arrivalTimestamp = Math.floor(arrivalTime.getTime() / 1000);

    try {
        apiCallCounter++;
        const data = await callProxy('distancematrix', {
            origins: uncachedOrigins.join('|'),
            destinations: destination,
            arrival_time: arrivalTimestamp.toString(),
        });

        if (data.status === 'REQUEST_DENIED' || data.status === 'OVER_QUERY_LIMIT') {
            throw new Error(`Google API error: ${data.status} - ${data.error_message || 'API key issue'}`);
        }

        for (let r = 0; r < data.rows.length; r++) {
            const element = data.rows[r].elements[0];
            const originalIndex = uncachedIndices[r];
            let result;
            if (!element || element.status !== 'OK') {
                result = { duration: null, status: element?.status || 'UNKNOWN_ERROR' };
            } else {
                result = {
                    duration: element.duration_in_traffic?.value
                        ? element.duration_in_traffic.value / 60
                        : element.duration.value / 60,
                    status: 'OK',
                };
            }
            results[originalIndex] = result;
            if (result.status === 'OK') {
                cacheTravelTime(origins[originalIndex], destination, arrivalHour, result);
            }
        }

        return results;
    } catch (error) {
        if (proxyAvailable === false) {
            for (const idx of uncachedIndices) {
                results[idx] = getMockTravelTime(origins[idx], destination);
            }
            return results;
        }
        if (error.message.includes('API')) throw error;
        for (const idx of uncachedIndices) {
            results[idx] = { duration: null, status: 'NETWORK_ERROR' };
        }
        return results;
    }
}

/**
 * Get travel time between two arbitrary points (for route with pickup detour).
 *
 * @param {string[]} waypoints - Ordered list of addresses [pickup1, pickup2, ..., destination]
 * @param {Date} arrivalTime
 * @returns {Promise<{totalDuration: number|null, legDurations: number[], status: string}>}
 */
export async function getRouteDuration(waypoints, arrivalTime) {
    if (waypoints.length < 2) return { totalDuration: 0, legDurations: [], status: 'OK' };

    if (!isApiConfigured()) {
        return getMockRouteDuration(waypoints);
    }

    const arrivalHour = arrivalTime.getHours();
    const cached = getCachedRouteDuration(waypoints, arrivalHour);
    if (cached !== null) return cached;

    const origin = waypoints[0];
    const destination = waypoints[waypoints.length - 1];
    const intermediates = waypoints.slice(1, -1);

    const params = {
        origin,
        destination,
        arrival_time: Math.floor(arrivalTime.getTime() / 1000).toString(),
    };
    if (intermediates.length > 0) {
        params.waypoints = intermediates.join('|');
    }

    try {
        apiCallCounter++;
        const data = await callProxy('directions', params);

        if (data.status !== 'OK') {
            return { totalDuration: null, legDurations: [], status: data.status };
        }

        const legDurations = data.routes[0].legs.map(
            leg => (leg.duration_in_traffic?.value || leg.duration.value) / 60
        );
        const totalSeconds = data.routes[0].legs.reduce(
            (sum, leg) => sum + (leg.duration_in_traffic?.value || leg.duration.value),
            0
        );

        const result = { totalDuration: totalSeconds / 60, legDurations, status: 'OK' };
        cacheRouteDuration(waypoints, arrivalHour, result);
        return result;
    } catch (error) {
        if (proxyAvailable === false) {
            return getMockRouteDuration(waypoints);
        }
        if (error.message.includes('API')) throw error;
        return { totalDuration: null, legDurations: [], status: 'NETWORK_ERROR' };
    }
}

/**
 * Get travel times between ALL pickup points (n×n matrix).
 *
 * Cache strategy (three tiers, cheapest first):
 *   1. DB (address_pair_cache) — permanent, cross-session. Checked per chunk:
 *      if every pair in a chunk is already stored, that chunk fires no API call.
 *   2. In-session memory (local variable) — rebuilt from DB on each page load.
 *   3. Google Distance Matrix API — only for genuinely unknown pairs.
 *
 * After any API calls the newly-fetched pairs are persisted to the DB so future
 * sessions with the same recurring passengers skip the API entirely.
 *
 * NOTE: only used for ILP grouping decisions.  Final pickup times come from
 * getRouteDuration which is intentionally never cached here (traffic-sensitive).
 *
 * Google limits Distance Matrix to 25 origins OR 25 destinations per request,
 * so we split into 25×25 chunks and run only uncached chunks in parallel.
 *
 * @param {string[]} addresses - Array of all pickup addresses
 * @param {Date} arrivalTime   - Desired arrival time (for traffic prediction)
 * @returns {Promise<number[][]>} n×n matrix, result[i][j] = minutes from i to j
 */
export async function getAllPairTravelTimes(addresses, arrivalTime) {
    const n = addresses.length;
    if (n <= 1) return Array.from({ length: n }, () => new Array(n).fill(0));

    if (!isApiConfigured()) {
        return getMockPairMatrix(addresses);
    }

    const CHUNK_SIZE = 25;
    const arrivalTimestamp = Math.floor(arrivalTime.getTime() / 1000);

    // ── Tier 1: load whatever is already in the DB ────────────────────────────
    const matrix = await loadPairMatrix(addresses);
    for (let i = 0; i < n; i++) matrix[i][i] = 0;

    // ── Determine which 25×25 chunks still have missing pairs ─────────────────
    const chunksToFetch = [];
    for (let oStart = 0; oStart < n; oStart += CHUNK_SIZE) {
        for (let dStart = 0; dStart < n; dStart += CHUNK_SIZE) {
            const oEnd = Math.min(oStart + CHUNK_SIZE, n);
            const dEnd = Math.min(dStart + CHUNK_SIZE, n);
            let needsFetch = false;
            outer: for (let i = oStart; i < oEnd; i++) {
                for (let j = dStart; j < dEnd; j++) {
                    if (i !== j && matrix[i][j] === null) {
                        needsFetch = true;
                        break outer;
                    }
                }
            }
            if (needsFetch) chunksToFetch.push({ oStart, dStart });
        }
    }

    // All pairs served from DB — zero API calls needed
    if (chunksToFetch.length === 0) return matrix;

    // ── Tier 2: fetch only the uncached chunks in parallel ────────────────────
    const results = await Promise.allSettled(
        chunksToFetch.map(({ oStart, dStart }) => {
            const originSlice = addresses.slice(oStart, Math.min(oStart + CHUNK_SIZE, n));
            const destSlice   = addresses.slice(dStart, Math.min(dStart + CHUNK_SIZE, n));

            apiCallCounter++;
            return callProxy('distancematrix', {
                origins:      originSlice.join('|'),
                destinations: destSlice.join('|'),
                arrival_time: arrivalTimestamp.toString(),
            }).then(data => {
                if (data.status === 'REQUEST_DENIED' || data.status === 'OVER_QUERY_LIMIT') {
                    throw new Error(`Google API error: ${data.status} - ${data.error_message || ''}`);
                }
                return { oStart, dStart, data };
            });
        })
    );

    if (proxyAvailable === false) {
        return getMockPairMatrix(addresses);
    }

    let criticalError = null;
    for (const result of results) {
        if (result.status === 'rejected') {
            if (result.reason?.message?.includes('REQUEST_DENIED') ||
                result.reason?.message?.includes('OVER_QUERY_LIMIT')) {
                criticalError = result.reason;
            }
            continue;
        }
        const { oStart, dStart, data } = result.value;
        for (let i = 0; i < data.rows.length; i++) {
            for (let j = 0; j < data.rows[i].elements.length; j++) {
                const el = data.rows[i].elements[j];
                if (el.status === 'OK') {
                    matrix[oStart + i][dStart + j] = el.duration_in_traffic?.value
                        ? el.duration_in_traffic.value / 60
                        : el.duration.value / 60;
                }
            }
        }
    }

    if (criticalError) throw criticalError;

    for (let i = 0; i < n; i++) matrix[i][i] = 0;

    // ── Persist newly-fetched pairs so the next session skips the API ─────────
    savePairMatrix(addresses, matrix); // fire-and-forget — don't block the caller

    return matrix;
}

// ---------------------------------------------------------------------------
// Mock implementations for local dev without a configured API key
// ---------------------------------------------------------------------------

function getMockPairMatrix(addresses) {
    const n = addresses.length;
    const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            const seed = (addresses[i] + addresses[j]).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
            const pseudoRandom = ((seed * 9301 + 49297) % 233280) / 233280;
            matrix[i][j] = Math.round((5 + pseudoRandom * 25) * 10) / 10;
        }
    }
    return matrix;
}

function getMockRouteDuration(waypoints) {
    const destination = waypoints[waypoints.length - 1];
    const pickups = waypoints.slice(0, -1);

    const directTimes = pickups.map(p => getMockTravelTime(p, destination).duration);
    const maxDirect = Math.max(...directTimes);

    const allPickupsStr = pickups.join('|');
    const seed = allPickupsStr.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const pseudoRandom = ((seed * 9301 + 49297) % 233280) / 233280;
    const detourPerStop = 3 + pseudoRandom * 12;
    const totalDetour = Math.round(detourPerStop * (pickups.length - 1) * 10) / 10;
    const totalDuration = Math.round((maxDirect + totalDetour) * 10) / 10;

    const numLegs = waypoints.length - 1;
    const legDurations = [];
    if (numLegs === 1) {
        legDurations.push(totalDuration);
    } else {
        for (let i = 0; i < numLegs - 1; i++) {
            const legSeed = (waypoints[i] + waypoints[i + 1]).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
            const legRandom = ((legSeed * 9301 + 49297) % 233280) / 233280;
            const legPortion = Math.round((totalDetour * (0.3 + legRandom * 0.7) / (numLegs - 1)) * 10) / 10;
            legDurations.push(legPortion);
        }
        const usedByLegs = legDurations.reduce((s, d) => s + d, 0);
        legDurations.push(Math.round((totalDuration - usedByLegs) * 10) / 10);
    }

    return { totalDuration, legDurations, status: 'OK' };
}

function getMockTravelTime(origin, destination) {
    const seed = (origin + destination).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const pseudoRandom = ((seed * 9301 + 49297) % 233280) / 233280;
    const duration = 10 + pseudoRandom * 50;
    return { duration: Math.round(duration * 10) / 10, status: 'OK' };
}
