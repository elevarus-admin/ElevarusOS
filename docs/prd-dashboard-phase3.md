# PRD — ElevarusOS Dashboard Phase 3

**Status:** Draft  
**Date:** 2026-04-19  
**Author:** Shane McIntyre  
**Scope:** Dashboard (`:3000`) + ElevarusOS API (`:3001`) + backend model changes

---

## Background

Phase 1 built the Next.js dashboard shell with auth, active jobs, job history, and the approve/reject flow. Phase 2 added job detail, stage timelines, and agent registry. Phase 3 adds the operational layer: cost observability, integration transparency, API discoverability, and in-dashboard content editing.

---

## Goals

1. **Token + cost visibility** — Track input/output tokens per stage, aggregate per job, chart spend by day
2. **Integration dashboard** — Expose every configured integration with health, table schemas, and live stats — no keys shown
3. **API documentation** — Self-hosted reference page backed by Zod schemas; always in sync with the actual API
4. **Editable .md files** — Edit `instance.md`, `soul.md`, `agent.md`, and workflow prompt `.md` files directly from the dashboard
5. **Kill a running job** — Cancel button on active jobs
6. **Settings page** — Preferences, alert thresholds, and display options
7. **Rename `src/instances` → `src/agents`** — Align naming with the platform's vocabulary

---

## Scope

### Out of scope (Phase 4+)

- ClickUp write tools (create/update tasks from dashboard)
- Multi-user auth (role-based dashboard access)
- Email digest for daily token cost
- LLM provider switching (non-Anthropic)
- Publish pipeline UI

---

## Feature Specifications

---

### 1. Token + Cost Tracking

#### 1a. Backend — capture usage per stage

**`src/models/job.model.ts`** — add to `StageRecord`:

```ts
usage?: {
  inputTokens:  number;
  outputTokens: number;
  totalTokens:  number;
  estimatedCostUsd: number;   // calculated at capture time using model pricing
};
```

Add to `Job`:

```ts
totalUsage?: {
  inputTokens:  number;
  outputTokens: number;
  totalTokens:  number;
  estimatedCostUsd: number;
};
```

**`src/core/claude-client.ts`** — update `claudeJSON()` to return `{ result, usage }`:

```ts
return {
  result: parsed,
  usage: {
    inputTokens:  msg.usage.input_tokens,
    outputTokens: msg.usage.output_tokens,
    totalTokens:  msg.usage.input_tokens + msg.usage.output_tokens,
    estimatedCostUsd: calcCost(model, msg.usage.input_tokens, msg.usage.output_tokens),
  }
};
```

**`src/core/orchestrator.ts`** — after each stage completes, merge usage into `stageRecord.usage` and accumulate into `job.totalUsage`.

**`src/core/model-pricing.ts`** (new file) — pricing table:

```ts
const PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "claude-opus-4-7":   { inputPer1M: 5.00,  outputPer1M: 25.00 },
  "claude-opus-4-6":   { inputPer1M: 5.00,  outputPer1M: 25.00 },
  "claude-sonnet-4-6": { inputPer1M: 3.00,  outputPer1M: 15.00 },
  "claude-haiku-4-5":  { inputPer1M: 1.00,  outputPer1M: 5.00  },
};

export function calcCost(model: string, input: number, output: number): number {
  const p = PRICING[model] ?? PRICING["claude-opus-4-7"];
  return (input / 1_000_000) * p.inputPer1M + (output / 1_000_000) * p.outputPer1M;
}
```

#### 1b. Supabase — new migration

```sql
-- Add token/cost columns to jobs
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS total_input_tokens   INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_output_tokens  INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tokens         INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_cost_usd   NUMERIC(10,6) DEFAULT 0;

-- Daily rollup view for charts
CREATE OR REPLACE VIEW daily_token_usage AS
SELECT
  date_trunc('day', created_at) AS day,
  workflow_type,
  COUNT(*)                       AS job_count,
  SUM(total_input_tokens)        AS input_tokens,
  SUM(total_output_tokens)       AS output_tokens,
  SUM(total_tokens)              AS total_tokens,
  SUM(estimated_cost_usd)        AS cost_usd
FROM jobs
WHERE status IN ('completed', 'failed', 'rejected')
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
```

