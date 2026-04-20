-- =============================================================================
-- ElevarusOS — Agent Builder
-- =============================================================================
--
-- Single table: agent_builder_sessions
--   One row per "I want to propose a new agent" conversation.
--   Transcript stored as JSONB; attachments[] references Supabase Storage URLs.
--   Question order enforced server-side via current_question_index.
--
-- See docs/prd-agent-builder.md for the full design.
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_builder_sessions (
  id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Provenance
  source                  TEXT          NOT NULL,                    -- 'slack' | 'dashboard'
  created_by              TEXT,                                      -- slack_user_id or dashboard user email
  slack_channel_id        TEXT,                                      -- set when source='slack'
  slack_thread_ts         TEXT,                                      -- set when source='slack'; used for session resume

  created_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- State machine
  status                  TEXT          NOT NULL DEFAULT 'open',     -- open | submitted | abandoned
  current_question_index  SMALLINT      NOT NULL DEFAULT 0,          -- 0 = not started; 1..6 = on canonical question N; 7+ = adaptive follow-ups; 99 = ready to finalize
  adaptive_followup_count SMALLINT      NOT NULL DEFAULT 0,          -- hard cap at 3 extra beyond the 6 canonical (total 9)

  -- Content
  transcript              JSONB         NOT NULL DEFAULT '[]',       -- [{role: 'assistant'|'user', content, question_index?, ts}]
  attachments             JSONB         NOT NULL DEFAULT '[]',       -- [{url, mime_type, filename, size_bytes, uploaded_at}]

  -- Extracted fields (populated at finalize time — redundant with transcript but faster to query)
  proposed_name           TEXT,
  proposed_slug           TEXT,
  vertical_tag            TEXT,                                      -- e.g. 'vertical:hvac'
  capability_tag          TEXT,                                      -- e.g. 'capability:reporting'

  -- Output
  clickup_task_id         TEXT,                                      -- set on successful finalize
  clickup_task_url        TEXT
);

-- Session resume lookup: find open session for this slack user in this thread
CREATE INDEX IF NOT EXISTS agent_builder_sessions_slack_resume_idx
  ON agent_builder_sessions (created_by, slack_channel_id, slack_thread_ts)
  WHERE source = 'slack' AND status = 'open';

-- Lifecycle queries (e.g. "find sessions idle >7 days, mark abandoned")
CREATE INDEX IF NOT EXISTS agent_builder_sessions_status_updated_idx
  ON agent_builder_sessions (status, updated_at DESC);

-- Reviewer queries (recent submitted tickets)
CREATE INDEX IF NOT EXISTS agent_builder_sessions_submitted_idx
  ON agent_builder_sessions (status, created_at DESC)
  WHERE status = 'submitted';

-- updated_at auto-maintenance
DROP TRIGGER IF EXISTS agent_builder_sessions_set_updated_at ON agent_builder_sessions;
CREATE TRIGGER agent_builder_sessions_set_updated_at
  BEFORE UPDATE ON agent_builder_sessions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
