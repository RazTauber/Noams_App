import { describe, it, expect, vi, beforeEach } from 'vitest';
import { estimateGroupRoute, enumerateValidGroups, solveOptimalGrouping } from '../src/js/services/optimizer.js';
import { evaluateDelay } from '../src/js/services/delayEvaluator.js';

describe('Smart Algorithm - estimateGroupRoute', () => {

    it('returns direct time for a single passenger', () => {
        const pairMatrix = [[0]];
        const directTimes = [30];
        const result = estimateGroupRoute([0], pairMatrix, directTimes);
        expect(result.bestOrder).toEqual([0]);
        expect(result.estimatedTime).toBe(30);
    });

    it('picks the shorter ordering for a pair', () => {
        const pairMatrix = [
            [0, 8],
            [12, 0],
        ];
        const directTimes = [30, 25];

        const result = estimateGroupRoute([0, 1], pairMatrix, directTimes);
        // Order [0,1]: T[0][1] + D[1] = 8 + 25 = 33
        // Order [1,0]: T[1][0] + D[0] = 12 + 30 = 42
        expect(result.bestOrder).toEqual([0, 1]);
        expect(result.estimatedTime).toBe(33);
    });

    it('picks the shortest ordering for a triple', () => {
        const pairMatrix = [
            [0, 5, 20],
            [6, 0, 7],
            [18, 8, 0],
        ];
        const directTimes = [30, 25, 40];

        const result = estimateGroupRoute([0, 1, 2], pairMatrix, directTimes);
        // [2,1,0]: T[2][1]+T[1][0]+D[0] = 8+6+30 = 44 (shortest)
        expect(result.bestOrder).toEqual([2, 1, 0]);
        expect(result.estimatedTime).toBe(44);
    });

    it('returns Infinity when matrix has null values', () => {
        const pairMatrix = [
            [0, null],
            [null, 0],
        ];
        const directTimes = [30, 25];

        const result = estimateGroupRoute([0, 1], pairMatrix, directTimes);
        expect(result.estimatedTime).toBe(Infinity);
    });
});

describe('Smart Algorithm - enumerateValidGroups', () => {

    it('includes singleton groups for all valid passengers', () => {
        const n = 3;
        const pairMatrix = [
            [0, 10, 20],
            [10, 0, 10],
            [20, 10, 0],
        ];
        const directTimes = [20, 25, 30];

        const groups = enumerateValidGroups(n, pairMatrix, directTimes);
        const singletons = groups.filter(g => g.indices.length === 1);
        expect(singletons.length).toBe(3);
    });

    it('skips passengers with null direct times', () => {
        const n = 3;
        const pairMatrix = [
            [0, 10, 20],
            [10, 0, 10],
            [20, 10, 0],
        ];
        const directTimes = [20, null, 30];

        const groups = enumerateValidGroups(n, pairMatrix, directTimes);
        const singletons = groups.filter(g => g.indices.length === 1);
        expect(singletons.length).toBe(2);
        expect(singletons.every(g => !g.indices.includes(1))).toBe(true);
    });

    it('filters out groups that violate delay constraints', () => {
        const n = 2;
        const pairMatrix = [
            [0, 30],
            [30, 0],
        ];
        // With these times, the estimated route = 30 + 15 = 45
        // Delay for passenger 0: 45 - 15 = 30 → exceeds hard cap
        const directTimes = [15, 15];

        const groups = enumerateValidGroups(n, pairMatrix, directTimes);
        const pairs = groups.filter(g => g.indices.length === 2);
        expect(pairs.length).toBe(0);
    });

    it('includes valid pairs that pass delay evaluation', () => {
        const n = 2;
        const pairMatrix = [
            [0, 5],
            [6, 0],
        ];
        const directTimes = [30, 25];
        // Best order [0,1]: 5 + 25 = 30. Delays: [0, 5] → both under grace

        const groups = enumerateValidGroups(n, pairMatrix, directTimes);
        const pairs = groups.filter(g => g.indices.length === 2);
        expect(pairs.length).toBe(1);
        expect(pairs[0].estimatedTime).toBe(30);
    });
});

