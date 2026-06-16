import { ALGORITHM_CONFIG } from '../utils/constants.js';
import { groupByTimeBucket, subtractMinutesFromTime, extractCity } from '../utils/helpers.js';
import { getBatchTravelTimes, getRouteDuration, getAllPairTravelTimes } from './mapsService.js';
import { enumerateValidGroups, solveOptimalGrouping, estimateGroupRoute } from './optimizer.js';
import { evaluateDelay } from './delayEvaluator.js';
import { lookupGrouping, saveGrouping, normalizeAddress } from './groupMemoryService.js';

export { evaluateDelay };

/**
 * Core routing algorithm.
 * Implements greedy matching and smart (ILP-optimized) matching
 * with dynamic delay thresholds.
 */

/**
 * Run the full routing calculation.
 *
 * @param {Array} passengers - Normalized passenger objects
 * @param {string} destination - Set address
 * @param {string} mainTime - Main arrival time (HH:MM)
 * @param {function} onProgress - Callback for progress updates
 * @param {object} [options] - Algorithm options
 * @param {string} [options.mode='smart'] - 'greedy', 'smart', or 'auto' (auto-selects based on bucket size)
 * @returns {Promise<{taxis: Array, errors: Array, meta?: object}>}
 */
export async function calculateRoutes(passengers, destination, mainTime, onProgress, options = {}) {
    const { mode = 'smart' } = options;
    const taxis = [];
    const errors = [];
    let taxiCounter = 0;

    console.group(`[ROUTING] ▶ calculateRoutes — ${passengers.length} passengers → "${destination}" @ ${mainTime} (mode: ${mode})`);
    console.log(`  Passengers:`, passengers.map(p => `${p.name} [${p.address}]${p.isSpecial ? ' ⭐special' : ''}`));

    onProgress?.('Separating special passengers...');

    const specialPassengers = passengers.filter(p => p.isSpecial);
    const regularPassengers = passengers.filter(p => !p.isSpecial);

    console.log(`  Special: ${specialPassengers.length}, Regular: ${regularPassengers.length}`);

    if (specialPassengers.length > 0) {
        console.group(`  [ROUTING] Special passengers (${specialPassengers.length})`);
        const specialBuckets = groupByTimeBucket(specialPassengers, mainTime);
        for (const [bucketTime, bucketSpecials] of specialBuckets) {
            console.log(`    Bucket ${bucketTime}: ${bucketSpecials.map(p => p.name).join(', ')}`);
            const arrivalDate = buildArrivalDate(bucketTime);
            const specialTravelResults = await getBatchTravelTimes(
                bucketSpecials.map(p => p.address),
                destination,
                arrivalDate
            );
            for (let i = 0; i < bucketSpecials.length; i++) {
                const passenger = bucketSpecials[i];
                const directTime = specialTravelResults[i].duration;
                taxiCounter++;
                const pickupTime = directTime
                    ? subtractMinutesFromTime(bucketTime, directTime)
                    : bucketTime;
                console.log(`    ⭐ Taxi #${taxiCounter} (special): ${passenger.name} — directTime=${directTime?.toFixed(1)} min, pickup=${pickupTime}`);
                taxis.push({
                    id: `taxi-${taxiCounter}`,
                    number: taxiCounter,
                    passengers: [{
                        ...passenger,
                        directTime,
                        delay: 0,
                        pickupTime,
                    }],
                    isSpecial: true,
                });
            }
        }
        console.groupEnd();
    }

    onProgress?.('Grouping by time buckets...');
    const timeBuckets = groupByTimeBucket(regularPassengers, mainTime);
    let meta = { mode, totalDirectionsCalls: 0, totalMatrixElements: 0 };

    console.log(`  Time buckets:`, [...timeBuckets.keys()].map(k => `${k} (${timeBuckets.get(k).length} pax)`));

    for (const [bucketTime, bucketPassengers] of timeBuckets) {
        console.group(`  [ROUTING] Bucket ${bucketTime} — ${bucketPassengers.length} passengers`);
        onProgress?.(`Calculating routes for ${bucketTime} group (${bucketPassengers.length} passengers)...`);

        const arrivalDate = buildArrivalDate(bucketTime);

        const travelResults = await getBatchTravelTimes(
            bucketPassengers.map(p => p.address),
            destination,
            arrivalDate
        );
        meta.totalMatrixElements += bucketPassengers.length;

        const passengersWithTimes = bucketPassengers.map((p, i) => ({
            ...p,
            directTime: travelResults[i].duration,
            apiStatus: travelResults[i].status,
        }));

        console.log(`  Direct times:`, passengersWithTimes.map(p => `${p.name}: ${p.directTime?.toFixed(1) ?? 'N/A'} min (${p.apiStatus})`));

        const addressErrors = passengersWithTimes.filter(p => p.apiStatus !== 'OK');
        for (const errPassenger of addressErrors) {
            taxiCounter++;
            console.warn(`  ❌ Error passenger: ${errPassenger.name} — ${errPassenger.apiStatus}`);
            errors.push({ passenger: errPassenger, reason: errPassenger.apiStatus });
            taxis.push({
                id: `taxi-${taxiCounter}`,
                number: taxiCounter,
                passengers: [{ ...errPassenger, delay: null, pickupTime: null }],
                isSpecial: false,
                hasError: true,
            });
        }

        const validPassengers = passengersWithTimes
            .filter(p => p.apiStatus === 'OK')
            .sort((a, b) => a.directTime - b.directTime);

        const effectiveMode = resolveMode(mode, validPassengers.length);
        console.log(`  Effective mode: ${effectiveMode} (requested: ${mode}, valid passengers: ${validPassengers.length})`);

        if (validPassengers.length === 0) {
            console.log(`  All passengers in bucket had API errors — skipping matching`);
            console.groupEnd();
            continue;
        }

        let bucketTaxis;
        if (effectiveMode === 'smart') {
            const result = await smartMatch(validPassengers, destination, arrivalDate, bucketTime, onProgress);
            bucketTaxis = result.taxis;
            meta.totalDirectionsCalls += result.directionsCalls;
            meta.totalMatrixElements += result.matrixElements;
        } else {
            bucketTaxis = await greedyMatch(validPassengers, destination, arrivalDate, bucketTime, onProgress);
        }

        console.log(`  Bucket result: ${bucketTaxis.length} taxis`);
        for (const taxi of bucketTaxis) {
            taxiCounter++;
            const t = { ...taxi, id: `taxi-${taxiCounter}`, number: taxiCounter };
            console.log(`    Taxi #${taxiCounter}: [${t.passengers.map(p => `${p.name} delay=${p.delay?.toFixed(1)}min pickup=${p.pickupTime}`).join(' | ')}]`);
            taxis.push(t);
        }
        console.groupEnd();
    }

    console.log(`[ROUTING] ✅ Done — ${taxis.length} taxis total, ${errors.length} errors`);
    console.log(`  Meta:`, meta);
    console.groupEnd();

    return { taxis, errors, meta };
}

