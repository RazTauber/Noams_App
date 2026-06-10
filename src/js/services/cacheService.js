/**
 * Multi-tier caching for Google Maps API responses.
 * Tier 1: In-memory Map (fastest, cleared on page reload).
 * Tier 2: localStorage with same-day expiry.
 */

const STORAGE_PREFIX = 'taxi_cache_';

const memoryCache = new Map();
let cacheHits = 0;
let cacheMisses = 0;

function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function getFromStorage(key) {
    try {
        const raw = localStorage.getItem(STORAGE_PREFIX + key);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (entry.day !== todayKey()) {
            localStorage.removeItem(STORAGE_PREFIX + key);
            return null;
        }
        return entry.value;
    } catch {
        return null;
    }
}

function setToStorage(key, value) {
    try {
        localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify({
            day: todayKey(),
            value,
        }));
    } catch {
        // localStorage full or unavailable — silent fail, memory cache still works
    }
}

function travelTimeKey(origin, destination, arrivalHour) {
    return `tt|${origin}|${destination}|${arrivalHour}`;
}

function routeDurationKey(waypoints, arrivalHour) {
    return `rd|${waypoints.join('|')}|${arrivalHour}`;
}

export function getCachedTravelTime(origin, destination, arrivalHour) {
    const key = travelTimeKey(origin, destination, arrivalHour);
    if (memoryCache.has(key)) {
        cacheHits++;
        return memoryCache.get(key);
    }
    const stored = getFromStorage(key);
    if (stored !== null) {
        cacheHits++;
        memoryCache.set(key, stored);
        return stored;
    }
    cacheMisses++;
    return null;
}

export function cacheTravelTime(origin, destination, arrivalHour, result) {
    const key = travelTimeKey(origin, destination, arrivalHour);
    memoryCache.set(key, result);
    setToStorage(key, result);
}

export function getCachedRouteDuration(waypoints, arrivalHour) {
    const key = routeDurationKey(waypoints, arrivalHour);
    if (memoryCache.has(key)) {
        cacheHits++;
        return memoryCache.get(key);
    }
    const stored = getFromStorage(key);
    if (stored !== null) {
        cacheHits++;
        memoryCache.set(key, stored);
        return stored;
    }
    cacheMisses++;
    return null;
}

export function cacheRouteDuration(waypoints, arrivalHour, result) {
    const key = routeDurationKey(waypoints, arrivalHour);
    memoryCache.set(key, result);
    setToStorage(key, result);
}

/**
 * Evict all stale localStorage entries (from previous days) and clear memory cache.
 */
export function clearAllCaches() {
    memoryCache.clear();
    cacheHits = 0;
    cacheMisses = 0;
    try {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith(STORAGE_PREFIX)) {
                try {
                    const entry = JSON.parse(localStorage.getItem(key));
                    if (entry.day !== todayKey()) {
                        keysToRemove.push(key);
                    }
                } catch {
                    keysToRemove.push(key);
                }
            }
        }
        keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch {
        // localStorage unavailable
    }
}

export function getCacheStats() {
    return {
        hits: cacheHits,
        misses: cacheMisses,
        memorySize: memoryCache.size,
    };
}
