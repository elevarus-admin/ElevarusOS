# PRD: ClickUp Integration

**Status:** Draft v2
**Author:** Shane McIntyre
**Date:** 2026-04-18
**Supersedes:** v1 (2026-04-17)
**Audience:** ElevarusOS engineering team

---

## Quick Reference

| Item | Value |
|---|---|
| Integration dir | `src/integrations/clickup/` |
| Manifest entry | `src/core/integration-registry.ts` (push `clickupManifest`) |
| Env vars | `CLICKUP_API_TOKEN`, `CLICKUP_TEAM_ID`, `CLICKUP_WEBHOOK_SECRET`, `CLICKUP_DEFAULT_LIST_ID` |
| Inbound endpoint | `POST /api/webhooks/clickup` (Express, HMAC-SHA256 verified) |
| Outbound stage | `src/workflows/stages/clickup-sync.stage.ts` |
| Slack surface | Claude `liveTools[]` on the integration manifest — read + write |
| Static catalog | `data/clickup-spaces.json` (team / space / list IDs) |
| Storage | None in Supabase. `clickupTaskId` lives on `job.metadata` |
| ClickUp API | `https://api.clickup.com/api/v2`, header `Authorization: {CLICKUP_API_TOKEN}` |
| Legacy code | `src/adapters/intake/clickup.adapter.ts` (deprecated, see §10) |

---

## Decisions Locked In (vs. v1)

1. **Slack bot interacts via Claude tools, not REST endpoints.** ClickUp ships its capabilities as `liveTools[]` on the integration manifest, the same path Ringba uses ([src/integrations/ringba/manifest.ts:86](../src/integrations/ringba/manifest.ts:86)). Ask Elevarus picks them up automatically through `getIntegrationTools()` ([src/core/integration-registry.ts:114](../src/core/integration-registry.ts:114)). v1's parallel REST API (`POST /api/clickup/tasks`, etc.) is dropped.
2. **Read is the primary value; writes are a small secondary surface.** The headline use is the Slack bot **surfacing** ClickUp tasks — triage, status, "what's due," "who has overdue," progress checks. Writes (create / update / comment) are kept in scope but explicitly de-prioritized: they ship in Phase 2 only after Phase 1 reads are solid, and `clickup_create_task` in particular is a low-volume fallback, not a daily driver.
3. **Write tools use the shared token; ElevarusOS is always the assigner.** Any task or comment ElevarusOS writes appears in ClickUp under the `CLICKUP_API_TOKEN` owner — i.e. ElevarusOS itself, not the human who triggered it. Per-user OAuth is deferred. The Slack `userId` is logged on every write so attribution lives in our audit trail.
4. **Inbound agent resolution uses contextual cues, not a required custom field.** When a ClickUp webhook fires, the agent is resolved by (a) the list the task lives in (each instance declares `clickup.listId`), then (b) task tags, then (c) assignee usernames matched against the member directory. No `ElevarusAgent` custom field required. If nothing resolves, the event is logged and dropped.
5. **No auto-comment on job start.** `commentOnStart` is dropped from the config entirely — too chatty for scheduled jobs, and Phase-3 outbound comments cover the useful case (completion / failure summary). Workflows that want a start comment can add `clickup_add_comment` as an explicit early stage.
6. **Public URL: ngrok now, real domain at production rollover.** Webhook registration and any Slack callbacks point to `https://commotion-ecology-lion.ngrok-free.dev` (the existing `ELEVARUS_PUBLIC_URL`). This URL **will change at production rollout** — webhook registrations on the ClickUp side will need to be re-pointed at that time. Track as a launch-checklist item, not a code change.
7. **Legacy intake adapter stays parked.** `src/adapters/intake/clickup.adapter.ts` keeps working in `--once` mode and the Scheduler's MC-fallback path. It's flagged deprecated in this PRD and migrated in Phase 5; nothing in Phase 1–4 touches it.

---

## 1. Problem

ElevarusOS is closed-loop today: agents run on schedule or on MC task assignment, output goes to Slack, and Slack is read-only. ClickUp is the team's primary task tracker but has no bridge:

