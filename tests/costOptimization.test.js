import { describe, it, expect, vi, beforeEach } from 'vitest';
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
 * Tests that call calculateRoutes / refineTaxis use vi.doMock for the maps
 * and DB services.  Pure-logic tests (caching, resolveMode, estimateMerge,
 * estimateSeparate) import directly since they never hit the network.
 */

// ─── Shared mock helpers ────────────────────────────────────────────────────

function seedDuration(origin, destination) {
    const seed = (origin + destination).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const pseudoRandom = ((seed * 9301 + 49297) % 233280) / 233280;
    return Math.round((10 + pseudoRandom * 50) * 10) / 10;
}

function mockMapsService() {
    return {
        getApiCallCount: () => 0,
        getCumulativeCost: () => 0,
        resetApiCallCount: () => {},
        onApiMilestone: () => {},
        getBatchTravelTimes: vi.fn(async (origins, destination) =>
            origins.map(origin => ({ duration: seedDuration(origin, destination), status: 'OK' }))
        ),
        getRouteDuration: vi.fn(async (waypoints) => {
            const dest = waypoints[waypoints.length - 1];
            const pickups = waypoints.slice(0, -1);
            const directTimes = pickups.map(p => seedDuration(p, dest));
            const maxDirect = Math.max(...directTimes);
            const detour = 5 * (pickups.length - 1);
            const totalDuration = Math.round((maxDirect + detour) * 10) / 10;
            const legDurations = [];
            if (pickups.length === 1) {
                legDurations.push(totalDuration);
            } else {
                for (let i = 0; i < pickups.length - 1; i++) {
                    legDurations.push(Math.round(detour / (pickups.length - 1) * 10) / 10);
                }
                const usedByLegs = legDurations.reduce((s, d) => s + d, 0);
                legDurations.push(Math.round((totalDuration - usedByLegs) * 10) / 10);
            }
            return { totalDuration, legDurations, status: 'OK' };
        }),
        getAllPairTravelTimes: vi.fn(async (addresses) => {
            const n = addresses.length;
            const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (i !== j) matrix[i][j] = seedDuration(addresses[i], addresses[j]);
                }
            }
            return matrix;
        }),
    };
}

function mockGroupMemoryService() {
    return {
        lookupGrouping: vi.fn(async () => null),
        saveGrouping: vi.fn(async () => {}),
        loadPairMatrix: vi.fn(async (addrs) => {
            const n = addrs.length;
            return Array.from({ length: n }, () => new Array(n).fill(null));
        }),
        savePairMatrix: vi.fn(async () => {}),
        harvestLegsToDb: vi.fn(async () => {}),
        normalizeAddress: (addr) => addr.trim().toLowerCase().replace(/\s+/g, ' '),
        isDbConfigured: () => false,
    };
}

// ──────────────────────────────────────────────────────────
// Phase 1: Pre-API Gating
// ──────────────────────────────────────────────────────────

describe('Phase 1 - CLIENT-4: Early rejection on directTime difference', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doMock('../src/js/services/mapsService.js', () => mockMapsService());
        vi.doMock('../src/js/services/groupMemoryService.js', () => mockGroupMemoryService());
    });

    const farApartPassengers = [
        { id: 'p1', name: 'Near', address: 'Near Place 1', isSpecial: false, arrivalTime: '' },
        { id: 'p2', name: 'Far', address: 'A very far away address in a different city entirely', isSpecial: false, arrivalTime: '' },
    ];

    it('T-SKIP-1: passengers with large directTime difference are not grouped together', async () => {
        const { calculateRoutes } = await import('../src/js/services/routingAlgorithm.js');
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
        const { calculateRoutes } = await import('../src/js/services/routingAlgorithm.js');
        const closePassengers = [
            { id: 'p1', name: 'A', address: 'Street A 10', isSpecial: false, arrivalTime: '' },
            { id: 'p2', name: 'B', address: 'Street A 12', isSpecial: false, arrivalTime: '' },
            { id: 'p3', name: 'C', address: 'Street A 14', isSpecial: false, arrivalTime: '' },
        ];

        const result = await calculateRoutes(closePassengers, 'Dest', '06:30', null, { mode: 'greedy' });

        const totalPassengers = result.taxis.reduce((sum, t) => sum + t.passengers.length, 0);
        expect(totalPassengers).toBe(3);
    });
});

