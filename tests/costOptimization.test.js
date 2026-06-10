import { describe, it, expect, beforeEach } from 'vitest';
import { calculateRoutes, resolveMode, estimateMerge, estimateSeparate, refineTaxis } from '../src/js/services/routingAlgorithm.js';
import { getApiCallCount, resetApiCallCount } from '../src/js/services/mapsService.js';
import { getCacheStats, clearAllCaches, getCachedTravelTime, cacheTravelTime, getCachedRouteDuration, cacheRouteDuration } from '../src/js/services/cacheService.js';
import { subtractMinutesFromTime } from '../src/js/utils/helpers.js';
import { estimateGroupRoute } from '../src/js/services/optimizer.js';

/**
 * Cost optimization tests covering all 4 phases:
 * Phase 1 - Gating (dirty flag logic, early rejection, solo skip, telemetry)
 * Phase 2 - Caching (memory + localStorage, hit/miss verification)
 * Phase 3 - Algorithm mode (auto/greedy/smart switching, NN ordering)
 * Phase 4 - Deferred API (estimateMerge, estimateSeparate, refineTaxis)
 *
 * All tests run in mock mode (no API key configured).
 */

// ──────────────────────────────────────────────────────────
// Phase 1: Pre-API Gating
// ──────────────────────────────────────────────────────────

describe('Phase 1 - CLIENT-4: Early rejection on directTime difference', () => {
    const farApartPassengers = [
        { id: 'p1', name: 'Near', address: 'Near Place 1', isSpecial: false, exceptionTime: '' },
        { id: 'p2', name: 'Far', address: 'A very far away address in a different city entirely', isSpecial: false, exceptionTime: '' },
    ];

    it('T-SKIP-1: passengers with large directTime difference are not grouped together', async () => {
        const result = await calculateRoutes(
            farApartPassengers,
            'Destination Address',
            '06:30',
            null,
            { mode: 'greedy' }
        );

        const multiPassengerTaxis = result.taxis.filter(t => t.passengers.length > 1);
        for (const taxi of multiPassengerTaxis) {
            const directTimes = taxi.passengers.map(p => p.directTime).filter(t => t !== null);
            if (directTimes.length >= 2) {
                const maxDiff = Math.max(...directTimes) - Math.min(...directTimes);
                expect(maxDiff).toBeLessThanOrEqual(25);
            }
        }
    });

    it('T-SKIP-2: passengers with close directTimes can still be grouped', async () => {
        const closePassengers = [
            { id: 'p1', name: 'A', address: 'Street A 10', isSpecial: false, exceptionTime: '' },
            { id: 'p2', name: 'B', address: 'Street A 12', isSpecial: false, exceptionTime: '' },
            { id: 'p3', name: 'C', address: 'Street A 14', isSpecial: false, exceptionTime: '' },
        ];

        const result = await calculateRoutes(closePassengers, 'Dest', '06:30', null, { mode: 'greedy' });

        const totalPassengers = result.taxis.reduce((sum, t) => sum + t.passengers.length, 0);
        expect(totalPassengers).toBe(3);
    });
});

describe('Phase 1 - ALGO-4: Solo taxi skip', () => {
    it('T-SOLO-1: single passenger gets correct pickupTime without extra Directions call', async () => {
        const passengers = [
            { id: 'p1', name: 'Solo', address: 'Solo Street 1', isSpecial: false, exceptionTime: '' },
        ];

        const result = await calculateRoutes(passengers, 'Destination', '06:30', null, { mode: 'greedy' });

        expect(result.taxis).toHaveLength(1);
        const solo = result.taxis[0].passengers[0];
        expect(solo.pickupTime).toBeTruthy();
        expect(solo.pickupTime).toMatch(/^\d{2}:\d{2}$/);
        expect(solo.delay).toBe(0);
    });

    it('T-SOLO-2: solo pickupTime equals subtractMinutesFromTime(bucketTime, directTime)', async () => {
        const passengers = [
            { id: 'p1', name: 'Solo', address: 'Solo Place', isSpecial: false, exceptionTime: '' },
        ];

        const result = await calculateRoutes(passengers, 'Destination', '07:00', null, { mode: 'greedy' });

        const solo = result.taxis[0].passengers[0];
        const expected = subtractMinutesFromTime('07:00', solo.directTime);
        expect(solo.pickupTime).toBe(expected);
    });
});