- A team member who wants an agent to act on a ClickUp task has to leave ClickUp, log into MC, and recreate the task.
- Workflow output never finds its way back to the originating ClickUp task — the trail dies in Slack.
- The Slack bot can answer questions about agents and metrics but can't surface or act on ClickUp work.

This PRD establishes a two-way channel: ClickUp can trigger ElevarusOS jobs, workflows can update ClickUp tasks, and the Slack bot becomes the primary interactive surface for both directions.

---

## 2. Goals & Non-Goals

### Goals

- **Slack-first.** Users can list, get, create, comment on, and update ClickUp tasks via `@Elevarus` mentions and DMs.
- **Workflows can write back.** Any workflow can opt into a `clickup-sync` terminal stage that posts a completion comment and updates task status.
- **Inbound automation.** A ClickUp task created or assigned to a known agent automatically becomes an MC task and queues a job.
- **One integration directory.** All ClickUp code lives under `src/integrations/clickup/` and registers via the manifest pattern.
- **Webhooks are HMAC-verified before any payload work.**
- **Audit trail.** Every Slack-initiated write logs Slack user ID + channel ID alongside the ClickUp task ID via the existing `auditQueryTool` pattern.

### Non-Goals

- Mirroring ClickUp data into Supabase for analytics.
- Replacing MC as the task layer. ClickUp events create MC tasks; MC remains the orchestrator.
- Multi-workspace ClickUp support. One `CLICKUP_TEAM_ID` only.
- Per-user ClickUp OAuth in v1 (see Decision 2).
- Any UI surface in the dashboard.

---

## 3. Topology

```
┌────────────────────────────────────────────────────────────────────┐
│                            CLICKUP                                 │
│   Spaces · Lists · Tasks · Statuses · Comments · Webhooks          │
└──────────────────┬───────────────────────┬─────────────────────────┘
                   │ webhook (inbound)      │ REST (outbound)
                   ▼                        ▲
┌────────────────────────────────────────────────────────────────────┐
│                       ElevarusOS Express API                       │
│                                                                    │
│  POST /api/webhooks/clickup                                        │
│  └─ HMAC-SHA256 verify (CLICKUP_WEBHOOK_SECRET)                    │
│      └─ webhook-handler.ts → resolve agent → MCClient.createTask   │
│                                                                    │
│              ▲                                                     │
│              │  (no public REST surface for ClickUp — Slack uses   │
│              │   the Claude tool path below)                       │
│                                                                    │
│  src/integrations/clickup/                                         │
│    ├─ client.ts       ClickUpHttpClient (raw REST, retries)        │
│    ├─ types.ts        ClickUpTask / Comment / Webhook shapes       │
│    ├─ manifest.ts     IntegrationManifest with liveTools[]         │
│    ├─ live-tools.ts   QATool[]: list / get / create / update / ... │
│    └─ webhook-handler.ts                                           │
│                                                                    │
│  src/workflows/stages/clickup-sync.stage.ts                        │
│    (opt-in terminal stage; no-ops if instance.clickup.syncEnabled  │
│     is false or job.metadata.clickupTaskId is missing)             │
└────────────────────────────────────────────────────────────────────┘
              ▲                                       │
              │                                       ▼
┌──────────────┴───────────────┐           ┌─────────────────────────┐
│   Slack Events API           │           │   MCWorker → Workflow   │
│   (@Elevarus mentions, DMs)  │           │   stages → Slack post   │
│   tool calls Claude makes    │           │                         │
│   resolve to ClickUp methods │           │                         │
└──────────────────────────────┘           └─────────────────────────┘
```

The Slack bot does **not** call new REST endpoints. It calls Claude tools that the manifest contributes. This matches the existing pattern and keeps the API surface small.

---

## 4. Slack Bot ↔ ClickUp (Primary Surface)

### Target use cases (drives the tool surface)

These are the questions a user should be able to ask `@Elevarus` and have answered without leaving Slack. The tool inventory below is sized to cover all of them.

**Triage / status (read):**
- "Who has tasks due today?"
- "Who has overdue tasks?" / "Show me overdue tasks for the marketing list."
- "What's on Shane's plate this week?"
- "What's the status of the Q3 deck task?"
- "Show me everything in the marketing list still in `In Progress`."

