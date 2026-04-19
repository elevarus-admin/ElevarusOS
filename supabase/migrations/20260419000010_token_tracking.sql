-- Token usage columns on jobs table
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS total_input_tokens   INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_output_tokens  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tokens         INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_cost_usd   NUMERIC(10,6) DEFAULT 0;

-- Daily token usage rollup view
CREATE OR REPLACE VIEW daily_token_usage AS
SELECT
  date_trunc('day', created_at AT TIME ZONE 'UTC') AS day,
  workflow_type,
  COUNT(*)                                          AS job_count,
  SUM(total_input_tokens)                           AS input_tokens,
  SUM(total_output_tokens)                          AS output_tokens,
  SUM(total_tokens)                                 AS total_tokens,
  ROUND(SUM(estimated_cost_usd)::NUMERIC, 6)        AS cost_usd
FROM jobs
WHERE status IN ('completed', 'failed', 'rejected')
GROUP BY 1, 2
ORDER BY 1 DESC, 2;

-- Settings table for dashboard preferences and alert thresholds
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('alert_daily_cost_usd',   '{"threshold": 50, "enabled": false}'),
  ('alert_job_failure_rate', '{"threshold": 20, "enabled": false}'),
  ('display_prefs',          '{"showCostEstimates": true, "historyPageSize": 25, "dateFormat": "relative"}')
ON CONFLICT (key) DO NOTHING;