/**
 * Smart matching algorithm for a single time bucket.
 *
 * Execution path (cheapest first):
 *
 *   A. Grouping memory hit  — saved ILP result found in DB for this exact
 *      destination + hour + address set.  Skips pair matrix + ILP entirely.
 *      Still calls getRouteDuration per group for live traffic times.
 *
 *   B. Full solve  — pair matrix (DB-assisted) + ILP + Directions API.
 *      Saves the resulting grouping to DB for future sessions.
 *
 * @returns {{taxis: Array, directionsCalls: number, matrixElements: number}}
 */
async function smartMatch(passengers, destination, arrivalDate, bucketTime, onProgress) {
    const n = passengers.length;

    console.group(`[ROUTING] 🧠 smartMatch — ${n} passengers, bucket=${bucketTime}`);
    console.log(`  Passengers sorted by directTime:`, passengers.map(p => `${p.name} (${p.directTime?.toFixed(1)} min)`));

    if (n === 0) {
        console.warn(`  ⚠️ smartMatch called with 0 passengers — returning empty`);
        console.groupEnd();
        return { taxis: [], directionsCalls: 0, matrixElements: 0 };
    }

    if (n === 1) {
        const solo = passengers[0];
        const pickupTime = subtractMinutesFromTime(bucketTime, solo.directTime);
        console.log(`  Solo passenger — skip matching. pickup=${pickupTime}`);
        console.groupEnd();
        return {
            taxis: [{
                passengers: [{
                    ...solo,
                    delay: 0,
                    pickupTime,
                }],
                isSpecial: false,
                hasError: false,
            }],
            directionsCalls: 0,
            matrixElements: 0,
        };
    }

    const addresses = passengers.map(p => p.address);

    onProgress?.(`Checking grouping memory...`);
    const savedGrouping = await lookupGrouping(destination, arrivalDate.getHours(), addresses);

    if (savedGrouping) {
        console.log(`  📦 Memory hit — saved grouping found:`, savedGrouping);
        onProgress?.(`Saved grouping found — fetching fresh route times...`);
        const memoryResult = await buildTaxisFromSavedGrouping(
            savedGrouping, passengers, destination, arrivalDate, bucketTime
        );
        if (memoryResult) {
            console.log(`  ✅ Memory restore OK — ${memoryResult.taxis.length} taxis, ${memoryResult.directionsCalls} API calls`);
            console.groupEnd();
            onProgress?.(`Done: ${memoryResult.taxis.length} taxis (from memory, ${memoryResult.directionsCalls} API calls)`);
            return { taxis: memoryResult.taxis, directionsCalls: memoryResult.directionsCalls, matrixElements: 0 };
        }
        console.warn(`  ⚠️ Memory grouping could not be applied (address mismatch) — running full solve`);
        onProgress?.(`Memory grouping could not be applied — running full solve...`);
    } else {
        console.log(`  No saved grouping found — running full solve`);
    }

    onProgress?.(`Building distance matrix (${n} addresses)...`);
    const pairMatrix = await getAllPairTravelTimes(addresses, arrivalDate);
    const matrixElements = n * n;

    console.log(`  Pair matrix (${n}×${n}):`);
    for (let i = 0; i < n; i++) {
        console.log(`    ${passengers[i].name}:`, pairMatrix[i].map((v, j) => `→${passengers[j]?.name?.split(' ')[0]}:${v?.toFixed(1) ?? 'null'}`).join('  '));
    }

    onProgress?.(`Calculating possible combinations...`);
    const directTimes = passengers.map(p => p.directTime);
    const validGroups = enumerateValidGroups(n, pairMatrix, directTimes);
    console.log(`  Valid groups enumerated: ${validGroups.length}`);

    onProgress?.(`Solving optimization (${validGroups.length} combinations)...`);
    const { selectedGroups, solverStatus } = await solveOptimalGrouping(validGroups, n);

    if (!selectedGroups) {
        console.warn(`  ❌ ILP solver failed (${solverStatus}) — falling back to greedy`);
        onProgress?.(`Optimization failed (${solverStatus}), falling back to greedy algorithm...`);
        const fallback = await greedyMatch(passengers, destination, arrivalDate, bucketTime, onProgress);
        console.groupEnd();
        return { taxis: fallback, directionsCalls: 0, matrixElements };
    }

    console.log(`  ✅ ILP solved — ${selectedGroups.length} groups:`);
    selectedGroups.forEach((g, i) => {
        const names = g.bestOrder.map(idx => passengers[idx].name);
        console.log(`    Group ${i+1}: [${names.join(', ')}]  est. time=${g.estimatedTime?.toFixed(1)} min`);
    });

    onProgress?.(`Calculating final routes (${selectedGroups.length} taxis)...`);
    const taxis = [];
    let directionsCalls = 0;

    const multiGroups = [];
    const soloGroups = [];
    for (const group of selectedGroups) {
        const groupPassengers = group.bestOrder.map(idx => passengers[idx]);
        if (groupPassengers.length === 1) {
            soloGroups.push({ group, groupPassengers });
        } else {
            multiGroups.push({ group, groupPassengers });
        }
    }

    for (const { groupPassengers } of soloGroups) {
        const solo = groupPassengers[0];
        const pickupTime = subtractMinutesFromTime(bucketTime, solo.directTime);
        console.log(`  Solo: ${solo.name} — pickup=${pickupTime}, delay=0`);
        taxis.push({
            passengers: [{ ...solo, delay: 0, pickupTime }],
            isSpecial: false,
            hasError: false,
        });
    }

    const routeResults = await Promise.all(
        multiGroups.map(({ groupPassengers }) => {
            const waypoints = [...groupPassengers.map(p => p.address), destination];
            return getRouteDuration(waypoints, arrivalDate);
        })
    );
    directionsCalls += multiGroups.length;

    for (let g = 0; g < multiGroups.length; g++) {
        const { group, groupPassengers } = multiGroups[g];
        const routeResult = routeResults[g];

        console.group(`  Group [${groupPassengers.map(p => p.name).join(', ')}]`);
        const taxiGroup = [];
        if (routeResult.status === 'OK' && routeResult.totalDuration !== null) {
            console.log(`    Route OK: ${routeResult.totalDuration.toFixed(1)} min total, legs: [${routeResult.legDurations.map(d => d.toFixed(1)).join(', ')}]`);
            let cumulativeMinutes = 0;
            for (let k = 0; k < groupPassengers.length; k++) {
                const p = groupPassengers[k];
                const rideTime = routeResult.totalDuration - cumulativeMinutes;
                const delay = Math.max(0, Math.round((rideTime - p.directTime) * 10) / 10);
                const pickupTime = subtractMinutesFromTime(bucketTime, rideTime);
                console.log(`    ${p.name}: directTime=${p.directTime?.toFixed(1)} min, rideTime=${rideTime.toFixed(1)} min, delay=${delay} min, pickup=${pickupTime}`);
                taxiGroup.push({ ...p, delay, pickupTime });
                if (k < routeResult.legDurations.length) {
                    cumulativeMinutes += routeResult.legDurations[k];
                }
            }
        } else {
            console.warn(`    Route status: ${routeResult.status} — using estimated times`);
            for (const p of groupPassengers) {
                const delay = Math.max(0, Math.round((group.estimatedTime - p.directTime) * 10) / 10);
                const pickupTime = subtractMinutesFromTime(bucketTime, p.directTime);
                console.log(`    ${p.name}: delay=${delay} min (estimated), pickup=${pickupTime}`);
                taxiGroup.push({ ...p, delay, pickupTime });
            }
        }
        console.groupEnd();

        taxis.push({ passengers: taxiGroup, isSpecial: false, hasError: false });
    }

    const groupingToSave = selectedGroups.map(group =>
        group.bestOrder.map(idx => passengers[idx].address)
    );
    console.log(`  Saving grouping to DB:`, groupingToSave);
    saveGrouping(destination, arrivalDate.getHours(), addresses, groupingToSave);

    console.log(`  ✅ smartMatch done — ${taxis.length} taxis, ${directionsCalls} Directions calls`);
    console.groupEnd();
    onProgress?.(`Done: ${taxis.length} taxis (optimal)`);
    return { taxis, directionsCalls, matrixElements };
}

