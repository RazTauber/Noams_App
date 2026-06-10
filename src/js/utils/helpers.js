import { COLUMN_MAPPINGS, POSITIVE_VALUES } from './constants.js';

/**
 * Strip non-breaking spaces, pipes, and parenthetical suffixes so messy
 * Excel headers still match.
 */
function cleanHeader(raw) {
    return raw
        ?.toString()
        .replace(/[\u00A0]/g, ' ')   // NBSP → regular space
        .replace(/\|/g, '')          // remove pipes
        .replace(/\(.*?\)/g, '')     // remove (…) suffixes
        .trim()
        .toLowerCase() || '';
}

/**
 * Find the matching column name from raw Excel headers.
 * Uses fuzzy cleaning so extra decoration in headers doesn't break matching.
 */
function resolveColumn(headers, mappings) {
    const cleaned = headers.map(cleanHeader);
    for (const alias of mappings) {
        const target = alias.toLowerCase();
        const idx = cleaned.indexOf(target);
        if (idx !== -1) return headers[idx];
    }
    for (const alias of mappings) {
        const target = alias.toLowerCase();
        const idx = cleaned.findIndex(h => h.includes(target));
        if (idx !== -1) return headers[idx];
    }
    return null;
}

/**
 * Parse raw Excel row data into a normalized passenger object.
 */
export function parsePassengers(rawRows) {
    if (!rawRows || rawRows.length === 0) return [];

    const headers = [...new Set(rawRows.flatMap(r => Object.keys(r)))];
    const nameCol = resolveColumn(headers, COLUMN_MAPPINGS.name);
    const addressCol = resolveColumn(headers, COLUMN_MAPPINGS.address);
    const specialCol = resolveColumn(headers, COLUMN_MAPPINGS.isSpecial);
    const timeCol = resolveColumn(headers, COLUMN_MAPPINGS.exceptionTime);

    const results = rawRows.map((row, index) => ({
        id: `p-${index}-${Date.now()}`,
        name: (nameCol ? row[nameCol] : '')?.toString().trim() || '',
        address: (addressCol ? row[addressCol] : '')?.toString().trim() || '',
        isSpecial: specialCol
            ? POSITIVE_VALUES.includes(row[specialCol]?.toString().trim().toLowerCase())
            : false,
        exceptionTime: normalizeTime(timeCol ? row[timeCol] : ''),
        status: 'pending',
    }));

    return results;
}

/**
 * Group passengers by arrival time buckets.
 * Passengers with exception times go to their own bucket; others go to the main bucket.
 */
export function groupByTimeBucket(passengers, mainTime) {
    const buckets = new Map();

    for (const p of passengers) {
        const key = p.exceptionTime || mainTime;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(p);
    }

    return buckets;
}

/**
 * Normalize an Excel time value to HH:MM format.
 * Handles fractional day numbers (0.375 → "09:00"), Date objects,
 * and plain strings ("9:00", "09:00:00").
 */
function normalizeTime(raw) {
    if (raw == null || raw === '') return '';
    if (typeof raw === 'number') {
        const totalMinutes = Math.round(raw * 24 * 60);
        const h = Math.floor(totalMinutes / 60) % 24;
        const m = totalMinutes % 60;
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
    }
    const str = raw.toString().trim();
    if (!str) return '';
    const match = str.match(/^(\d{1,2}):(\d{2})/);
    if (match) {
        return `${match[1].padStart(2, '0')}:${match[2]}`;
    }
    return str;
}

/**
 * Format minutes into a readable delay string.
 */
export function formatDelay(minutes) {
    if (minutes <= 0) return 'Direct';
    return `+${Math.round(minutes)} min`;
}

/**
 * Subtract minutes from a time string (HH:MM) and return the resulting time string.
 * E.g. subtractMinutesFromTime("06:30", 45) → "05:45"
 */
export function subtractMinutesFromTime(timeStr, minutes) {
    const [hours, mins] = timeStr.split(':').map(Number);
    const totalMinutes = hours * 60 + mins - Math.round(minutes);
    const wrappedMinutes = ((totalMinutes % 1440) + 1440) % 1440;
    const h = Math.floor(wrappedMinutes / 60);
    const m = wrappedMinutes % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

/**
 * Generate a unique ID.
 */
export function generateId() {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Extract the city from an Israeli address.
 * Israeli addresses follow the pattern "street_name number city_name",
 * so the city is everything after the last numeric token.
 *
 * Examples:
 *   "דיזינגוף 214 תל אביב"   → "תל אביב"
 *   "טרומפלדור 10 כפר סבא"   → "כפר סבא"
 *   "הירשנברג 19 תל אביב"    → "תל אביב"
 *
 * Returns an empty string for addresses that don't match the pattern
 * (e.g. English destination names), which safely disables the city
 * constraint for those passengers.
 */
export function extractCity(address) {
    if (!address) return '';
    const match = address.match(/\d+\s+(.+)$/);
    return match ? match[1].trim() : '';
}