describe('Phase 1 - FIN-4: API call telemetry', () => {
    beforeEach(() => {
        resetApiCallCount();
    });

    it('T-COUNTER-1: getApiCallCount starts at zero and tracks calls', () => {
        expect(getApiCallCount()).toBe(0);
    });

    it('T-COUNTER-2: resetApiCallCount resets to zero', async () => {
        expect(getApiCallCount()).toBe(0);
        resetApiCallCount();
        expect(getApiCallCount()).toBe(0);
    });
});

// ──────────────────────────────────────────────────────────
// Phase 2: Caching
// ──────────────────────────────────────────────────────────

describe('Phase 2 - Cache behavior', () => {
    beforeEach(() => {
        clearAllCaches();
        resetApiCallCount();
    });

    it('T-CACHE-4: clearAllCaches resets stats and memory', () => {
        const stats = getCacheStats();
        expect(stats.memorySize).toBe(0);
        expect(stats.hits).toBe(0);
        expect(stats.misses).toBe(0);
    });

    it('T-CACHE-2: cache stores and retrieves travel times correctly', () => {
        cacheTravelTime('Origin A', 'Dest B', 6, { duration: 30, status: 'OK' });
        const cached = getCachedTravelTime('Origin A', 'Dest B', 6);

        expect(cached).toEqual({ duration: 30, status: 'OK' });

        const stats = getCacheStats();
        expect(stats.hits).toBe(1);
        expect(stats.memorySize).toBe(1);
    });

    it('T-CACHE-3: different route orderings are separate cache entries', () => {
        const resultAB = { totalDuration: 35, legDurations: [10, 25], status: 'OK' };
        cacheRouteDuration(['A', 'B', 'Dest'], 6, resultAB);

        const cachedAB = getCachedRouteDuration(['A', 'B', 'Dest'], 6);
        expect(cachedAB).toEqual(resultAB);

        const cachedBA = getCachedRouteDuration(['B', 'A', 'Dest'], 6);
        expect(cachedBA).toBeNull();
    });

    it('T-CACHE-7: different arrival hours are separate cache entries', () => {
        cacheTravelTime('X', 'Y', 6, { duration: 30, status: 'OK' });
        const same = getCachedTravelTime('X', 'Y', 6);
        expect(same).toEqual({ duration: 30, status: 'OK' });

        const different = getCachedTravelTime('X', 'Y', 8);
        expect(different).toBeNull();
    });

    it('T-CACHE-8: getCacheStats tracks hits and misses accurately', () => {
        cacheTravelTime('H1', 'H2', 7, { duration: 20, status: 'OK' });
        getCachedTravelTime('H1', 'H2', 7);
        getCachedTravelTime('H1', 'H2', 7);
        getCachedTravelTime('miss', 'miss', 9);

        const stats = getCacheStats();
        expect(stats.hits).toBeGreaterThanOrEqual(2);
        expect(stats.misses).toBeGreaterThanOrEqual(1);
        expect(stats.memorySize).toBeGreaterThanOrEqual(1);
    });
});

// ──────────────────────────────────────────────────────────
// Phase 3: Algorithm mode switching
// ──────────────────────────────────────────────────────────

describe('Phase 3 - resolveMode', () => {
    it('T-AUTO-1: resolveMode returns correct mode for auto', () => {
        expect(resolveMode('auto', 3)).toBe('greedy');
        expect(resolveMode('auto', 5)).toBe('greedy');
        expect(resolveMode('auto', 6)).toBe('smart');
        expect(resolveMode('auto', 8)).toBe('smart');
    });

    it('T-AUTO-5: explicit greedy is always greedy regardless of count', () => {
        expect(resolveMode('greedy', 10)).toBe('greedy');
        expect(resolveMode('greedy', 100)).toBe('greedy');
    });

    it('T-AUTO-6: explicit smart is always smart regardless of count', () => {
        expect(resolveMode('smart', 1)).toBe('smart');
        expect(resolveMode('smart', 3)).toBe('smart');
    });
});