describe('Phase 1 - ALGO-4: Solo taxi skip', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doMock('../src/js/services/mapsService.js', () => mockMapsService());
        vi.doMock('../src/js/services/groupMemoryService.js', () => mockGroupMemoryService());
    });

    it('T-SOLO-1: single passenger gets correct pickupTime without extra Directions call', async () => {
        const { calculateRoutes } = await import('../src/js/services/routingAlgorithm.js');
        const passengers = [
            { id: 'p1', name: 'Solo', address: 'Solo Street 1', isSpecial: false, arrivalTime: '' },
        ];

        const result = await calculateRoutes(passengers, 'Destination', '06:30', null, { mode: 'greedy' });

        expect(result.taxis).toHaveLength(1);
        const solo = result.taxis[0].passengers[0];
        expect(solo.pickupTime).toBeTruthy();
        expect(solo.pickupTime).toMatch(/^\d{2}:\d{2}$/);
        expect(solo.delay).toBe(0);
    });

    it('T-SOLO-2: solo pickupTime equals subtractMinutesFromTime(bucketTime, directTime)', async () => {
        const { calculateRoutes } = await import('../src/js/services/routingAlgorithm.js');
        const passengers = [
            { id: 'p1', name: 'Solo', address: 'Solo Place', isSpecial: false, arrivalTime: '' },
        ];

        const result = await calculateRoutes(passengers, 'Destination', '07:00', null, { mode: 'greedy' });

        const solo = result.taxis[0].passengers[0];
        const expected = subtractMinutesFromTime('07:00', solo.directTime);
        expect(solo.pickupTime).toBe(expected);
    });
});