**Action (write):**
- "Create a new task for Shane to update the Q3 deck, due Friday."
- "Add a comment to <task> saying the data is wrong."
- "Move the Q3 deck task to `Review`."
- "Have the U65 reporting bot pick up <task>."

The "who has X" questions force a **member directory** — Claude needs to map "Shane" → ClickUp user ID for both filters and assignment. Without it, every assignee question becomes a guessing game. See `clickup_list_members` and `data/clickup-spaces.json.members` below.

The "due today" / "overdue" questions force **multi-list aggregation** with date filters — a single list query isn't enough when the user doesn't specify a list. See `clickup_find_tasks`.

### Tool inventory (all on `clickupManifest.liveTools`)

| Tool name | Mode | Purpose |
|---|---|---|
| `clickup_list_lists` | read | Returns the catalog from `data/clickup-spaces.json` so Claude can resolve "the marketing list" → real list ID. |
| `clickup_list_members` | read | Returns the member directory from `data/clickup-spaces.json.members` — `{ id, username, email, slackUserId? }`. Lets Claude resolve "Shane" / `<@U123>` → ClickUp user ID. |
| `clickup_list_tasks` | read | `GET /list/{listId}/task` with status / assignee / date filters. Single-list query. |
| `clickup_find_tasks` | read | Cross-list query via `GET /team/{teamId}/task` (Filtered Team Tasks). Filters: `assignees[]`, `dueDate` (`overdue` \| `today` \| `this_week` \| `{ from, to }`), `statuses[]`, `lists[]`, `includeClosed`. **This is the tool for "who has overdue tasks today" — call it without a `lists[]` filter to span the workspace.** |
| `clickup_get_task` | read | `GET /task/{taskId}`. Includes status, assignees, custom fields, comments count. |
| `clickup_get_task_comments` | read | `GET /task/{taskId}/comment`. Returns recent comment thread. |
| `clickup_create_task` | **write** | `POST /list/{listId}/task`. Required: `listId`, `name`. Optional: `description`, `assignees[]` (ClickUp user IDs — resolve via `clickup_list_members` first), `status`, `dueDate` (ISO or natural-language like `"friday"` resolved against PT today), `priority`, `tags[]`, `agentInstanceId` (when present, also queues an MC task). |
| `clickup_update_task` | **write** | `PUT /task/{taskId}`. Patches name / description / status / dueDate / assignees (with `add`/`rem` semantics ClickUp expects). |
| `clickup_add_comment` | **write** | `POST /task/{taskId}/comment`. Optional `assignee` to assign the comment. |
| `clickup_trigger_agent` | **write** | Links an existing ClickUp task to an instance, creates an MC task with `metadata.clickupTaskId`, returns `{ jobId, mcTaskId }`. |

`clickup_trigger_agent` is the bridge that makes "have the U65 reporting bot pick this up" work in Slack. It validates `agentInstanceId` against `listInstanceIds()` and rejects unknown agents with a hint.

### Date-filter semantics for `clickup_find_tasks`

Date references are interpreted in **PT** to match the existing system-prompt date convention ([src/adapters/slack/events.ts:409](../src/adapters/slack/events.ts:409)). The tool layer converts to ClickUp's expected millisecond timestamps.

| Filter value | Resolves to |
|---|---|
| `overdue` | `due_date_lt = start of today PT` AND `status != closed/done equivalent` |
| `today` | `due_date_gt = start of today PT − 1ms`, `due_date_lt = end of today PT + 1ms` |
| `this_week` | Monday 00:00 PT through Sunday 23:59:59 PT (current week, Mon-anchored) |
| `{ from: "YYYY-MM-DD", to: "YYYY-MM-DD" }` | Inclusive PT date range |

"Closed" detection: ClickUp marks status `type: "closed"` and `type: "done"` as terminal. The tool excludes both for `overdue` unless `includeClosed: true`.

### Member directory (`data/clickup-spaces.json.members`)

The static catalog is extended to include team members so Claude can resolve names without hitting the ClickUp API on every question:

