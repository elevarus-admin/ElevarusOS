-- =============================================================================
-- ElevarusOS — Ringba tag rollup RPC
-- Migration: 007
-- =============================================================================
--
-- Provides server-side aggregation of ringba_calls by a JSONB tag path, with
-- call volume, paid-call counts, revenue, payout, and RPC (revenue per call).
--
-- Motivated by the Slack bot's recurring need to answer questions like:
--   - "Revenue by utm_campaign for last 7 days"
--   - "Top utm_content values by billable calls this week"
--   - "Which Geo:Country drove the highest RPC last month?"
--
-- The query-builder's groupBy only accepts whitelisted columns — it can't
-- group by a JSONB path. Rather than generalize the builder (complex +
-- easy to get wrong), we provide one purpose-built RPC callable via
-- `supabase.rpc('ringba_tag_rollup', ...)`.
--
-- Called from: src/integrations/ringba/live-tools.ts (ringbaTagRollupTool)
--
-- Semantics match the revenue report conventions:
--   - call_count includes ALL non-duplicate rows (or everything when
--     p_exclude_duplicates=false)
--   - paid_calls = has_payout=TRUE AND is_duplicate=FALSE
--   - revenue = SUM(payout_amount) over paid_calls only (matches the
--     Ringba UI "Paid" revenue column)
--   - rpc = revenue / paid_calls, 0 when no paid calls
--
-- NOTE: grants are not altered — the service-role key continues to be
-- the only caller until a read-only role lands in a later phase.
-- =============================================================================