/**
 * Reconstruct taxis from a saved grouping record, fetching fresh route times
 * from the Directions API (traffic-aware) for each multi-passenger group.
 *
 * Returns null if the saved addresses can't be mapped back to the current
 * passenger list (e.g. address changed slightly), triggering a full re-solve.
 *
 * @param {string[][]} savedGrouping   Ordered address arrays per taxi (from DB)
 * @param {Array}      passengers      Current passenger objects with directTime
 * @param {string}     destination
 * @param {Date}       arrivalDate
 * @param {string}     bucketTime      HH:MM
 * @returns {Promise<{taxis: Array, directionsCalls: number}|null>}
 */
async function buildTaxisFromSavedGrouping(savedGrouping, passengers, destination, arrivalDate, bucketTime) {
    // Build a normalized-address → passenger lookup
    const normMap = new Map(passengers.map(p => [normalizeAddress(p.address), p]));

    const taxis = [];
    let directionsCalls = 0;
    const assignedIds = new Set();

    const soloTaxis = [];
    const multiGroupData = [];

    for (const groupAddresses of savedGrouping) {
        const groupPassengers = groupAddresses
            .map(addr => normMap.get(normalizeAddress(addr)))
            .filter(Boolean);

        if (groupPassengers.length === 0) continue;
        for (const p of groupPassengers) assignedIds.add(p.id);

        if (groupPassengers.length === 1) {
            const solo = groupPassengers[0];
            soloTaxis.push({
                passengers: [{
                    ...solo,
                    delay: 0,
                    pickupTime: subtractMinutesFromTime(bucketTime, solo.directTime),
                }],
                isSpecial: false,
                hasError: false,
            });
        } else {
            multiGroupData.push(groupPassengers);
        }
    }

    // If not all passengers were covered the saved grouping is stale — re-solve
    if (assignedIds.size !== passengers.length) return null;

    // Fetch fresh routes in parallel for all multi-passenger groups
    const routeResults = await Promise.all(
        multiGroupData.map(groupPassengers => {
            const waypoints = [...groupPassengers.map(p => p.address), destination];
            return getRouteDuration(waypoints, arrivalDate);
        })
    );
    directionsCalls += multiGroupData.length;

    taxis.push(...soloTaxis);

    for (let g = 0; g < multiGroupData.length; g++) {
        const groupPassengers = multiGroupData[g];
        const routeResult = routeResults[g];

        const taxiGroup = [];
        if (routeResult.status === 'OK' && routeResult.totalDuration !== null) {
            let cumulativeMinutes = 0;
            for (let k = 0; k < groupPassengers.length; k++) {
                const p = groupPassengers[k];
                const rideTime = routeResult.totalDuration - cumulativeMinutes;
                const delay = Math.max(0, Math.round((rideTime - p.directTime) * 10) / 10);
                const pickupTime = subtractMinutesFromTime(bucketTime, rideTime);
                taxiGroup.push({ ...p, delay, pickupTime });
                if (k < routeResult.legDurations.length) {
                    cumulativeMinutes += routeResult.legDurations[k];
                }
            }
        } else {
            for (const p of groupPassengers) {
                taxiGroup.push({
                    ...p,
                    delay: 0,
                    pickupTime: subtractMinutesFromTime(bucketTime, p.directTime),
                });
            }
        }

        taxis.push({ passengers: taxiGroup, isSpecial: false, hasError: false });
    }

    return { taxis, directionsCalls };
}