```json
{
  "members": [
    { "id": "12345678", "username": "Shane McIntyre", "email": "shane@elevarus.com", "slackUserId": "U01ABCDEF" },
    { "id": "87654321", "username": "Pamela",         "email": "pamela@elevarus.com", "slackUserId": "U02GHIJKL" }
  ]
}
```

Hand-maintained or refreshed by `scripts/sync-clickup-catalog.ts` (which now also pulls `GET /team/{teamId}/member`). `slackUserId` is optional and lets the bot map `<@U01ABCDEF>` mentions in the Slack message directly to ClickUp IDs.

### Auth & attribution

- One shared `CLICKUP_API_TOKEN`. Every ClickUp-side action shows up under that token's owner.
- Every write tool's `execute()` MUST log: `slack.userId`, `slack.channelId`, `slack.traceId`, `clickupTaskId` (or `listId` for create). Use `auditQueryTool` ([src/core/audit-log.ts](../src/core/audit-log.ts)).
- Tool result on success returns the ClickUp task URL so Claude can cite it in the Slack reply.

### Confirmation policy

Write tools execute immediately when called. We do not interpose a "are you sure?" round-trip — the tool description is the contract, and Claude is the gate.

The system prompt gets a paragraph injected by the manifest's `systemPromptBlurb`:

> "ClickUp is the team's task tracker. For triage questions ('who has overdue tasks', 'what's due today', 'what's on Shane's plate') prefer `clickup_find_tasks` — it spans the whole workspace and supports `dueDate: 'overdue' | 'today' | 'this_week'`. For single-list questions use `clickup_list_tasks`. Always resolve names → ClickUp user IDs via `clickup_list_members` before passing `assignees[]`. ClickUp tools include writes (`clickup_create_task`, `clickup_update_task`, `clickup_add_comment`, `clickup_trigger_agent`). Use them when the user asks you to take an action; otherwise prefer the read tools. If the user is ambiguous about a write (which list, who to assign, what date), confirm in chat before calling the tool."

The manifest's `exampleQuestions[]` carries the use-case list from the top of this section so it shows up in `list_integrations` output and few-shots Claude.

This shifts the "confirm before destructive action" responsibility to Claude, in line with the existing pattern for `broadcast_reply`.

### Failure surfaces

- All tools return `{ ok: false, error: string, hint?: string }` on failure rather than throwing. Claude relays the error verbatim to the user.
- Rate limits (429): the shared `request()` helper retries with exponential backoff (cap 3 attempts) — same pattern as `RingbaHttpClient`.
- Unknown list / task / status: tool returns the closest match from the catalog as `hint`.

---

## 5. Outbound: Workflow → ClickUp

### `clickup-sync` stage

A new opt-in terminal stage at `src/workflows/stages/clickup-sync.stage.ts`. Behavior:

1. Read `job.metadata.clickupTaskId`. If absent → no-op, return `{ skipped: "no clickupTaskId" }`.
2. Read `instanceConfig.clickup`. If absent or `syncEnabled: false` → no-op.
3. On upstream success: `addComment()` with a workflow-defined summary (default: render `summary.markdownReport` or `editorial.editedDraft`, capped at 2k chars). Then `updateTaskStatus(statusMap.completed)`.
4. On upstream failure (detected via `job.error` set): `addComment()` with the error message. Then `updateTaskStatus(statusMap.failed)`.
5. Stage output: `{ clickupTaskId, commentId, statusSet }`.

The stage is self-guarding so workflow definitions can declare it unconditionally. Including it costs nothing for instances without ClickUp configured.

### Status mapping

Per-instance because ClickUp lists use workspace-defined custom statuses:

```yaml
clickup:
  listId: "abc123"
  spaceId: "def456"
  syncEnabled: true
  commentOnStart: true
  statusMap:
    queued:    "Open"
    running:   "In Progress"
    completed: "Complete"
    failed:    "Blocked"
```

Status flows outbound only. ElevarusOS job state is the source of truth; ClickUp status is a derived reflection.

---

## 6. Inbound: ClickUp → ElevarusOS

### Endpoint

