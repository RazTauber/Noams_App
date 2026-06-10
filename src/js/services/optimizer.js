import highs from 'highs';
import { ALGORITHM_CONFIG } from '../utils/constants.js';
import { evaluateDelay } from './delayEvaluator.js';

let solverInstance = null;

async function getSolver() {
    if (!solverInstance) {
        solverInstance = await highs();
    }
    return solverInstance;
}

/**
 * Estimate the best route time for a group of passengers using the pairwise matrix.
 * Tries all permutations of pickup order and returns the shortest.
 *
 * @param {number[]} indices - Passenger indices in the group
 * @param {number[][]} pairMatrix - n×n travel time matrix between pickups
 * @param {number[]} directTimes - Direct travel times to destination
 * @returns {{bestOrder: number[], estimatedTime: number}}
 */
export function estimateGroupRoute(indices, pairMatrix, directTimes) {
    if (indices.length === 1) {
        return { bestOrder: indices, estimatedTime: directTimes[indices[0]] };
    }

    if (indices.length === 2) {
        return evaluateBestOfOrders(permutations(indices), pairMatrix, directTimes);
    }

    // For triples: nearest-neighbor from each starting point (3 orderings vs 6 permutations)
    let bestTime = Infinity;
    let bestOrder = indices;

    for (const start of indices) {
        const order = nearestNeighborOrder(start, indices, pairMatrix);
        const time = evaluateOrderTime(order, pairMatrix, directTimes);
        if (time < bestTime) {
            bestTime = time;
            bestOrder = order;
        }
    }

    return { bestOrder, estimatedTime: bestTime };
}

function nearestNeighborOrder(start, indices, pairMatrix) {
    const remaining = new Set(indices.filter(i => i !== start));
    const order = [start];

    while (remaining.size > 0) {
        let nearest = null;
        let nearestDist = Infinity;
        const current = order[order.length - 1];
        for (const candidate of remaining) {
            const dist = pairMatrix[current][candidate];
            if (dist !== null && dist < nearestDist) {
                nearestDist = dist;
                nearest = candidate;
            }
        }
        if (nearest === null) {
            for (const r of remaining) { order.push(r); }
            break;
        }
        order.push(nearest);
        remaining.delete(nearest);
    }

    return order;
}

function evaluateOrderTime(order, pairMatrix, directTimes) {
    let time = 0;
    for (let k = 0; k < order.length - 1; k++) {
        const travelBetween = pairMatrix[order[k]][order[k + 1]];
        if (travelBetween === null) return Infinity;
        time += travelBetween;
    }
    const lastIdx = order[order.length - 1];
    if (directTimes[lastIdx] === null) return Infinity;
    time += directTimes[lastIdx];
    return time;
}

function evaluateBestOfOrders(orders, pairMatrix, directTimes) {
    let bestTime = Infinity;
    let bestOrder = orders[0];

    for (const perm of orders) {
        const time = evaluateOrderTime(perm, pairMatrix, directTimes);
        if (time < bestTime) {
            bestTime = time;
            bestOrder = [...perm];
        }
    }

    return { bestOrder, estimatedTime: bestTime };
}

/**
 * Enumerate all valid groups (pairs and triples) and filter by delay constraints.
 *
 * @param {number} n - Number of passengers
 * @param {number[][]} pairMatrix - n×n travel time matrix
 * @param {number[]} directTimes - Direct times to destination per passenger
 * @returns {Array<{indices: number[], bestOrder: number[], estimatedTime: number, delays: number[]}>}
 */