/**
 * Greedy matching algorithm for a single time bucket.
 */
async function greedyMatch(passengers, destination, arrivalDate, bucketTime, onProgress) {
    const { MAX_PASSENGERS_PER_TAXI, CROSS_CITY_MAX_DELAY } = ALGORITHM_CONFIG;
    const assigned = new Set();
    const taxis = [];

    console.group(`[ROUTING] 🔁 greedyMatch — ${passengers.length} passengers, bucket=${bucketTime}`);
    console.log(`  Passengers sorted by directTime:`, passengers.map(p => `${p.name} (${p.directTime?.toFixed(1)} min)`));

    for (let i = 0; i < passengers.length; i++) {
        if (assigned.has(i)) continue;

        const anchor = passengers[i];
        const anchorCity = extractCity(anchor.address);
        const taxiGroup = [{ ...anchor, delay: 0 }];
        assigned.add(i);

        console.group(`  Anchor [${i}] ${anchor.name} (${anchor.directTime?.toFixed(1)} min) [${anchorCity || 'unknown city'}]`);

        // Collect unassigned candidates and sort same-city before cross-city.
        // Within each city group, the existing directTime order is preserved
        // (JS sort is stable), so the cheapest same-city candidate is always
        // tested first.
        const candidateIndices = [];
        for (let j = i + 1; j < passengers.length; j++) {
            if (!assigned.has(j)) candidateIndices.push(j);
        }
        if (anchorCity) {
            candidateIndices.sort((a, b) => {
                const aCity = extractCity(passengers[a].address);
                const bCity = extractCity(passengers[b].address);
                const aScore = aCity === anchorCity ? 0 : 1;
                const bScore = bCity === anchorCity ? 0 : 1;
                return aScore - bScore;
            });
            const sameCityCount = candidateIndices.filter(j => extractCity(passengers[j].address) === anchorCity).length;
            const crossCityCount = candidateIndices.length - sameCityCount;
            if (crossCityCount > 0) {
                console.log(`  Candidates reordered: ${sameCityCount} same-city [${anchorCity}] first, ${crossCityCount} cross-city last`);
            }
        }

        for (const j of candidateIndices) {
            if (assigned.has(j)) continue;
            if (taxiGroup.length >= MAX_PASSENGERS_PER_TAXI) {
                console.log(`    Full (${MAX_PASSENGERS_PER_TAXI} pax max) — stop looking`);
                break;
            }

            const candidate = passengers[j];
            const candidateCity = extractCity(candidate.address);
            const isCrossCity = anchorCity && candidateCity && anchorCity !== candidateCity;
            const timeDiff = Math.abs(candidate.directTime - anchor.directTime);

            if (timeDiff > ALGORITHM_CONFIG.HARD_CAP_MINUTES) {
                console.log(`    [${j}] ${candidate.name}: ❌ timeDiff=${timeDiff.toFixed(1)} min > hardCap=${ALGORITHM_CONFIG.HARD_CAP_MINUTES}`);
                continue;
            }

            // Pre-filter: the route duration is always >= max(directTimes in the
            // group). If even this best-case total (zero detour) would violate delay
            // rules for any member, skip the expensive Directions API call.
            const bestCaseTotal = Math.max(
                ...taxiGroup.map(p => p.directTime),
                candidate.directTime
            );
            let preFilterFailed = false;
            for (const existing of taxiGroup) {
                const bestDelay = bestCaseTotal - existing.directTime;
                if (bestDelay > 0 && !evaluateDelay(existing.directTime, bestDelay).approved) {
                    preFilterFailed = true;
                    console.log(`    [${j}] ${candidate.name}: ❌ pre-filter — best-case delay ${bestDelay.toFixed(1)} min already fails for ${existing.name} (direct=${existing.directTime.toFixed(1)} min)`);
                    break;
                }
            }
            if (!preFilterFailed) {
                const candidateBestDelay = bestCaseTotal - candidate.directTime;
                if (candidateBestDelay > 0 && !evaluateDelay(candidate.directTime, candidateBestDelay).approved) {
                    preFilterFailed = true;
                    console.log(`    [${j}] ${candidate.name}: ❌ pre-filter — best-case delay ${candidateBestDelay.toFixed(1)} min fails for candidate itself (direct=${candidate.directTime.toFixed(1)} min)`);
                }
            }
            if (preFilterFailed) continue;

            const waypoints = [
                ...taxiGroup.map(p => p.address),
                candidate.address,
                destination,
            ];

            console.log(`    [${j}] ${candidate.name} [${candidateCity || 'unknown city'}]${isCrossCity ? ' ⚠️ cross-city' : ''}: testing route ${waypoints.join(' → ')}`);
            const routeResult = await getRouteDuration(waypoints, arrivalDate);

            if (routeResult.status !== 'OK' || routeResult.totalDuration === null) {
                console.warn(`    [${j}] ${candidate.name}: ❌ route status=${routeResult.status}`);
                continue;
            }

            const maxDirectTime = Math.max(
                ...taxiGroup.map(p => p.directTime),
                candidate.directTime
            );
            const additionalDelay = routeResult.totalDuration - maxDirectTime;

            // Geographic constraint: passengers from different cities require a
            // route detour that is almost always too costly. Enforce a strict cap
            // before running the normal per-passenger delay evaluation.
            if (isCrossCity && additionalDelay > CROSS_CITY_MAX_DELAY) {
                console.log(`    [${j}] ⛔ ${candidate.name} — cross-city [${anchorCity} → ${candidateCity}] delay=${additionalDelay.toFixed(1)} min > cross-city cap=${CROSS_CITY_MAX_DELAY} min`);
                continue;
            }

            let allApproved = true;
            const delayEvals = [];
            let evalCumulative = 0;
            for (let ei = 0; ei < taxiGroup.length; ei++) {
                const existing = taxiGroup[ei];
                const rideTime = routeResult.totalDuration - evalCumulative;
                const personalDelay = rideTime - existing.directTime;
                const evaluation = evaluateDelay(existing.directTime, Math.max(0, personalDelay));
                delayEvals.push({ name: existing.name, rideTime: rideTime.toFixed(1), delay: personalDelay.toFixed(1), approved: evaluation.approved, reason: evaluation.reason });
                if (!evaluation.approved) {
                    allApproved = false;
                    break;
                }
                if (ei < routeResult.legDurations.length) {
                    evalCumulative += routeResult.legDurations[ei];
                }
            }

            const candidateRideTime = routeResult.totalDuration - evalCumulative;
            const candidateDelay = candidateRideTime - candidate.directTime;
            const candidateEval = evaluateDelay(candidate.directTime, Math.max(0, candidateDelay));

            console.log(`    [${j}] ${candidate.name}: route=${routeResult.totalDuration.toFixed(1)} min, addlDelay=${additionalDelay.toFixed(1)} min`);
            console.log(`      Existing pax delay check:`, delayEvals);
            console.log(`      Candidate: rideTime=${candidateRideTime.toFixed(1)} min, delay=${candidateDelay.toFixed(1)} min, approved=${candidateEval.approved} (reason=${candidateEval.reason})`);

            if (allApproved && candidateEval.approved) {
                assigned.add(j);
                taxiGroup.push({
                    ...candidate,
                    delay: Math.max(0, Math.round(candidateDelay * 10) / 10),
                });

                let updCumulative = 0;
                for (let k = 0; k < taxiGroup.length; k++) {
                    const rideTime = routeResult.totalDuration - updCumulative;
                    taxiGroup[k].delay = Math.max(
                        0,
                        Math.round((rideTime - taxiGroup[k].directTime) * 10) / 10
                    );
                    if (k < routeResult.legDurations.length) {
                        updCumulative += routeResult.legDurations[k];
                    }
                }
                console.log(`    ✅ ${candidate.name} added to group`);
            } else {
                console.log(`    ❌ ${candidate.name} rejected — delay not approved`);
            }
        }

        if (taxiGroup.length === 1) {
            const solo = taxiGroup[0];
            solo.pickupTime = subtractMinutesFromTime(bucketTime, solo.directTime);
            console.log(`  Solo taxi: ${solo.name} — pickup=${solo.pickupTime}`);
        } else {
            const finalWaypoints = [...taxiGroup.map(p => p.address), destination];
            console.log(`  Final route for group [${taxiGroup.map(p => p.name).join(', ')}]: ${finalWaypoints.join(' → ')}`);
            const finalRoute = await getRouteDuration(finalWaypoints, arrivalDate);

            if (finalRoute.status === 'OK' && finalRoute.legDurations.length > 0) {
                console.log(`  Final route: ${finalRoute.totalDuration.toFixed(1)} min, legs=[${finalRoute.legDurations.map(d => d.toFixed(1)).join(', ')}]`);
                let cumulativeMinutes = 0;
                for (let k = 0; k < taxiGroup.length; k++) {
                    const rideTime = finalRoute.totalDuration - cumulativeMinutes;
                    taxiGroup[k].delay = Math.max(
                        0,
                        Math.round((rideTime - taxiGroup[k].directTime) * 10) / 10
                    );
                    taxiGroup[k].pickupTime = subtractMinutesFromTime(bucketTime, rideTime);
                    console.log(`    ${taxiGroup[k].name}: rideTime=${rideTime.toFixed(1)} min, pickup=${taxiGroup[k].pickupTime}, delay=${taxiGroup[k].delay} min`);
                    if (k < finalRoute.legDurations.length) {
                        cumulativeMinutes += finalRoute.legDurations[k];
                    }
                }
            } else {
                console.warn(`  Final route status=${finalRoute.status} — using directTime fallback`);
                for (const p of taxiGroup) {
                    p.delay = 0;
                    p.pickupTime = subtractMinutesFromTime(bucketTime, p.directTime);
                }
            }
        }

        console.groupEnd();
        taxis.push({ passengers: taxiGroup, isSpecial: false, hasError: false });
    }

    console.log(`[ROUTING] greedyMatch done — ${taxis.length} taxis`);
    console.groupEnd();
    onProgress?.(`Done: ${taxis.length} taxis`);
    return taxis;
}

