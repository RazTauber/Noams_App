import { ALGORITHM_CONFIG } from '../utils/constants.js';
import { groupByTimeBucket, subtractMinutesFromTime } from '../utils/helpers.js';
import { getBatchTravelTimes, getRouteDuration, getAllPairTravelTimes } from './mapsService.js';
import { enumerateValidGroups, solveOptimalGrouping } from './optimizer.js';
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
 * @param {string} [options.mode='auto'] - 'greedy', 'smart', or 'auto' (auto-selects based on bucket size)
 * @returns {Promise<{taxis: Array, errors: Array, meta?: object}>}
 */
export async function calculateRoutes(passengers, destination, mainTime, onProgress, options = {}) {
    const { mode = 'auto' } = options;
    const taxis = [];
    const errors = [];
    let taxiCounter = 0;

    onProgress?.('Separating special passengers...');

    const specialPassengers = passengers.filter(p => p.isSpecial);
    const regularPassengers = passengers.filter(p => !p.isSpecial);

    if (specialPassengers.length > 0) {
        const specialBuckets = groupByTimeBucket(specialPassengers, mainTime);
        for (const [bucketTime, bucketSpecials] of specialBuckets) {
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
                taxis.push({
                    id: `taxi-${taxiCounter}`,
                    number: taxiCounter,
                    passengers: [{
                        ...passenger,
                        directTime,
                        delay: 0,
                        pickupTime: directTime
                            ? subtractMinutesFromTime(bucketTime, directTime)
                            : bucketTime,
                    }],
                    isSpecial: true,
                });
            }
        }
    }

    onProgress?.('Grouping by time buckets...');
    const timeBuckets = groupByTimeBucket(regularPassengers, mainTime);
    let meta = { mode, totalDirectionsCalls: 0, totalMatrixElements: 0 };

    for (const [bucketTime, bucketPassengers] of timeBuckets) {
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

        const addressErrors = passengersWithTimes.filter(p => p.apiStatus !== 'OK');
        for (const errPassenger of addressErrors) {
            taxiCounter++;
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
        let bucketTaxis;
        if (effectiveMode === 'smart') {
            const result = await smartMatch(validPassengers, destination, arrivalDate, bucketTime, onProgress);
            bucketTaxis = result.taxis;
            meta.totalDirectionsCalls += result.directionsCalls;
            meta.totalMatrixElements += result.matrixElements;
        } else {
            bucketTaxis = await greedyMatch(validPassengers, destination, arrivalDate, bucketTime, onProgress);
        }

        for (const taxi of bucketTaxis) {
            taxiCounter++;
            taxis.push({ ...taxi, id: `taxi-${taxiCounter}`, number: taxiCounter });
        }
    }

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

    if (n <= 1) {
        const solo = passengers[0];
        return {
            taxis: [{
                passengers: [{
                    ...solo,
                    delay: 0,
                    pickupTime: subtractMinutesFromTime(bucketTime, solo.directTime),
                }],
                isSpecial: false,
                hasError: false,
            }],
            directionsCalls: 0,
            matrixElements: 0,
        };
    }

    const addresses = passengers.map(p => p.address);

    // ── Path A: grouping memory ───────────────────────────────────────────────
    onProgress?.(`Checking grouping memory...`);
    const savedGrouping = await lookupGrouping(destination, arrivalDate.getHours(), addresses);

    if (savedGrouping) {
        onProgress?.(`Saved grouping found — fetching fresh route times...`);
        const memoryResult = await buildTaxisFromSavedGrouping(
            savedGrouping, passengers, destination, arrivalDate, bucketTime
        );
        if (memoryResult) {
            onProgress?.(`Done: ${memoryResult.taxis.length} taxis (from memory, ${memoryResult.directionsCalls} API calls)`);
            return { taxis: memoryResult.taxis, directionsCalls: memoryResult.directionsCalls, matrixElements: 0 };
        }
        // Address mismatch on restore — fall through to full solve
        onProgress?.(`Memory grouping could not be applied — running full solve...`);
    }

    // ── Path B: full solve ────────────────────────────────────────────────────
    onProgress?.(`Building distance matrix (${n} addresses)...`);
    const pairMatrix = await getAllPairTravelTimes(addresses, arrivalDate);
    const matrixElements = n * n;

    onProgress?.(`Calculating possible combinations...`);
    const directTimes = passengers.map(p => p.directTime);
    const validGroups = enumerateValidGroups(n, pairMatrix, directTimes);

    onProgress?.(`Solving optimization (${validGroups.length} combinations)...`);
    const { selectedGroups, solverStatus } = await solveOptimalGrouping(validGroups, n);

    if (!selectedGroups) {
        onProgress?.(`Optimization failed (${solverStatus}), falling back to greedy algorithm...`);
        const fallback = await greedyMatch(passengers, destination, arrivalDate, bucketTime, onProgress);
        return { taxis: fallback, directionsCalls: 0, matrixElements };
    }

    onProgress?.(`Calculating final routes (${selectedGroups.length} taxis)...`);
    const taxis = [];
    let directionsCalls = 0;

    for (const group of selectedGroups) {
        const groupPassengers = group.bestOrder.map(idx => passengers[idx]);

        if (groupPassengers.length === 1) {
            const solo = groupPassengers[0];
            taxis.push({
                passengers: [{
                    ...solo,
                    delay: 0,
                    pickupTime: subtractMinutesFromTime(bucketTime, solo.directTime),
                }],
                isSpecial: false,
                hasError: false,
            });
            continue;
        }

        const waypoints = [...groupPassengers.map(p => p.address), destination];
        const routeResult = await getRouteDuration(waypoints, arrivalDate);
        directionsCalls++;

        const taxiGroup = [];
        if (routeResult.status === 'OK' && routeResult.totalDuration !== null) {
            let cumulativeMinutes = 0;
            for (let k = 0; k < groupPassengers.length; k++) {
                const p = groupPassengers[k];
                const delay = Math.max(0, Math.round((routeResult.totalDuration - p.directTime) * 10) / 10);
                const pickupTime = subtractMinutesFromTime(bucketTime, routeResult.totalDuration - cumulativeMinutes);
                taxiGroup.push({ ...p, delay, pickupTime });
                if (k < routeResult.legDurations.length) {
                    cumulativeMinutes += routeResult.legDurations[k];
                }
            }
        } else {
            for (const p of groupPassengers) {
                taxiGroup.push({
                    ...p,
                    delay: Math.max(0, Math.round((group.estimatedTime - p.directTime) * 10) / 10),
                    pickupTime: subtractMinutesFromTime(bucketTime, p.directTime),
                });
            }
        }

        taxis.push({ passengers: taxiGroup, isSpecial: false, hasError: false });
    }

    // ── Persist grouping for future sessions ──────────────────────────────────
    const groupingToSave = selectedGroups.map(group =>
        group.bestOrder.map(idx => passengers[idx].address)
    );
    saveGrouping(destination, arrivalDate.getHours(), addresses, groupingToSave); // fire-and-forget

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

    for (const groupAddresses of savedGrouping) {
        const groupPassengers = groupAddresses
            .map(addr => normMap.get(normalizeAddress(addr)))
            .filter(Boolean);

        if (groupPassengers.length === 0) continue;
        for (const p of groupPassengers) assignedIds.add(p.id);

        if (groupPassengers.length === 1) {
            const solo = groupPassengers[0];
            taxis.push({
                passengers: [{
                    ...solo,
                    delay: 0,
                    pickupTime: subtractMinutesFromTime(bucketTime, solo.directTime),
                }],
                isSpecial: false,
                hasError: false,
            });
            continue;
        }

        // Always fetch a fresh route — respects today's traffic
        const waypoints = [...groupPassengers.map(p => p.address), destination];
        const routeResult = await getRouteDuration(waypoints, arrivalDate);
        directionsCalls++;

        const taxiGroup = [];
        if (routeResult.status === 'OK' && routeResult.totalDuration !== null) {
            let cumulativeMinutes = 0;
            for (let k = 0; k < groupPassengers.length; k++) {
                const p = groupPassengers[k];
                const delay = Math.max(0, Math.round((routeResult.totalDuration - p.directTime) * 10) / 10);
                const pickupTime = subtractMinutesFromTime(bucketTime, routeResult.totalDuration - cumulativeMinutes);
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

    // If not all passengers were covered the saved grouping is stale — re-solve
    if (assignedIds.size !== passengers.length) return null;

    return { taxis, directionsCalls };
}

/**
 * Greedy matching algorithm for a single time bucket.
 */
async function greedyMatch(passengers, destination, arrivalDate, bucketTime, onProgress) {
    const { MAX_PASSENGERS_PER_TAXI } = ALGORITHM_CONFIG;
    const assigned = new Set();
    const taxis = [];

    for (let i = 0; i < passengers.length; i++) {
        if (assigned.has(i)) continue;

        const anchor = passengers[i];
        const taxiGroup = [{ ...anchor, delay: 0 }];
        assigned.add(i);

        for (let j = i + 1; j < passengers.length; j++) {
            if (assigned.has(j)) continue;
            if (taxiGroup.length >= MAX_PASSENGERS_PER_TAXI) break;

            const candidate = passengers[j];

            const timeDiff = Math.abs(candidate.directTime - anchor.directTime);
            if (timeDiff > ALGORITHM_CONFIG.HARD_CAP_MINUTES) continue;

            const waypoints = [
                ...taxiGroup.map(p => p.address),
                candidate.address,
                destination,
            ];

            const routeResult = await getRouteDuration(waypoints, arrivalDate);

            if (routeResult.status !== 'OK' || routeResult.totalDuration === null) {
                continue;
            }

            const maxDirectTime = Math.max(
                ...taxiGroup.map(p => p.directTime),
                candidate.directTime
            );
            const additionalDelay = routeResult.totalDuration - maxDirectTime;

            const worstDelay = Math.max(
                ...taxiGroup.map(p => {
                    const personalDelay = routeResult.totalDuration - p.directTime;
                    return personalDelay;
                }),
                routeResult.totalDuration - candidate.directTime
            );

            let allApproved = true;
            for (const existing of taxiGroup) {
                const personalDelay = routeResult.totalDuration - existing.directTime;
                const evaluation = evaluateDelay(existing.directTime, Math.max(0, personalDelay));
                if (!evaluation.approved) {
                    allApproved = false;
                    break;
                }
            }

            if (allApproved) {
                const candidateDelay = routeResult.totalDuration - candidate.directTime;
                const candidateEval = evaluateDelay(candidate.directTime, Math.max(0, candidateDelay));
                if (candidateEval.approved) {
                    assigned.add(j);
                    taxiGroup.push({
                        ...candidate,
                        delay: Math.max(0, Math.round(candidateDelay * 10) / 10),
                    });

                    for (let k = 0; k < taxiGroup.length - 1; k++) {
                        taxiGroup[k].delay = Math.max(
                            0,
                            Math.round((routeResult.totalDuration - taxiGroup[k].directTime) * 10) / 10
                        );
                    }
                }
            }
        }

        if (taxiGroup.length === 1) {
            taxiGroup[0].pickupTime = subtractMinutesFromTime(bucketTime, taxiGroup[0].directTime);
        } else {
            const finalWaypoints = [...taxiGroup.map(p => p.address), destination];
            const finalRoute = await getRouteDuration(finalWaypoints, arrivalDate);

            if (finalRoute.status === 'OK' && finalRoute.legDurations.length > 0) {
                let cumulativeMinutes = 0;
                for (let k = 0; k < taxiGroup.length; k++) {
                    const minutesFromStart = cumulativeMinutes;
                    const totalRouteMinutes = finalRoute.totalDuration;
                    taxiGroup[k].pickupTime = subtractMinutesFromTime(bucketTime, totalRouteMinutes - minutesFromStart);
                    if (k < finalRoute.legDurations.length) {
                        cumulativeMinutes += finalRoute.legDurations[k];
                    }
                }
            } else {
                for (const p of taxiGroup) {
                    p.pickupTime = subtractMinutesFromTime(bucketTime, p.directTime + (p.delay || 0));
                }
            }
        }

        taxis.push({ passengers: taxiGroup, isSpecial: false, hasError: false });
    }

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
    if (!taxi1 || !taxi2) return { taxis, errors: [] };

    const mergedPassengers = [...taxi1.passengers, ...taxi2.passengers];
    const bucketTime = mergedPassengers[0].exceptionTime || mainTime;
    const arrivalDate = buildArrivalDate(bucketTime);

    const waypoints = [...mergedPassengers.map(p => p.address), destination];
    const routeResult = await getRouteDuration(waypoints, arrivalDate);

    if (routeResult.status === 'OK' && routeResult.totalDuration !== null) {
        let cumulativeMinutes = 0;
        for (let k = 0; k < mergedPassengers.length; k++) {
            mergedPassengers[k].delay = Math.max(
                0,
                Math.round((routeResult.totalDuration - mergedPassengers[k].directTime) * 10) / 10
            );
            const minutesFromStart = cumulativeMinutes;
            mergedPassengers[k].pickupTime = subtractMinutesFromTime(
                bucketTime,
                routeResult.totalDuration - minutesFromStart
            );
            if (k < routeResult.legDurations.length) {
                cumulativeMinutes += routeResult.legDurations[k];
            }
        }
    } else {
        for (const p of mergedPassengers) {
            p.pickupTime = subtractMinutesFromTime(bucketTime, p.directTime + (p.delay || 0));
        }
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
        const bucketTime = remainingInTaxi[0].exceptionTime || mainTime;
        const arrivalDate = buildArrivalDate(bucketTime);
        const waypoints = [...remainingInTaxi.map(p => p.address), destination];
        const routeResult = await getRouteDuration(waypoints, arrivalDate);

        if (routeResult.status === 'OK' && routeResult.totalDuration !== null) {
            let cumulativeMinutes = 0;
            for (let k = 0; k < remainingInTaxi.length; k++) {
                remainingInTaxi[k].delay = Math.max(
                    0,
                    Math.round((routeResult.totalDuration - remainingInTaxi[k].directTime) * 10) / 10
                );
                const minutesFromStart = cumulativeMinutes;
                remainingInTaxi[k].pickupTime = subtractMinutesFromTime(
                    bucketTime,
                    routeResult.totalDuration - minutesFromStart
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

    const separatedBucketTime = passengerToSeparate.exceptionTime || mainTime;
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
    const bucketTime = mergedPassengers[0].exceptionTime || mainTime;

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

    const separatedBucketTime = passengerToSeparate.exceptionTime || mainTime;
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

        const bucketTime = taxi.passengers[0].exceptionTime || mainTime;
        const arrivalDate = buildArrivalDate(bucketTime);
        const waypoints = [...taxi.passengers.map(p => p.address), destination];
        const routeResult = await getRouteDuration(waypoints, arrivalDate);

        const updatedPassengers = taxi.passengers.map(p => ({ ...p }));

        if (routeResult.status === 'OK' && routeResult.totalDuration !== null) {
            let cumulativeMinutes = 0;
            for (let k = 0; k < updatedPassengers.length; k++) {
                updatedPassengers[k].delay = Math.max(
                    0,
                    Math.round((routeResult.totalDuration - updatedPassengers[k].directTime) * 10) / 10
                );
                const minutesFromStart = cumulativeMinutes;
                updatedPassengers[k].pickupTime = subtractMinutesFromTime(
                    bucketTime,
                    routeResult.totalDuration - minutesFromStart
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
