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
        const val = memoryCache.get(key);
        console.log(`[CACHE] ✅ MEM HIT  travelTime "${origin}" → "${destination}" @${arrivalHour}h = ${val?.duration?.toFixed(1)} min  (hits=${cacheHits})`);
        return val;
    }

    const stored = getFromStorage(key);
    if (stored !== null) {
        cacheHits++;
        memoryCache.set(key, stored);
        console.log(`[CACHE] ✅ LS  HIT  travelTime "${origin}" → "${destination}" @${arrivalHour}h = ${stored?.duration?.toFixed(1)} min  (hits=${cacheHits})`);
        return stored;
    }

    cacheMisses++;
    console.log(`[CACHE] ❌ MISS      travelTime "${origin}" → "${destination}" @${arrivalHour}h  (misses=${cacheMisses})`);
    return null;
}

export function cacheTravelTime(origin, destination, arrivalHour, result) {
    const key = travelTimeKey(origin, destination, arrivalHour);
    memoryCache.set(key, result);
    setToStorage(key, result);
    console.log(`[CACHE] 💾 STORE travelTime "${origin}" → "${destination}" @${arrivalHour}h = ${result?.duration?.toFixed(1)} min  (memSize=${memoryCache.size})`);
}

export function getCachedRouteDuration(waypoints, arrivalHour) {
    const key = routeDurationKey(waypoints, arrivalHour);
    const shortRoute = waypoints.map(w => w.split(',')[0]).join(' → ');

    if (memoryCache.has(key)) {
        cacheHits++;
        const val = memoryCache.get(key);
        console.log(`[CACHE] ✅ MEM HIT  routeDuration [${shortRoute}] @${arrivalHour}h = ${val?.totalDuration?.toFixed(1)} min  (hits=${cacheHits})`);
        return val;
    }

    const stored = getFromStorage(key);
    if (stored !== null) {
        cacheHits++;
        memoryCache.set(key, stored);
        console.log(`[CACHE] ✅ LS  HIT  routeDuration [${shortRoute}] @${arrivalHour}h = ${stored?.totalDuration?.toFixed(1)} min  (hits=${cacheHits})`);
        return stored;
    }

    cacheMisses++;
    console.log(`[CACHE] ❌ MISS      routeDuration [${shortRoute}] @${arrivalHour}h  (misses=${cacheMisses})`);
    return null;
}

export function cacheRouteDuration(waypoints, arrivalHour, result) {
    const key = routeDurationKey(waypoints, arrivalHour);
    const shortRoute = waypoints.map(w => w.split(',')[0]).join(' → ');
    memoryCache.set(key, result);
    setToStorage(key, result);
    console.log(`[CACHE] 💾 STORE routeDuration [${shortRoute}] @${arrivalHour}h = ${result?.totalDuration?.toFixed(1)} min, legs=[${result?.legDurations?.map(d => d.toFixed(1)).join(', ')}]  (memSize=${memoryCache.size})`);
}

/**
 * Evict all stale localStorage entries (from previous days) and clear memory cache.
 */
export function clearAllCaches() {
    const prevMemSize = memoryCache.size;
    memoryCache.clear();
    cacheHits = 0;
    cacheMisses = 0;

    let removedFromStorage = 0;
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
        removedFromStorage = keysToRemove.length;
    } catch {
        // localStorage unavailable
    }

    console.log(`[CACHE] 🗑️ clearAllCaches — memory: ${prevMemSize} entries cleared, localStorage: ${removedFromStorage} stale entries removed`);
}

export function getCacheStats() {
    const stats = {
        hits: cacheHits,
        misses: cacheMisses,
        memorySize: memoryCache.size,
    };
    console.log(`[CACHE] 📊 Stats — hits=${stats.hits}, misses=${stats.misses}, memSize=${stats.memorySize}, hitRate=${stats.hits + stats.misses > 0 ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1) : 0}%`);
    return stats;
}
