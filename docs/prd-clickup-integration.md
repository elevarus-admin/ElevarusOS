# PRD: ClickUp Integration

**Status:** Draft  
**Author:** Shane McIntyre  
**Date:** 2026-04-17  
**Audience:** ElevarusOS engineering team

---

## Quick Reference

| Item | Value |
|---|---|
| **Env vars** | `CLICKUP_API_TOKEN`, `CLICKUP_WEBHOOK_SECRET`, `CLICKUP_TEAM_ID` |
| **Inbound endpoint** | `POST /webhooks/clickup` |
| **New client** | `src/integrations/clickup/client.ts` |
| **New types** | `src/integrations/clickup/types.ts` |
| **New stage** | `src/workflows/stages/clickup-sync.stage.ts` |
| **Config extension** | `InstanceClickUp` block in `src/core/instance-config.ts` |
| **Cache file** | `data/clickup-spaces.json` (list/space IDs, no Supabase) |
| **ClickUp API base** | `https://api.clickup.com/api/v2` |
| **Auth header** | `Authorization: {CLICKUP_API_TOKEN}` |
| **Webhook verification** | HMAC-SHA256 via `X-Signature` header |

---

## 1. Overview and Problem Statement

ElevarusOS currently operates as a closed loop: agents run on schedule or on MC task assignment, produce outputs, and post to Slack. There is no connection between the team's primary project management tool (ClickUp) and the agent orchestration layer.

This creates three friction points:

1. **Manual task creation.** When a human creates a ClickUp task and wants an agent to act on it, they must separately log into MC, create a task, assign it to an agent, and wait. There is no automated bridge.
2. **No closed-loop feedback.** When an agent workflow completes, results go to Slack only. ClickUp tasks that spawned the work never get updated with status, output summaries, or completion comments.
3. **Slack bot isolation.** The Slack bot being built has no way to surface or manipulate ClickUp tasks, so users cannot query task state or trigger agent work through a single interface.

The integration addresses all three by establishing a two-way channel: ClickUp can trigger ElevarusOS jobs, and ElevarusOS workflows can create, update, and comment on ClickUp tasks. The Slack bot surfaces both directions.

---

## 2. Goals and Non-Goals

### Goals

- Inbound: ClickUp webhook events create MC tasks and trigger agent workflows automatically
- Outbound: Any workflow stage can create, update, or comment on a ClickUp task via a shared `ClickUpHttpClient`
- Slack: The Slack bot can create ClickUp tasks, query task status, and trigger agent workflows — all via ElevarusOS API
- Store `clickupTaskId` on the `Job` metadata and in `instance.md` config; no dedicated Supabase table
- Follow the existing integration pattern established by `src/integrations/ringba/` exactly
- Webhook endpoint verifies ClickUp signatures before processing any payload
- Phased rollout: outbound first, inbound second, Slack commands third

### Non-Goals

- Syncing ClickUp data to Supabase for reporting or analytics
- Replacing MC as the task management layer — ClickUp events create MC tasks, not bypass them
- Full ClickUp project management UI or two-way sync of all ClickUp fields
- Supporting multiple ClickUp workspaces (single `CLICKUP_TEAM_ID` only)
- Real-time ClickUp data in the ElevarusOS dashboard

---

## 3. User Stories

### Human in ClickUp

| ID | Story | Acceptance Criteria |
|---|---|---|
| CU-01 | As a team member, I create a ClickUp task in a watched list and expect the assigned agent to begin work automatically. | Webhook fires within 30s; MC task created; agent job starts; ClickUp task receives a comment confirming job start. |
| CU-02 | As a team member, I update a ClickUp task's status to a configured trigger value and expect the agent workflow to re-run or advance. | `taskStatusUpdated` event received; mapped MC task status updated; orchestrator responds per status mapping table. |
| CU-03 | As a team member, I assign a ClickUp task to an agent-named assignee and expect ElevarusOS to detect the assignment and dispatch accordingly. | `taskAssigned` event parsed; `assigned_to` extracted; MC task created with correct agent name. |
| CU-04 | As a team member, after an agent workflow completes I want to see a summary comment on the original ClickUp task. | `clickup-sync` stage posts completion comment; ClickUp task status updated per `statusMap` config. |

### ElevarusOS Agent (Workflow / Orchestrator)

