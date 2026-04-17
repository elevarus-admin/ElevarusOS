-- =============================================================================
-- ElevarusOS — Migration 002
-- Add mc_task_id to jobs for Mission Control bridge persistence
-- =============================================================================
--
-- Stores the Mission Control task ID so the bridge can rebuild its in-memory
-- taskIdMap after a restart, preventing lost updates.
-- =============================================================================

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS mc_task_id INTEGER;

CREATE INDEX IF NOT EXISTS jobs_mc_task_id_idx ON jobs (mc_task_id) WHERE mc_task_id IS NOT NULL;
