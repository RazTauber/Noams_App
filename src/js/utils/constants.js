/**
 * Routing algorithm configuration.
 * Based on the Dynamic Threshold model from the spec.
 */
export const ALGORITHM_CONFIG = {
    MAX_PASSENGERS_PER_TAXI: 3,
    DELAY_PERCENTAGE_LIMIT: 0.4,    // 40% of direct travel time
    MIN_GRACE_MINUTES: 10,          // always allow up to 10 min
    HARD_CAP_MINUTES: 25,           // never exceed 25 min delay
};

export const COLUMN_MAPPINGS = {
    name: ['full name', 'name', 'שם מלא', 'שם'],
    address: ['pickup address', 'address', 'כתובת איסוף', 'כתובת'],
    isSpecial: ['special taxi', 'special', 'מונית ספיישל', 'מונית לבד', 'ספיישל'],
    exceptionTime: ['exception time', 'time', 'שעת חריג', 'שעת הגעה'],
};

export const POSITIVE_VALUES = ['yes', '1', 'true', 'v', 'x', 'כן'];
