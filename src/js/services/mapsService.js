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

// ── Cost & milestone tracking ─────────────────────────────────────────────────
// Pricing: Distance Matrix $5/1000 elements, Directions $5/1000 requests
const COST_PER_ELEMENT = 5 / 1000;   // $0.005 per origin×dest pair
const COST_PER_DIRECTION = 5 / 1000; // $0.005 per Directions request
const COST_ALERT_INTERVAL = 2;        // fire alert every $2
const CALL_ALERT_INTERVAL = 10;       // fire alert every 10 calls

let cumulativeCost = 0;
let lastCostMilestone = 0;
let lastCallMilestone = 0;
const _milestoneListeners = [];

/** Register a callback that fires when a cost or call milestone is crossed. */
export function onApiMilestone(callback) {
    _milestoneListeners.push(callback);
}

export function getApiCallCount() { return apiCallCounter; }
export function getCumulativeCost() { return cumulativeCost; }

export function resetApiCallCount() {
    apiCallCounter = 0;
    cumulativeCost = 0;
    lastCostMilestone = 0;
    lastCallMilestone = 0;
}

function estimateCallCost(type, params) {
    if (type === 'distancematrix') {
        const origins = (params.origins || '').split('|').length;
        const dests   = (params.destinations || '').split('|').length;
        return origins * dests * COST_PER_ELEMENT;
    }
    if (type === 'directions') {
        return COST_PER_DIRECTION;
    }
    return 0;
}

