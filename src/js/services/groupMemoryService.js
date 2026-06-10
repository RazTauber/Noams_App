/**
 * Permanent memory layer backed by Supabase (PostgreSQL).
 *
 * Stores two kinds of data that the same-day cacheService cannot:
 *
 *   grouping_memory     — ILP solver output: which passengers go together and in
 *                         what pickup order.  Keyed by destination + arrival hour +
 *                         sorted pickup address set.  A single changed address
 *                         produces a cache miss, so passengers picked up from a
 *                         different location are never auto-grouped.
 *
 *   address_pair_cache  — Pickup-to-pickup travel times used exclusively for ILP
 *                         grouping decisions.  No TTL; these are stable structural
 *                         distances between recurring locations.
 *                         getRouteDuration (final scheduled times) is NEVER cached
 *                         here — those always hit the Directions API for live traffic.
 *
 * All operations degrade silently when Supabase is not configured, so the app
 * works identically without a DB connection.
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL     = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

let _client = null;

function getClient() {
    if (!_client && isDbConfigured()) {
        _client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return _client;
}

export function isDbConfigured() {
    return !!(
        SUPABASE_URL &&
        SUPABASE_ANON_KEY &&
        SUPABASE_URL      !== 'your_supabase_project_url_here' &&
        SUPABASE_ANON_KEY !== 'your_supabase_anon_key_here'
    );
}

// ─── Address normalization ────────────────────────────────────────────────────

/**
 * Canonical form used as DB keys.
 * Lowercase + collapse whitespace so "Tel Aviv " and "Tel Aviv" map to the same key.
 */
export function normalizeAddress(addr) {
    return addr.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * FNV-1a 32-bit hash — fast, deterministic, no async needed.
 * Used to build the address-set fingerprint for grouping_memory.
 */
function fnv1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash  = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * Stable fingerprint for a set of pickup addresses.
 * Sort + normalize before hashing → order-independent.
 * Picking someone up from a different address changes the hash.
 */
function buildAddressSetHash(addresses) {
    const canonical = [...addresses].map(normalizeAddress).sort().join('|');
    return fnv1a(canonical);
}

// ─── grouping_memory ──────────────────────────────────────────────────────────

/**
 * Look up a saved taxi grouping for a time bucket.
 *
 * Returns the grouping on a hit — an array of ordered address arrays where each
 * inner array is one taxi's pickup sequence:
 *   [["addr1_norm", "addr2_norm"], ["addr3_norm"], ...]
 *
 * Returns null on a miss or any DB error.
 *
 * @param {string}   destination
 * @param {number}   arrivalHour  0–23
 * @param {string[]} addresses    All pickup addresses in this time bucket
 * @returns {Promise<string[][]|null>}
 */
export async function lookupGrouping(destination, arrivalHour, addresses) {
    const db = getClient();
    if (!db) return null;

    try {
        const { data, error } = await db
            .from('grouping_memory')
            .select('grouping')
            .eq('dest_norm',     normalizeAddress(destination))
            .eq('arrival_hour',  arrivalHour)
            .eq('addr_set_hash', buildAddressSetHash(addresses))
            .maybeSingle();

        if (error || !data) return null;
        return data.grouping;
    } catch {
        return null;
    }
}

/**
 * Persist (or update) a taxi grouping after a successful ILP solve.
 * Uses the upsert_grouping RPC to atomically increment usage_count.
 *
 * @param {string}   destination
 * @param {number}   arrivalHour  0–23
 * @param {string[]} addresses    Original pickup addresses (normalized internally)
 * @param {string[][]} grouping   Ordered address arrays per taxi
 */
export async function saveGrouping(destination, arrivalHour, addresses, grouping) {
    const db = getClient();
    if (!db) return;

    try {
        await db.rpc('upsert_grouping', {
            p_dest_norm:     normalizeAddress(destination),
            p_arrival_hour:  arrivalHour,
            p_addr_set_hash: buildAddressSetHash(addresses),
            p_addresses:     addresses.map(normalizeAddress).sort(),
            p_grouping:      grouping,
            p_today:         new Date().toISOString().slice(0, 10),
        });
    } catch {
        // DB is optional — silent fail
    }
}

// ─── address_pair_cache ───────────────────────────────────────────────────────

/**
 * Load all cached pickup-to-pickup travel times for a set of addresses.
 * Returns a partially (or fully) populated n×n matrix.
 * Null means the pair is not yet in the DB — caller must fetch it from the API.
 *
 * @param {string[]} addresses
 * @returns {Promise<(number|null)[][]>}
 */
export async function loadPairMatrix(addresses) {
    const n      = addresses.length;
    const matrix = Array.from({ length: n }, () => new Array(n).fill(null));

    const db = getClient();
    if (!db || n === 0) return matrix;

    const normalized = addresses.map(normalizeAddress);

    try {
        const { data, error } = await db
            .from('address_pair_cache')
            .select('origin_norm, dest_norm, travel_minutes')
            .in('origin_norm', normalized)
            .in('dest_norm',   normalized);

        if (error || !data) return matrix;

        const indexMap = new Map(normalized.map((a, i) => [a, i]));

        for (const row of data) {
            const i = indexMap.get(row.origin_norm);
            const j = indexMap.get(row.dest_norm);
            if (i !== undefined && j !== undefined) {
                matrix[i][j] = row.travel_minutes;
            }
        }
    } catch {
        // Return whatever is populated so far
    }

    return matrix;
}

/**
 * Persist all non-null, non-diagonal pairs from a freshly-fetched pair matrix.
 * Uses the upsert_pair_times RPC for a single round-trip regardless of matrix size.
 *
 * @param {string[]}           addresses
 * @param {(number|null)[][]}  matrix
 */
export async function savePairMatrix(addresses, matrix) {
    const db = getClient();
    if (!db) return;

    const normalized = addresses.map(normalizeAddress);
    const rows = [];

    for (let i = 0; i < normalized.length; i++) {
        for (let j = 0; j < normalized.length; j++) {
            if (i !== j && matrix[i][j] !== null) {
                rows.push({
                    origin_norm:    normalized[i],
                    dest_norm:      normalized[j],
                    travel_minutes: matrix[i][j],
                });
            }
        }
    }

    if (rows.length === 0) return;

    try {
        await db.rpc('upsert_pair_times', { p_rows: rows });
    } catch {
        // silent fail
    }
}
