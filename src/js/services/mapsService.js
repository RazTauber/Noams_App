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
import { loadPairMatrix, savePairMatrix, harvestLegsToDb } from './groupMemoryService.js';
import { ALGORITHM_CONFIG } from '../utils/constants.js';

let apiCallCounter = 0;

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
 * POST to the /api/maps proxy with the given type and params.
 * Returns the parsed JSON from Google Maps, or throws on error.
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
        throw new Error('Proxy unreachable');
    }

    if (!response.ok) {
        console.warn(`  ❌ HTTP ${response.status}`);
        console.groupEnd();
        if (response.status === 503) {
            throw new Error('GOOGLE_MAPS_API_KEY not configured on server');
        }
        if (response.status === 502 || response.status === 504) {
            throw new Error('Proxy server unavailable');
        }
        throw new Error(`Proxy HTTP error: ${response.status}`);
    }

    const data = await response.json();
    const elapsed = (performance.now() - t0).toFixed(0);

    if (data.error) {
        console.warn(`  ❌ Proxy error: ${data.error}`);
        console.groupEnd();
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

    const arrivalTimestamp = Math.floor(arrivalTime.getTime() / 1000);

    try {
        apiCallCounter++;
        const data = await callProxy('distancematrix', {
            origins: origin,
            destinations: destination,
            arrival_time: arrivalTimestamp.toString(),
            departure_offset: ALGORITHM_CONFIG.DEPARTURE_OFFSET_MINUTES,
        });

        if (data.status !== 'OK') {
            throw new Error(`Google API error: ${data.status} - ${data.error_message || ''}`);
        }

        const element = data.rows[0]?.elements[0];
        if (!element || element.status !== 'OK') {
            console.warn(`[MAPS]   → ADDRESS_ERROR for "${origin}"`);
            return { duration: null, status: 'ADDRESS_ERROR' };
        }

        if (!element.duration_in_traffic) {
            console.warn('[MAPS] ⚠️ No traffic data — using static duration (check departure_time / traffic_model config)');
        }
        const rawMinutes = element.duration_in_traffic?.value
            ? element.duration_in_traffic.value / 60
            : element.duration.value / 60;
        const duration = rawMinutes * ALGORITHM_CONFIG.TRAVEL_TIME_BUFFER;
        console.log(`[MAPS]   → raw=${rawMinutes.toFixed(1)} → buffered=${duration.toFixed(1)} min`);
        return { duration, status: 'OK' };
    } catch (error) {
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
            departure_offset: ALGORITHM_CONFIG.DEPARTURE_OFFSET_MINUTES,
        });

        if (data.status === 'REQUEST_DENIED' || data.status === 'OVER_QUERY_LIMIT') {
            throw new Error(`Google API error: ${data.status} - ${data.error_message || 'API key issue'}`);
        }

        const buf = ALGORITHM_CONFIG.TRAVEL_TIME_BUFFER;
        console.group(`  Parsing ${data.rows.length} rows (×${buf} safety buffer)`);
        for (let r = 0; r < data.rows.length; r++) {
            const element = data.rows[r].elements[0];
            const originalIndex = uncachedIndices[r];
            let result;
            if (!element || element.status !== 'OK') {
                result = { duration: null, status: element?.status || 'UNKNOWN_ERROR' };
                console.warn(`    [${originalIndex}] ❌ ${origins[originalIndex]} — ${result.status}`);
            } else {
                const rawMinutes = element.duration_in_traffic?.value
                    ? element.duration_in_traffic.value / 60
                    : element.duration.value / 60;
                result = {
                    duration: rawMinutes * buf,
                    status: 'OK',
                };
                const trafficNote = element.duration_in_traffic
                    ? ` (traffic: ${(element.duration_in_traffic.value/60).toFixed(1)} min)`
                    : ' (no traffic data)';
                if (!element.duration_in_traffic) {
                    console.warn('[MAPS] ⚠️ No traffic data — using static duration (check departure_time / traffic_model config)');
                }
                console.log(`    [${originalIndex}] ✅ ${origins[originalIndex]} — raw=${rawMinutes.toFixed(1)} → buffered=${result.duration.toFixed(1)} min${trafficNote}`);
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
        departure_offset: ALGORITHM_CONFIG.DEPARTURE_OFFSET_MINUTES,
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

        const buf = ALGORITHM_CONFIG.TRAVEL_TIME_BUFFER;
        const legsWithoutTraffic = data.routes[0].legs.filter(leg => !leg.duration_in_traffic);
        const noTrafficData = legsWithoutTraffic.length > 0;

        let legDurations;
        let totalDuration;

        if (noTrafficData && waypoints.length > 2) {
            // Google Directions API does NOT return duration_in_traffic
            // with stopover waypoints — this is a documented API limitation.
            // Fall back to per-leg Distance Matrix calls (traffic-aware).
            console.warn(`[MAPS] ⚠️ ${legsWithoutTraffic.length}/${data.routes[0].legs.length} leg(s) missing traffic data (Directions API limitation with waypoints) — fetching per-leg traffic times via Distance Matrix`);

            legDurations = await Promise.all(
                waypoints.slice(0, -1).map((wp, i) => {
                    const dest = waypoints[i + 1];
                    const cached = getCachedTravelTime(wp, dest, arrivalHour);
                    if (cached !== null && cached.duration !== null) {
                        console.log(`    Leg ${i}: ${wp} → ${dest}: ${cached.duration.toFixed(1)} min (cache)`);
                        return cached.duration;
                    }
                    return getBatchTravelTimes([wp], dest, arrivalTime)
                        .then(results => {
                            const dur = results[0]?.duration ?? null;
                            if (dur !== null) {
                                console.log(`    Leg ${i}: ${wp} → ${dest}: ${dur.toFixed(1)} min (Distance Matrix, traffic-aware)`);
                            }
                            return dur;
                        });
                })
            );

            const hasNulls = legDurations.some(d => d === null);
            if (hasNulls) {
                // Some legs failed — fall back to static Directions durations
                console.warn(`  ⚠️ Some per-leg DM calls failed — falling back to static Directions durations`);
                legDurations = data.routes[0].legs.map(
                    leg => ((leg.duration_in_traffic?.value || leg.duration.value) / 60) * buf
                );
                totalDuration = legDurations.reduce((s, d) => s + d, 0);
            } else {
                totalDuration = legDurations.reduce((s, d) => s + d, 0);
            }
        } else {
            legDurations = data.routes[0].legs.map(
                leg => ((leg.duration_in_traffic?.value || leg.duration.value) / 60) * buf
            );
            const rawTotalSeconds = data.routes[0].legs.reduce(
                (sum, leg) => sum + (leg.duration_in_traffic?.value || leg.duration.value),
                0
            );
            totalDuration = (rawTotalSeconds / 60) * buf;
        }

        const result = { totalDuration, legDurations, status: 'OK', noTrafficData };
        console.log(`  ✅ Total: ${totalDuration.toFixed(1)} min${noTrafficData ? ' (via Distance Matrix — traffic-aware)' : ` (×${buf})`} | Legs: [${legDurations.map(d => d.toFixed(1)).join(', ')}]`);
        console.groupEnd();
        cacheRouteDuration(waypoints, arrivalHour, result);

        // Harvest pickup-to-pickup leg durations into the pair cache
        if (waypoints.length > 2 && legDurations.length === waypoints.length - 1) {
            const harvestPairs = [];
            for (let k = 0; k < legDurations.length - 1; k++) {
                harvestPairs.push({
                    origin: waypoints[k],
                    dest: waypoints[k + 1],
                    minutes: legDurations[k],
                });
                cacheTravelTime(waypoints[k], waypoints[k + 1], arrivalHour, {
                    duration: legDurations[k], status: 'OK',
                });
            }
            if (harvestPairs.length > 0) {
                harvestLegsToDb(harvestPairs);
            }
        }

        return result;
    } catch (error) {
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

    const CHUNK_SIZE = 25;
    const arrivalTimestamp = Math.floor(arrivalTime.getTime() / 1000);

    console.log(`  Tier 1: loading from DB...`);
    const matrix = await loadPairMatrix(addresses);
    for (let i = 0; i < n; i++) matrix[i][i] = 0;

    const dbHits = matrix.flat().filter(v => v !== null).length - n;
    const dbMisses = matrix.flat().filter(v => v === null).length;
    console.log(`  DB cache: ${dbHits} hits, ${dbMisses} misses`);

    // Collect only the address indices that participate in missing pairs
    const missingOriginSet = new Set();
    const missingDestSet = new Set();
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            if (i !== j && matrix[i][j] === null) {
                missingOriginSet.add(i);
                missingDestSet.add(j);
            }
        }
    }

    if (missingOriginSet.size === 0) {
        console.log(`  ✅ All pairs in DB — 0 API calls needed`);
        console.groupEnd();
        return matrix;
    }

    const missingOrigins = [...missingOriginSet];
    const missingDests = [...missingDestSet];
    const totalMissingElements = missingOrigins.length * missingDests.length;
    const naiveElements = n * n;

    console.log(`  Minimal-chunk strategy: ${missingOrigins.length} origins × ${missingDests.length} dests = ${totalMissingElements} elements (vs ${naiveElements} naive)`);

    // Build minimal chunks from only the addresses that have missing data
    const chunksToFetch = [];
    for (let oStart = 0; oStart < missingOrigins.length; oStart += CHUNK_SIZE) {
        for (let dStart = 0; dStart < missingDests.length; dStart += CHUNK_SIZE) {
            const oSlice = missingOrigins.slice(oStart, oStart + CHUNK_SIZE);
            const dSlice = missingDests.slice(dStart, dStart + CHUNK_SIZE);
            chunksToFetch.push({ originIndices: oSlice, destIndices: dSlice });
        }
    }

    console.log(`  Tier 2: fetching ${chunksToFetch.length} minimal chunk(s) from API`);

    const results = await Promise.allSettled(
        chunksToFetch.map(({ originIndices, destIndices }) => {
            const originAddrs = originIndices.map(i => addresses[i]);
            const destAddrs = destIndices.map(j => addresses[j]);

            console.log(`    Chunk ${originAddrs.length}×${destAddrs.length} elements`);

            apiCallCounter++;
            return callProxy('distancematrix', {
                origins:      originAddrs.join('|'),
                destinations: destAddrs.join('|'),
                arrival_time: arrivalTimestamp.toString(),
                departure_offset: ALGORITHM_CONFIG.DEPARTURE_OFFSET_MINUTES,
            }).then(data => {
                if (data.status === 'REQUEST_DENIED' || data.status === 'OVER_QUERY_LIMIT') {
                    throw new Error(`Google API error: ${data.status} - ${data.error_message || ''}`);
                }
                return { originIndices, destIndices, data };
            });
        })
    );

    let criticalError = null;
    let filledPairs = 0;
    let failedPairs = 0;

    const buf = ALGORITHM_CONFIG.TRAVEL_TIME_BUFFER;
    for (const result of results) {
        if (result.status === 'rejected') {
            console.warn(`  ❌ Chunk rejected:`, result.reason?.message);
            if (result.reason?.message?.includes('REQUEST_DENIED') ||
                result.reason?.message?.includes('OVER_QUERY_LIMIT')) {
                criticalError = result.reason;
            }
            continue;
        }
        const { originIndices, destIndices, data } = result.value;
        for (let i = 0; i < data.rows.length; i++) {
            for (let j = 0; j < data.rows[i].elements.length; j++) {
                const el = data.rows[i].elements[j];
                const matrixRow = originIndices[i];
                const matrixCol = destIndices[j];
                if (el.status === 'OK') {
                    const rawMinutes = el.duration_in_traffic?.value
                        ? el.duration_in_traffic.value / 60
                        : el.duration.value / 60;
                    matrix[matrixRow][matrixCol] = rawMinutes * buf;
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