/**
 * Build a Date object for tomorrow at the given time string (HH:MM).
 */
function buildArrivalDate(timeStr) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(hours, minutes, 0, 0);
    return date;
}

const AUTO_MODE_THRESHOLD = 5;

/**
 * Determine effective algorithm mode for a bucket.
 * 'auto' uses greedy for small buckets and smart for larger ones.
 */
export function resolveMode(requested, passengerCount) {
    if (requested === 'greedy') return 'greedy';
    if (requested === 'smart') return 'smart';
    return passengerCount > AUTO_MODE_THRESHOLD ? 'smart' : 'greedy';
}

/**
 * Merge two taxis into one, recalculating route and pickup times.
 * This is a manual override — delay rules are NOT enforced.
 *
 * @param {Array} taxis - Current taxi assignments
 * @param {string} taxiId1 - First taxi to merge
 * @param {string} taxiId2 - Second taxi to merge
 * @param {string} destination - Set address
 * @param {string} mainTime - Main arrival time
 * @returns {Promise<{taxis: Array, errors: Array}>}
 */
export async function mergeTaxis(taxis, taxiId1, taxiId2, destination, mainTime) {
    const taxi1 = taxis.find(t => t.id === taxiId1);
    const taxi2 = taxis.find(t => t.id === taxiId2);

    console.group(`[MERGE] 🔀 mergeTaxis: ${taxiId1} + ${taxiId2} → "${destination}" @ ${mainTime}`);

    if (!taxi1 || !taxi2) {
        console.warn(`  ❌ One or both taxis not found — aborting`);
        console.groupEnd();
        return { taxis, errors: [] };
    }

    console.log(`  Taxi 1 (${taxiId1}): [${taxi1.passengers.map(p => `${p.name} direct=${p.directTime?.toFixed(1)}min`).join(', ')}]`);
    console.log(`  Taxi 2 (${taxiId2}): [${taxi2.passengers.map(p => `${p.name} direct=${p.directTime?.toFixed(1)}min`).join(', ')}]`);

    const mergedPassengers = [...taxi1.passengers, ...taxi2.passengers];
    const bucketTime = mergedPassengers[0].arrivalTime || mainTime;
    const arrivalDate = buildArrivalDate(bucketTime);

    const waypoints = [...mergedPassengers.map(p => p.address), destination];
    console.log(`  Merged waypoints: ${waypoints.join(' → ')}`);
    console.log(`  Bucket time: ${bucketTime}`);

    const routeResult = await getRouteDuration(waypoints, arrivalDate);
    console.log(`  Route result: status=${routeResult.status}, total=${routeResult.totalDuration?.toFixed(1)} min, legs=[${routeResult.legDurations?.map(d => d.toFixed(1)).join(', ')}]`);

    if (routeResult.status === 'OK' && routeResult.totalDuration !== null) {
        let cumulativeMinutes = 0;
        for (let k = 0; k < mergedPassengers.length; k++) {
            const p = mergedPassengers[k];
            const prevDelay = p.delay;
            const rideTime = routeResult.totalDuration - cumulativeMinutes;
            mergedPassengers[k].delay = Math.max(
                0,
                Math.round((rideTime - p.directTime) * 10) / 10
            );
            mergedPassengers[k].pickupTime = subtractMinutesFromTime(
                bucketTime,
                rideTime
            );
            console.log(`  ${p.name}: directTime=${p.directTime?.toFixed(1)} min, rideTime=${rideTime.toFixed(1)} min, delay=${prevDelay?.toFixed(1)}→${mergedPassengers[k].delay} min, pickup=${mergedPassengers[k].pickupTime}`);
            if (k < routeResult.legDurations.length) {
                cumulativeMinutes += routeResult.legDurations[k];
            }
        }
    } else {
        console.warn(`  ⚠️ Route failed (${routeResult.status}) — using directTime fallback`);
        for (const p of mergedPassengers) {
            p.delay = 0;
            p.pickupTime = subtractMinutesFromTime(bucketTime, p.directTime);
            console.log(`  ${p.name}: pickup=${p.pickupTime} (fallback)`);
        }
    }

    let updatedTaxis = taxis.filter(t => t.id !== taxiId1 && t.id !== taxiId2);
    const mergedTaxiId = `taxi-merge-${Date.now()}`;
    updatedTaxis.push({
        id: mergedTaxiId,
        number: updatedTaxis.length + 1,
        passengers: mergedPassengers,
        isSpecial: false,
        hasError: false,
    });

    updatedTaxis = updatedTaxis.map((t, idx) => ({ ...t, number: idx + 1 }));

    console.log(`  ✅ Merged into ${mergedTaxiId} — ${updatedTaxis.length} total taxis remaining`);
    console.groupEnd();

    return { taxis: updatedTaxis, errors: [] };
}

