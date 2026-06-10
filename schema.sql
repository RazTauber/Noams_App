-- =============================================================================
-- Production Taxi Router — Supabase PostgreSQL Schema
-- Run this once in the Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. grouping_memory
--    Permanent record of which passengers (identified by their pickup addresses)
--    belong together in a taxi.
--
--    Primary key logic (Role 1 — API Cost Guardian):
--      dest_norm + arrival_hour + addr_set_hash
--
--    • dest_norm      — normalized destination address  (same job, different set → miss)
--    • arrival_hour   — 0-23 bucket hour                (same people, 06:30 vs 08:00 → miss)
--    • addr_set_hash  — FNV-1a of sorted, normalized pickup addresses
--                       (person picked up from girlfriend's address → different hash → miss)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS grouping_memory (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    dest_norm     text        NOT NULL,
    arrival_hour  smallint    NOT NULL CHECK (arrival_hour BETWEEN 0 AND 23),
    addr_set_hash text        NOT NULL,
    addresses     text[]      NOT NULL,   -- sorted normalized pickups (human-readable audit)
    grouping      jsonb       NOT NULL,   -- [["addr1","addr2"],["addr3"]] — pickup order per taxi
    usage_count   integer     NOT NULL DEFAULT 1,
    last_used     date        NOT NULL DEFAULT CURRENT_DATE,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT grouping_memory_unique UNIQUE (dest_norm, arrival_hour, addr_set_hash)
);

COMMENT ON TABLE  grouping_memory IS 'Saved ILP taxi grouping decisions, keyed by destination + hour + pickup address set.';
COMMENT ON COLUMN grouping_memory.grouping IS 'Array of ordered address arrays — each inner array is one taxi in pickup sequence order.';
COMMENT ON COLUMN grouping_memory.addr_set_hash IS 'FNV-1a hash of sorted, normalized pickup addresses. Changing any address invalidates the record.';

-- ---------------------------------------------------------------------------
-- 2. address_pair_cache
--    Long-lived pickup-to-pickup travel times used exclusively for ILP grouping
--    decisions (Role 2 — Optimization Economist).  No TTL — these are structural
--    distances between recurring locations, not traffic-sensitive scheduled times.
--
--    NOTE: getRouteDuration (final pickup times) is NEVER cached here.
--    Those always fetch fresh from the Directions API to respect live traffic.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS address_pair_cache (
    origin_norm    text        NOT NULL,
    dest_norm      text        NOT NULL,
    travel_minutes real        NOT NULL,
    recorded_at    timestamptz NOT NULL DEFAULT now(),
    usage_count    integer     NOT NULL DEFAULT 1,
    PRIMARY KEY (origin_norm, dest_norm)
);

COMMENT ON TABLE  address_pair_cache IS 'Permanent pickup-to-pickup travel times for ILP grouping decisions. No TTL.';
COMMENT ON COLUMN address_pair_cache.travel_minutes IS 'Minutes between the two pickup addresses. Used only for who-rides-together decisions, not for final scheduling.';

-- ---------------------------------------------------------------------------
-- 3. upsert_grouping  (RPC function)
--    Atomically inserts or updates a grouping record, incrementing usage_count.
--    Called from the browser via supabase.rpc('upsert_grouping', {...}).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_grouping(
    p_dest_norm     text,
    p_arrival_hour  smallint,
    p_addr_set_hash text,
    p_addresses     text[],
    p_grouping      jsonb,
    p_today         date
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO grouping_memory
        (dest_norm, arrival_hour, addr_set_hash, addresses, grouping, last_used)
    VALUES
        (p_dest_norm, p_arrival_hour, p_addr_set_hash, p_addresses, p_grouping, p_today)
    ON CONFLICT (dest_norm, arrival_hour, addr_set_hash)
    DO UPDATE SET
        grouping    = EXCLUDED.grouping,
        addresses   = EXCLUDED.addresses,
        usage_count = grouping_memory.usage_count + 1,
        last_used   = EXCLUDED.last_used;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. upsert_pair_times  (RPC function)
--    Bulk-upserts multiple origin→destination pairs in one round-trip.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_pair_times(
    p_rows jsonb  -- array of {origin_norm, dest_norm, travel_minutes}
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    r jsonb;
BEGIN
    FOR r IN SELECT * FROM jsonb_array_elements(p_rows)
    LOOP
        INSERT INTO address_pair_cache (origin_norm, dest_norm, travel_minutes)
        VALUES (
            r->>'origin_norm',
            r->>'dest_norm',
            (r->>'travel_minutes')::real
        )
        ON CONFLICT (origin_norm, dest_norm)
        DO UPDATE SET
            travel_minutes = EXCLUDED.travel_minutes,
            recorded_at    = now(),
            usage_count    = address_pair_cache.usage_count + 1;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Row Level Security
--    This is an internal production tool with no user authentication.
--    Anonymous read/write is intentional — the anon key is the only credential.
--    To restrict access in the future, replace these policies with auth-based ones.
-- ---------------------------------------------------------------------------
ALTER TABLE grouping_memory   ENABLE ROW LEVEL SECURITY;
ALTER TABLE address_pair_cache ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon_all_grouping_memory"    ON grouping_memory;
DROP POLICY IF EXISTS "anon_all_address_pair_cache" ON address_pair_cache;

CREATE POLICY "anon_all_grouping_memory"
    ON grouping_memory FOR ALL TO anon
    USING (true) WITH CHECK (true);

CREATE POLICY "anon_all_address_pair_cache"
    ON address_pair_cache FOR ALL TO anon
    USING (true) WITH CHECK (true);