`POST /api/webhooks/clickup` registered in [src/api/server.ts](../src/api/server.ts), wired through `express.raw({ type: 'application/json' })` so the raw buffer is available for HMAC.

### Verification

1. Read `X-Signature` header.
2. Compute `HMAC-SHA256(CLICKUP_WEBHOOK_SECRET, rawBody)`.
3. Compare with `crypto.timingSafeEqual()`. Mismatch → 401, log warning, drop.
4. `JSON.parse(rawBody)`, hand to `webhook-handler.ts`.

Mirrors the existing `/api/webhooks/mc` and `/api/webhooks/slack` patterns at [src/api/server.ts:72](../src/api/server.ts:72).

### Event handling

Always return `200` after verification — non-200 triggers ClickUp retries. Downstream errors are logged, not surfaced.

| Event | Action |
|---|---|
| `taskCreated` | If task is in a watched list AND resolves to an agent (see below) → `MCClient.createTask({ instanceId, title, metadata: { clickupTaskId, clickupListId } })`. No auto-comment on the ClickUp task. |
| `taskAssigned` | Same as `taskCreated` if no MC task exists yet for that `clickupTaskId`. |
| `taskStatusUpdated` | If a known MC task exists, update its status per the reverse mapping. Phase 4 only — Phase 3 ignores. |
| `taskCommentPosted` | Ignore in v1. |
| Anything else | Log + drop. |

### Agent resolution

Resolution walks contextual cues in order. **No required custom field.** First match wins; ties (multiple instances watching the same list) fall to the next signal.

1. **List membership.** For each instance in `listInstanceIds()`, check `instanceConfig.clickup.listId === task.list.id`. If exactly one instance matches, that's the agent.
2. **Tags.** If list resolution returned 0 or >1 candidates, intersect the task's `tags[].name` with the candidate set's instance IDs. If exactly one tag matches an instance ID, that's the agent.
3. **Assignees.** Fallback: match `task.assignees[].username` (case-insensitive, whitespace-collapsed) against the candidate set's instance IDs or display names.
4. **Drop.** If none resolve, log `{ eventId, taskId, listId, candidates, signals }` and return 200.

Each step logs which signal won so we can tune the heuristics from real traffic.

---

## 7. Data Model

### Field mapping

| ClickUp field | ElevarusOS field | Notes |
|---|---|---|
| `task.id` | `job.metadata.clickupTaskId` | String. Set at MC task create time. |
| `task.list.id` | `instanceConfig.clickup.listId` | Per-instance config. |
| `task.space.id` | `instanceConfig.clickup.spaceId` | Per-instance config. |
| `task.status.status` | `instanceConfig.clickup.statusMap[*]` | Per-instance string→string. |
| `task.assignees[].username` | `job.metadata.assignedAgent` | Used for inbound resolution. |
| `task.custom_fields[]` | `job.metadata.clickupCustomFields` | Stored verbatim. |
| `task.name` | `mcTask.title` | For traceability. |

### Storage decision

- **No Supabase tables.** `clickupTaskId` lives on `job.metadata` (existing field on the Job record).
- **`data/clickup-spaces.json`** holds team / space / list catalog. Hand-maintained, checked in. Read by `clickup_list_lists` and the inbound webhook handler.

```json
{
  "teamId": "9012345",
  "spaces": [
    { "id": "90120000001", "name": "Elevarus" }
  ],
  "lists": [
    { "id": "901200012345", "name": "Agent Jobs",  "spaceId": "90120000001" },
    { "id": "901200067890", "name": "Marketing",   "spaceId": "90120000001" }
  ],
  "members": [
    { "id": "12345678", "username": "Shane McIntyre", "email": "shane@elevarus.com", "slackUserId": "U01ABCDEF" }
  ]
}
```

A one-shot setup script (`scripts/sync-clickup-catalog.ts`) refreshes this file from the ClickUp API (`GET /team`, `GET /team/{teamId}/space`, `GET /space/{spaceId}/list`, `GET /team/{teamId}/member`). Not a daemon. `slackUserId` is hand-maintained — the script preserves existing values on overwrite.

---

## 8. Configuration

### Env vars

