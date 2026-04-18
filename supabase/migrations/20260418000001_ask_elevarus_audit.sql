-- =============================================================================
-- ElevarusOS — Ask Elevarus query audit log
-- Migration: 005
-- =============================================================================
--
-- Tables
--   ask_elevarus_queries — one row per tool invocation by the Slack Q&A bot.
--
-- Design notes
--   - Captures tool_name, input params, status, row count, timing, and the
--     Slack user/channel/trace id. Used to audit what the bot is touching
--     and to tune caps / rate limits later.
--   - No RLS — service role only.
-- =============================================================================

CREATE TABLE IF NOT EXISTS ask_elevarus_queries (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name         TEXT         NOT NULL,
  params            JSONB        NOT NULL DEFAULT '{}',
  status            TEXT         NOT NULL CHECK (status IN ('ok','capped','error')),
  row_count         INTEGER,
  total_available   INTEGER,
  elapsed_ms        INTEGER,
  error_message     TEXT,
  slack_user_id     TEXT,
  slack_channel_id  TEXT,
  trace_id          TEXT,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ask_elevarus_queries_created_at_idx
  ON ask_elevarus_queries (created_at DESC);

CREATE INDEX IF NOT EXISTS ask_elevarus_queries_tool_name_idx
  ON ask_elevarus_queries (tool_name);

CREATE INDEX IF NOT EXISTS ask_elevarus_queries_slack_user_idx
  ON ask_elevarus_queries (slack_user_id)
  WHERE slack_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ask_elevarus_queries_status_idx
  ON ask_elevarus_queries (status)
  WHERE status <> 'ok';