describe('Smart Algorithm - solveOptimalGrouping', () => {

    it('returns single group when only one passenger', () => {
        const validGroups = [{ indices: [0], bestOrder: [0], estimatedTime: 30, delays: [0] }];
        return solveOptimalGrouping(validGroups, 1).then(result => {
            expect(result.solverStatus).toBe('OPTIMAL');
            expect(result.selectedGroups.length).toBe(1);
        });
    });

    it('picks a pair over two singletons to minimize taxis', () => {
        const validGroups = [
            { indices: [0], bestOrder: [0], estimatedTime: 30, delays: [0] },
            { indices: [1], bestOrder: [1], estimatedTime: 25, delays: [0] },
            { indices: [0, 1], bestOrder: [0, 1], estimatedTime: 33, delays: [3, 8] },
        ];
        return solveOptimalGrouping(validGroups, 2).then(result => {
            expect(result.solverStatus).toBe('OPTIMAL');
            expect(result.selectedGroups.length).toBe(1);
            expect(result.selectedGroups[0].indices).toEqual([0, 1]);
        });
    });

    it('assigns all passengers exactly once in a larger problem', () => {
        const validGroups = [
            { indices: [0], bestOrder: [0], estimatedTime: 30, delays: [0] },
            { indices: [1], bestOrder: [1], estimatedTime: 25, delays: [0] },
            { indices: [2], bestOrder: [2], estimatedTime: 35, delays: [0] },
            { indices: [3], bestOrder: [3], estimatedTime: 28, delays: [0] },
            { indices: [0, 1], bestOrder: [0, 1], estimatedTime: 33, delays: [3, 8] },
            { indices: [2, 3], bestOrder: [3, 2], estimatedTime: 37, delays: [2, 9] },
            { indices: [0, 2], bestOrder: [0, 2], estimatedTime: 40, delays: [10, 5] },
        ];
        return solveOptimalGrouping(validGroups, 4).then(result => {
            expect(result.solverStatus).toBe('OPTIMAL');
            const allIndices = result.selectedGroups.flatMap(g => g.indices).sort();
            expect(allIndices).toEqual([0, 1, 2, 3]);
            expect(result.selectedGroups.length).toBe(2);
        });
    });

    it('handles empty input', () => {
        return solveOptimalGrouping([], 0).then(result => {
            expect(result.solverStatus).toBe('OPTIMAL');
            expect(result.selectedGroups).toEqual([]);
        });
    });
});

describe('Smart Algorithm - delay compliance', () => {

    it('all groups from enumerateValidGroups pass delay evaluation', () => {
        const n = 5;
        const pairMatrix = Array.from({ length: n }, (_, i) =>
            Array.from({ length: n }, (_, j) => {
                if (i === j) return 0;
                return 5 + Math.abs(i - j) * 3;
            })
        );
        const directTimes = [20, 25, 30, 35, 22];

        const groups = enumerateValidGroups(n, pairMatrix, directTimes);

        for (const group of groups) {
            if (group.indices.length === 1) continue;
            for (let k = 0; k < group.indices.length; k++) {
                const idx = group.indices[k];
                const delay = group.delays[k];
                const result = evaluateDelay(directTimes[idx], delay);
                expect(result.approved).toBe(true);
            }
        }
    });
});