function checkMilestones(callCost) {
    cumulativeCost += callCost;

    const costMilestone = Math.floor(cumulativeCost / COST_ALERT_INTERVAL);
    if (costMilestone > lastCostMilestone) {
        lastCostMilestone = costMilestone;
        _milestoneListeners.forEach(cb => cb('cost', cumulativeCost, apiCallCounter));
    }

    const callMilestone = Math.floor(apiCallCounter / CALL_ALERT_INTERVAL);
    if (callMilestone > lastCallMilestone) {
        lastCallMilestone = callMilestone;
        _milestoneListeners.forEach(cb => cb('calls', cumulativeCost, apiCallCounter));
    }
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
 * Tracks cost and fires milestone notifications after each successful call.
 */
async function callProxy(type, params) {
    const callId = `#${apiCallCounter}`;
    const callCost = estimateCallCost(type, params);
    const originsCount = type === 'distancematrix' ? (params.origins || '').split('|').length : null;
    const destsCount   = type === 'distancematrix' ? (params.destinations || '').split('|').length : null;

    console.group(`[MAPS] 📡 Google API call ${callId} — ${type.toUpperCase()}`);
    if (type === 'distancematrix') {
        console.log(`  Origins   (${originsCount}):`, (params.origins || '').split('|'));
        console.log(`  Dests     (${destsCount}):`,   (params.destinations || '').split('|'));
        console.log(`  Elements: ${originsCount * destsCount}  |  Est. cost: $${callCost.toFixed(4)}`);
    } else if (type === 'directions') {
        console.log(`  Origin:   ${params.origin}`);
        console.log(`  Dest:     ${params.destination}`);
        if (params.waypoints) console.log(`  Via:      ${params.waypoints.split('|').join(' → ')}`);
        console.log(`  Est. cost: $${callCost.toFixed(4)}`);
    }
    if (params.arrival_time) {
        const ts = parseInt(params.arrival_time, 10);
        console.log(`  Arrival:  ${new Date(ts * 1000).toLocaleTimeString()}`);
    }
    console.log(`  Cumulative calls so far: ${apiCallCounter}  |  Cumulative cost: $${cumulativeCost.toFixed(4)}`);

    let response;
    const t0 = performance.now();
    try {
        response = await fetch('/api/maps', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, ...params }),
        });
    } catch (err) {
        console.warn(`  ❌ Network error — proxy unreachable:`, err.message);
        console.groupEnd();
        proxyAvailable = false;
        throw new Error('Proxy unreachable');
    }

    if (!response.ok) {
        console.warn(`  ❌ HTTP ${response.status}`);
        console.groupEnd();
        if (response.status === 503) {
            proxyAvailable = false;
            throw new Error('GOOGLE_MAPS_API_KEY not configured on server');
        }
        if (response.status === 502 || response.status === 504) {
            proxyAvailable = false;
            throw new Error('Proxy server unavailable');
        }
        throw new Error(`Proxy HTTP error: ${response.status}`);
    }

    const data = await response.json();
    const elapsed = (performance.now() - t0).toFixed(0);

    if (data.error) {
        console.warn(`  ❌ Proxy error: ${data.error}`);
        console.groupEnd();
        if (data.error.includes('GOOGLE_MAPS_API_KEY')) proxyAvailable = false;
        throw new Error(`Proxy error: ${data.error}`);
    }

    console.log(`  ✅ Status: ${data.status}  |  Round-trip: ${elapsed}ms`);

    if (type === 'distancematrix' && data.rows) {
        console.group(`  📊 Distance Matrix Results`);
        data.rows.forEach((row, i) => {
            const originLabel = (params.origins || '').split('|')[i] || `Origin ${i}`;
            row.elements.forEach((el, j) => {
                const destLabel = (params.destinations || '').split('|')[j] || `Dest ${j}`;
                if (el.status === 'OK') {
                    const mins = (el.duration_in_traffic?.value || el.duration?.value || 0) / 60;
                    const traffic = el.duration_in_traffic ? ` (traffic: ${(el.duration_in_traffic.value/60).toFixed(1)} min)` : '';
                    console.log(`    [${i}→${j}] ${originLabel}  →  ${destLabel} : ${mins.toFixed(1)} min${traffic}`);
                } else {
                    console.warn(`    [${i}→${j}] ${originLabel}  →  ${destLabel} : ❌ ${el.status}`);
                }
            });
        });
        console.groupEnd();
    }

    if (type === 'directions' && data.routes?.[0]) {
        console.group(`  🗺️ Directions Results`);
        const legs = data.routes[0].legs;
        let totalSecs = 0;
        legs.forEach((leg, i) => {
            const secs = leg.duration_in_traffic?.value || leg.duration?.value || 0;
            totalSecs += secs;
            const traffic = leg.duration_in_traffic ? ` (w/ traffic: ${(leg.duration_in_traffic.value/60).toFixed(1)} min)` : '';
            console.log(`    Leg ${i}: ${leg.start_address?.split(',')[0]} → ${leg.end_address?.split(',')[0]} : ${(secs/60).toFixed(1)} min${traffic}`);
        });
        console.log(`    Total: ${(totalSecs/60).toFixed(1)} min`);
        console.groupEnd();
    }

    console.groupEnd();

    proxyAvailable = true;
    checkMilestones(callCost);
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
    console.log(`[MAPS] getTravelTime: "${origin}" → "${destination}" @ ${arrivalTime.toLocaleTimeString()}`);

    if (!isApiConfigured()) {
        const mock = getMockTravelTime(origin, destination);
        console.log(`[MAPS]   → MOCK result: ${mock.duration?.toFixed(1)} min`);
        return mock;
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
            console.warn(`[MAPS]   → ADDRESS_ERROR for "${origin}"`);
            return { duration: null, status: 'ADDRESS_ERROR' };
        }

        const duration = element.duration_in_traffic?.value
            ? element.duration_in_traffic.value / 60
            : element.duration.value / 60;
        console.log(`[MAPS]   → ${duration.toFixed(1)} min`);
        return { duration, status: 'OK' };
    } catch (error) {
        if (proxyAvailable === false) {
            const mock = getMockTravelTime(origin, destination);
            console.log(`[MAPS]   → MOCK fallback: ${mock.duration?.toFixed(1)} min`);
            return mock;
        }
        if (error.message.includes('API')) throw error;
        console.warn(`[MAPS]   → NETWORK_ERROR:`, error.message);
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
    console.group(`[MAPS] getBatchTravelTimes — ${origins.length} origins → "${destination}" @ ${arrivalTime.toLocaleTimeString()}`);

    if (!isApiConfigured()) {
        const mocks = origins.map(origin => getMockTravelTime(origin, destination));
        console.log(`  → All MOCK results:`, mocks.map((m, i) => `${origins[i]}: ${m.duration?.toFixed(1)} min`));
        console.groupEnd();
        return mocks;
    }

    const arrivalHour = arrivalTime.getHours();
    const results = new Array(origins.length);
    const uncachedIndices = [];

    for (let i = 0; i < origins.length; i++) {
        const cached = getCachedTravelTime(origins[i], destination, arrivalHour);
        if (cached !== null) {
            console.log(`  [${i}] CACHE HIT  "${origins[i]}" → ${cached.duration?.toFixed(1)} min`);
            results[i] = cached;
        } else {
            console.log(`  [${i}] cache miss "${origins[i]}"`);
            uncachedIndices.push(i);
        }
    }

    if (uncachedIndices.length === 0) {
        console.log(`  ✅ All ${origins.length} results served from cache — no API call needed`);
        console.groupEnd();
        return results;
    }

    console.log(`  Fetching ${uncachedIndices.length} uncached origins from API...`);
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

        console.group(`  Parsing ${data.rows.length} rows`);
        for (let r = 0; r < data.rows.length; r++) {
            const element = data.rows[r].elements[0];
            const originalIndex = uncachedIndices[r];
            let result;
            if (!element || element.status !== 'OK') {
                result = { duration: null, status: element?.status || 'UNKNOWN_ERROR' };
                console.warn(`    [${originalIndex}] ❌ ${origins[originalIndex]} — ${result.status}`);
            } else {
                result = {
                    duration: element.duration_in_traffic?.value
                        ? element.duration_in_traffic.value / 60
                        : element.duration.value / 60,
                    status: 'OK',
                };
                const trafficNote = element.duration_in_traffic
                    ? ` (traffic: ${(element.duration_in_traffic.value/60).toFixed(1)} min)`
                    : '';
                console.log(`    [${originalIndex}] ✅ ${origins[originalIndex]} — ${result.duration.toFixed(1)} min${trafficNote}`);
            }
            results[originalIndex] = result;
            if (result.status === 'OK') {
                cacheTravelTime(origins[originalIndex], destination, arrivalHour, result);
            }
        }
        console.groupEnd();

        console.groupEnd();
        return results;
    } catch (error) {
        if (proxyAvailable === false) {
            for (const idx of uncachedIndices) {
                results[idx] = getMockTravelTime(origins[idx], destination);
                console.log(`  [${idx}] MOCK fallback: ${results[idx].duration?.toFixed(1)} min`);
            }
            console.groupEnd();
            return results;
        }
        if (error.message.includes('API')) { console.groupEnd(); throw error; }
        for (const idx of uncachedIndices) {
            results[idx] = { duration: null, status: 'NETWORK_ERROR' };
        }
        console.warn(`  ❌ NETWORK_ERROR for ${uncachedIndices.length} origins`);
        console.groupEnd();
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

    console.group(`[MAPS] getRouteDuration — ${waypoints.length} waypoints @ ${arrivalTime.toLocaleTimeString()}`);
    console.log(`  Route: ${waypoints.join(' → ')}`);

    if (!isApiConfigured()) {
        const mock = getMockRouteDuration(waypoints);
        console.log(`  → MOCK: ${mock.totalDuration?.toFixed(1)} min total, legs: [${mock.legDurations.map(d => d.toFixed(1)).join(', ')}]`);
        console.groupEnd();
        return mock;
    }

    const arrivalHour = arrivalTime.getHours();
    const cached = getCachedRouteDuration(waypoints, arrivalHour);
    if (cached !== null) {
        console.log(`  ✅ CACHE HIT: ${cached.totalDuration?.toFixed(1)} min total`);
        console.groupEnd();
        return cached;
    }

    console.log(`  cache miss — calling Directions API`);

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
            console.warn(`  ❌ Directions API status: ${data.status}`);
            console.groupEnd();
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
        console.log(`  ✅ Total: ${result.totalDuration.toFixed(1)} min | Legs: [${legDurations.map(d => d.toFixed(1)).join(', ')}]`);
        console.groupEnd();
        cacheRouteDuration(waypoints, arrivalHour, result);
        return result;
    } catch (error) {
        if (proxyAvailable === false) {
            const mock = getMockRouteDuration(waypoints);
            console.log(`  → MOCK fallback: ${mock.totalDuration?.toFixed(1)} min`);
            console.groupEnd();
            return mock;
        }
        if (error.message.includes('API')) { console.groupEnd(); throw error; }
        console.warn(`  ❌ NETWORK_ERROR:`, error.message);
        console.groupEnd();
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

    console.group(`[MAPS] getAllPairTravelTimes — ${n}×${n} matrix (${n*n} pairs) @ ${arrivalTime.toLocaleTimeString()}`);
    console.log(`  Addresses:`, addresses);

    if (!isApiConfigured()) {
        const mock = getMockPairMatrix(addresses);
        console.log(`  → MOCK matrix`);
        console.groupEnd();
        return mock;
    }

    const CHUNK_SIZE = 25;
    const arrivalTimestamp = Math.floor(arrivalTime.getTime() / 1000);

    console.log(`  Tier 1: loading from DB...`);
    const matrix = await loadPairMatrix(addresses);
    for (let i = 0; i < n; i++) matrix[i][i] = 0;

    const dbHits = matrix.flat().filter(v => v !== null).length - n;
    const dbMisses = matrix.flat().filter(v => v === null).length;
    console.log(`  DB cache: ${dbHits} hits, ${dbMisses} misses`);

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

    if (chunksToFetch.length === 0) {
        console.log(`  ✅ All pairs in DB — 0 API calls needed`);
        console.groupEnd();
        return matrix;
    }

    console.log(`  Tier 2: fetching ${chunksToFetch.length} chunk(s) from API:`, chunksToFetch);

    const results = await Promise.allSettled(
        chunksToFetch.map(({ oStart, dStart }) => {
            const originSlice = addresses.slice(oStart, Math.min(oStart + CHUNK_SIZE, n));
            const destSlice   = addresses.slice(dStart, Math.min(dStart + CHUNK_SIZE, n));

            console.log(`    Chunk [${oStart}..${oStart+originSlice.length-1}] × [${dStart}..${dStart+destSlice.length-1}] — ${originSlice.length}×${destSlice.length} elements`);

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
        console.log(`  → MOCK fallback for entire matrix`);
        console.groupEnd();
        return getMockPairMatrix(addresses);
    }

    let criticalError = null;
    let filledPairs = 0;
    let failedPairs = 0;

    for (const result of results) {
        if (result.status === 'rejected') {
            console.warn(`  ❌ Chunk rejected:`, result.reason?.message);
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
                    filledPairs++;
                } else {
                    failedPairs++;
                }
            }
        }
    }

    console.log(`  Matrix filled: ${filledPairs} pairs OK, ${failedPairs} failed`);

    if (criticalError) {
        console.groupEnd();
        throw criticalError;
    }

    for (let i = 0; i < n; i++) matrix[i][i] = 0;

    console.log(`  Persisting new pairs to DB (fire-and-forget)`);
    console.groupEnd();
    savePairMatrix(addresses, matrix);

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