| ID | Story | Acceptance Criteria |
|---|---|---|
| AG-01 | As a reporting agent, after completing my workflow I create a ClickUp task in the configured list summarizing the run results. | Outbound `POST /task` to ClickUp API succeeds; task ID stored in `job.metadata.clickupTaskId`. |
| AG-02 | As any agent, when my workflow fails I update the ClickUp task that triggered me to a failure status. | `ClickUpHttpClient.updateTaskStatus()` called with `statusMap.failed`; comment added with error summary. |
| AG-03 | As any agent, I can optionally include `clickup-sync` as a terminal stage in my workflow definition without coupling my core stages to ClickUp. | Stage is opt-in per workflow definition; skipped cleanly if `clickup.syncEnabled` is false in instance config. |

### Slack Bot User

| ID | Story | Acceptance Criteria |
|---|---|---|
| SB-01 | As a Slack user, I send a command to create a ClickUp task and optionally trigger an agent workflow. | Bot calls `POST /api/clickup/tasks`; task created in ClickUp; if agent specified, MC task created and job queued. |
| SB-02 | As a Slack user, I query the status of a ClickUp task by ID or name. | Bot calls `GET /api/clickup/tasks/:taskId`; ElevarusOS proxies ClickUp API; current status returned to Slack. |
| SB-03 | As a Slack user, I link an existing ClickUp task to an agent and trigger a workflow run. | Bot calls `POST /api/clickup/tasks/:taskId/trigger`; MC task created; job queued with `clickupTaskId` in metadata. |

---

## 4. Integration Architecture

### Two-Way Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CLICKUP                                    │
│  Lists / Tasks / Custom Fields / Statuses / Webhooks                │
└────────────────────┬──────────────────────┬─────────────────────────┘
                     │ Webhook (inbound)     │ REST API calls (outbound)
                     ▼                       ▲