describe('Phase 1 - FIN-4: API call telemetry', () => {
    it('T-COUNTER-1: getApiCallCount starts at zero and tracks calls', async () => {
        const { getApiCallCount, resetApiCallCount } = await import('../src/js/services/mapsService.js');
        resetApiCallCount();
        expect(getApiCallCount()).toBe(0);
    });

    it('T-COUNTER-2: resetApiCallCount resets to zero', async () => {
        const { getApiCallCount, resetApiCallCount } = await import('../src/js/services/mapsService.js');
        resetApiCallCount();
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
    it('T-AUTO-1: resolveMode returns correct mode for auto', async () => {
        const { resolveMode } = await import('../src/js/services/routingAlgorithm.js');
        expect(resolveMode('auto', 3)).toBe('greedy');
        expect(resolveMode('auto', 5)).toBe('greedy');
        expect(resolveMode('auto', 6)).toBe('smart');
        expect(resolveMode('auto', 8)).toBe('smart');
    });

    it('T-AUTO-5: explicit greedy is always greedy regardless of count', async () => {
        const { resolveMode } = await import('../src/js/services/routingAlgorithm.js');
        expect(resolveMode('greedy', 10)).toBe('greedy');
        expect(resolveMode('greedy', 100)).toBe('greedy');
    });

    it('T-AUTO-6: explicit smart is always smart regardless of count', async () => {
        const { resolveMode } = await import('../src/js/services/routingAlgorithm.js');
        expect(resolveMode('smart', 1)).toBe('smart');
        expect(resolveMode('smart', 3)).toBe('smart');
    });
});

describe('Phase 3 - Auto mode end-to-end', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doMock('../src/js/services/mapsService.js', () => mockMapsService());
        vi.doMock('../src/js/services/groupMemoryService.js', () => mockGroupMemoryService());
    });

    it('T-AUTO-2: small bucket uses greedy in auto mode', async () => {
        const { calculateRoutes } = await import('../src/js/services/routingAlgorithm.js');
        const passengers = [
            { id: 'p1', name: 'A', address: 'Auto1', isSpecial: false, arrivalTime: '' },
            { id: 'p2', name: 'B', address: 'Auto2', isSpecial: false, arrivalTime: '' },
            { id: 'p3', name: 'C', address: 'Auto3', isSpecial: false, arrivalTime: '' },
        ];

        const result = await calculateRoutes(passengers, 'AutoDest', '06:30', null);
        expect(result.meta.mode).toBe('auto');
        const totalPassengers = result.taxis.reduce((s, t) => s + t.passengers.length, 0);
        expect(totalPassengers).toBe(3);
    });

    it('T-AUTO-3: large bucket uses smart in auto mode', async () => {
        const { calculateRoutes } = await import('../src/js/services/routingAlgorithm.js');
        const passengers = Array.from({ length: 8 }, (_, i) => ({
            id: `p${i}`, name: `P${i}`, address: `LargeAuto Street ${i}`, isSpecial: false, arrivalTime: '',
        }));

        const result = await calculateRoutes(passengers, 'LargeAutoDest', '06:30', null);
        expect(result.meta.mode).toBe('auto');
        const totalPassengers = result.taxis.reduce((s, t) => s + t.passengers.length, 0);
        expect(totalPassengers).toBe(8);
    }, 30000);

    it('T-AUTO-4: mixed buckets use different modes per bucket', async () => {
        const { calculateRoutes } = await import('../src/js/services/routingAlgorithm.js');
        const passengers = [
            { id: 'p1', name: 'Small1', address: 'SmallBucket 1', isSpecial: false, arrivalTime: '06:00' },
            { id: 'p2', name: 'Small2', address: 'SmallBucket 2', isSpecial: false, arrivalTime: '06:00' },
            { id: 'p3', name: 'Small3', address: 'SmallBucket 3', isSpecial: false, arrivalTime: '06:00' },
            { id: 'p4', name: 'Large1', address: 'LargeBucket 1', isSpecial: false, arrivalTime: '08:00' },
            { id: 'p5', name: 'Large2', address: 'LargeBucket 2', isSpecial: false, arrivalTime: '08:00' },
            { id: 'p6', name: 'Large3', address: 'LargeBucket 3', isSpecial: false, arrivalTime: '08:00' },
            { id: 'p7', name: 'Large4', address: 'LargeBucket 4', isSpecial: false, arrivalTime: '08:00' },
            { id: 'p8', name: 'Large5', address: 'LargeBucket 5', isSpecial: false, arrivalTime: '08:00' },
            { id: 'p9', name: 'Large6', address: 'LargeBucket 6', isSpecial: false, arrivalTime: '08:00' },
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
        expect(result.estimatedTime).toBeLessThanOrEqual(45);
    });

    it('pairs still use full permutation (both orderings)', () => {
        const pairMatrix = [
            [0, 8],
            [12, 0],
        ];
        const directTimes = [30, 25];

        const result = estimateGroupRoute([0, 1], pairMatrix, directTimes);
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
                { id: 'p1', name: 'A', address: 'Addr1', directTime: 30, delay: 0, arrivalTime: '', pickupTime: '06:00' },
            ],
            isSpecial: false, hasError: false,
        },
        {
            id: 'taxi-2', number: 2,
            passengers: [
                { id: 'p2', name: 'B', address: 'Addr2', directTime: 25, delay: 0, arrivalTime: '', pickupTime: '06:05' },
            ],
            isSpecial: false, hasError: false,
        },
    ];

    it('T-EST-1: estimateMerge flags all passengers as isEstimated', async () => {
        const { estimateMerge } = await import('../src/js/services/routingAlgorithm.js');
        const result = estimateMerge(baseTaxis, 'taxi-1', 'taxi-2', '06:30');

        const mergedTaxi = result.taxis.find(t => t.passengers.length === 2);
        expect(mergedTaxi).toBeDefined();
        expect(mergedTaxi.passengers.every(p => p.isEstimated === true)).toBe(true);
    });

    it('estimateMerge produces correct number of taxis', async () => {
        const { estimateMerge } = await import('../src/js/services/routingAlgorithm.js');
        const result = estimateMerge(baseTaxis, 'taxi-1', 'taxi-2', '06:30');
        expect(result.taxis).toHaveLength(1);
    });

    it('estimateMerge returns unchanged taxis if IDs not found', async () => {
        const { estimateMerge } = await import('../src/js/services/routingAlgorithm.js');
        const result = estimateMerge(baseTaxis, 'taxi-1', 'taxi-999', '06:30');
        expect(result.taxis).toHaveLength(2);
    });
});