| Variable | Required | Description |
|---|---|---|
| `CLICKUP_API_TOKEN` | Yes | Personal API token. ClickUp → Settings → Apps. Format `pk_<digits>_<alphanum>`. |
| `CLICKUP_TEAM_ID` | Yes | Workspace team ID. Required for team-scoped endpoints. |
| `CLICKUP_WEBHOOK_SECRET` | Phase 4 | Secret set during webhook registration. |
| `CLICKUP_DEFAULT_LIST_ID` | Optional | Fallback list ID when Slack tool calls don't specify one. Replaces v1's `CLICKUP_LIST_ID`. |

`ClickUpHttpClient` constructor sets `this.enabled = Boolean(CLICKUP_API_TOKEN && CLICKUP_TEAM_ID)`. All methods no-op (return `null`) when disabled. Manifest `status()` returns `"unconfigured"` so `list_integrations` reflects reality.

The existing `config.clickup` block ([src/config/index.ts:24](../src/config/index.ts:24)) gets `teamId`, `webhookSecret`, and `defaultListId` added; `apiToken` and `listId` (renamed `defaultListId`) stay backward-compatible for the legacy intake adapter until Phase 5.

### Per-instance config

Add `InstanceClickUp` to [src/core/instance-config.ts](../src/core/instance-config.ts):

```ts
interface InstanceClickUp {
  listId:        string;
  spaceId:       string;
  syncEnabled:   boolean;  // gates the clickup-sync stage
  statusMap: {
    queued?:    string;
    running:    string;
    completed:  string;
    failed:     string;
  };
}
```

No `commentOnStart` — workflows that want a start comment can declare `clickup_add_comment` as an explicit early stage. Default behavior is silent until the workflow finishes.

Loaded with the same null-guard pattern as `ringba` and `meta`.

---

## 9. Code Layout

### New files (Phase 1)

```
src/integrations/clickup/
  client.ts          ClickUpHttpClient — auth, retries, raw REST
  types.ts           ClickUpTask, ClickUpComment, ClickUpWebhookEvent, ...
  index.ts           barrel export (mirrors ringba/index.ts)
  manifest.ts        IntegrationManifest — registers liveTools[]
  live-tools.ts      QATool[] — read tools first, write tools after Phase 1 review
```

### New files (Phase 3)

```
src/workflows/stages/clickup-sync.stage.ts
```

### New files (Phase 4)

```
src/integrations/clickup/webhook-handler.ts
```

### Touched files

- `src/core/integration-registry.ts` — one import + push to `INTEGRATION_MANIFESTS`.
- `src/core/instance-config.ts` — add `InstanceClickUp` + parser.
- `src/config/index.ts` — extend `clickup` block.
- `src/api/server.ts` — `express.raw()` mount + `POST /api/webhooks/clickup` route (Phase 4).
- `docs/environment.md`, `docs/integrations.md` — document env vars + ClickUp section.
- `docs/qa-bot.md` — note that write tools are now in-scope for ClickUp specifically (see revisions in this PR).

### Audit log entries

Every write tool emits one row via the audit logger with shape `{ tool, slackUserId, slackChannelId, traceId, clickupTaskId|listId, payloadHash, ok, ms }`. Backed by the same Supabase table the audit tool already writes to.

---

## 10. Legacy Adapter Migration (Phase 5)

[src/adapters/intake/clickup.adapter.ts](../src/adapters/intake/clickup.adapter.ts) is a polling intake that:
- pulls `Open`-status tasks from `config.clickup.listId`,
- normalizes them to `BlogRequest`,
- dedups via `data/clickup-processed.json`,
- is wired into `--once` mode and the Scheduler's no-MC fallback path ([src/index.ts:64](../src/index.ts:64), [src/index.ts:215](../src/index.ts:215)).

Migration plan (Phase 5 only — no churn during 1–4):
1. Move ClickUp HTTP into `ClickUpHttpClient.listTasks(listId, { status: ["Open"] })`. Adapter becomes a thin shim around the client + the existing normalization logic.
2. Replace the dedup file with a check against `job_store` for `metadata.clickupTaskId` already-seen.
3. Keep the adapter file but reduce it to the normalization + dedup logic; HTTP and types come from `src/integrations/clickup/`.
4. After daemon mode is the only mode in production, delete the adapter and the Scheduler fallback path entirely.