┌─────────────────────────────────────────────────────────────────────┐
│                        ElevarusOS Express API                       │
│                                                                     │
│  POST /webhooks/clickup          GET|POST /api/clickup/*            │
│  (HMAC-SHA256 verified)          (Slack bot consumer)               │
│           │                               ▲                         │
│           ▼                               │                         │
│   ClickUp Webhook Handler         ClickUpHttpClient                 │
│   src/integrations/clickup/       src/integrations/clickup/         │
│   webhook-handler.ts              client.ts                         │
│           │                               ▲                         │
│           ▼                               │                         │
│       MC Client                   clickup-sync.stage.ts             │
│   (creates MC task,               (optional terminal stage          │
│    assigns agent)                  in any workflow)                 │
│           │                               ▲                         │
│           ▼                               │                         │
│       MC Worker  ──────────►  Orchestrator  ──────────►  Slack      │
│   (polls, dispatches)         (runs stages)             (publish)   │
└─────────────────────────────────────────────────────────────────────┘
                     ▲
                     │  POST /api/clickup/*
┌────────────────────┴────────────────────────────────────────────────┐
│                         Slack Bot (external)                        │
│             Reads/creates tasks, triggers agent workflows           │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. Inbound Flow: ClickUp → ElevarusOS

### Sequence

```
ClickUp task event
        │
        ▼
POST /webhooks/clickup
        │
        ├─ Verify X-Signature header (HMAC-SHA256)
        │   └─ 401 if invalid
        │
        ├─ Parse ClickUpWebhookEvent (event type + task payload)
        │
        ├─ Route by event type (see Event Mapping, §11)
        │
        ├─ Extract agent name from task assignee or custom field
        │
        ├─ Verify agent name maps to a known instance ID
        │   └─ Log warning and 200 if no match (avoid webhook retry storms)
        │
        ├─ MCClient.createTask({
        │     title: clickup task name,
        │     assigned_to: agentInstanceId,
        │     metadata: { clickupTaskId, clickupListId, clickupSpaceId }
        │   })
        │
        ├─ Optionally: ClickUpHttpClient.addComment(taskId, "Job queued: <jobId>")
        │
        └─ Return 200 immediately (async job dispatch)
```

### Key Rules

- Always return `200` to ClickUp after signature verification, regardless of downstream success. Returning non-200 triggers ClickUp retries.
- The webhook handler must be non-blocking: create the MC task and return. Do not await job completion.
- If the MC task creation fails, log the error and still return `200`. Failed inbound events should surface in ElevarusOS logs, not ClickUp retry queues.
- Agent name resolution: check the ClickUp task's `assignees[].username` or a dedicated custom field (e.g. `ElevarusAgent`) against the list of known instance IDs from `listInstanceIds()`.

---

## 6. Outbound Flow: ElevarusOS → ClickUp

### Trigger Points

| Trigger | Action |
|---|---|
| Workflow stage completes successfully | `clickup-sync.stage.ts` posts completion comment, updates status |
| Workflow job fails | `clickup-sync.stage.ts` posts error comment, updates status to failure value |
| Slack bot command (create task) | `POST /api/clickup/tasks` route calls `ClickUpHttpClient.createTask()` |
| Slack bot command (trigger workflow) | `POST /api/clickup/tasks/:id/trigger` creates MC task with `clickupTaskId` in metadata |

### `clickup-sync.stage.ts` Behavior

- Stage name: `clickup-sync`
- Reads `job.metadata.clickupTaskId` — if absent, stage completes as no-op
- Reads `instanceConfig.clickup.syncEnabled` — if false, stage completes as no-op
- On success: calls `ClickUpHttpClient.addComment()` with a summary of `job.stageOutputs`, then calls `updateTaskStatus()` with `statusMap.completed`
- On upstream stage failure detected in job record: posts error summary, calls `updateTaskStatus()` with `statusMap.failed`
- Stores `{ clickupTaskId, commentId, statusSet }` as its stage output

### ClickUp API Operations Supported (Phase 1 and 2)

| Operation | ClickUp Endpoint |
|---|---|
| Create task | `POST /list/{listId}/task` |
| Update task | `PUT /task/{taskId}` |
| Update status | `PUT /task/{taskId}` (status field) |
| Add comment | `POST /task/{taskId}/comment` |
| Get task | `GET /task/{taskId}` |
| Get tasks in list | `GET /list/{listId}/task` |

---

## 7. Slack Bot ↔ ClickUp

The Slack bot is an external project that communicates with ElevarusOS via `src/core/api.ts` REST endpoints. ElevarusOS acts as the ClickUp proxy — the Slack bot never calls ClickUp directly.

### New API Endpoints for Slack Bot Consumption

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/clickup/tasks` | Create a ClickUp task; optionally queue an agent job |
| `GET` | `/api/clickup/tasks/:taskId` | Proxy GET task from ClickUp API |
| `POST` | `/api/clickup/tasks/:taskId/trigger` | Link task to agent, create MC task, queue job |
| `GET` | `/api/clickup/lists` | Return known list IDs from `data/clickup-spaces.json` |

### `POST /api/clickup/tasks` Request Body

```
{
  listId: string,           // ClickUp list ID
  name: string,             // Task title
  description?: string,
  agentInstanceId?: string, // If provided, also creates MC task
  status?: string           // ClickUp status value
}
```

### `POST /api/clickup/tasks/:taskId/trigger` Request Body

```
{
  agentInstanceId: string,  // Must match a known instance ID
  metadata?: Record<string, unknown>  // Extra metadata passed through to MC task
}
```

Response for trigger: `{ jobId, mcTaskId, clickupTaskId }` — Slack bot can poll job status via existing `GET /api/jobs/:jobId`.

---

## 8. Data Model

### Field Mapping: ClickUp ↔ ElevarusOS

| ClickUp Field | ElevarusOS Field | Notes |
|---|---|---|
| `task.id` | `job.metadata.clickupTaskId` | String. Stored on Job at creation time. |
| `task.list.id` | `instanceConfig.clickup.listId` | Configured per instance in `instance.md`. |
| `task.space.id` | `instanceConfig.clickup.spaceId` | Configured per instance in `instance.md`. |
| `task.status.status` | Mapped via `instanceConfig.clickup.statusMap` | String → string mapping per instance. |
| `task.assignees[].username` | `job.metadata.assignedAgent` | Used to resolve agent instance ID inbound. |
| `task.custom_fields[]` | `job.metadata.clickupCustomFields` | Raw array stored for workflow use; no schema enforcement at this layer. |
| `task.name` | `mcTask.title` | MC task title set to ClickUp task name for traceability. |

### Storage Decision

- No Supabase table for ClickUp data.
- `clickupTaskId` stored in `job.metadata` (existing `metadata?: Record<string, unknown>` on `MCTask`).
- `job.metadata` is already persisted by the MC task record — no schema migration needed.
- List IDs and space IDs are static configuration values; store them in:
  - **Per-instance:** `instanceConfig.clickup.listId`, `instanceConfig.clickup.spaceId` in `instance.md` YAML frontmatter
  - **Shared/lookup:** `data/clickup-spaces.json` — a lightweight JSON file mapping human-readable names to IDs, checked into the repo, updated manually or via a one-time setup script

### `data/clickup-spaces.json` Shape

```json
{
  "teamId": "CLICKUP_TEAM_ID_VALUE",
  "spaces": [
    { "id": "space_id", "name": "ElevarusOS" }
  ],
  "lists": [
    { "id": "list_id", "name": "Agent Jobs", "spaceId": "space_id" }
  ]
}
```

---

## 9. New Technical Components

### `src/integrations/clickup/types.ts`

Interfaces to define (TypeScript, no implementation here — see PRD constraints):

- `ClickUpTask` — full task shape from the ClickUp v2 API
- `ClickUpTaskCreate` — request body for `POST /list/{listId}/task`
- `ClickUpTaskUpdate` — request body for `PUT /task/{taskId}`
- `ClickUpComment` — request body for `POST /task/{taskId}/comment`
- `ClickUpWebhookEvent` — inbound webhook payload shape
- `ClickUpWebhookEventType` — string union of supported event types
- `ClickUpStatus` — `{ status: string; color: string; type: string }`
- `ClickUpAssignee` — `{ id: number; username: string; email: string }`
- `ClickUpCustomField` — `{ id: string; name: string; value: unknown }`

### `src/integrations/clickup/client.ts`

`ClickUpHttpClient` class following the `RingbaHttpClient` pattern exactly:

- Constructor reads `CLICKUP_API_TOKEN` and `CLICKUP_TEAM_ID` from env; sets `this.enabled`
- Auth header: `Authorization: {CLICKUP_API_TOKEN}` (no `Bearer` prefix — ClickUp personal tokens use raw value)
- Base URL: `https://api.clickup.com/api/v2`
- Shared private `request()` helper with 429/5xx retry and exponential backoff (same pattern as Ringba)
- Public methods: `createTask()`, `updateTask()`, `updateTaskStatus()`, `addComment()`, `getTask()`, `getTasksInList()`
- All methods return `null` (not throw) on failure; errors logged via `logger.warn`

### `src/integrations/clickup/index.ts`

Barrel export: `export { ClickUpHttpClient } from "./client"` and all types from `./types`.

### `src/integrations/clickup/webhook-handler.ts`

- `handleClickUpWebhook(payload: ClickUpWebhookEvent, instanceId?: string): Promise<void>`
- Resolves agent from task assignee/custom field
- Creates MC task via `MCClient`
- Optionally posts confirmation comment via `ClickUpHttpClient`
- All errors caught and logged — never throws (called from Express handler which must return 200)

### `src/core/api.ts` — New Routes

Three additions (all authenticated with existing API key mechanism if present):

1. `POST /webhooks/clickup` — public-facing, verified by `X-Signature` HMAC only
2. `POST /api/clickup/tasks` — Slack bot: create task ± queue agent job
3. `GET /api/clickup/tasks/:taskId` — Slack bot: proxy get task
4. `POST /api/clickup/tasks/:taskId/trigger` — Slack bot: link task + trigger agent
5. `GET /api/clickup/lists` — Slack bot: return list catalog from `data/clickup-spaces.json`

### `src/workflows/stages/clickup-sync.stage.ts`

Implements `IStage` from `src/core/stage.interface.ts`:

- `stageName: "clickup-sync"`
- `run(job: Job): Promise<unknown>`
- Reads `job.metadata?.clickupTaskId` — no-op if absent
- Reads `instanceConfig.clickup.syncEnabled` — no-op if false
- Constructs comment body from prior stage outputs (summary of key metrics or content)
- Calls `ClickUpHttpClient.addComment()` then `updateTaskStatus()`
- Returns `{ clickupTaskId, commentPosted, statusUpdated }` as stage output

To include in a workflow, add `"clickup-sync"` to the workflow definition's `stages[]` array in the relevant workflow registry entry. The stage is self-guarding and produces no side effects if not configured.

### `src/core/instance-config.ts` — Extension

Add `InstanceClickUp` interface and optional `clickup?: InstanceClickUp` field on `InstanceConfig`:

```
interface InstanceClickUp {
  listId: string;        // ClickUp list ID where tasks are created/watched
  spaceId: string;       // ClickUp space ID
  syncEnabled: boolean;  // Whether clickup-sync stage should execute
  statusMap: {
    running: string;     // ClickUp status value when job starts
    completed: string;   // ClickUp status value when job completes
    failed: string;      // ClickUp status value when job fails
  };
  commentOnStart?: boolean;  // Post a comment when job is queued (default: false)
}
```

`instance.md` YAML frontmatter example:

```yaml
clickup:
  listId: "abc123"
  spaceId: "def456"
  syncEnabled: true
  commentOnStart: true
  statusMap:
    running: "In Progress"
    completed: "Complete"
    failed: "Blocked"
```

`loadInstanceConfig()` must be updated to parse and validate the `clickup` block using the same null-guard pattern used for `ringba` and `meta`.

---

## 10. Webhook Security

ClickUp signs all webhook payloads with HMAC-SHA256 using the secret set during webhook registration.

### Verification Flow

```
Incoming POST /webhooks/clickup
        │
        ├─ Read raw request body as Buffer (before JSON.parse)
        │
        ├─ Read X-Signature header (hex string)
        │
        ├─ Compute: HMAC-SHA256(CLICKUP_WEBHOOK_SECRET, rawBody)
        │
        ├─ Compare computed hex to X-Signature (timing-safe compare)
        │   └─ 401 + log warning if mismatch
        │
        └─ JSON.parse(rawBody) and proceed
```

### Implementation Notes

- Use Node's built-in `crypto.timingSafeEqual()` for the comparison — never use `===` on signature strings.
- Express must be configured to preserve the raw body for this route. Use `express.raw({ type: 'application/json' })` on the `/webhooks/clickup` route specifically, not global `express.json()`, to avoid interference with other routes.
- The raw body buffer must be captured before any middleware parses it.
- `CLICKUP_WEBHOOK_SECRET` is set during webhook registration in the ClickUp UI/API and must match exactly.

---

## 11. Event Mapping

| ClickUp Event Type | ElevarusOS Action | Condition |
|---|---|---|
| `taskCreated` | Create MC task, assign agent | Task is in a watched list AND has an agent assignee/custom field |
| `taskStatusUpdated` | Update existing MC task status OR re-queue job | Existing `clickupTaskId` matches a known MC task |
| `taskAssigned` | Create MC task if not already exists | New assignee maps to a known agent instance ID |
| `taskCommentPosted` | No action (Phase 1/2) | — |
| `taskUpdated` | No action unless custom field change (Phase 3+) | — |
| `customFieldUpdated` | Conditional re-queue (Phase 3+) | Depends on which custom field and configured trigger values |

### Event Routing Logic

The webhook handler checks events in this order:

1. Is the event type in the supported set? If not, log and return.
2. Is the task in a list mapped to a known instance? Check `data/clickup-spaces.json` and all instance configs.
3. Does the task have a resolvable agent (assignee username = instance ID, or `ElevarusAgent` custom field)?
4. Is there already an active MC task for this `clickupTaskId`? If yes, update rather than create.

---

## 12. Status Mapping

ClickUp task statuses are workspace-configured strings. The mapping is per-instance in `instanceConfig.clickup.statusMap`.

### Default Suggested Mapping

| ElevarusOS Job Status | ClickUp Task Status (suggested default) |
|---|---|
| `queued` | `Open` |
| `running` | `In Progress` |
| `awaiting_approval` | `Review` |
| `completed` | `Complete` |
| `failed` | `Blocked` |

The actual string values must match the ClickUp workspace's custom statuses exactly (case-sensitive). Each instance configures its own map since different ClickUp lists may use different status names.

Status updates flow outbound only (ElevarusOS → ClickUp). ElevarusOS job status is the source of truth; ClickUp status is a derived reflection.

---

## 13. Environment Variables

| Variable | Required | Description |
|---|---|---|
| `CLICKUP_API_TOKEN` | Yes | Personal API token from ClickUp → Settings → Apps. Used for all outbound REST calls. |
| `CLICKUP_WEBHOOK_SECRET` | Yes (Phase 2) | Secret string set during ClickUp webhook registration. Used for HMAC-SHA256 verification. |
| `CLICKUP_TEAM_ID` | Yes | ClickUp workspace team ID. Found in workspace settings or API response. Required for team-scoped API calls. |

These follow the same `process.env.X ?? ""` pattern used in all other ElevarusOS clients. The `ClickUpHttpClient` constructor sets `this.enabled = Boolean(CLICKUP_API_TOKEN && CLICKUP_TEAM_ID)` and no-ops all methods when disabled.

Add all three to `docs/environment.md` and `.env.example`.

---

## 14. Phased Rollout

### Phase 1: Outbound Only (No Webhook Needed)

**Goal:** Any workflow can create or update a ClickUp task on completion.

Deliverables:
- `src/integrations/clickup/client.ts` with `createTask()`, `updateTask()`, `addComment()`, `getTask()`
- `src/integrations/clickup/types.ts`
- `src/integrations/clickup/index.ts`
- `src/workflows/stages/clickup-sync.stage.ts`
- `InstanceClickUp` config block in `src/core/instance-config.ts`
- `data/clickup-spaces.json` with team/space/list IDs
- Add `clickup` block to `src/instances/final-expense-reporting/instance.md` as the pilot instance

Validation: Run `final-expense-reporting` workflow manually; confirm ClickUp task created/commented in the target list.

### Phase 2: Inbound Webhook

**Goal:** ClickUp task creation triggers agent workflow automatically.

Deliverables:
- `POST /webhooks/clickup` route in `src/core/api.ts`
- `src/integrations/clickup/webhook-handler.ts`
- HMAC-SHA256 verification middleware
- ClickUp webhook registration (point to ElevarusOS public URL + set secret)
- Agent resolution logic (assignee username → instance ID lookup)
- `commentOnStart` support in `clickup-sync` stage

Validation: Create a ClickUp task assigned to `final-expense-reporting`; confirm MC task created and job queued within 30 seconds; confirm ClickUp task receives a start comment.

### Phase 3: Slack Bot ClickUp Commands

**Goal:** Slack bot users can create tasks, query status, and trigger agent workflows via ElevarusOS.

Deliverables:
- `POST /api/clickup/tasks` endpoint
- `GET /api/clickup/tasks/:taskId` endpoint
- `POST /api/clickup/tasks/:taskId/trigger` endpoint
- `GET /api/clickup/lists` endpoint
- Slack bot command handlers (in the Slack bot project, consuming these endpoints)

Validation: Slack command creates a ClickUp task; task appears in ClickUp; Slack bot reports task ID back to user.

---

## 15. Open Questions

| # | Question | Owner | Notes |
|---|---|---|---|
| OQ-01 | Which ClickUp lists map to which agent instances? | Shane | Need list IDs for each active instance before Phase 2 config. |
| OQ-02 | What is the agent resolution strategy? Assignee username = instance ID, or a custom field? | Shane | Custom field (`ElevarusAgent`) is more explicit but requires ClickUp workspace config. |
| OQ-03 | What is the custom field schema for agent assignment? | Shane | If using a custom field, decide field name, type (text/dropdown), and allowed values. |
| OQ-04 | What is the MC task template for ClickUp-triggered jobs? Should it include a `workflowType` override? | Engineering | Current `MCTaskCreate` has no `workflowType` — the MC worker infers it from `assigned_to`. Confirm this is sufficient. |
| OQ-05 | Does the Slack bot need ClickUp OAuth per user, or does it use the shared `CLICKUP_API_TOKEN`? | Shane | Personal token is simpler but all writes attributed to one user. |
| OQ-06 | Should `clickup-sync` post a comment containing full stage output, or a formatted summary? | Shane | Full output may be verbose for large reports. A summary template per workflow type is preferred. |
| OQ-07 | Which ClickUp status string values does each watched list use? | Shane | Must match exactly — collect before writing `statusMap` configs. |
| OQ-08 | Is `commentOnStart` needed for all instances, or only for human-initiated tasks? | Shane | Adds chattiness for scheduled jobs that auto-create ClickUp tasks. |
| OQ-09 | What is the public URL / hostname for the ElevarusOS Express server to register with ClickUp webhooks? | Engineering | Required for Phase 2. Must be stable (not localhost). |
| OQ-10 | Should ClickUp-triggered jobs bypass the MC worker poll cycle (direct orchestrator dispatch), or go through the full MC → poll → dispatch path? | Engineering | Full MC path adds latency but maintains audit trail. Direct dispatch is faster but skips MC task creation. Recommendation: full MC path. |