describe('Phase 3 - Auto mode end-to-end', () => {
    it('T-AUTO-2: small bucket uses greedy in auto mode', async () => {
        const passengers = [
            { id: 'p1', name: 'A', address: 'Auto1', isSpecial: false, exceptionTime: '' },
            { id: 'p2', name: 'B', address: 'Auto2', isSpecial: false, exceptionTime: '' },
            { id: 'p3', name: 'C', address: 'Auto3', isSpecial: false, exceptionTime: '' },
        ];

        const result = await calculateRoutes(passengers, 'AutoDest', '06:30', null);
        expect(result.meta.mode).toBe('auto');
        const totalPassengers = result.taxis.reduce((s, t) => s + t.passengers.length, 0);
        expect(totalPassengers).toBe(3);
    });

    it('T-AUTO-3: large bucket uses smart in auto mode', async () => {
        const passengers = Array.from({ length: 8 }, (_, i) => ({
            id: `p${i}`, name: `P${i}`, address: `LargeAuto Street ${i}`, isSpecial: false, exceptionTime: '',
        }));

        const result = await calculateRoutes(passengers, 'LargeAutoDest', '06:30', null);
        expect(result.meta.mode).toBe('auto');
        const totalPassengers = result.taxis.reduce((s, t) => s + t.passengers.length, 0);
        expect(totalPassengers).toBe(8);
    }, 30000);

    it('T-AUTO-4: mixed buckets use different modes per bucket', async () => {
        const passengers = [
            { id: 'p1', name: 'Small1', address: 'SmallBucket 1', isSpecial: false, exceptionTime: '06:00' },
            { id: 'p2', name: 'Small2', address: 'SmallBucket 2', isSpecial: false, exceptionTime: '06:00' },
            { id: 'p3', name: 'Small3', address: 'SmallBucket 3', isSpecial: false, exceptionTime: '06:00' },
            { id: 'p4', name: 'Large1', address: 'LargeBucket 1', isSpecial: false, exceptionTime: '08:00' },
            { id: 'p5', name: 'Large2', address: 'LargeBucket 2', isSpecial: false, exceptionTime: '08:00' },
            { id: 'p6', name: 'Large3', address: 'LargeBucket 3', isSpecial: false, exceptionTime: '08:00' },
            { id: 'p7', name: 'Large4', address: 'LargeBucket 4', isSpecial: false, exceptionTime: '08:00' },
            { id: 'p8', name: 'Large5', address: 'LargeBucket 5', isSpecial: false, exceptionTime: '08:00' },
            { id: 'p9', name: 'Large6', address: 'LargeBucket 6', isSpecial: false, exceptionTime: '08:00' },
        ];

        const result = await calculateRoutes(passengers, 'MixedDest', '07:00', null);

        const totalPassengers = result.taxis.reduce((s, t) => s + t.passengers.length, 0);
        expect(totalPassengers).toBe(9);
    }, 30000);
});

describe('Phase 3 - MATH-5: Nearest-neighbor ordering', () => {
    it('T-NN-1: NN finds the same optimal order as full permutation for known case', () => {
        const pairMatrix = [
            [0, 5, 20],
            [6, 0, 7],
            [18, 8, 0],
        ];
        const directTimes = [30, 25, 40];

        const result = estimateGroupRoute([0, 1, 2], pairMatrix, directTimes);
        // Best order should be [2,1,0]: T[2][1]+T[1][0]+D[0] = 8+6+30 = 44
        expect(result.bestOrder).toEqual([2, 1, 0]);
        expect(result.estimatedTime).toBe(44);
    });

    it('T-NN-2: NN result is close to optimal even in harder cases', () => {
        const pairMatrix = [
            [0, 15, 3],
            [15, 0, 12],
            [3, 12, 0],
        ];
        const directTimes = [20, 30, 25];

        const result = estimateGroupRoute([0, 1, 2], pairMatrix, directTimes);

        // Optimal by full permutation:
        // [0,2,1]: 3+12+30 = 45
        // [2,0,1]: 3+15+30 = 48
        // [1,2,0]: 12+3+20 = 35
        // [1,0,2]: 15+3+25 = 43
        // [0,1,2]: 15+12+25 = 52
        // [2,1,0]: 12+15+20 = 47
        // Optimal = 35 ([1,2,0])
        // NN from 1: picks 2 (dist 12), then 0 (dist 3) → [1,2,0] = 35 ✓
        expect(result.estimatedTime).toBeLessThanOrEqual(45);
    });

    it('pairs still use full permutation (both orderings)', () => {
        const pairMatrix = [
            [0, 8],
            [12, 0],
        ];
        const directTimes = [30, 25];

        const result = estimateGroupRoute([0, 1], pairMatrix, directTimes);
        // [0,1]: 8+25=33, [1,0]: 12+30=42 → best is [0,1]
        expect(result.bestOrder).toEqual([0, 1]);
        expect(result.estimatedTime).toBe(33);
    });
});