CREATE OR REPLACE FUNCTION ringba_tag_rollup(
  p_tag_key             TEXT,                           -- e.g. 'User:utm_campaign'
  p_start_date          TIMESTAMPTZ,
  p_end_date            TIMESTAMPTZ,
  p_campaigns           TEXT[] DEFAULT NULL,            -- optional campaign_name IN (...)
  p_publishers          TEXT[] DEFAULT NULL,            -- optional publisher_name IN (...)
  p_buyers              TEXT[] DEFAULT NULL,            -- optional winning_buyer IN (...)
  p_only_paid           BOOLEAN DEFAULT FALSE,          -- restrict to has_payout AND NOT is_duplicate
  p_exclude_duplicates  BOOLEAN DEFAULT TRUE,           -- drop is_duplicate=TRUE
  p_include_empty       BOOLEAN DEFAULT FALSE,          -- include rows where the tag key is missing
  p_limit               INT DEFAULT 1000
)
RETURNS TABLE (
  tag_value    TEXT,
  call_count   BIGINT,
  paid_calls   BIGINT,
  revenue      NUMERIC,
  total_payout NUMERIC,
  rpc          NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    COALESCE(NULLIF(c.tag_values->>p_tag_key, ''), '(missing)') AS tag_value,
    COUNT(*)                                                           AS call_count,
    COUNT(*) FILTER (WHERE c.has_payout AND NOT c.is_duplicate)        AS paid_calls,
    ROUND(
      SUM(CASE WHEN c.has_payout AND NOT c.is_duplicate THEN c.payout_amount ELSE 0 END)::numeric,
      2
    )                                                                  AS revenue,
    ROUND(SUM(c.payout_amount)::numeric, 2)                            AS total_payout,
    CASE
      WHEN COUNT(*) FILTER (WHERE c.has_payout AND NOT c.is_duplicate) > 0
      THEN ROUND(
        SUM(CASE WHEN c.has_payout AND NOT c.is_duplicate THEN c.payout_amount ELSE 0 END)::numeric
          / NULLIF(COUNT(*) FILTER (WHERE c.has_payout AND NOT c.is_duplicate), 0),
        2
      )
      ELSE 0
    END                                                                AS rpc
  FROM ringba_calls c
  WHERE c.call_dt >= p_start_date
    AND c.call_dt <  p_end_date
    AND (p_include_empty OR c.tag_values ? p_tag_key)
    AND (NOT p_exclude_duplicates OR NOT c.is_duplicate)
    AND (NOT p_only_paid OR (c.has_payout AND NOT c.is_duplicate))
    AND (p_campaigns  IS NULL OR c.campaign_name  = ANY(p_campaigns))
    AND (p_publishers IS NULL OR c.publisher_name = ANY(p_publishers))
    AND (p_buyers     IS NULL OR c.winning_buyer  = ANY(p_buyers))
  GROUP BY COALESCE(NULLIF(c.tag_values->>p_tag_key, ''), '(missing)')
  ORDER BY revenue DESC, call_count DESC
  LIMIT GREATEST(p_limit, 1);
$$;

-- =============================================================================
-- Time-bucketed variant — useful for "utm_campaign revenue by day" charts.
-- Returns one row per (bucket, tag_value) with the same aggregates.
-- =============================================================================

CREATE OR REPLACE FUNCTION ringba_tag_timeseries(
  p_tag_key             TEXT,
  p_start_date          TIMESTAMPTZ,
  p_end_date            TIMESTAMPTZ,
  p_bucket              TEXT DEFAULT 'day',             -- 'hour' | 'day' | 'week' | 'month'
  p_campaigns           TEXT[] DEFAULT NULL,
  p_publishers          TEXT[] DEFAULT NULL,
  p_buyers              TEXT[] DEFAULT NULL,
  p_only_paid           BOOLEAN DEFAULT FALSE,
  p_exclude_duplicates  BOOLEAN DEFAULT TRUE,
  p_include_empty       BOOLEAN DEFAULT FALSE,
  p_limit               INT DEFAULT 5000
)
RETURNS TABLE (
  bucket_start TIMESTAMPTZ,
  tag_value    TEXT,
  call_count   BIGINT,
  paid_calls   BIGINT,
  revenue      NUMERIC,
  total_payout NUMERIC,
  rpc          NUMERIC
)
LANGUAGE sql STABLE AS $$
  SELECT
    date_trunc(
      CASE p_bucket
        WHEN 'hour'  THEN 'hour'
        WHEN 'week'  THEN 'week'
        WHEN 'month' THEN 'month'
        ELSE 'day'
      END,
      c.call_dt
    ) AS bucket_start,
    COALESCE(NULLIF(c.tag_values->>p_tag_key, ''), '(missing)') AS tag_value,
    COUNT(*)                                                           AS call_count,
    COUNT(*) FILTER (WHERE c.has_payout AND NOT c.is_duplicate)        AS paid_calls,
    ROUND(
      SUM(CASE WHEN c.has_payout AND NOT c.is_duplicate THEN c.payout_amount ELSE 0 END)::numeric,
      2
    )                                                                  AS revenue,
    ROUND(SUM(c.payout_amount)::numeric, 2)                            AS total_payout,
    CASE
      WHEN COUNT(*) FILTER (WHERE c.has_payout AND NOT c.is_duplicate) > 0
      THEN ROUND(
        SUM(CASE WHEN c.has_payout AND NOT c.is_duplicate THEN c.payout_amount ELSE 0 END)::numeric
          / NULLIF(COUNT(*) FILTER (WHERE c.has_payout AND NOT c.is_duplicate), 0),
        2
      )
      ELSE 0
    END                                                                AS rpc
  FROM ringba_calls c
  WHERE c.call_dt >= p_start_date
    AND c.call_dt <  p_end_date
    AND (p_include_empty OR c.tag_values ? p_tag_key)
    AND (NOT p_exclude_duplicates OR NOT c.is_duplicate)
    AND (NOT p_only_paid OR (c.has_payout AND NOT c.is_duplicate))
    AND (p_campaigns  IS NULL OR c.campaign_name  = ANY(p_campaigns))
    AND (p_publishers IS NULL OR c.publisher_name = ANY(p_publishers))
    AND (p_buyers     IS NULL OR c.winning_buyer  = ANY(p_buyers))
  GROUP BY 1, 2
  ORDER BY bucket_start ASC, revenue DESC
  LIMIT GREATEST(p_limit, 1);
$$;