#### 1c. API — new endpoint

```
GET /api/analytics/tokens?days=30&instanceId=
```

Returns daily token and cost data suitable for chart rendering:

```json
{
  "days": 30,
  "totals": {
    "inputTokens": 1402000,
    "outputTokens": 384000,
    "totalTokens": 1786000,
    "estimatedCostUsd": 16.72
  },
  "byDay": [
    { "day": "2026-04-19", "inputTokens": 48000, "outputTokens": 12000, "costUsd": 0.57, "jobCount": 3 }
  ],
  "byWorkflow": [
    { "workflowType": "elevarus-blog", "totalTokens": 980000, "costUsd": 10.44 }
  ]
}
```

#### 1d. Dashboard — Token Usage page

**Route:** `/tokens`  
**Sidebar label:** "Token Usage" (BarChart2 icon)  
**Type:** Client Component, polls on mount

**Layout:**

```
┌─ Token Usage ─────────────────────────────────────────────────────┐
│  [Last 7d] [Last 30d] [Last 90d]           Filter: [All agents ▼] │
├───────────────────────────────────────────────────────────────────┤
│  Stat cards:                                                       │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐       │
│  │ Total tokens │ │  Input tok.  │ │  Total cost (USD)     │       │
│  │  1.78M       │ │  1.40M       │ │     $16.72            │       │
│  └──────────────┘ └──────────────┘ └──────────────────────┘       │
├───────────────────────────────────────────────────────────────────┤
│  Daily token usage (stacked bar — input / output by day)          │
│  [Recharts BarChart — 30 data points]                              │
├───────────────────────────────────────────────────────────────────┤
│  Daily cost (USD) line chart                                       │
│  [Recharts AreaChart]                                              │
├───────────────────────────────────────────────────────────────────┤
│  By workflow (horizontal bar or table):                            │
│  elevarus-blog      ████████████  $10.44                          │
│  final-expense...   ████          $4.21                           │
└───────────────────────────────────────────────────────────────────┘
```

**Chart library:** Recharts (already in `dashboard/package.json`). No additional dependency needed.

