-- ─── ElevarusOS Task Queue ────────────────────────────────────────────────────
--
-- Native replacement for Mission Control's task queue.
-- Used by TaskQueue (src/core/task-queue.ts) for durable, atomic task claiming.
--
-- The `claim_task` function uses SELECT ... FOR UPDATE SKIP LOCKED so multiple
-- daemon replicas can compete safely without double-claiming.
--
-- Status lifecycle:
--   pending → running → completed | failed
--
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tasks (
  id             uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_type  text          NOT NULL,
  instance_id    text          NOT NULL,
  status         text          NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','running','completed','failed')),
  priority       int           NOT NULL DEFAULT 0,
  payload        jsonb         NOT NULL DEFAULT '{}'::jsonb,
  claimed_by     text,                         -- daemon hostname / process ID
  claimed_at     timestamptz,
  completed_at   timestamptz,
  created_at     timestamptz   NOT NULL DEFAULT now(),
  updated_at     timestamptz   NOT NULL DEFAULT now(),
  error          text
);

CREATE INDEX IF NOT EXISTS tasks_status_priority_idx
  ON tasks (status, priority DESC, created_at ASC)
  WHERE status = 'pending';

-- ─── Atomic claim function ────────────────────────────────────────────────────
-- Claims the next pending task for a given workflow_type (or any type if NULL).
-- Returns the claimed row, or nothing if the queue is empty.

CREATE OR REPLACE FUNCTION claim_task(
  p_workflow_type  text    DEFAULT NULL,
  p_claimed_by     text    DEFAULT NULL
)
RETURNS SETOF tasks
LANGUAGE plpgsql
AS $$
DECLARE
  v_task tasks%ROWTYPE;
BEGIN
  SELECT *
    INTO v_task
    FROM tasks
   WHERE status = 'pending'
     AND (p_workflow_type IS NULL OR workflow_type = p_workflow_type)
   ORDER BY priority DESC, created_at ASC
   LIMIT 1
     FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE tasks
     SET status     = 'running',
         claimed_by = p_claimed_by,
         claimed_at = now(),
         updated_at = now()
   WHERE id = v_task.id
  RETURNING * INTO v_task;

  RETURN NEXT v_task;
END;
$$;

-- ─── Updated-at trigger ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