describe('Smart Algorithm - end-to-end with mocked API', () => {
    function seedDuration(origin, destination) {
        const seed = (origin + destination).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        const pseudoRandom = ((seed * 9301 + 49297) % 233280) / 233280;
        return Math.round((10 + pseudoRandom * 50) * 10) / 10;
    }

    beforeEach(() => {
        vi.resetModules();
        vi.doMock('../src/js/services/mapsService.js', () => ({
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
        }));
        vi.doMock('../src/js/services/groupMemoryService.js', () => ({
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
        }));
    });

    it('smart mode produces fewer or equal taxis compared to greedy', async () => {
        const { calculateRoutes } = await import('../src/js/services/routingAlgorithm.js');
        const passengers = [
            { id: 'p1', name: 'Avi', address: 'Tel Aviv, Dizengoff 100', isSpecial: false, arrivalTime: '' },
            { id: 'p2', name: 'Bat', address: 'Tel Aviv, Rothschild 50', isSpecial: false, arrivalTime: '' },
            { id: 'p3', name: 'Chen', address: 'Tel Aviv, Allenby 30', isSpecial: false, arrivalTime: '' },
            { id: 'p4', name: 'Dan', address: 'Ramat Gan, Bialik 15', isSpecial: false, arrivalTime: '' },
            { id: 'p5', name: 'Ela', address: 'Herzliya, Ben Gurion 8', isSpecial: false, arrivalTime: '' },
            { id: 'p6', name: 'Fadi', address: 'Tel Aviv, King George 22', isSpecial: false, arrivalTime: '' },
        ];
        const destination = 'Rishon LeZion, HaRakevet 5';
        const mainTime = '06:30';

        const greedyResult = await calculateRoutes(passengers, destination, mainTime, null, { mode: 'greedy' });
        const smartResult = await calculateRoutes(passengers, destination, mainTime, null, { mode: 'smart' });

        expect(smartResult.taxis.length).toBeLessThanOrEqual(greedyResult.taxis.length);
        expect(smartResult.meta.mode).toBe('smart');

        const totalPassengersGreedy = greedyResult.taxis.reduce((sum, t) => sum + t.passengers.length, 0);
        const totalPassengersSmart = smartResult.taxis.reduce((sum, t) => sum + t.passengers.length, 0);
        expect(totalPassengersSmart).toBe(totalPassengersGreedy);
    }, 30000);

    it('smart mode assigns all passengers with valid pickup times', async () => {
        const { calculateRoutes } = await import('../src/js/services/routingAlgorithm.js');
        const passengers = [
            { id: 'p1', name: 'A', address: 'Addr1', isSpecial: false, arrivalTime: '' },
            { id: 'p2', name: 'B', address: 'Addr2', isSpecial: false, arrivalTime: '' },
            { id: 'p3', name: 'C', address: 'Addr3', isSpecial: false, arrivalTime: '' },
        ];
        const destination = 'SetAddr';
        const mainTime = '07:00';

        const result = await calculateRoutes(passengers, destination, mainTime, null, { mode: 'smart' });

        const allPassengers = result.taxis.flatMap(t => t.passengers);
        expect(allPassengers.length).toBe(3);

        for (const p of allPassengers) {
            expect(p.pickupTime).toBeTruthy();
            expect(p.pickupTime).toMatch(/^\d{2}:\d{2}$/);
        }
    }, 30000);

    it('handles special passengers identically in both modes', async () => {
        const { calculateRoutes } = await import('../src/js/services/routingAlgorithm.js');
        const passengers = [
            { id: 'p1', name: 'Special', address: 'SpecialAddr', isSpecial: true, arrivalTime: '' },
            { id: 'p2', name: 'Regular', address: 'RegularAddr', isSpecial: false, arrivalTime: '' },
        ];
        const destination = 'Dest';
        const mainTime = '08:00';

        const greedyResult = await calculateRoutes(passengers, destination, mainTime, null, { mode: 'greedy' });
        const smartResult = await calculateRoutes(passengers, destination, mainTime, null, { mode: 'smart' });

        const greedySpecial = greedyResult.taxis.filter(t => t.isSpecial);
        const smartSpecial = smartResult.taxis.filter(t => t.isSpecial);
        expect(smartSpecial.length).toBe(greedySpecial.length);
    }, 30000);
});
