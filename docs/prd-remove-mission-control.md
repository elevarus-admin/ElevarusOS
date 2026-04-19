# PRD: Remove Mission Control — Replace With Native Capabilities

**Status:** Draft  
**Date:** 2026-04-18  
**Author:** Shane McIntyre  
**Target release:** Phase 1 in next sprint; Phase 2 within 4 weeks

---

## Quick Reference

### Files to Delete

| File | Why |
|------|-----|
| `src/core/mc-client.ts` | Entire MC HTTP wrapper — 11 API methods, no longer called |
| `src/core/mc-worker.ts` | Polling loop, agent registration, approval gate, comment posting |

### Files to Modify

| File | Change |
|------|--------|
| `src/index.ts` | Remove `MCWorker` instantiation, webhook registration block, and MC branch in `Scheduler` trigger; wire `Scheduler` directly to `Orchestrator.submitJob()` |
| `src/api/server.ts` | Remove `POST /api/webhooks/mc` route and its HMAC handler; remove `MCWorker` from `ApiServerOptions`; add `POST /api/jobs/:jobId/approve` and `POST /api/jobs/:jobId/reject`; remove MC task creation branch from `POST /api/jobs` `submitJob()` handler |
| `src/core/workspace-scaffold.ts` | Remove `MCClient` import and `buildSoulMd()` call to `MCClient.buildSoulContent()`; remove MC-specific content from `buildAgentMd()`, `buildToolsMd()`, `buildAgentsMd()`, `buildMissionMd()`, `buildWorkingMd()` — retain as agent memory files without MC references |
| `src/adapters/slack/notify.adapter.ts` | Add interactive Slack Block Kit button to `sendApprovalRequest()` — Approve / Reject buttons that POST to `/api/jobs/:jobId/approve` or `/api/jobs/:jobId/reject` |
| `docs/environment.md` | Remove Mission Control section; document `ELEVARUS_INTERNAL_WEBHOOK_SECRET` |
| `docs/architecture.md` | Replace MC-centric data flow diagram with native queue diagram |
| `.env.example` | Remove four MC env vars |

### New Files to Create

| File | Purpose |
|------|---------|
| `src/core/task-queue.ts` | Internal task queue backed by Supabase `tasks` table — atomic claim via `SELECT ... FOR UPDATE SKIP LOCKED` |
| `src/core/approval-store.ts` | In-memory approval callback registry (extracted from `MCWorker.approvalCallbacks`) — resolves `waitForApproval()` when `POST /api/jobs/:jobId/approve` fires |
| `supabase/migrations/20260419000001_tasks_table.sql` | `tasks` table DDL |
| `supabase/migrations/20260419000002_drop_mc_task_id.sql` | Drop `mc_task_id` column from `jobs` |

### Env Vars to Remove

| Variable | Currently used in |
|----------|------------------|
| `MISSION_CONTROL_URL` | `src/core/mc-client.ts` constructor |
| `MISSION_CONTROL_API_KEY` | `src/core/mc-client.ts` constructor |
| `MC_WEBHOOK_SECRET` | `src/api/server.ts` `receiveMCWebhook()` |
| `ELEVARUS_PUBLIC_URL` | `src/index.ts` webhook registration block |

---

## Background

ElevarusOS uses Mission Control (MC) as an external task board for four functions:

1. **Atomic task queue** — `GET /api/tasks/queue?agent={name}` atomically assigns one task per poll, preventing double-execution across restarts.
2. **Human approval gate** — blog workflows call `waitForApproval()` inside `MCWorker._executeTaskInner()`, which blocks until `MCWorker.notifyApproval()` is called by `POST /api/webhooks/mc`. MC fires that webhook when a human moves the task to `done` or `quality_review` in the MC UI.
3. **Agent registry UI** — `MCClient.registerAgent()` syncs instances to MC's Task Board on startup.
4. **Stage output surfacing** — `MCClient.addComment()` posts `summary`, `editorial`, and `drafting` stage outputs as readable comments on the MC task.

ElevarusOS already has everything needed to replace each of these:

| MC function | Native replacement |
|-------------|-------------------|
| Atomic queue | Supabase `tasks` table with `SELECT ... FOR UPDATE SKIP LOCKED` |
| Approval gate | `POST /api/jobs/:jobId/approve` endpoint + Slack interactive buttons |
| Agent registry | `listInstanceIds()` + `loadInstanceConfig()` (already the source of truth) |
| Stage output surfacing | `GET /api/jobs/:jobId/output` already exposes full stage outputs; Slack notifications already deliver key content |

The `Scheduler` in `src/index.ts` already has a direct-to-`Orchestrator` fallback path (the `else` branch in the `triggerFn` when `mcWorker.enabled` is false). Reporting bots (`final-expense-reporting`, `u65-reporting`, `hvac-reporting`) are fired entirely by the Scheduler and need no queue — they are point-in-time cron jobs, not inbound-request queues.

The `Orchestrator` (`src/core/orchestrator.ts`) already runs stages, handles retries with exponential backoff, persists state to Supabase, and sends Slack/email notifications. It is fully capable of being the primary execution engine.

---

## Phase 1 — Remove MC, Replace With Native Queue + Approval

### Goal

By end of Phase 1, ElevarusOS runs with zero MC dependencies. Reporting bots fire on cron directly. Blog bots receive jobs via the internal API queue and block on a native approval endpoint. Slack interactive buttons replace the MC Task Board approval UI.

### 1.1 Reporting Bots — Direct Scheduler Wiring

**Instances affected:** `final-expense-reporting`, `u65-reporting`, `hvac-reporting`

These bots have no approval gate (no `approval_notify` stage in their workflows). They are triggered entirely by cron. The fallback path already exists in `src/index.ts`:

```
// current (daemon mode):
if (mcWorker.enabled) {
  await mcWorker.createTask({ ... });
} else {
  const orchestrator = new Orchestrator(...);
  await orchestrator.submitJob(req, instanceId);
}
```

**Change:** Remove the `mcWorker.enabled` branch entirely. The `else` path becomes the only path. A single shared `Orchestrator` instance is constructed once at daemon startup (same as `--once` mode) and reused by the Scheduler trigger function.

The `Scheduler` constructor signature does not change — it still takes `triggerFn: (instanceId: string) => Promise<void>`. Only the closure body changes.

### 1.2 Blog Bots — Native Approval Gate

**Instances affected:** `elevarus-blog`, `nes-blog`

The approval gate is implemented in `MCWorker._executeTaskInner()` at the `approval_notify` stage check (line 308). The pattern is:

1. `ApprovalNotifyStage.run()` fires (sends Slack/email to approver)
2. `waitForApproval(mcTaskId)` blocks on a `Promise<boolean>` stored in `approvalCallbacks: Map<number, (approved: boolean) => void>`
3. `MCWorker.notifyApproval(mcTaskId, approved)` resolves the promise when the webhook arrives

This pattern is sound. The change is to extract it from `MCWorker` into a standalone `ApprovalStore` and key it on `job.id` (UUID) instead of an MC task ID (integer).

**New: `src/core/approval-store.ts`**

A singleton that manages pending approval callbacks:

- `waitForApproval(jobId: string, timeoutMs?: number): Promise<boolean>` — registers a callback and returns a Promise that resolves when approved/rejected or times out (default 24h, matching current behavior)
- `resolve(jobId: string, approved: boolean): boolean` — resolves the pending callback; returns `false` if no callback was registered (idempotent)
- `pendingJobIds(): string[]` — lists jobs currently awaiting approval (for health/status endpoints)

The `Orchestrator` already transitions jobs to `awaiting_approval` after the `approval_notify` stage (`src/core/orchestrator.ts`, line 205). Post-Phase 1, the `Orchestrator.runJob()` method needs a hook after this transition to call `approvalStore.waitForApproval(job.id)` and then either continue or fail the job.

**Alternative (simpler):** Rather than modifying `Orchestrator.runJob()`, a thin wrapper can be applied: the `approval_notify` stage itself calls `approvalStore.waitForApproval()` as part of its `run()` method. This is contained to `src/workflows/blog/stages/07-approval-notify.stage.ts` and requires no changes to the generic Orchestrator. This is the preferred approach as it keeps the Orchestrator workflow-agnostic.

