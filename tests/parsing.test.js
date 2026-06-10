import { describe, it, expect } from 'vitest';
import { parsePassengers, groupByTimeBucket } from '../src/js/utils/helpers.js';

describe('Data Parsing', () => {

    it('parses English column names correctly', () => {
        const rawRows = [
            { 'Full Name': 'Israel Israeli', 'Pickup Address': 'Dizengoff 50, Tel Aviv', 'Special Taxi': 'No', 'Exception Time': '' },
            { 'Full Name': 'Yael Cohen', 'Pickup Address': 'Herzl 10, Rishon LeZion', 'Special Taxi': 'Yes', 'Exception Time': '08:00' },
        ];

        const passengers = parsePassengers(rawRows);
        expect(passengers).toHaveLength(2);
        expect(passengers[0].name).toBe('Israel Israeli');
        expect(passengers[0].address).toBe('Dizengoff 50, Tel Aviv');
        expect(passengers[0].isSpecial).toBe(false);
        expect(passengers[1].isSpecial).toBe(true);
        expect(passengers[1].exceptionTime).toBe('08:00');
    });

    it('parses Hebrew column names correctly', () => {
        const rawRows = [
            { 'שם מלא': 'Israel Israeli', 'כתובת איסוף': 'Dizengoff 50, Tel Aviv', 'מונית ספיישל': 'לא', 'שעת חריג': '' },
            { 'שם מלא': 'Yael Cohen', 'כתובת איסוף': 'Herzl 10, Rishon LeZion', 'מונית ספיישל': 'כן', 'שעת חריג': '08:00' },
        ];

        const passengers = parsePassengers(rawRows);
        expect(passengers).toHaveLength(2);
        expect(passengers[0].name).toBe('Israel Israeli');
        expect(passengers[0].address).toBe('Dizengoff 50, Tel Aviv');
        expect(passengers[0].isSpecial).toBe(false);
        expect(passengers[1].isSpecial).toBe(true);
        expect(passengers[1].exceptionTime).toBe('08:00');
    });

    it('parses alternative column names', () => {
        const rawRows = [
            { 'name': 'Danny Levi', 'address': 'Allenby 100, Tel Aviv', 'special': 'yes', 'time': '07:00' },
        ];

        const passengers = parsePassengers(rawRows);
        expect(passengers[0].name).toBe('Danny Levi');
        expect(passengers[0].isSpecial).toBe(true);
        expect(passengers[0].exceptionTime).toBe('07:00');
    });

    it('returns empty array for empty input', () => {
        expect(parsePassengers([])).toEqual([]);
        expect(parsePassengers(null)).toEqual([]);
    });

    it('assigns unique IDs to all passengers', () => {
        const rawRows = [
            { 'Full Name': 'A', 'Pickup Address': 'B' },
            { 'Full Name': 'C', 'Pickup Address': 'D' },
        ];
        const passengers = parsePassengers(rawRows);
        const ids = passengers.map(p => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('Time Bucket Grouping', () => {

    // T03: Same address, different times → separate buckets
    it('T03 - separates passengers with different arrival times', () => {
        const passengers = [
            { id: '1', name: 'A', exceptionTime: '06:00' },
            { id: '2', name: 'B', exceptionTime: '08:30' },
        ];

        const buckets = groupByTimeBucket(passengers, '07:00');
        expect(buckets.size).toBe(2);
        expect(buckets.get('06:00')).toHaveLength(1);
        expect(buckets.get('08:30')).toHaveLength(1);
    });

    it('groups passengers without exception time into main bucket', () => {
        const passengers = [
            { id: '1', name: 'A', exceptionTime: '' },
            { id: '2', name: 'B', exceptionTime: '' },
            { id: '3', name: 'C', exceptionTime: '08:00' },
        ];

        const buckets = groupByTimeBucket(passengers, '06:30');
        expect(buckets.get('06:30')).toHaveLength(2);
        expect(buckets.get('08:00')).toHaveLength(1);
    });
});
