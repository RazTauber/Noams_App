import { ALGORITHM_CONFIG } from '../utils/constants.js';

/**
 * Determine if adding a detour is acceptable for a passenger.
 * Extracted to its own module to avoid circular imports between
 * routingAlgorithm.js and optimizer.js.
 *
 * @param {number} directTime - Direct travel time in minutes
 * @param {number} additionalDelay - Extra minutes added by the detour
 * @returns {{approved: boolean, reason: string}}
 */
export function evaluateDelay(directTime, additionalDelay) {
    const { DELAY_PERCENTAGE_LIMIT, MIN_GRACE_MINUTES, HARD_CAP_MINUTES } = ALGORITHM_CONFIG;

    if (additionalDelay > HARD_CAP_MINUTES) {
        return { approved: false, reason: 'hard_cap' };
    }

    if (additionalDelay <= MIN_GRACE_MINUTES) {
        return { approved: true, reason: 'grace_period' };
    }

    const percentageDelay = additionalDelay / directTime;
    if (percentageDelay <= DELAY_PERCENTAGE_LIMIT) {
        return { approved: true, reason: 'percentage_rule' };
    }

    return { approved: false, reason: 'percentage_exceeded' };
}