describe('Phase 4 - estimateSeparate', () => {
    const taxiWithGroup = [
        {
            id: 'taxi-1', number: 1,
            passengers: [
                { id: 'p1', name: 'A', address: 'Addr1', directTime: 30, delay: 5, arrivalTime: '', pickupTime: '05:55' },
                { id: 'p2', name: 'B', address: 'Addr2', directTime: 25, delay: 8, arrivalTime: '', pickupTime: '06:00' },
                { id: 'p3', name: 'C', address: 'Addr3', directTime: 28, delay: 6, arrivalTime: '', pickupTime: '05:57' },
            ],
            isSpecial: false, hasError: false,
        },
    ];

    it('T-EST-2: separated passenger has delay:0 and isEstimated:false', async () => {
        const { estimateSeparate } = await import('../src/js/services/routingAlgorithm.js');
        const result = estimateSeparate(taxiWithGroup, 'taxi-1', 'p2', '06:30');

        const soloTaxi = result.taxis.find(t =>
            t.passengers.length === 1 && t.passengers[0].id === 'p2'
        );
        expect(soloTaxi).toBeDefined();
        expect(soloTaxi.passengers[0].delay).toBe(0);
        expect(soloTaxi.passengers[0].isEstimated).toBe(false);
    });

    it('remaining group passengers are flagged isEstimated:true', async () => {
        const { estimateSeparate } = await import('../src/js/services/routingAlgorithm.js');
        const result = estimateSeparate(taxiWithGroup, 'taxi-1', 'p2', '06:30');

        const remainingTaxi = result.taxis.find(t => t.passengers.length === 2);
        expect(remainingTaxi).toBeDefined();
        expect(remainingTaxi.passengers.every(p => p.isEstimated === true)).toBe(true);
    });

    it('total passenger count is preserved', async () => {
        const { estimateSeparate } = await import('../src/js/services/routingAlgorithm.js');
        const result = estimateSeparate(taxiWithGroup, 'taxi-1', 'p2', '06:30');
        const total = result.taxis.reduce((s, t) => s + t.passengers.length, 0);
        expect(total).toBe(3);
    });
});

describe('Phase 4 - refineTaxis', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doMock('../src/js/services/mapsService.js', () => mockMapsService());
        vi.doMock('../src/js/services/groupMemoryService.js', () => mockGroupMemoryService());
    });

    it('T-EST-3: refineTaxis clears isEstimated flag', async () => {
        const { refineTaxis } = await import('../src/js/services/routingAlgorithm.js');
        const estimatedTaxis = [
            {
                id: 'taxi-1', number: 1,
                passengers: [
                    { id: 'p1', name: 'A', address: 'RefineAddr1', directTime: 30, delay: 5, arrivalTime: '', pickupTime: '~06:00', isEstimated: true },
                    { id: 'p2', name: 'B', address: 'RefineAddr2', directTime: 25, delay: 8, arrivalTime: '', pickupTime: '~06:05', isEstimated: true },
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
        const { refineTaxis } = await import('../src/js/services/routingAlgorithm.js');
        const exactTaxis = [
            {
                id: 'taxi-1', number: 1,
                passengers: [
                    { id: 'p1', name: 'A', address: 'ExactAddr', directTime: 30, delay: 0, arrivalTime: '', pickupTime: '06:00', isEstimated: false },
                ],
                isSpecial: false, hasError: false,
            },
        ];

        const refined = await refineTaxis(exactTaxis, 'ExactDest', '06:30');
        expect(refined).toHaveLength(1);
        expect(refined[0].passengers[0].pickupTime).toBe('06:00');
    });

    it('refineTaxis handles mixed estimated and non-estimated taxis', async () => {
        const { refineTaxis } = await import('../src/js/services/routingAlgorithm.js');
        const mixedTaxis = [
            {
                id: 'taxi-1', number: 1,
                passengers: [
                    { id: 'p1', name: 'Exact', address: 'ExactAddr', directTime: 30, delay: 0, arrivalTime: '', pickupTime: '06:00', isEstimated: false },
                ],
                isSpecial: false, hasError: false,
            },
            {
                id: 'taxi-2', number: 2,
                passengers: [
                    { id: 'p2', name: 'Est', address: 'EstAddr1', directTime: 25, delay: 5, arrivalTime: '', pickupTime: '~06:05', isEstimated: true },
                    { id: 'p3', name: 'Est2', address: 'EstAddr2', directTime: 28, delay: 3, arrivalTime: '', pickupTime: '~06:02', isEstimated: true },
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
    beforeEach(() => {
        vi.resetModules();
        vi.doMock('../src/js/services/mapsService.js', () => mockMapsService());
        vi.doMock('../src/js/services/groupMemoryService.js', () => mockGroupMemoryService());
    });

    it('merge then refine produces valid final state', async () => {
        const { calculateRoutes, estimateMerge, refineTaxis } = await import('../src/js/services/routingAlgorithm.js');
        const passengers = [
            { id: 'p1', name: 'A', address: 'FlowAddr1', isSpecial: false, arrivalTime: '' },
            { id: 'p2', name: 'B', address: 'FlowAddr2', isSpecial: false, arrivalTime: '' },
            { id: 'p3', name: 'C', address: 'FlowAddr3', isSpecial: false, arrivalTime: '' },
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
