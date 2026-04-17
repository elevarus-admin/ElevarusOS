-- =============================================================================
-- ElevarusOS — LeadsProsper Integration
-- Migration: 003
-- =============================================================================
--
-- Tables
--   lp_campaigns    — reference data: every LP campaign the account owns
--   lp_leads        — one row per lead (call/form submission) routed by LP
--   lp_sync_state   — checkpoint table for incremental pagination
--
-- Design notes
--   - `raw` JSONB holds the full original API payload for every row, so schema
--     drift on LP's side never loses data — we can reparse later if needed.
--   - `phone_normalized` is the reconciliation join key across LP / Ringba /
--     dispositions. Populated via a generated column (digits-only).
--   - `lead_date` is a real TIMESTAMPTZ (converted from LP's `lead_date_ms`)
--     so time-range queries use an index.
--   - No RLS — server-side service role only.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- lp_campaigns
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lp_campaigns (
  id              BIGINT       PRIMARY KEY,
  name            TEXT         NOT NULL,
  raw             JSONB        NOT NULL DEFAULT '{}',
  first_seen_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_synced_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lp_campaigns_name_idx ON lp_campaigns (name);

-- ---------------------------------------------------------------------------
-- lp_leads
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lp_leads (
  id                TEXT         PRIMARY KEY,          -- LP lead ID string
  campaign_id       BIGINT,                            -- FK-ish; no hard FK because campaigns sync is eventually-consistent
  campaign_name     TEXT,
  status            TEXT         NOT NULL,             -- ACCEPTED | REJECTED | DUPLICATED | ERROR
  error_code        INTEGER      NOT NULL DEFAULT 0,
  error_message     TEXT,
  is_test           BOOLEAN      NOT NULL DEFAULT FALSE,

  cost              NUMERIC(12, 4),                    -- what we paid supplier
  revenue           NUMERIC(12, 4),                    -- what buyer paid us

  lead_date         TIMESTAMPTZ  NOT NULL,             -- from lead_date_ms

  -- Promoted fields for fast filters and the reconciliation join
  phone             TEXT,
  phone_normalized  TEXT         GENERATED ALWAYS AS (REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g')) STORED,
  email             TEXT,
  state             TEXT,
  zip_code          TEXT,
  sub1              TEXT,
  sub2              TEXT,
  sub3              TEXT,

  supplier_id       BIGINT,
  supplier_name     TEXT,

  -- JSONB for long-tail fields that vary across verticals
  lead_data         JSONB        NOT NULL DEFAULT '{}',
  buyers            JSONB        NOT NULL DEFAULT '[]',
  raw               JSONB        NOT NULL DEFAULT '{}',

  synced_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Reconciliation join key — the hot index for phone-based cross-system lookups
CREATE INDEX IF NOT EXISTS lp_leads_phone_normalized_idx
  ON lp_leads (phone_normalized)
  WHERE phone_normalized <> '';

-- Time-range queries (most common reporting pattern)
CREATE INDEX IF NOT EXISTS lp_leads_lead_date_idx
  ON lp_leads (lead_date DESC);

-- Campaign + time (per-campaign reports)
CREATE INDEX IF NOT EXISTS lp_leads_campaign_date_idx
  ON lp_leads (campaign_id, lead_date DESC);

-- Attribution / supplier analysis
CREATE INDEX IF NOT EXISTS lp_leads_supplier_idx
  ON lp_leads (supplier_id)
  WHERE supplier_id IS NOT NULL;

-- Filter out rejected/error leads quickly
CREATE INDEX IF NOT EXISTS lp_leads_status_idx ON lp_leads (status);

-- Keep updated_at fresh
DROP TRIGGER IF EXISTS lp_leads_set_updated_at ON lp_leads;
CREATE TRIGGER lp_leads_set_updated_at
  BEFORE UPDATE ON lp_leads
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- lp_sync_state
-- ---------------------------------------------------------------------------
-- Checkpoint for the sync worker. One row per logical sync stream.
-- Current streams:
--   'leads:global'      — time-ranged incremental lead sync (all campaigns)
--   'campaigns:global'  — full campaign-list refresh
-- Future streams can be added without schema changes.

CREATE TABLE IF NOT EXISTS lp_sync_state (
  sync_key          TEXT         PRIMARY KEY,
  last_synced_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  high_water_mark   TIMESTAMPTZ,                       -- latest lead_date we've seen
  last_error        TEXT,
  notes             JSONB        NOT NULL DEFAULT '{}'
);
