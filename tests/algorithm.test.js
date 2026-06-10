import { describe, it, expect } from 'vitest';
import { evaluateDelay } from '../src/js/services/routingAlgorithm.js';

describe('Routing Algorithm - evaluateDelay', () => {

    // T05: Short trip (15 min), 8 min delay → approved (grace period)
    it('T05 - approves short trip delay within grace period', () => {
        const result = evaluateDelay(15, 8);
        expect(result.approved).toBe(true);
        expect(result.reason).toBe('grace_period');
    });

    // T06: Short trip (15 min), 15 min delay → rejected
    it('T06 - rejects short trip with excessive delay', () => {
        const result = evaluateDelay(15, 15);
        expect(result.approved).toBe(false);
        expect(result.reason).toBe('percentage_exceeded');
    });

    // T07: Long trip (50 min), 18 min delay → approved (under 40%)
    it('T07 - approves long trip delay under percentage limit', () => {
        const result = evaluateDelay(50, 18);
        expect(result.approved).toBe(true);
        expect(result.reason).toBe('percentage_rule');
    });

    // T08: Very long trip, 35 min delay → rejected (hard cap)
    it('T08 - rejects delay exceeding hard cap (25 min)', () => {
        const result = evaluateDelay(90, 35);
        expect(result.approved).toBe(false);
        expect(result.reason).toBe('hard_cap');
    });

    // Edge: exactly at grace boundary (10 min)
    it('approves delay exactly at grace period boundary', () => {
        const result = evaluateDelay(12, 10);
        expect(result.approved).toBe(true);
        expect(result.reason).toBe('grace_period');
    });

    // Edge: exactly at hard cap boundary (25 min)
    it('approves delay exactly at hard cap boundary', () => {
        const result = evaluateDelay(80, 25);
        expect(result.approved).toBe(true);
        expect(result.reason).toBe('percentage_rule');
    });

    // Edge: just over hard cap
    it('rejects delay just over hard cap', () => {
        const result = evaluateDelay(80, 25.1);
        expect(result.approved).toBe(false);
        expect(result.reason).toBe('hard_cap');
    });

    // Edge: exactly at percentage limit (40% of 50 = 20 min)
    it('approves delay exactly at percentage limit', () => {
        const result = evaluateDelay(50, 20);
        expect(result.approved).toBe(true);
        expect(result.reason).toBe('percentage_rule');
    });

    // Edge: just over percentage limit
    it('rejects delay just over percentage limit for short-medium trip', () => {
        const result = evaluateDelay(30, 13);
        expect(result.approved).toBe(false);
        expect(result.reason).toBe('percentage_exceeded');
    });

    // Zero delay should always be approved
    it('approves zero delay', () => {
        const result = evaluateDelay(20, 0);
        expect(result.approved).toBe(true);
        expect(result.reason).toBe('grace_period');
    });
});