/**
 * Separate a passenger from their taxi and recalculate.
 *
 * @param {Array} taxis - Current taxi assignments
 * @param {string} taxiId - Taxi to modify
 * @param {string} passengerId - Passenger to separate
 * @param {string} destination - Set address
 * @param {string} mainTime - Main arrival time
 * @returns {Promise<{taxis: Array, errors: Array}>}
 */
export async function separatePassenger(taxis, taxiId, passengerId, destination, mainTime) {
    const targetTaxi = taxis.find(t => t.id === taxiId);
    if (!targetTaxi) return { taxis, errors: [] };

    const passengerToSeparate = targetTaxi.passengers.find(p => p.id === passengerId);
    if (!passengerToSeparate) return { taxis, errors: [] };

    const remainingInTaxi = targetTaxi.passengers.filter(p => p.id !== passengerId);

    let updatedTaxis = taxis.filter(t => t.id !== taxiId);

    if (remainingInTaxi.length > 0) {
        const bucketTime = remainingInTaxi[0].arrivalTime || mainTime;
        const arrivalDate = buildArrivalDate(bucketTime);
        const waypoints = [...remainingInTaxi.map(p => p.address), destination];
        const routeResult = await getRouteDuration(waypoints, arrivalDate);

        if (routeResult.status === 'OK' && routeResult.totalDuration !== null) {
            let cumulativeMinutes = 0;
            for (let k = 0; k < remainingInTaxi.length; k++) {
                const rideTime = routeResult.totalDuration - cumulativeMinutes;
                remainingInTaxi[k].delay = Math.max(
                    0,
                    Math.round((rideTime - remainingInTaxi[k].directTime) * 10) / 10
                );
                remainingInTaxi[k].pickupTime = subtractMinutesFromTime(
                    bucketTime,
                    rideTime
                );
                if (k < routeResult.legDurations.length) {
                    cumulativeMinutes += routeResult.legDurations[k];
                }
            }
        }

        updatedTaxis.push({
            ...targetTaxi,
            passengers: remainingInTaxi,
        });
    }

    const separatedBucketTime = passengerToSeparate.arrivalTime || mainTime;
    updatedTaxis.push({
        id: `taxi-sep-${Date.now()}`,
        number: updatedTaxis.length + 1,
        passengers: [{
            ...passengerToSeparate,
            delay: 0,
            pickupTime: passengerToSeparate.directTime
                ? subtractMinutesFromTime(separatedBucketTime, passengerToSeparate.directTime)
                : separatedBucketTime,
        }],
        isSpecial: false,
        hasError: false,
    });

    updatedTaxis = updatedTaxis.map((t, idx) => ({ ...t, number: idx + 1 }));

    return { taxis: updatedTaxis, errors: [] };
}

