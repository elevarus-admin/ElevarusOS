-- =============================================================================
-- ElevarusOS — Google Ads Integration
-- =============================================================================
--
-- Tables
--   google_ads_customers        — sub-account directory under MCC 9899477831
--   google_ads_daily_metrics    — customer/day grain (primary rollup)
--   google_ads_campaign_metrics — customer/campaign/day grain
--   google_ads_sync_runs        — worker run log (for debugging sync lag)
--
-- Design notes
--   - Google Ads spend is synced nightly at 02:00 PT with a 3-day rolling
--     window to absorb Google's ~3h reporting lag and late attribution.
--   - `cost_micros` / 1e6 is stored as numeric(12,2) for direct reporting.
--   - Status values follow Google's enum: ENABLED | PAUSED | REMOVED |
--     CANCELED | CLOSED | SUSPENDED | HIDDEN | UNSPECIFIED.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- google_ads_customers
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS google_ads_customers (
  customer_id        TEXT         PRIMARY KEY,                -- 10-digit CID, no dashes
  descriptive_name   TEXT,
  manager            BOOLEAN      NOT NULL DEFAULT FALSE,     -- true = sub-MCC, false = leaf ad account
  parent_manager_id  TEXT,                                    -- parent CID in the hierarchy (nullable at root)
  level              SMALLINT     NOT NULL DEFAULT 1,         -- 0 = MCC root, 1 = direct child, ...
  currency_code      TEXT,
  time_zone          TEXT,
  status             TEXT,                                    -- ENABLED | CANCELED | SUSPENDED | CLOSED | ...
  first_seen_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_synced_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS google_ads_customers_name_idx
  ON google_ads_customers (lower(descriptive_name));

CREATE INDEX IF NOT EXISTS google_ads_customers_status_idx
  ON google_ads_customers (status)
  WHERE status = 'ENABLED';

-- ---------------------------------------------------------------------------
-- google_ads_daily_metrics
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS google_ads_daily_metrics (
  customer_id        TEXT         NOT NULL REFERENCES google_ads_customers(customer_id) ON DELETE CASCADE,
  date               DATE         NOT NULL,                   -- segments.date

  cost               NUMERIC(12,2) NOT NULL DEFAULT 0,        -- metrics.cost_micros / 1e6
  impressions        BIGINT        NOT NULL DEFAULT 0,
  clicks             BIGINT        NOT NULL DEFAULT 0,
  conversions        NUMERIC(12,2) NOT NULL DEFAULT 0,
  conversions_value  NUMERIC(12,2) NOT NULL DEFAULT 0,

  -- Derived (stored for query simplicity — sync worker computes on upsert)
  ctr                NUMERIC(8,4)  NOT NULL DEFAULT 0,        -- clicks / impressions (fraction)
  avg_cpc            NUMERIC(8,4)  NOT NULL DEFAULT 0,        -- cost / clicks

  synced_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  PRIMARY KEY (customer_id, date)
);

CREATE INDEX IF NOT EXISTS google_ads_daily_metrics_date_idx
  ON google_ads_daily_metrics (date DESC);

-- ---------------------------------------------------------------------------
-- google_ads_campaign_metrics
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS google_ads_campaign_metrics (
  customer_id        TEXT         NOT NULL REFERENCES google_ads_customers(customer_id) ON DELETE CASCADE,
  campaign_id        TEXT         NOT NULL,
  campaign_name      TEXT,
  campaign_status    TEXT,                                    -- ENABLED | PAUSED | REMOVED
  date               DATE         NOT NULL,

  cost               NUMERIC(12,2) NOT NULL DEFAULT 0,
  impressions        BIGINT        NOT NULL DEFAULT 0,
  clicks             BIGINT        NOT NULL DEFAULT 0,
  conversions        NUMERIC(12,2) NOT NULL DEFAULT 0,
  conversions_value  NUMERIC(12,2) NOT NULL DEFAULT 0,

  synced_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  PRIMARY KEY (customer_id, campaign_id, date)
);

CREATE INDEX IF NOT EXISTS google_ads_campaign_metrics_customer_date_idx
  ON google_ads_campaign_metrics (customer_id, date DESC);

CREATE INDEX IF NOT EXISTS google_ads_campaign_metrics_campaign_idx
  ON google_ads_campaign_metrics (campaign_id);

-- ---------------------------------------------------------------------------
-- google_ads_sync_runs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS google_ads_sync_runs (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at        TIMESTAMPTZ,
  status             TEXT         NOT NULL DEFAULT 'running', -- running | ok | partial | error
  customers_synced   INTEGER      NOT NULL DEFAULT 0,
  customers_failed   INTEGER      NOT NULL DEFAULT 0,
  rows_upserted      INTEGER      NOT NULL DEFAULT 0,
  window_days        SMALLINT     NOT NULL DEFAULT 3,
  error_message      TEXT
);

CREATE INDEX IF NOT EXISTS google_ads_sync_runs_started_at_idx
  ON google_ads_sync_runs (started_at DESC);