export function enumerateValidGroups(n, pairMatrix, directTimes) {
    const validGroups = [];
    const { MAX_PASSENGERS_PER_TAXI } = ALGORITHM_CONFIG;

    for (let i = 0; i < n; i++) {
        if (directTimes[i] === null) continue;
        validGroups.push({
            indices: [i],
            bestOrder: [i],
            estimatedTime: directTimes[i],
            delays: [0],
        });
    }

    for (let i = 0; i < n; i++) {
        if (directTimes[i] === null) continue;
        for (let j = i + 1; j < n; j++) {
            if (directTimes[j] === null) continue;

            const { bestOrder, estimatedTime } = estimateGroupRoute([i, j], pairMatrix, directTimes);
            if (estimatedTime === Infinity) continue;

            const delays = [i, j].map(idx => Math.max(0, estimatedTime - directTimes[idx]));
            const allApproved = [i, j].every((idx, k) =>
                evaluateDelay(directTimes[idx], delays[k]).approved
            );

            if (allApproved) {
                validGroups.push({ indices: [i, j], bestOrder, estimatedTime, delays });
            }
        }
    }

    if (MAX_PASSENGERS_PER_TAXI >= 3) {
        for (let i = 0; i < n; i++) {
            if (directTimes[i] === null) continue;
            for (let j = i + 1; j < n; j++) {
                if (directTimes[j] === null) continue;
                for (let k = j + 1; k < n; k++) {
                    if (directTimes[k] === null) continue;

                    const { bestOrder, estimatedTime } = estimateGroupRoute([i, j, k], pairMatrix, directTimes);
                    if (estimatedTime === Infinity) continue;

                    const delays = [i, j, k].map(idx => Math.max(0, estimatedTime - directTimes[idx]));
                    const allApproved = [i, j, k].every((idx, m) =>
                        evaluateDelay(directTimes[idx], delays[m]).approved
                    );

                    if (allApproved) {
                        validGroups.push({ indices: [i, j, k], bestOrder, estimatedTime, delays });
                    }
                }
            }
        }
    }

    return validGroups;
}

/**
 * Solve the optimal passenger-to-taxi assignment using Integer Linear Programming.
 * Minimizes total number of taxis (groups) while ensuring every passenger is assigned exactly once.
 *
 * @param {Array} validGroups - Output from enumerateValidGroups()
 * @param {number} n - Total number of passengers
 * @returns {Promise<{selectedGroups: Array, solverStatus: string}>}
 */
export async function solveOptimalGrouping(validGroups, n) {
    if (n === 0) return { selectedGroups: [], solverStatus: 'OPTIMAL' };
    if (n === 1) return { selectedGroups: [validGroups[0]], solverStatus: 'OPTIMAL' };

    const numVars = validGroups.length;

    let problem = 'Minimize\n  obj: ';
    const objTerms = validGroups.map((_, g) => `x${g}`);
    problem += objTerms.join(' + ') + '\n';

    problem += 'Subject To\n';
    for (let i = 0; i < n; i++) {
        const groupsContainingI = [];
        for (let g = 0; g < numVars; g++) {
            if (validGroups[g].indices.includes(i)) {
                groupsContainingI.push(`x${g}`);
            }
        }
        if (groupsContainingI.length === 0) continue;
        problem += `  c${i}: ${groupsContainingI.join(' + ')} = 1\n`;
    }

    problem += 'Binary\n';
    problem += `  ${validGroups.map((_, g) => `x${g}`).join(' ')}\n`;
    problem += 'End\n';

    try {
        const solver = await getSolver();
        const result = solver.solve(problem);

        if (result.Status === 'Optimal') {
            const selectedGroups = [];
            for (let g = 0; g < numVars; g++) {
                const val = result.Columns[`x${g}`]?.Primal ?? 0;
                if (val > 0.5) {
                    selectedGroups.push(validGroups[g]);
                }
            }
            return { selectedGroups, solverStatus: 'OPTIMAL' };
        }

        return { selectedGroups: null, solverStatus: result.Status };
    } catch (error) {
        return { selectedGroups: null, solverStatus: `ERROR: ${error.message}` };
    }
}

/**
 * Generate all permutations of an array (up to length 3, so max 6 permutations).
 */
function permutations(arr) {
    if (arr.length <= 1) return [arr];
    if (arr.length === 2) return [arr, [arr[1], arr[0]]];

    const result = [];
    for (let i = 0; i < arr.length; i++) {
        const rest = arr.filter((_, idx) => idx !== i);
        for (const perm of permutations(rest)) {
            result.push([arr[i], ...perm]);
        }
    }
    return result;
}
