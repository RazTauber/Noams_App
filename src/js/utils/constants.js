/**
 * Routing algorithm configuration.
 * Based on the Dynamic Threshold model from the spec.
 */
// Bump this version whenever cached travel-time data becomes stale
// (e.g. switching from static durations to pessimistic traffic model).
// On first load after a version change the DB pair cache and grouping
// memory are flushed automatically — see groupMemoryService.js.
export const PAIR_CACHE_VERSION = 2;

export const ALGORITHM_CONFIG = {
    MAX_PASSENGERS_PER_TAXI: 3,
    DELAY_PERCENTAGE_LIMIT: 0.5,    // 50% of direct travel time
    MIN_GRACE_MINUTES: 15,          // always allow up to 15 min
    HARD_CAP_MINUTES: 25,           // never exceed 25 min delay
    CROSS_CITY_MAX_DELAY: 8,        // cap (min) for cross-city pairs —
                                    // passengers from different cities require a
                                    // geographic detour that only pays off if the
                                    // added delay is small
    TRAVEL_TIME_BUFFER: 1.15,       // 15% safety margin on top of pessimistic estimates
    DEPARTURE_OFFSET_MINUTES: 60,   // estimate departure as arrival minus this offset
                                    // (used to convert arrival_time → departure_time
                                    // for the Google Maps API driving mode)
};

export const COLUMN_MAPPINGS = {
    name: ['full name', 'name', 'שם מלא', 'שם'],
    phone: ['phone', 'telephone', 'tel', 'טלפון', 'נייד', 'phone number'],
    address: ['pickup address', 'address', 'כתובת איסוף', 'כתובת'],
    isSpecial: ['special taxi', 'special', 'מונית ספיישל', 'מונית לבד', 'ספיישל'],
    arrivalTime: ['arrival time', 'time', 'שעת הגעה', 'שעת חריג', 'exception time'],
};

export const POSITIVE_VALUES = ['yes', '1', 'true', 'v', 'x', 'כן'];
