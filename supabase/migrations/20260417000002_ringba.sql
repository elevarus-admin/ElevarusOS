-- =============================================================================
-- ElevarusOS — Ringba Integration
-- Migration: 004
-- =============================================================================
--
-- Tables
--   ringba_campaigns    — reference data: every Ringba campaign the account has
--   ringba_calls        — one row per inbound call (routing attempts in JSONB)
--   ringba_sync_state   — checkpoint for incremental sync
--
-- Design notes
--   - One row per Ringba `inboundCallId`. A single inbound call may have been
--     routed to multiple buyers — those routing attempts live in the
--     `routing_attempts` JSONB array. The "winning" record (non-duplicate,
--     hasPayout preferred) is promoted to top-level columns.
--   - `phone_normalized` is generated (digits-only) — reconciliation join key
--     with lp_leads.phone_normalized and future dispositions.phone_normalized.
--   - `raw` stores the winning RingbaCallRecord; `routing_attempts` stores ALL
--     records for the call. No information is lost relative to the API.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ringba_campaigns
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ringba_campaigns (
  id              TEXT         PRIMARY KEY,
  name            TEXT         NOT NULL,
  enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
  raw             JSONB        NOT NULL DEFAULT '{}',
  first_seen_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_synced_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ringba_campaigns_name_idx ON ringba_campaigns (lower(name));

-- ---------------------------------------------------------------------------
-- ringba_calls
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ringba_calls (
  inbound_call_id           TEXT         PRIMARY KEY,
  campaign_id               TEXT,
  campaign_name             TEXT,

  inbound_phone             TEXT,
  phone_normalized          TEXT         GENERATED ALWAYS AS
                                          (REGEXP_REPLACE(COALESCE(inbound_phone, ''), '[^0-9]', '', 'g')) STORED,

  call_dt                   TIMESTAMPTZ  NOT NULL,

  -- Winning-record fields (non-duplicate, payout preferred)
  call_length_seconds       INTEGER      NOT NULL DEFAULT 0,
  connected_length_seconds  INTEGER      NOT NULL DEFAULT 0,
  has_connected             BOOLEAN      NOT NULL DEFAULT FALSE,
  has_converted             BOOLEAN      NOT NULL DEFAULT FALSE,
  has_payout                BOOLEAN      NOT NULL DEFAULT FALSE,
  is_duplicate              BOOLEAN      NOT NULL DEFAULT FALSE,
  no_conversion_reason      TEXT,
  conversion_amount         NUMERIC(12, 4) NOT NULL DEFAULT 0,
  payout_amount             NUMERIC(12, 4) NOT NULL DEFAULT 0,
  profit_net                NUMERIC(12, 4) NOT NULL DEFAULT 0,
  total_cost                NUMERIC(12, 4) NOT NULL DEFAULT 0,
  winning_buyer             TEXT,
  target_name               TEXT,
  publisher_name            TEXT,
  recording_url             TEXT,

  -- Full raw data — winning record + all routing attempts
  routing_attempt_count     INTEGER      NOT NULL DEFAULT 1,
  routing_attempts          JSONB        NOT NULL DEFAULT '[]',
  raw                       JSONB        NOT NULL DEFAULT '{}',

  synced_at                 TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Reconciliation join key
CREATE INDEX IF NOT EXISTS ringba_calls_phone_normalized_idx
  ON ringba_calls (phone_normalized)
  WHERE phone_normalized <> '';

-- Time-range queries
CREATE INDEX IF NOT EXISTS ringba_calls_call_dt_idx
  ON ringba_calls (call_dt DESC);

-- Campaign + time (per-campaign reports)
CREATE INDEX IF NOT EXISTS ringba_calls_campaign_dt_idx
  ON ringba_calls (campaign_id, call_dt DESC)
  WHERE campaign_id IS NOT NULL;

-- Paid/billable filter — the hot path for revenue reports
CREATE INDEX IF NOT EXISTS ringba_calls_payout_idx
  ON ringba_calls (campaign_id, call_dt DESC)
  WHERE has_payout = TRUE AND is_duplicate = FALSE;

-- Attribution by publisher/traffic source
CREATE INDEX IF NOT EXISTS ringba_calls_publisher_idx
  ON ringba_calls (publisher_name)
  WHERE publisher_name IS NOT NULL AND publisher_name <> '';

-- updated_at auto-maintained by the shared trigger from migration 001
DROP TRIGGER IF EXISTS ringba_calls_set_updated_at ON ringba_calls;
CREATE TRIGGER ringba_calls_set_updated_at
  BEFORE UPDATE ON ringba_calls
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- ringba_sync_state
-- ---------------------------------------------------------------------------
-- Same shape as lp_sync_state (see docs/data-platform.md for pattern).
--   'calls:global'      — incremental call sync across all campaigns
--   'campaigns:global'  — campaign-list refresh

CREATE TABLE IF NOT EXISTS ringba_sync_state (
  sync_key          TEXT         PRIMARY KEY,
  last_synced_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  high_water_mark   TIMESTAMPTZ,
  low_water_mark    TIMESTAMPTZ,    -- earliest call_dt we have synced, for coverage checks
  last_error        TEXT,
  notes             JSONB        NOT NULL DEFAULT '{}'
);