/**
 * Locally estimate merge result without calling the API.
 * Passengers are flagged isEstimated: true until refined.
 */
export function estimateMerge(taxis, taxiId1, taxiId2, mainTime) {
    const taxi1 = taxis.find(t => t.id === taxiId1);
    const taxi2 = taxis.find(t => t.id === taxiId2);
    if (!taxi1 || !taxi2) return { taxis, errors: [] };

    const mergedPassengers = [...taxi1.passengers, ...taxi2.passengers].map(p => ({ ...p }));
    const bucketTime = mergedPassengers[0].arrivalTime || mainTime;

    const maxDirectTime = Math.max(...mergedPassengers.map(p => p.directTime || 0));
    const estimatedTotal = maxDirectTime + (mergedPassengers.length - 1) * 5;

    for (const p of mergedPassengers) {
        p.delay = Math.max(0, Math.round((estimatedTotal - (p.directTime || 0)) * 10) / 10);
        p.pickupTime = subtractMinutesFromTime(bucketTime, p.directTime || 0);
        p.isEstimated = true;
    }

    let updatedTaxis = taxis.filter(t => t.id !== taxiId1 && t.id !== taxiId2);
    updatedTaxis.push({
        id: `taxi-merge-${Date.now()}`,
        number: updatedTaxis.length + 1,
        passengers: mergedPassengers,
        isSpecial: false,
        hasError: false,
    });

    updatedTaxis = updatedTaxis.map((t, idx) => ({ ...t, number: idx + 1 }));
    return { taxis: updatedTaxis, errors: [] };
}