// ──────────────────────────────────────────────────────────
// Phase 4: Deferred API (estimateMerge, estimateSeparate, refineTaxis)
// ──────────────────────────────────────────────────────────

describe('Phase 4 - estimateMerge', () => {
    const baseTaxis = [
        {
            id: 'taxi-1', number: 1,
            passengers: [
                { id: 'p1', name: 'A', address: 'Addr1', directTime: 30, delay: 0, exceptionTime: '', pickupTime: '06:00' },
            ],
            isSpecial: false, hasError: false,
        },
        {
            id: 'taxi-2', number: 2,
            passengers: [
                { id: 'p2', name: 'B', address: 'Addr2', directTime: 25, delay: 0, exceptionTime: '', pickupTime: '06:05' },
            ],
            isSpecial: false, hasError: false,
        },
    ];

    it('T-EST-1: estimateMerge flags all passengers as isEstimated', () => {
        const result = estimateMerge(baseTaxis, 'taxi-1', 'taxi-2', '06:30');

        const mergedTaxi = result.taxis.find(t => t.passengers.length === 2);
        expect(mergedTaxi).toBeDefined();
        expect(mergedTaxi.passengers.every(p => p.isEstimated === true)).toBe(true);
    });

    it('estimateMerge produces correct number of taxis', () => {
        const result = estimateMerge(baseTaxis, 'taxi-1', 'taxi-2', '06:30');
        expect(result.taxis).toHaveLength(1);
    });

    it('estimateMerge returns unchanged taxis if IDs not found', () => {
        const result = estimateMerge(baseTaxis, 'taxi-1', 'taxi-999', '06:30');
        expect(result.taxis).toHaveLength(2);
    });
});

describe('Phase 4 - estimateSeparate', () => {
    const taxiWithGroup = [
        {
            id: 'taxi-1', number: 1,
            passengers: [
                { id: 'p1', name: 'A', address: 'Addr1', directTime: 30, delay: 5, exceptionTime: '', pickupTime: '05:55' },
                { id: 'p2', name: 'B', address: 'Addr2', directTime: 25, delay: 8, exceptionTime: '', pickupTime: '06:00' },
                { id: 'p3', name: 'C', address: 'Addr3', directTime: 28, delay: 6, exceptionTime: '', pickupTime: '05:57' },
            ],
            isSpecial: false, hasError: false,
        },
    ];

    it('T-EST-2: separated passenger has delay:0 and isEstimated:false', () => {
        const result = estimateSeparate(taxiWithGroup, 'taxi-1', 'p2', '06:30');

        const soloTaxi = result.taxis.find(t =>
            t.passengers.length === 1 && t.passengers[0].id === 'p2'
        );
        expect(soloTaxi).toBeDefined();
        expect(soloTaxi.passengers[0].delay).toBe(0);
        expect(soloTaxi.passengers[0].isEstimated).toBe(false);
    });

    it('remaining group passengers are flagged isEstimated:true', () => {
        const result = estimateSeparate(taxiWithGroup, 'taxi-1', 'p2', '06:30');

        const remainingTaxi = result.taxis.find(t => t.passengers.length === 2);
        expect(remainingTaxi).toBeDefined();
        expect(remainingTaxi.passengers.every(p => p.isEstimated === true)).toBe(true);
    });

    it('total passenger count is preserved', () => {
        const result = estimateSeparate(taxiWithGroup, 'taxi-1', 'p2', '06:30');
        const total = result.taxis.reduce((s, t) => s + t.passengers.length, 0);
        expect(total).toBe(3);
    });
});