**Colors:**
- Input tokens: `brand.primary` (#04BF7E)
- Output tokens: `brand.navy` (#16163F) at 60% opacity
- Cost line: amber-500

**Cost display note:** Show "~$X.XX (estimate)" with a tooltip explaining these are Anthropic list prices and actual billing may vary.

---

### 2. Cancel / Kill a Running Job

**Problem:** The `elevarus-blog` job is stuck running. There is currently no way to cancel it from the dashboard.

#### 2a. API endpoint

```
POST /api/jobs/:jobId/cancel
```

Sets `job.status = "failed"`, `job.error = "Cancelled by user"`, `job.completedAt = now()`. If the job is `awaiting_approval`, calls `approvalStore.notifyApproval(jobId, false)` to unblock the waiting promise before marking it failed.

Note: stages that are mid-execution cannot be interrupted (they run inside `async/await` without cancellation tokens). The cancel endpoint marks the job failed immediately; the currently-executing stage will complete and then the orchestrator checks the status before running the next stage. For `awaiting_approval` jobs, cancel resolves instantly.

#### 2b. Dashboard — Cancel button

On the **Active Jobs** table (`/active`) and **Job Detail** page (`/jobs/:id`), show a red "Cancel" button for jobs in `running` or `awaiting_approval` status.

- Clicking opens a confirmation dialog: *"Cancel this job? The current stage may still complete but no further stages will run."*
- On confirm: `POST /api/jobs/:jobId/cancel` → refresh job state
- The Next.js Route Handler at `dashboard/src/app/api/jobs/[jobId]/cancel/route.ts` proxies server-side with `x-api-key`

**Immediate action for the stuck elevarus-blog job:**

```bash
curl -X POST http://localhost:3001/api/jobs/<stuck-job-id>/cancel \
  -H "x-api-key: $API_SECRET"
```

Run `GET /api/jobs?status=running&instanceId=elevarus-blog` to find the job ID first.

---

### 3. Integrations Dashboard

**Route:** `/integrations`  
**Sidebar label:** "Integrations" (Plug icon)

Each integration is represented as a card. Cards show status (enabled/disabled based on env vars), metadata, and table schemas. **No API keys or secrets are ever shown** — the dashboard only shows which vars are configured (boolean).

#### Integration cards

**Ringba**
- Status: Enabled / Disabled (based on `RINGBA_API_KEY` + `RINGBA_ACCOUNT_ID` presence)
- Last sync: from `ringba_sync_state.last_synced_at`
- Sync frequency: Every 15 min
- Tables exposed: `ringba_calls`, `ringba_campaigns`
- Schema viewer: column name, type, description — collapsible
- Stats: Total calls (MTD), total revenue (MTD), last synced at
- Feature badges: `Call tracking`, `Revenue reporting`, `Tag rollup`, `Time-series queries`

**LeadsProsper**
- Status: Enabled / Disabled (based on `LEADSPROSPER_API_KEY`)
- Last sync: from `lp_sync_state.last_synced_at`
- Tables exposed: `lp_leads`, `lp_campaigns`
- Stats: Total leads (MTD), acceptance rate
- Feature badges: `Lead routing`, `Attribution`, `Phone normalization`

**ClickUp**
- Status: Enabled / Disabled (based on `CLICKUP_API_TOKEN`)
- Tables exposed: None (live API only; catalog cached at `data/clickup-spaces.json`)
- Feature badges: `Task read`, `Task search`, `Comments read`, `Phase 2: Task write`, `Phase 2: Agent trigger`
- Phase badges: show which features are live vs. planned
- Catalog: number of spaces, lists, members loaded

**Meta Ads**
- Status: Enabled / Disabled (based on `META_ACCESS_TOKEN`)
- Tables exposed: None (live Graph API)
- Feature badges: `Spend data`, `Impressions/clicks`, `CTR/CPC/CPM`
- Stats: Not available (no sync; live queries only)

**Slack**
- Status: Enabled / Disabled (based on `SLACK_BOT_TOKEN`)
- Features: `Approval notifications`, `Block Kit buttons`, `Q&A bot` (if `SLACK_SIGNING_SECRET` set)
- Endpoints consumed: Events API (inbound), Interactions (inbound), chat.postMessage (outbound)

#### API endpoint

```
GET /api/integrations
```

Returns integration status + stats without any secret values:

```json
{
  "integrations": [
    {
      "id": "ringba",
      "name": "Ringba",
      "enabled": true,
      "lastSyncedAt": "2026-04-19T14:30:00Z",
      "syncFrequencyMinutes": 15,
      "tables": ["ringba_calls", "ringba_campaigns"],
      "features": ["Call tracking", "Revenue reporting", "Tag rollup"],
      "stats": {
        "mtdCalls": 312,
        "mtdRevenue": 14220.00
      }
    }
  ]
}
```

---

### 4. API Reference Page

**Route:** `/api-reference`  
**Sidebar label:** "API Reference" (Code2 icon)

A self-hosted, always-in-sync API reference built from Zod schemas. No separate spec file to maintain.

#### Approach: Zod + `@asteasolutions/zod-to-openapi`

**Why Zod over raw OpenAPI:**
- Zod schemas already validate request bodies in the API — the docs are derived from the same source of truth
- `zod-to-openapi` generates an OpenAPI 3.1 spec from decorated Zod schemas at build/request time
- The dashboard page renders the spec using `@scalar/api-reference` (a modern, lightweight alternative to Swagger UI)

**New packages:**

```
API server:  @asteasolutions/zod-to-openapi  zod
Dashboard:   @scalar/api-reference
```

**Implementation plan:**

1. **`src/api/schemas/`** — add Zod schemas for every request/response:
   ```
   src/api/schemas/
   ├── jobs.schema.ts        # Job, JobStatus, SubmitJobRequest, etc.
   ├── instances.schema.ts
   ├── analytics.schema.ts
   ├── integrations.schema.ts
   └── index.ts              # exports OpenAPIRegistry, generateSpec()
   ```

2. **`GET /api/openapi.json`** — new endpoint that calls `generateSpec()` and returns the full OpenAPI spec. Cached in memory after first generation.

3. **Dashboard page** — `<APIReference>` component from `@scalar/api-reference` pointed at `NEXT_PUBLIC_ELEVARUS_API_URL/api/openapi.json`:

   ```tsx
   import { ApiReferenceReact } from '@scalar/api-reference-react'

   export default function ApiReferencePage() {
     return (
       <ApiReferenceReact
         configuration={{
           url: `${process.env.NEXT_PUBLIC_ELEVARUS_API_URL}/api/openapi.json`,
           theme: 'default',
           hideClientButton: true,
         }}
       />
     )
   }
   ```

**Why Scalar over Swagger UI:** Scalar renders faster, has a cleaner UI, supports dark mode, includes a built-in HTTP client for trying endpoints, and weighs ~60KB vs Swagger UI's ~400KB.

---

### 5. Editable .md Files

**Routes:**
- `/agents/:agentId/edit` — edit `instance.md`, `soul.md`, `agent.md` for a specific agent
- `/workflows/:workflowType/edit` — edit workflow prompt `.md` files (research, outline, draft, editorial)

**Type:** Client Component with CodeMirror editor

#### 5a. Backend — file read/write API

```
GET  /api/files?path=src/agents/elevarus-blog/instance.md
PUT  /api/files?path=src/agents/elevarus-blog/instance.md
     Body: { content: "raw markdown string" }
```

**Security constraints:**
- `path` must start with `src/agents/` or `src/workflows/` (allowlist)
- `path` must end with `.md`
- No `..` path traversal
- Only editable files — no `.env`, `*.ts`, `*.json`

**Server response:**

```json
GET  → { path: "...", content: "raw markdown", lastModified: "..." }
PUT  → { success: true, path: "...", savedAt: "..." }
```

On save, if the file is `instance.md`, trigger a reload of instance configs (`registry.reload()` or restart signal).

#### 5b. Dashboard — editor UI

**Package:** `@uiw/react-codemirror` with `@codemirror/lang-markdown` and `@codemirror/theme-one-dark`

**Why CodeMirror over plain textarea:**
- Markdown syntax highlighting
- Line numbers
- Keyboard shortcuts (Cmd+S to save)
- No bloated rich-text editor — raw markdown is intentional

**Editor page layout:**

```
┌─ Agents / elevarus-blog / Edit ──────────────────────────────────┐
│  Tabs: [instance.md] [soul.md] [agent.md]                        │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ 1  ---                                                       │ │
│  │ 2  id: elevarus-blog                                         │ │
│  │ 3  name: Elevarus Blog Bot                                   │ │
│  │    ...                                                       │ │
│  └──────────────────────────────────────────────────────────────┘ │
│  [Save changes]  [Discard]   Last saved: 2 minutes ago            │
└───────────────────────────────────────────────────────────────────┘
```

On the Agent Registry page (`/agents`), add an "Edit" button on each card linking to `/agents/:agentId/edit`.

On the workflow detail (accessible from Job Detail or a new `/workflows` page), add "Edit prompts" linking to `/workflows/:workflowType/edit`.

---

### 6. Rename `src/instances` → `src/agents`

All instance directories, config references, and documentation currently use the word "instance" — but the platform, dashboard, and PRDs all say "agent." This rename brings code in line with the vocabulary.

#### Scope of change

| Before | After |
|--------|-------|
| `src/instances/` | `src/agents/` |
| `src/core/instance-config.ts` → `loadInstanceConfig()` | Keep function name, update internal path |
| `src/api/server.ts` — `/api/instances` routes | Keep route URLs for backward compatibility; update internal path resolution |
| `GET /api/instances` response field `instanceDir` | Update path in response |
| `docs/instances.md` | `docs/agents.md` (rename, update content) |
| `src/instances/_template/` | `src/agents/_template/` |

**Migration steps:**
1. `git mv src/instances src/agents`
2. Update `src/core/instance-config.ts` path constants
3. Update `src/core/workspace-scaffold.ts` path constants
4. Update `src/api/server.ts` path resolution in `createInstance` handler
5. Update `src/index.ts` any hardcoded paths
6. Update `docs/instances.md` → `docs/agents.md`
7. Verify `npm run typecheck` passes

This is purely a filesystem + string rename — no logic changes.

---

### 7. Settings Page

**Route:** `/settings`  
**Type:** Client Component (some sections Server)

#### Sections

**Display**
- Date/time format preference (stored in `localStorage`)
- Default job history page size (25 / 50 / 100)
- Token cost display: "Show / Hide estimated costs"

**Alert thresholds** (stored in Supabase `settings` table — see migration below)
- Daily cost alert threshold (USD): notify via Slack when exceeded
- Job failure rate threshold (%): alert when >X% of jobs in last 24h fail

**Integration sync** (read-only status)
- Last Ringba sync / manual trigger button → `POST /api/integrations/ringba/sync`
- Last LP sync / manual trigger button → `POST /api/integrations/lp/sync`

**About**
- API URL, API version, Node version (from `GET /api/health` extended response)
- Dashboard version (from `package.json`)

#### Settings storage — Supabase migration

```sql
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Seed defaults
INSERT INTO settings (key, value) VALUES
  ('alert_daily_cost_usd',     '{"threshold": 50, "enabled": false}'),
  ('alert_job_failure_rate',   '{"threshold": 20, "enabled": false}')
ON CONFLICT (key) DO NOTHING;
```

---

## Additional Recommendations

### R1. Job Execution Tracing

Each job currently stores stage outputs as a blob of JSONB. For debugging, it would be valuable to also store a structured execution trace — each Claude API call with its prompt hash, token count, and latency. This enables "which prompt is the most expensive?" analysis without reading full outputs.

**Suggestion:** Add `src/core/tracer.ts` — a lightweight call-level logger that writes to a `job_traces` Supabase table. Off by default; enabled with `TRACE_ENABLED=true`.

### R2. Cost Budgets and Alerts

Once token tracking is live (Feature 1), add a daily budget guard in the Orchestrator: before calling Claude, check today's `estimatedCostUsd` total against a configurable `DAILY_COST_BUDGET_USD` env var. If exceeded, fail the stage with a `budget_exceeded` error and notify via Slack. This prevents runaway cost from a misconfigured or looping workflow.

### R3. Workflow Version Pinning

Prompt `.md` files are currently read from disk at stage execution time — meaning an in-progress job can pick up edited prompts mid-run. For production workflows this is a correctness risk. **Recommendation:** At job creation time, snapshot the current prompt files into `job.metadata.promptSnapshots`. The editor UI should show a "Changes will take effect on the next job" notice.

### R4. Agent Health / Last Seen

The Scheduler fires `submitJob()` but nothing tracks whether a scheduled agent has successfully fired recently. Add a `last_fired_at` and `last_succeeded_at` to the `agents` table (after the `src/instances` → `src/agents` rename). The `/agents` dashboard page would show a "Last ran 3 hours ago ✓" or "Overdue — expected 2 hours ago ⚠" badge per agent.

### R5. Zod Schemas as Single Source of Truth

Once Zod schemas are added (Feature 4), replace the existing manual `body` parsing in `server.ts` (`const { workflowType, title, brief } = req.body`) with `schema.parse(req.body)` — validation errors automatically return structured 422 responses with field-level messages. This removes a class of runtime bugs and makes the API self-validating.

### R6. Log Streaming on Job Detail

The Job Detail page currently polls every 10 seconds. For long-running blog jobs (5–8 minutes), this means the stage output appears in chunks with delays. **Recommendation:** Add `GET /api/jobs/:jobId/stream` as a Server-Sent Events endpoint that pushes `job_updated` events in real time. The dashboard subscribes via `EventSource` and updates the UI instantly as each stage completes. This is a significant UX improvement with moderate backend effort (one new route + `EventEmitter` in the Orchestrator).

### R7. `src/agents` Rename Urgency

Do this early in Phase 3 — every other feature in this PRD touches files inside `src/instances/`. Doing the rename first prevents merge conflicts and ensures all new code is written with the correct path from the start.

---

## Implementation Order

| Phase 3 Step | Feature | Estimated Effort | Priority |
|---|---|---|---|
| 3.0 | Rename `src/instances` → `src/agents` | Small (1 session) | Do first |
| 3.1 | Cancel/kill job API + dashboard button | Small | Do immediately (stuck job) |
| 3.2 | Token tracking — backend + model + migration | Medium | High |
| 3.3 | Token Usage dashboard page with Recharts | Medium | High |
| 3.4 | Integrations page | Medium | High |
| 3.5 | Zod schemas + `GET /api/openapi.json` | Medium | Medium |
| 3.6 | API Reference page (Scalar) | Small (once 3.5 done) | Medium |
| 3.7 | Editable .md files (CodeMirror) | Medium | Medium |
| 3.8 | Settings page | Small | Low |
| 3.R6 | SSE log streaming | Large | Low (Phase 4) |

---

## New npm Dependencies

**ElevarusOS API (`package.json`):**
```json
"zod": "^3.23.0",
"@asteasolutions/zod-to-openapi": "^7.0.0"
```

**Dashboard (`dashboard/package.json`):**
```json
"@scalar/api-reference-react": "^0.5.0",
"@uiw/react-codemirror": "^4.23.0",
"@codemirror/lang-markdown": "^6.3.0",
"@codemirror/theme-one-dark": "^6.1.0"
```

No new charting library needed — Recharts is already installed.

---

## Files Created / Modified

### New files

| File | Purpose |
|------|---------|
| `src/core/model-pricing.ts` | Anthropic model pricing table + `calcCost()` |
| `src/api/schemas/jobs.schema.ts` | Zod schemas for job endpoints |
| `src/api/schemas/instances.schema.ts` | Zod schemas for instance endpoints |
| `src/api/schemas/analytics.schema.ts` | Zod schemas for analytics endpoint |
| `src/api/schemas/integrations.schema.ts` | Zod schemas for integrations endpoint |
| `src/api/schemas/index.ts` | OpenAPI registry + `generateSpec()` |
| `supabase/migrations/20260419000010_token_tracking.sql` | token columns + daily_token_usage view |
| `supabase/migrations/20260419000011_settings_table.sql` | settings key/value table |
| `dashboard/src/app/(dashboard)/tokens/page.tsx` | Token Usage page |
| `dashboard/src/app/(dashboard)/integrations/page.tsx` | Integrations page |
| `dashboard/src/app/(dashboard)/api-reference/page.tsx` | API Reference page |
| `dashboard/src/app/(dashboard)/agents/[agentId]/edit/page.tsx` | Agent .md editor |
| `dashboard/src/app/(dashboard)/workflows/[workflowType]/edit/page.tsx` | Workflow prompt editor |
| `dashboard/src/app/api/jobs/[jobId]/cancel/route.ts` | Cancel proxy route |
| `dashboard/src/app/api/files/route.ts` | File read/write proxy route |
| `dashboard/src/components/charts/TokenUsageChart.tsx` | Recharts bar chart |
| `dashboard/src/components/charts/CostAreaChart.tsx` | Recharts area chart |
| `dashboard/src/components/editor/MarkdownEditor.tsx` | CodeMirror wrapper |

### Modified files

| File | Change |
|------|--------|
| `src/models/job.model.ts` | Add `usage` to `StageRecord`; add `totalUsage` to `Job` |
| `src/core/claude-client.ts` | Return usage alongside result |
| `src/core/orchestrator.ts` | Accumulate usage from stage returns |
| `src/api/server.ts` | Add `/api/analytics/tokens`, `/api/integrations`, `/api/openapi.json`, `/api/jobs/:id/cancel`, `/api/files` |
| `src/instances/` → `src/agents/` | Filesystem rename |
| `src/core/instance-config.ts` | Update path constants |
| `dashboard/src/components/layout/sidebar.tsx` | Add Token Usage, Integrations, API Reference nav items |
| `dashboard/src/lib/api.ts` | Add typed helpers for new endpoints |
| `dashboard/src/app/(dashboard)/agents/page.tsx` | Add "Edit" button per agent |