/**
 * Locally estimate separate result without calling the API.
 * The separated solo passenger gets exact values; the remaining group is flagged estimated.
 */
export function estimateSeparate(taxis, taxiId, passengerId, mainTime) {
    const targetTaxi = taxis.find(t => t.id === taxiId);
    if (!targetTaxi) return { taxis, errors: [] };

    const passengerToSeparate = targetTaxi.passengers.find(p => p.id === passengerId);
    if (!passengerToSeparate) return { taxis, errors: [] };

    const remainingInTaxi = targetTaxi.passengers
        .filter(p => p.id !== passengerId)
        .map(p => ({ ...p, isEstimated: true }));

    let updatedTaxis = taxis.filter(t => t.id !== taxiId);

    if (remainingInTaxi.length > 0) {
        updatedTaxis.push({
            ...targetTaxi,
            passengers: remainingInTaxi,
        });
    }

    const separatedBucketTime = passengerToSeparate.arrivalTime || mainTime;
    updatedTaxis.push({
        id: `taxi-sep-${Date.now()}`,
        number: updatedTaxis.length + 1,
        passengers: [{
            ...passengerToSeparate,
            delay: 0,
            isEstimated: false,
            pickupTime: passengerToSeparate.directTime
                ? subtractMinutesFromTime(separatedBucketTime, passengerToSeparate.directTime)
                : separatedBucketTime,
        }],
        isSpecial: false,
        hasError: false,
    });

    updatedTaxis = updatedTaxis.map((t, idx) => ({ ...t, number: idx + 1 }));
    return { taxis: updatedTaxis, errors: [] };
}

/**
 * Refine all taxis that have estimated passengers by calling the Directions API.
 * Taxis without estimated passengers are left untouched.
 */
export async function refineTaxis(taxis, destination, mainTime) {
    const refined = [];

    for (const taxi of taxis) {
        const hasEstimated = taxi.passengers.some(p => p.isEstimated);
        if (!hasEstimated) {
            refined.push(taxi);
            continue;
        }

        const bucketTime = taxi.passengers[0].arrivalTime || mainTime;
        const arrivalDate = buildArrivalDate(bucketTime);
        let orderedPassengers = [...taxi.passengers];

        if (orderedPassengers.length >= 2) {
            const addresses = orderedPassengers.map(p => p.address);
            const directTimes = orderedPassengers.map(p => p.directTime);
            const pairMatrix = await getAllPairTravelTimes(addresses, arrivalDate);

            const indices = orderedPassengers.map((_, i) => i);
            const { bestOrder } = estimateGroupRoute(indices, pairMatrix, directTimes);
            orderedPassengers = bestOrder.map(idx => orderedPassengers[idx]);

            console.log(`[REFINE] Optimized order: ${orderedPassengers.map(p => p.name).join(' → ')}`);
        }

        const waypoints = [...orderedPassengers.map(p => p.address), destination];
        const routeResult = await getRouteDuration(waypoints, arrivalDate);

        const updatedPassengers = orderedPassengers.map(p => ({ ...p }));

        if (routeResult.status === 'OK' && routeResult.totalDuration !== null) {
            let cumulativeMinutes = 0;
            for (let k = 0; k < updatedPassengers.length; k++) {
                const rideTime = routeResult.totalDuration - cumulativeMinutes;
                updatedPassengers[k].delay = Math.max(
                    0,
                    Math.round((rideTime - updatedPassengers[k].directTime) * 10) / 10
                );
                updatedPassengers[k].pickupTime = subtractMinutesFromTime(
                    bucketTime,
                    rideTime
                );
                if (k < routeResult.legDurations.length) {
                    cumulativeMinutes += routeResult.legDurations[k];
                }
                updatedPassengers[k].isEstimated = false;
            }
        } else {
            for (const p of updatedPassengers) {
                p.pickupTime = subtractMinutesFromTime(bucketTime, p.directTime + (p.delay || 0));
                p.isEstimated = false;
            }
        }

        refined.push({ ...taxi, passengers: updatedPassengers });
    }

    return refined;
}