In either case, `ApprovalNotifyStage` becomes the owner of the block, and the `ApprovalStore` is the signal mechanism.

### 1.3 New Supabase Table: `tasks`

This table is needed for **inbound job requests** from `POST /api/jobs` and any future intake (ClickUp webhook, Slack bot command). It is not needed for cron-fired jobs — those go directly to the Orchestrator.

**Migration: `supabase/migrations/20260419000001_tasks_table.sql`**

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identifies which bot instance should process this task
  instance_id   TEXT        NOT NULL,

  -- Status lifecycle: pending → claimed → running → done | failed
  status        TEXT        NOT NULL DEFAULT 'pending',

  -- Human-readable label (used in Slack messages and job titles)
  title         TEXT        NOT NULL,

  -- Full request payload — maps to BlogRequest fields
  request       JSONB       NOT NULL DEFAULT '{}',

  -- Set when a worker claims this task (prevents double-execution)
  claimed_by    TEXT,
  claimed_at    TIMESTAMPTZ,

  -- Set when the task completes (success or failure)
  completed_at  TIMESTAMPTZ,
  error         TEXT,

  -- Linked job ID once the Orchestrator creates a Job from this task
  job_id        UUID REFERENCES jobs(id),

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT tasks_status_check CHECK (
    status IN ('pending', 'claimed', 'running', 'done', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS tasks_instance_status_idx ON tasks (instance_id, status);
CREATE INDEX IF NOT EXISTS tasks_status_created_idx  ON tasks (status, created_at);
CREATE INDEX IF NOT EXISTS tasks_job_id_idx          ON tasks (job_id) WHERE job_id IS NOT NULL;

-- Atomic claim function — called by TaskQueue.claim()
-- Returns the claimed row, or NULL if no pending task exists for this instance.
CREATE OR REPLACE FUNCTION claim_task(p_instance_id TEXT, p_claimed_by TEXT)
RETURNS tasks LANGUAGE plpgsql AS $$
DECLARE
  claimed_row tasks;
BEGIN
  SELECT * INTO claimed_row
  FROM tasks
  WHERE instance_id = p_instance_id
    AND status = 'pending'
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE tasks
  SET status     = 'claimed',
      claimed_by = p_claimed_by,
      claimed_at = NOW(),
      updated_at = NOW()
  WHERE id = claimed_row.id;

  claimed_row.status     := 'claimed';
  claimed_row.claimed_by := p_claimed_by;
  claimed_row.claimed_at := NOW();
  RETURN claimed_row;
END;
$$;
```

**Migration: `supabase/migrations/20260419000002_drop_mc_task_id.sql`**

```sql
DROP INDEX IF EXISTS jobs_mc_task_id_idx;
ALTER TABLE jobs DROP COLUMN IF EXISTS mc_task_id;
```

### 1.4 New Module: `src/core/task-queue.ts`

Wraps the Supabase `tasks` table. Used by `POST /api/jobs` to enqueue inbound requests and by the daemon loop to claim and execute them.

**Interface:**

- `enqueue(params: { instanceId, title, request }): Promise<string>` — inserts a `pending` task, returns task UUID
- `claim(instanceId: string, workerId: string): Promise<Task | null>` — calls `claim_task()` Postgres function, returns claimed task or null
- `markDone(taskId: string, jobId: string): Promise<void>`
- `markFailed(taskId: string, error: string): Promise<void>`
- `listPending(instanceId?: string): Promise<Task[]>`

The daemon loop in `src/index.ts` (replacing the MCWorker poll loop) calls `taskQueue.claim()` per registered blog-bot instance on a `setInterval`. On claim, it calls `orchestrator.submitJob()` and links the resulting job ID via `taskQueue.markDone()`.

### 1.5 New API Endpoints

#### `POST /api/jobs/:jobId/approve`

Resolves the pending approval for a blog job. Called by Slack interactive component handler or directly via API.

**Request:**

```
POST /api/jobs/:jobId/approve
Content-Type: application/json
x-api-key: <API_SECRET>          (if API_SECRET is set)

{
  "approvedBy": "shane@elevarus.com",   // optional, for audit
  "notes": "Looks good"                  // optional
}
```

**Response 200:**

```json
{
  "jobId": "uuid",
  "approved": true,
  "approvedBy": "shane@elevarus.com",
  "message": "Job approved — workflow will resume"
}
```

**Response 404:** Job not found  
**Response 409:** Job is not in `awaiting_approval` status

**Implementation:** Calls `approvalStore.resolve(jobId, true)`. Updates `job.approval.approved = true`, `job.approval.approvedBy`, `job.approval.approvedAt` in the job store before resolving.

#### `POST /api/jobs/:jobId/reject`

Rejects the pending approval. Causes the workflow to transition to `failed`.

**Request:**

```
POST /api/jobs/:jobId/reject
Content-Type: application/json

{
  "rejectedBy": "shane@elevarus.com",
  "reason": "Needs revision"
}
```

**Response 200:**

```json
{
  "jobId": "uuid",
  "rejected": true,
  "message": "Job rejected — workflow will fail"
}
```

**Implementation:** Calls `approvalStore.resolve(jobId, false)`. Updates `job.approval.notes` with rejection reason.

#### Modified: `POST /api/jobs`

Remove the `mcWorker.enabled` branch entirely. The handler always calls `orchestrator.submitJob()` (or `taskQueue.enqueue()` for async queuing). Return the `jobId` immediately with a `pollUrl`.

For blog bots, the async pattern is:
1. `taskQueue.enqueue()` → returns task UUID, 202 response to caller
2. Daemon poll loop claims task → `orchestrator.submitJob()` → job begins

For reporting bots triggered via API (not cron), same flow applies.

Remove the `mcUrl` field from the 202 response. Remove the `message: "Task created in Mission Control"` copy.

#### Removed: `POST /api/webhooks/mc`

Delete the route registration and `receiveMCWebhook()` handler from `src/api/server.ts`. Remove the `express.raw()` mount for `/api/webhooks/mc`. Remove `MCWorker` from `ApiServerOptions`.

### 1.6 Slack Interactive Approval

The `SlackNotifyAdapter.sendApprovalRequest()` currently posts a plain text message. It needs to send a Block Kit message with Approve and Reject buttons.

**Button payload target:** `POST /api/jobs/:jobId/approve` or `POST /api/jobs/:jobId/reject`

Slack interactive components require a separate webhook endpoint (`/api/webhooks/slack/interactions`) that receives action payloads and maps them to the approval endpoints. This endpoint already has a natural home alongside the existing `POST /api/webhooks/slack` (Events API) handler in `src/api/server.ts`.

**New route:** `POST /api/webhooks/slack/interactions`

Slack posts a URL-encoded `payload` field. Parse it, extract `actions[0].action_id` (`approve` or `reject`) and `actions[0].value` (the job ID). Call `POST /api/jobs/:jobId/approve` or `reject` internally. Respond to Slack within 3 seconds with an updated message replacing the buttons with a confirmation.

Slack signature verification for this route uses the existing `verifySlackSignature()` from `src/adapters/slack/events.ts` — same `SLACK_SIGNING_SECRET`.

**Block Kit message structure for approval request:**

```
[Section] *Draft ready for approval*
          Job: <jobId>
          Title: <title>
          Words: <wordCount>
          Edit summary: <editSummary>

[Section] *Preview:*
          <first 400 chars of draft>

[Actions] [Approve ✓]  [Reject ✗]
```

Each button's `value` is the job UUID. No MC task ID involved.

### 1.7 Workspace Scaffold — Remove MC References

`src/core/workspace-scaffold.ts` currently generates 9 markdown files per instance, several of which contain MC-specific instructions. These files are useful as agent memory files and should be retained — just with MC references removed.

**Files to update content in (not delete):**

| Scaffold file | MC content to remove |
|---------------|----------------------|
| `agent.md` | "Tasks arrive via Mission Control's Task Board" paragraph; entire Task Protocol section |
| `TOOLS.md` | "Mission Control Integration" section (last 4 lines) |
| `AGENTS.md` | "All agents are coordinated via Mission Control's Task Board" and task flow description |
| `MISSION.md` | No MC references — no change needed |
| `WORKING.md` | `_(None — updated by MCWorker during workflow execution)_` → `_(None — updated by Orchestrator during workflow execution)_` |

**Also:** Remove the `MCClient` import from `workspace-scaffold.ts`. The `buildSoulMd()` function calls `MCClient.buildSoulContent(cfg)`. Extract this soul content generation inline (it is a simple string join of `cfg.brand` and `cfg.notify` fields) or move it to a utility in `src/core/instance-config.ts`.

### 1.8 `src/index.ts` — Daemon Startup Rewrite

Remove these blocks entirely:

1. `import { MCWorker } from "./core/mc-worker"` and `import { MCClient } from "./core/mc-client"`
2. `const mcWorker = new MCWorker(registry, notifiers, jobStore)` and `await mcWorker.start()`
3. Entire webhook registration block (`if (mcWorker.enabled) { ... registerWebhook ... }`)
4. The `mcWorker` option passed to `ApiServer`
5. The `mcWorker.enabled` branch inside the `Scheduler` `triggerFn` closure
6. `mcWorker.stop()` in the `shutdown` function

Add these:

1. A single `Orchestrator` instance constructed at daemon startup (same one used by both the Scheduler trigger and `POST /api/jobs`)
2. `ApprovalStore` singleton imported and passed to `ApprovalNotifyStage` constructor (via the blog workflow builder)
3. `TaskQueue` instance constructed and started (for inbound API jobs)
4. The `Scheduler` `triggerFn` closure now always calls `orchestrator.submitJob(req, instanceId)` directly

Updated daemon startup sequence:

```
1. createJobStore()
2. new WorkflowRegistry() → register all workflows
3. new ApprovalStore()
4. new Orchestrator(jobStore, [], notifiers, registry)   ← no intake adapters needed
5. new TaskQueue(supabaseClient)
6. new ApiServer({ port, jobStore, registry, orchestrator, approvalStore, taskQueue })
7. new Scheduler(async (instanceId) => orchestrator.submitJob(buildSampleRequest(instanceId), instanceId))
8. scheduler.start()
9. new LeadsProsperSyncWorker().start()
10. new RingbaSyncWorker().start()
```

The `--once` mode path is unchanged.

### 1.9 Environment Variable Changes

**Remove from `.env` and `.env.example`:**

```
MISSION_CONTROL_URL
MISSION_CONTROL_API_KEY
MC_WEBHOOK_SECRET
ELEVARUS_PUBLIC_URL
```

**Remove from `docs/environment.md`:** The entire "Mission Control" section (currently the last major section before "API Server").

**No new env vars required for Phase 1.** The Slack interactive buttons use the existing `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`.

### 1.10 Migration Path

Execute in this order to minimize blast radius. Each step can be independently verified before proceeding.

**Step 1 — Reporting bots (zero risk)**

Wire `final-expense-reporting`, `u65-reporting`, `hvac-reporting` directly to Orchestrator. These bots have no approval gate and no inbound queue. They are purely cron-fired. Verify one full run of each bot completes without MC credentials set in `.env`.

Rollback: restore the `mcWorker.enabled` branch in the Scheduler trigger function.

**Step 2 — Internal task queue**

Apply migration `20260419000001_tasks_table.sql`. Implement `TaskQueue` and wire `POST /api/jobs` to use it. Submit a test job via `POST /api/jobs` and verify it appears in the `tasks` table and is picked up by the daemon poll loop.

Rollback: remove the `TaskQueue` poll and revert `POST /api/jobs` to the direct-submit path.

**Step 3 — Approval store + endpoints**

Implement `ApprovalStore`. Add `POST /api/jobs/:jobId/approve` and `reject` endpoints. Modify `ApprovalNotifyStage` to call `approvalStore.waitForApproval()`. Test manually: run `elevarus-blog` through to `awaiting_approval`, then call `POST /api/jobs/:jobId/approve` directly. Verify remaining stages complete.

Rollback: revert `ApprovalNotifyStage` — approval notifications send but the gate does not block.

**Step 4 — Slack interactive buttons**

Add Block Kit message to `sendApprovalRequest()`. Add `POST /api/webhooks/slack/interactions` route. Test end-to-end: run blog workflow, receive Slack message with buttons, click Approve, verify workflow resumes.

Rollback: revert `sendApprovalRequest()` to plain text message. Approval still works via direct API call.

**Step 5 — Remove MC code**

Delete `src/core/mc-client.ts` and `src/core/mc-worker.ts`. Remove `POST /api/webhooks/mc` from `server.ts`. Remove all MC imports and references from `src/index.ts`. Apply migration `20260419000002_drop_mc_task_id.sql`. Remove MC env vars from `.env` and `.env.example`. Update `docs/environment.md`.

Rollback: restore from git.

**Instance flip order:**

| Order | Instance | Reason |
|-------|----------|--------|
| 1 | `final-expense-reporting` | Fully automated, 2h cron, no approval, lowest risk |
| 2 | `u65-reporting` | Same as above |
| 3 | `hvac-reporting` | Same as above |
| 4 | `elevarus-blog` | Has approval gate — flip after Slack buttons are tested |
| 5 | `nes-blog` | Same approval gate pattern as elevarus-blog |

### Phase 1 Definition of Done

- [ ] `src/core/mc-client.ts` and `src/core/mc-worker.ts` deleted from repo
- [ ] `POST /api/webhooks/mc` route removed from `src/api/server.ts`
- [ ] `MCWorker` not referenced anywhere in `src/`
- [ ] `src/index.ts` starts without MC env vars set — no errors, no warnings
- [ ] All five reporting/blog instances run a complete job without MC credentials
- [ ] `final-expense-reporting` completes a full cron-fired run to Slack
- [ ] `elevarus-blog` runs to `awaiting_approval`, receives Slack message with interactive buttons, approves via button, publishes
- [ ] `POST /api/jobs/:jobId/approve` endpoint returns 200; workflow resumes within 5 seconds
- [ ] `tasks` Supabase table created; `mc_task_id` column dropped from `jobs`
- [ ] MC env vars removed from `.env.example`; `docs/environment.md` MC section removed
- [ ] `workspace-scaffold.ts` does not import `MCClient`
- [ ] All TypeScript compilation errors resolved (`npm run build` passes)

---

## Phase 2 — Native Dashboard

### Goal

A lightweight read-only web UI backed by Supabase and the existing REST API. Replaces the MC Task Board as the status visibility layer for job monitoring and approval. No new backend required — all data is already in Supabase or the API.

### Context

`dashboard/` already exists in the repo (Next.js, confirmed by `next.config.js`, `tailwind.config.js`, `tsconfig.json` at the dashboard root). The dashboard directory has its own `package.json`. It connects to the same Supabase project as the ElevarusOS backend.

### 2.1 Pages

#### Active Jobs

Lists jobs with `status IN ('running', 'awaiting_approval')`.

Data source: `GET /api/jobs?status=running` + `GET /api/jobs?status=awaiting_approval`

Columns: Instance, Title, Status, Current Stage, Started At, Approver

For `awaiting_approval` rows, show an Approve / Reject button pair that calls `POST /api/jobs/:jobId/approve` or `/reject`. This duplicates the Slack button functionality for operators who prefer the dashboard.

#### Scheduled Jobs

Shows all instances with `schedule.enabled: true`.

Data source: `GET /api/schedule` (lists instanceId, cron expression, description, timezone)

Columns: Instance, Cron Expression, Next Fire (computed client-side from cron expression), Last Run Status, Last Run At

Next fire time can be computed in the browser using the `cronstrue` or `cron-parser` npm package — no backend change needed.

#### Job History

Paginated list of all jobs ordered by `created_at DESC`.

Data source: Supabase `jobs` table directly (service key is not exposed; use a read-only API endpoint or Supabase Row Level Security with an anon key scoped to read-only job columns).

Filters: instance (dropdown), status (dropdown), date range

Columns: Job ID (truncated), Instance, Title, Status, Created At, Completed At, Duration

#### Job Detail

Full job view: request fields, stage timeline, stage outputs.

Data source: `GET /api/jobs/:jobId` (metadata) + `GET /api/jobs/:jobId/output` (stage outputs)

Stage timeline: renders each `StageRecord` as a row with status indicator, start time, duration, attempt count, and error if failed.

Key outputs surfaced:
- Reporting jobs: `summary.markdownReport` rendered as markdown
- Blog jobs: `editorial.editedDraft` rendered as markdown; `drafting.draft` as collapsed secondary view

Approval panel (blog jobs only): shows approval state. If `awaiting_approval`, shows Approve / Reject controls.

#### Agent Registry

Lists all registered instances with config details.

Data source: `GET /api/instances`

Columns: ID, Name, Base Workflow, Enabled, Cron Schedule, Approver, Slack Channel

No create/edit UI in Phase 2 — instance configs are managed via `instance.md` files.

### 2.2 Auth

Dashboard uses `API_SECRET` passed as a bearer token in `Authorization: Bearer <API_SECRET>` headers to the ElevarusOS API. No separate auth layer needed for Phase 2. Session stored in `localStorage` or a cookie.

If a Supabase anon key is used for direct DB reads (job history pagination), enable RLS on `jobs` with a read-only policy for the anon role.

### 2.3 No New Backend Routes Required

All Phase 2 data is available from existing endpoints:

| Page | Data source |
|------|-------------|
| Active Jobs | `GET /api/jobs?status=running`, `GET /api/jobs?status=awaiting_approval` |
| Scheduled Jobs | `GET /api/schedule` |
| Job History | `GET /api/jobs?limit=50&offset=N` (add `offset` query param to existing handler) |
| Job Detail | `GET /api/jobs/:jobId`, `GET /api/jobs/:jobId/output` |
| Agent Registry | `GET /api/instances` |
| Approve/Reject | `POST /api/jobs/:jobId/approve`, `POST /api/jobs/:jobId/reject` |

The only API change needed is adding `offset` pagination support to `GET /api/jobs` in `src/api/server.ts` (`listJobs()` handler). Current implementation has `limit` but no `offset`.

### Phase 2 Definition of Done

- [ ] Active Jobs page loads and shows live job statuses with auto-refresh (polling `GET /api/jobs` every 15s)
- [ ] Approve / Reject buttons on awaiting_approval jobs resolve the workflow within 5 seconds
- [ ] Scheduled Jobs page shows correct next fire times for all five instances
- [ ] Job History paginates correctly; filters by instance and status work
- [ ] Job Detail renders stage timeline; `summary.markdownReport` and `editorial.editedDraft` display correctly
- [ ] Agent Registry page shows all instances with current config
- [ ] Dashboard is accessible at `http://localhost:3000` (or configured port) without MC running

---

## Phase 3 — Operational Telemetry

### Goal

Add structured event logging and dashboard charts for observability: job throughput, stage success rates, scheduled run health, and P&L trends from Ringba/Meta data.

### 3.1 New Supabase Tables

**Migration: `supabase/migrations/20260420000001_telemetry.sql`**

#### `job_events`

One row per stage start, stage complete, stage fail, and job-level state transitions. Enables per-stage timing and failure rate analysis without parsing the JSONB `stages` column.

```sql
CREATE TABLE IF NOT EXISTS job_events (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  instance_id   TEXT        NOT NULL,
  event_type    TEXT        NOT NULL,
  -- Values: job.started | job.completed | job.failed |
  --         stage.started | stage.completed | stage.failed
  stage_name    TEXT,
  attempt       INT,
  duration_ms   INT,         -- null for start events; populated on complete/fail
  error         TEXT,
  metadata      JSONB        DEFAULT '{}',
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS job_events_job_id_idx       ON job_events (job_id);
CREATE INDEX IF NOT EXISTS job_events_instance_idx     ON job_events (instance_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS job_events_event_type_idx   ON job_events (event_type, occurred_at DESC);
```

**Emitter:** A `TelemetryEmitter` class (thin Supabase insert wrapper) injected into the Orchestrator via the `IDashboardBridge` interface or as a direct dependency. The Orchestrator already calls `bridge?.onJobCreated()` and `bridge?.onJobUpdated()` — the telemetry emitter can implement this interface without any Orchestrator changes.

#### `scheduler_ticks`

One row per scheduled cron fire. Distinguishes "fired" from "completed" to detect missed or stalled schedules.

```sql
CREATE TABLE IF NOT EXISTS scheduler_ticks (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id   TEXT        NOT NULL,
  fired_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  job_id        UUID REFERENCES jobs(id),     -- set when the resulting job is created
  status        TEXT        NOT NULL DEFAULT 'fired',
  -- Values: fired | job_created | failed
  error         TEXT
);

CREATE INDEX IF NOT EXISTS scheduler_ticks_instance_idx ON scheduler_ticks (instance_id, fired_at DESC);
```

#### `agent_heartbeats`

One row per daemon ping (written every N minutes by a background interval in `src/index.ts`). Lets the dashboard show "last seen" for each agent and alert on stale heartbeats.

```sql
CREATE TABLE IF NOT EXISTS agent_heartbeats (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id   TEXT        NOT NULL,
  process_id    TEXT,       -- OS PID for identifying restarts
  beat_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata      JSONB       DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS heartbeats_instance_idx ON agent_heartbeats (instance_id, beat_at DESC);

-- Retention: auto-delete heartbeats older than 7 days
CREATE OR REPLACE FUNCTION prune_old_heartbeats() RETURNS void LANGUAGE sql AS $$
  DELETE FROM agent_heartbeats WHERE beat_at < NOW() - INTERVAL '7 days';
$$;
```

### 3.2 Dashboard Charts (Phase 2 dashboard extension)

| Chart | Data source | Granularity |
|-------|-------------|-------------|
| Jobs per day by instance | `job_events WHERE event_type = 'job.started'` grouped by `instance_id` + `DATE(occurred_at)` | Last 30 days |
| Stage success rate | `job_events` grouped by `stage_name` + `event_type` (completed vs. failed) | All time / 30d toggle |
| P&L trends | Existing `ringba_*` and `meta_*` Supabase tables (from `RingbaSyncWorker`) joined by date | MTD / last 3 months |
| Schedule health | `scheduler_ticks` — fired vs. job_created rate; gaps > 2 expected intervals flagged | Last 7 days |
| Agent uptime | `agent_heartbeats` — last beat age per instance | Live |

### 3.3 Alert Rules

Implemented as Supabase Database Webhooks (no new backend code) or as a periodic check in a lightweight `AlertWorker` in `src/integrations/`:

| Alert | Condition | Channel |
|-------|-----------|---------|
| Job failure rate | `>20% of jobs in last 1h failed` | Slack `#ops` |
| Missed schedule | `scheduler_ticks` gap for an instance > 2× cron interval | Slack `#ops` |
| Stale heartbeat | No heartbeat for instance in last 10 minutes | Slack `#ops` |
| Approval timeout | Job in `awaiting_approval` for > 20 hours | Email to approver + Slack `#ops` |

### Phase 3 Definition of Done

- [ ] `job_events` table populated with events for every job start, stage transition, and job complete/fail
- [ ] `scheduler_ticks` written on every cron fire
- [ ] `agent_heartbeats` written every 5 minutes per running instance
- [ ] Dashboard charts render for jobs-per-day, stage success rate, and P&L trends with real data
- [ ] At least one alert rule fires a Slack message to `#ops` under a test failure condition

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Approval webhook missed (Slack interactive component fails to deliver) | Low | Medium | Retain direct API endpoint `POST /api/jobs/:jobId/approve` as fallback; mention it in the approval Slack message |
| `claim_task()` Postgres function not available (Supabase plan limitation) | Low | High | Fallback: optimistic update with re-check (`UPDATE ... WHERE status='pending' ... RETURNING *`) — less safe but functional |
| Blog job stuck in `awaiting_approval` after restart (in-memory `ApprovalStore` cleared) | Medium | Medium | On daemon startup, query `jobs WHERE status = 'awaiting_approval'` and re-register callbacks in `ApprovalStore`; persist `approval.notifiedAt` to job record |
| Scheduler fires a cron job while a prior run for the same instance is still running | Low | Low | `Orchestrator.submitJob()` is fire-and-forget; concurrent runs are harmless for reporting bots; blog bots are unlikely to overlap given typical run time vs. schedule |
| Phase 2 dashboard exposes stage outputs containing PII or API keys | Low | High | Review stage output schemas before rendering; ensure `editorial.editedDraft` and `summary.markdownReport` only contain content, not credentials |