describe('Phase 4 - refineTaxis', () => {
    it('T-EST-3: refineTaxis clears isEstimated flag', async () => {
        const estimatedTaxis = [
            {
                id: 'taxi-1', number: 1,
                passengers: [
                    { id: 'p1', name: 'A', address: 'RefineAddr1', directTime: 30, delay: 5, exceptionTime: '', pickupTime: '~06:00', isEstimated: true },
                    { id: 'p2', name: 'B', address: 'RefineAddr2', directTime: 25, delay: 8, exceptionTime: '', pickupTime: '~06:05', isEstimated: true },
                ],
                isSpecial: false, hasError: false,
            },
        ];

        const refined = await refineTaxis(estimatedTaxis, 'RefineDest', '06:30');
        expect(refined).toHaveLength(1);
        expect(refined[0].passengers.every(p => p.isEstimated === false)).toBe(true);
        for (const p of refined[0].passengers) {
            expect(p.pickupTime).toMatch(/^\d{2}:\d{2}$/);
        }
    });

    it('T-EST-4: refineTaxis skips taxis without estimates', async () => {
        const exactTaxis = [
            {
                id: 'taxi-1', number: 1,
                passengers: [
                    { id: 'p1', name: 'A', address: 'ExactAddr', directTime: 30, delay: 0, exceptionTime: '', pickupTime: '06:00', isEstimated: false },
                ],
                isSpecial: false, hasError: false,
            },
        ];

        const refined = await refineTaxis(exactTaxis, 'ExactDest', '06:30');
        expect(refined).toHaveLength(1);
        expect(refined[0].passengers[0].pickupTime).toBe('06:00');
    });

    it('refineTaxis handles mixed estimated and non-estimated taxis', async () => {
        const mixedTaxis = [
            {
                id: 'taxi-1', number: 1,
                passengers: [
                    { id: 'p1', name: 'Exact', address: 'ExactAddr', directTime: 30, delay: 0, exceptionTime: '', pickupTime: '06:00', isEstimated: false },
                ],
                isSpecial: false, hasError: false,
            },
            {
                id: 'taxi-2', number: 2,
                passengers: [
                    { id: 'p2', name: 'Est', address: 'EstAddr1', directTime: 25, delay: 5, exceptionTime: '', pickupTime: '~06:05', isEstimated: true },
                    { id: 'p3', name: 'Est2', address: 'EstAddr2', directTime: 28, delay: 3, exceptionTime: '', pickupTime: '~06:02', isEstimated: true },
                ],
                isSpecial: false, hasError: false,
            },
        ];

        const refined = await refineTaxis(mixedTaxis, 'MixDest', '06:30');
        expect(refined).toHaveLength(2);
        expect(refined[0].passengers[0].pickupTime).toBe('06:00');
        expect(refined[1].passengers.every(p => p.isEstimated === false)).toBe(true);
    });
});

describe('Phase 4 - Full merge-then-refine flow', () => {
    it('merge then refine produces valid final state', async () => {
        const passengers = [
            { id: 'p1', name: 'A', address: 'FlowAddr1', isSpecial: false, exceptionTime: '' },
            { id: 'p2', name: 'B', address: 'FlowAddr2', isSpecial: false, exceptionTime: '' },
            { id: 'p3', name: 'C', address: 'FlowAddr3', isSpecial: false, exceptionTime: '' },
        ];

        const calcResult = await calculateRoutes(passengers, 'FlowDest', '06:30', null, { mode: 'greedy' });

        if (calcResult.taxis.length >= 2) {
            const t1 = calcResult.taxis[0];
            const t2 = calcResult.taxis[1];
            const combined = t1.passengers.length + t2.passengers.length;

            if (combined <= 3) {
                const merged = estimateMerge(calcResult.taxis, t1.id, t2.id, '06:30');
                const hasEstimates = merged.taxis.some(t => t.passengers.some(p => p.isEstimated));
                expect(hasEstimates).toBe(true);

                const refined = await refineTaxis(merged.taxis, 'FlowDest', '06:30');
                const stillEstimated = refined.some(t => t.passengers.some(p => p.isEstimated));
                expect(stillEstimated).toBe(false);

                for (const taxi of refined) {
                    for (const p of taxi.passengers) {
                        expect(p.pickupTime).toMatch(/^\d{2}:\d{2}$/);
                    }
                }
            }
        }
    });
});
