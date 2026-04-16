-- =============================================================================
-- ElevarusOS — Initial Schema
-- Migration: 001
-- =============================================================================
--
-- Tables
--   jobs       — one row per orchestrated job (blog, report, etc.)
--   instances  — bot instance configs, synced from instance.md files at startup
--
-- Views
--   job_stages_view — unnests the JSONB stages array for analytics queries
--
-- Design decisions
--   - stages, request, approval, publish_record stored as JSONB so the TypeScript
--     Job type maps 1:1 with no transformation layer
--   - Filterable columns (status, workflow_type, timestamps) promoted to real
--     columns so indexes work; everything else stays in JSONB
--   - RLS is disabled — ElevarusOS is a server-side service using the service
--     role key; enable + add policies if you expose the anon key to a frontend
-- =============================================================================

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jobs (
  id               UUID        PRIMARY KEY,
  workflow_type    TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'queued',

  -- Full BlogRequest (title, brief, audience, keyword, cta, rawSource, etc.)
  request          JSONB       NOT NULL DEFAULT '{}',

  -- Array of StageRecord objects
  stages           JSONB       NOT NULL DEFAULT '[]',

  -- ApprovalState { required, approved, approvedBy, approvedAt, notes }
  approval         JSONB       NOT NULL DEFAULT '{"required": true, "approved": false}',

  -- PublishRecord (optional)
  publish_record   JSONB,

  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,

  CONSTRAINT jobs_status_check CHECK (
    status IN (
      'queued', 'running', 'awaiting_approval',
      'approved', 'failed', 'completed'
    )
  )
);

-- Common query patterns
CREATE INDEX IF NOT EXISTS jobs_workflow_type_idx ON jobs (workflow_type);
CREATE INDEX IF NOT EXISTS jobs_status_idx        ON jobs (status);
CREATE INDEX IF NOT EXISTS jobs_created_at_idx    ON jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_updated_at_idx    ON jobs (updated_at DESC);
CREATE INDEX IF NOT EXISTS jobs_completed_at_idx  ON jobs (completed_at DESC) WHERE completed_at IS NOT NULL;

-- Full-text search on request fields (title, brief, keyword)
CREATE INDEX IF NOT EXISTS jobs_request_gin ON jobs USING GIN (request jsonb_path_ops);

-- ---------------------------------------------------------------------------
-- Auto-update updated_at on every save
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS jobs_set_updated_at ON jobs;
CREATE TRIGGER jobs_set_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- instances
-- ---------------------------------------------------------------------------
-- Synced from src/instances/<id>/instance.md at ElevarusOS startup.
-- Lets the dashboard and API query instance metadata from the DB instead of
-- reading .md files on every request.

CREATE TABLE IF NOT EXISTS instances (
  id            TEXT        PRIMARY KEY,
  name          TEXT        NOT NULL,
  base_workflow TEXT        NOT NULL,
  enabled       BOOLEAN     NOT NULL DEFAULT true,

  -- InstanceBrand { voice, audience, tone, industry? }
  brand         JSONB       NOT NULL DEFAULT '{}',

  -- InstanceNotify { approver?, slackChannel? }
  notify        JSONB       NOT NULL DEFAULT '{}',

  -- InstanceSchedule { enabled, cron?, description? }
  schedule      JSONB       NOT NULL DEFAULT '{"enabled": false}',

  synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- job_stages_view
-- ---------------------------------------------------------------------------
-- Unnests the JSONB stages array into rows for analytics.
-- Use this to answer questions like "which stage fails most?" without
-- loading full job objects.

CREATE OR REPLACE VIEW job_stages_view AS
SELECT
  j.id                                          AS job_id,
  j.workflow_type,
  j.status                                      AS job_status,
  j.created_at                                  AS job_created_at,
  s.ordinality                                  AS stage_index,
  s.value ->> 'name'                            AS stage_name,
  s.value ->> 'status'                          AS stage_status,
  (s.value ->> 'attempts')::INT                 AS attempts,
  (s.value ->> 'startedAt')::TIMESTAMPTZ        AS started_at,
  (s.value ->> 'completedAt')::TIMESTAMPTZ      AS completed_at,
  s.value ->> 'error'                           AS error,
  -- Exclude raw output from view (can be large); join jobs table for that
  (s.value -> 'output') IS NOT NULL             AS has_output
FROM jobs j,
  JSONB_ARRAY_ELEMENTS(j.stages) WITH ORDINALITY AS s(value, ordinality);

-- ---------------------------------------------------------------------------
-- Helper: jobs by instance summary (for dashboard cards)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW instance_job_summary AS
SELECT
  workflow_type                                 AS instance_id,
  COUNT(*)                                      AS total_jobs,
  COUNT(*) FILTER (WHERE status = 'completed')  AS completed,
  COUNT(*) FILTER (WHERE status = 'failed')     AS failed,
  COUNT(*) FILTER (
    WHERE status IN ('running', 'awaiting_approval')
  )                                             AS active,
  MAX(created_at)                               AS last_job_at,
  MAX(completed_at)                             AS last_completed_at
FROM jobs
GROUP BY workflow_type;
