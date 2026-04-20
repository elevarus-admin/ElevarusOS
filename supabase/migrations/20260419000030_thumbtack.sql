-- =============================================================================
-- ElevarusOS — Thumbtack Integration
-- =============================================================================
--
-- Source
--   A shared Google Sheet that Thumbtack updates daily. The sheet has a
--   "daily sessions" tab with one row per day; the import agent
--   (hvac-thumbtack-import) reads it on a daily cron and upserts rows here.
--
-- Tables
--   thumbtack_daily_sessions  — one row per (source, date)
--   thumbtack_sync_runs       — worker run log (for debugging sync lag)
--
-- Design notes
--   - `source` is denormalized in case we onboard a second Thumbtack feed
--     later (e.g. a different vertical's sheet). Default 'hvac' for now.
--   - Numeric columns mirror Google Sheets value semantics; sessions is
--     integer, owed_revenue is USD with 2 decimals.
--   - Upsert key is (source, day). Re-imports overwrite cleanly.
--   - Granular sheet-row metadata (raw JSON, sheet row index) is preserved
--     in `raw` so we never silently drop a column the report later wants.
-- =============================================================================

CREATE TABLE IF NOT EXISTS thumbtack_daily_sessions (
  source         TEXT          NOT NULL DEFAULT 'hvac',
  day            DATE          NOT NULL,
  sessions       INTEGER       NOT NULL DEFAULT 0,
  owed_revenue   NUMERIC(12,2) NOT NULL DEFAULT 0,
  raw            JSONB,
  imported_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source, day)
);

CREATE INDEX IF NOT EXISTS thumbtack_daily_sessions_day_idx
  ON thumbtack_daily_sessions (day DESC);

COMMENT ON TABLE  thumbtack_daily_sessions IS 'Per-day Thumbtack sessions + owed revenue. Populated daily by the hvac-thumbtack-import agent from a shared Google Sheet.';
COMMENT ON COLUMN thumbtack_daily_sessions.source       IS 'Logical feed name. Default ''hvac''. Allows multiple Thumbtack sheets later.';
COMMENT ON COLUMN thumbtack_daily_sessions.day          IS 'Sheet row date.';
COMMENT ON COLUMN thumbtack_daily_sessions.sessions     IS 'Daily Thumbtack session count.';
COMMENT ON COLUMN thumbtack_daily_sessions.owed_revenue IS 'Sum of "owed revenue" column for the day (USD).';
COMMENT ON COLUMN thumbtack_daily_sessions.raw          IS 'Verbatim sheet row (JSONB). Heavy — exclude from SELECT unless you need a column not promoted above.';
COMMENT ON COLUMN thumbtack_daily_sessions.imported_at  IS 'When this row was first written by the import agent.';
COMMENT ON COLUMN thumbtack_daily_sessions.updated_at   IS 'Last upsert (sheet edits land here).';

-- ---------------------------------------------------------------------------
-- thumbtack_sync_runs — observability for the import agent
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS thumbtack_sync_runs (
  id             BIGSERIAL    PRIMARY KEY,
  source         TEXT         NOT NULL DEFAULT 'hvac',
  started_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at    TIMESTAMPTZ,
  status         TEXT         NOT NULL DEFAULT 'running',     -- running | ok | error
  rows_read      INTEGER,
  rows_upserted  INTEGER,
  error_message  TEXT,
  notes          JSONB
);

CREATE INDEX IF NOT EXISTS thumbtack_sync_runs_started_idx
  ON thumbtack_sync_runs (started_at DESC);