This phase is a chore, not a feature. It is not blocked by the inbound webhook (Phase 4) and can be done out of order.

---

## 11. Phased Rollout

| Phase | Deliverable | Effort | Gates |
|---|---|---|---|
| **1. Slack read tools (the headline)** | `client.ts`, `types.ts`, `manifest.ts`, `live-tools.ts` (read-only: `list_lists`, `list_members`, `list_tasks`, `find_tasks`, `get_task`, `get_task_comments`), `data/clickup-spaces.json` (full catalog incl. `members[]`), `scripts/sync-clickup-catalog.ts`, `index.ts`. Manifest registered. | 2 days | `list_integrations` shows `clickup: configured`. Demos: (a) "@Elevarus who has overdue tasks?" returns assignee → task list grouped, (b) "what's due today on Shane's plate?", (c) "what's the status of the Q3 deck task?", (d) "what's open in Marketing?". |
| **2. Slack write tools (small surface)** | Add `clickup_update_task`, `clickup_add_comment`, `clickup_trigger_agent`, then `clickup_create_task` last. Audit logging on every write. System-prompt blurb updated. Slack bot PRD revised. | 1 day | Demos: (a) "move <task> to Review", (b) "comment on <task> that the data is stale", (c) "have the U65 bot pick up <task>", (d) (low-priority) "create a task for Shane to update the Q3 deck due Friday". |
| **3. Outbound workflow stage** | `clickup-sync.stage.ts`. `InstanceClickUp` config added. Pilot on `final-expense-reporting` instance. | 1 day | Pilot reporting workflow posts a completion comment + status update on its source ClickUp task. |
| **4. Inbound webhook** | `POST /api/webhooks/clickup`, HMAC verify, `webhook-handler.ts`, contextual agent resolution (list → tags → assignees). Webhook registered against `https://commotion-ecology-lion.ngrok-free.dev/api/webhooks/clickup`. | 1.5 days | Creating a ClickUp task in a watched list queues an MC task within 30s with `metadata.clickupTaskId` set. No auto-comment on the ClickUp task. |
| **5. Legacy adapter migration** | Refactor `src/adapters/intake/clickup.adapter.ts` to thin shim over the new client; later, delete. | 1 day | Old `--once` blog flow still works; dedup checks `job_store` instead of the JSON file. |

Total: ~6 working days through Phase 4. Production rollover step (separate from this PRD): re-register webhook with the production URL and update `ELEVARUS_PUBLIC_URL` in env.

---

## 12. Open Questions

All resolved with defaults — no outstanding questions block Phase 1.

- **OQ-01** — Sync the full catalog. No manual trim.
- **OQ-02** — Inbound agent resolution: list → tags → assignees. No required custom field.
- **OQ-03** — No `commentOnStart` anywhere. Dropped from config.
- **OQ-04** — `clickup_create_task` accepts free-form custom fields (`Record<string, unknown>`); ClickUp rejects what's wrong server-side.
- **OQ-05** — Public URL is `https://commotion-ecology-lion.ngrok-free.dev` (ngrok). Will change at production rollover; track as launch-checklist item.
- **OQ-06** — `clickup-sync` comment body: `summary.oneLiner` + first 1.5k chars of `summary.markdownReport`, with a link back to the MC task for the full output.
- **OQ-07** — `clickup_trigger_agent` deduplicates against existing MC tasks for the same `clickupTaskId` and returns the existing `jobId`.
- **OQ-08** — Per-user OAuth deferred until attribution becomes a real complaint.
- **OQ-09** — Member directory hand-curated in `data/clickup-spaces.json.members[]`; revisit if team grows past ~15.
- **OQ-10** — `clickup_find_tasks` defaults to `includeClosed: false`.
- **OQ-11** — Claude resolves natural-language dates ("Friday", "next Tuesday") to ISO using the PT date in its system prompt before calling `clickup_create_task` / `clickup_update_task`. No local date-NLP library.
