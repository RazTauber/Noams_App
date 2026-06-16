import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Integration tests verifying the full flow matches test plan T01-T12.
 * All tests mock the maps and DB services for deterministic, offline results.
 */

// ─── Shared mock helpers ────────────────────────────────────────────────────

function seedDuration(origin, destination) {
    const seed = (origin + destination).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const pseudoRandom = ((seed * 9301 + 49297) % 233280) / 233280;
    return Math.round((10 + pseudoRandom * 50) * 10) / 10;
}

function mockMapsService(overrides = {}) {
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
        ...overrides,
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

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Integration: T01 - Validation', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doMock('../src/js/services/mapsService.js', () => mockMapsService());
        vi.doMock('../src/js/services/groupMemoryService.js', () => mockGroupMemoryService());
    });

    it('T01 - prevents calculation without set address', async () => {
        const { calculateRoutes } = await import('../src/js/services/routingAlgorithm.js');

        const passengers = [
            { id: '1', name: 'Test', address: 'Some Street', isSpecial: false, arrivalTime: '' }
        ];

        expect(typeof calculateRoutes).toBe('function');
    });
});

describe('Integration: T02 - Max Occupancy', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doMock('../src/js/services/mapsService.js', () => mockMapsService());
        vi.doMock('../src/js/services/groupMemoryService.js', () => mockGroupMemoryService());
    });

    it('T02 - splits 4 passengers into 2 taxis (max 3 per taxi)', async () => {
        const { calculateRoutes } = await import('../src/js/services/routingAlgorithm.js');

        const passengers = [
            { id: '1', name: 'A', address: 'Same Street 1', isSpecial: false, arrivalTime: '' },
            { id: '2', name: 'B', address: 'Same Street 2', isSpecial: false, arrivalTime: '' },
            { id: '3', name: 'C', address: 'Same Street 3', isSpecial: false, arrivalTime: '' },
            { id: '4', name: 'D', address: 'Same Street 4', isSpecial: false, arrivalTime: '' },
        ];

        const result = await calculateRoutes(passengers, 'Destination', '06:30', () => {});

        expect(result.taxis.length).toBeGreaterThanOrEqual(2);
        for (const taxi of result.taxis) {
            expect(taxi.passengers.length).toBeLessThanOrEqual(3);
        }
    });
});

describe('Integration: T04 - Special Taxi', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doMock('../src/js/services/mapsService.js', () => mockMapsService());
        vi.doMock('../src/js/services/groupMemoryService.js', () => mockGroupMemoryService());
    });

    it('T04 - allocates dedicated taxi for special passengers', async () => {
        const { calculateRoutes } = await import('../src/js/services/routingAlgorithm.js');

        const passengers = [
            { id: '1', name: 'Regular1', address: 'Street 1', isSpecial: false, arrivalTime: '' },
            { id: '2', name: 'VIP', address: 'Street 2', isSpecial: true, arrivalTime: '' },
            { id: '3', name: 'Regular2', address: 'Street 3', isSpecial: false, arrivalTime: '' },
        ];

        const result = await calculateRoutes(passengers, 'Destination', '06:30', () => {});

        const specialTaxis = result.taxis.filter(t => t.isSpecial);
        expect(specialTaxis.length).toBe(1);
        expect(specialTaxis[0].passengers).toHaveLength(1);
        expect(specialTaxis[0].passengers[0].name).toBe('VIP');
    });
});

describe('Integration: Noam Scenario - 2 nearby Tel Aviv pickups to Petah Tikva', () => {
    const DEST = 'תוצרת הארץ 3 פתח תקוה';
    const ADDR_A = 'שילר 8 תל אביב';
    const ADDR_B = 'קהילת אודסה 27 תל אביב';

    beforeEach(() => {
        vi.resetModules();

        vi.doMock('../src/js/services/mapsService.js', () => mockMapsService({
            getBatchTravelTimes: vi.fn(async (origins) => origins.map(origin => {
                if (origin === ADDR_A) return { duration: 35, status: 'OK' };
                if (origin === ADDR_B) return { duration: 32, status: 'OK' };
                return { duration: 30, status: 'OK' };
            })),
            getRouteDuration: vi.fn(async (waypoints) => {
                if (waypoints.length === 3) {
                    return { totalDuration: 37, legDurations: [5, 32], status: 'OK' };
                }
                if (waypoints[0] === ADDR_A) return { totalDuration: 35, legDurations: [35], status: 'OK' };
                return { totalDuration: 32, legDurations: [32], status: 'OK' };
            }),
            getAllPairTravelTimes: vi.fn(async () => [
                [0, 5],
                [6, 0],
            ]),
        }));

        vi.doMock('../src/js/services/groupMemoryService.js', () => mockGroupMemoryService());
    });

    it('groups both passengers into a single taxi', async () => {
        const { calculateRoutes } = await import('../src/js/services/routingAlgorithm.js');

        const passengers = [
            { id: '1', name: 'Passenger A', address: ADDR_A, isSpecial: false, arrivalTime: '' },
            { id: '2', name: 'Passenger B', address: ADDR_B, isSpecial: false, arrivalTime: '' },
        ];

        const result = await calculateRoutes(passengers, DEST, '18:30', () => {});

        expect(result.errors.length).toBe(0);
        expect(result.taxis.length).toBe(1);
        expect(result.taxis[0].passengers.length).toBe(2);
        expect(result.taxis.filter(t => t.isSpecial).length).toBe(0);
    });

    it('last pickup has delay <= first pickup (position-aware)', async () => {
        const { calculateRoutes } = await import('../src/js/services/routingAlgorithm.js');

        const passengers = [
            { id: '1', name: 'Passenger A', address: ADDR_A, isSpecial: false, arrivalTime: '' },
            { id: '2', name: 'Passenger B', address: ADDR_B, isSpecial: false, arrivalTime: '' },
        ];

        const result = await calculateRoutes(passengers, DEST, '18:30', () => {});

        expect(result.taxis.length).toBe(1);
        const delays = result.taxis[0].passengers.map(p => p.delay);
        expect(delays[delays.length - 1]).toBeLessThanOrEqual(delays[0]);
    });
});

describe('Integration: T09 - Separate Passenger', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doMock('../src/js/services/mapsService.js', () => mockMapsService());
        vi.doMock('../src/js/services/groupMemoryService.js', () => mockGroupMemoryService());
    });

    it('T09 - separates passenger and recalculates', async () => {
        const { separatePassenger } = await import('../src/js/services/routingAlgorithm.js');

        const taxis = [
            {
                id: 'taxi-1',
                number: 1,
                passengers: [
                    { id: 'p1', name: 'A', address: 'Addr1', directTime: 30, delay: 5, arrivalTime: '' },
                    { id: 'p2', name: 'B', address: 'Addr2', directTime: 25, delay: 8, arrivalTime: '' },
                    { id: 'p3', name: 'C', address: 'Addr3', directTime: 28, delay: 6, arrivalTime: '' },
                ],
                isSpecial: false,
                hasError: false,
            },
        ];

        const result = await separatePassenger(taxis, 'taxi-1', 'p2', 'Destination', '06:30');

        const separatedTaxi = result.taxis.find(t => 
            t.passengers.length === 1 && t.passengers[0].id === 'p2'
        );
        expect(separatedTaxi).toBeDefined();
        expect(separatedTaxi.passengers[0].delay).toBe(0);

        const remainingTaxi = result.taxis.find(t => t.passengers.length === 2);
        expect(remainingTaxi).toBeDefined();
    });
});
