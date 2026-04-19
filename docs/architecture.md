# ElevarusOS — Architecture

## System overview

ElevarusOS is a TypeScript daemon that executes multi-stage AI workflows on behalf of registered bot instances. The `Orchestrator` is the primary executor — it accepts jobs, runs stages sequentially, handles approval gates via the `ApprovalStore`, and persists state. The `Scheduler` fires cron-based jobs by calling `Orchestrator.submitJob()` directly. The `ApiServer` exposes REST endpoints for monitoring, job submission, and approval actions. The `Dashboard` (a Next.js app on port 3000) provides a web UI backed by the same API.

The platform is workflow-agnostic. The core runtime (Orchestrator, Scheduler, ApiServer) knows nothing about blogs, ad campaigns, or any specific content type. All workflow logic lives in `IStage` implementations registered under a unique `workflowType` string.

---

## Components

### Entry point — `src/index.ts`

`main()` bootstraps the platform in one of two modes:

**Daemon mode** (default — `npm run dev`):
1. Instantiates a `WorkflowRegistry` and registers every active workflow
2. Creates a shared `Orchestrator` instance
3. Starts the `ApiServer` on `API_PORT` (default 3001), passing the `Orchestrator`
4. Starts the `Scheduler` — fires cron jobs for instances with `schedule.enabled: true`
5. Listens for `SIGINT`/`SIGTERM` to trigger graceful shutdown

**Single-run mode** (`--once`):

```bash
npm run dev -- --once --bot final-expense-reporting
```

Creates an `Orchestrator` directly, builds a sample request for the specified instance, and runs the workflow to completion. Useful for local testing without needing the full daemon.

---

### Orchestrator — `src/core/orchestrator.ts`

The primary workflow executor. Used in both daemon mode (via Scheduler + API) and `--once` mode.

**Responsibilities:**
- Accepts `BlogRequest` objects via `submitJob()`
- Creates `Job` objects from the `WorkflowRegistry` stage list
- Runs stages sequentially via `runStageWithRetry()`
- Sets `job.status = "awaiting_approval"` **before** running the `approval_notify` stage, then blocks on `ApprovalStore.waitForApproval(jobId)`
- After approval resolves: resumes remaining stages if `approved`, calls `rejectJob()` if `!approved`
- Persists `Job` state to the configured `IJobStore` after every stage
- Fires `IDashboardBridge` callbacks (`onJobCreated`, `onJobUpdated`) when attached
- Sends failure notifications via `INotifyAdapter[]`

**Job status transitions:**

```
queued → running → awaiting_approval → completed
                        │            → rejected
                        │            → failed
```

`awaiting_approval` is set before the `approval_notify` stage runs. The stage sends the Slack notification and returns immediately; the Orchestrator then calls `approvalStore.waitForApproval(jobId)` which blocks until a human responds via Slack, the Dashboard, or the API.

**Stage retry:**

Each stage is attempted up to `config.orchestrator.maxStageRetries + 1` times. Failed attempts use exponential backoff (`2000ms × attempt`). If all attempts fail, the job transitions to `failed`.

---

### ApprovalStore — `src/core/approval-store.ts`

A singleton in-process approval gate that blocks a workflow at the approval stage until a human responds.

```ts
export class ApprovalStore {
  waitForApproval(jobId: string, timeoutMs?: number): Promise<boolean>
  notifyApproval(jobId: string, approved: boolean): boolean
  hasPending(jobId: string): boolean
  pendingJobIds(): string[]
}

export const approvalStore = new ApprovalStore();
```

`waitForApproval()` stores a resolver callback in a `Map<jobId, resolve>` and returns a Promise that blocks until:
- `notifyApproval(jobId, true/false)` is called (from the API or Slack interaction handler)
- The 24-hour timeout fires (resolves `false`)

`notifyApproval()` is called by:
- `POST /api/jobs/:jobId/approve` (returns `true`)
- `POST /api/jobs/:jobId/reject` (returns `false`)
- `POST /api/webhooks/slack/interactions` when a Slack Block Kit button is clicked

---

### WorkflowRegistry — `src/core/workflow-registry.ts`

A simple `Map<string, WorkflowDefinition>` wrapper.

```ts
interface WorkflowDefinition {
  type:   string;      // matches job.workflowType and instance directory name
  stages: IStage[];    // ordered, instantiated stage objects
}
```

`registry.register()` throws if the same `type` is registered twice — preventing accidental duplicates at startup.

Stage names are derived at runtime from `stages.map(s => s.stageName)` — there is no separate name list to maintain.

---

### Scheduler — `src/core/scheduler.ts`

Wraps `node-cron`. At startup, `start()` iterates all enabled instance configs and registers a cron task for each instance with `schedule.enabled: true` and a valid `schedule.cron` expression.

Per-instance timezone is supported via `cfg.schedule.timezone` (passed to `node-cron`). The default is `UTC`.

When a cron fires, it calls `orchestrator.submitJob()` directly — no intermediate task board needed.

**Cron format:** Standard 5-field (`min hour day month weekday`), UTC unless `timezone` is set.

---

### ApiServer — `src/api/server.ts`

Express server on port 3001. Key design choices:

- **CORS middleware** runs first (before auth); reads `CORS_ORIGINS` env var (default `http://localhost:3000`); handles OPTIONS preflight
- **Auth middleware** checks `x-api-key` against `API_SECRET` when set; skips webhook routes
- **Approval endpoints** call `approvalStore.notifyApproval()` directly — no webhooks or external services needed
- **Slack interaction handler** verifies `X-Slack-Signature` (optional), parses `action_id` and `value`, calls `approvalStore.notifyApproval()`, updates the original Slack message via `response_url`
- **`submitJob`** always uses the `Orchestrator` directly (no external task board)

---

### Job model — `src/models/job.model.ts`

```ts
interface Job {
  id:           string;         // UUID
  workflowType: string;         // matches WorkflowDefinition.type
  status:       JobStatus;
  request:      BlogRequest;
  stages:       StageRecord[];
  createdAt:    string;         // ISO 8601
  updatedAt:    string;
  completedAt?: string;
  error?:       string;
  approval:     ApprovalState;
  publishRecord?: PublishRecord;
}

type JobStatus =
  | "queued" | "running" | "awaiting_approval"
  | "approved" | "rejected" | "failed" | "completed";

interface StageRecord {
  name:         string;
  status:       StageStatus;  // pending | running | completed | failed | skipped
  startedAt?:   string;
  completedAt?: string;
  attempts:     number;
  error?:       string;
  output?:      unknown;
}
```

`StageRecord.output` is the primary mechanism for passing data between stages. Downstream stages use `requireStageOutput<T>(job, stageName)` or `getStageOutput<T>(job, stageName)` to retrieve it.

---

### IStage interface — `src/core/stage.interface.ts`

```ts
interface IStage {
  readonly stageName: string;
  run(job: Job): Promise<unknown>;
}
```

Every workflow step implements `IStage`. The orchestrator calls `stage.run(job)` and stores the return value on `StageRecord.output`. Stages must not modify `job` directly — they communicate downstream only via their return value.

---

## Data flow diagram

```
Human / API / Scheduler
        │
        │  submitJob(request)
        ▼
Orchestrator.submitJob()
        │
        │  job.status = "queued" → "running"
        ▼
for each stage in workflow.stages:
  ├── [approval_notify] ──────────────────────────────────────────────────────┐
  │       job.status = "awaiting_approval"                                     │
  │       stage.run(job)  → sends Slack Block Kit with Approve/Reject buttons  │
  │       approvalStore.waitForApproval(jobId)  ← blocks                      │
  │                                                                             │
  │       Resolved by:                                                          │
  │         POST /api/jobs/:id/approve    → notifyApproval(id, true)           │
  │         POST /api/jobs/:id/reject     → notifyApproval(id, false)          │
  │         Slack button click            → notifyApproval(id, true/false)     │
  │                                                                             │
  │       [approved]  job.status = "running" → continue stages                 │
  │       [rejected]  job.status = "rejected" → return                         │
  │       [timeout]   job.status = "failed"   → return                         │
  │                                                                             │
  └── [all other stages]                                                        │
          runStageWithRetry(job, stage, stageRecord)                            │
            └── stage.run(job)  → stageRecord.output                           │
          saveJobOptional(job)                                                  │
                                                                                │
◄───────────────────────────────────────────────────────────────────────────────┘
        │
        │  all stages complete
        ▼
job.status = "completed"
saveJobOptional(job)
```

---

## Workflow anatomy

A `WorkflowDefinition` is built by a factory function and registered once in `src/index.ts`:

```ts
// In src/index.ts:
registry.register(buildFinalExpenseReportingWorkflow(notifiers));

// The factory:
export function buildFinalExpenseReportingWorkflow(notifiers: INotifyAdapter[]): WorkflowDefinition {
  return {
    type: "final-expense-reporting",
    stages: [
      new DataCollectionStage(),
      new AnalysisStage(),
      new SummaryStage(),
      new SlackPublishStage(),
    ],
  };
}
```

Stages chain by reading prior outputs from `job.stages[].output`:

```ts
// In AnalysisStage.run():
const collected = requireStageOutput<DataCollectionOutput>(job, "data-collection");

// In SummaryStage.run():
const analysis = requireStageOutput<AnalysisOutput>(job, "analysis");
```

The `workflowType` on the job (`job.workflowType`) is the instance ID string. Every stage can call `loadInstanceConfig(job.workflowType)` to read the instance's `instance.md` frontmatter for per-instance config.

---

## Dashboard

The dashboard (`dashboard/`) is a Next.js 15 App Router application. It communicates with the ElevarusOS API via:

- **Client Components** (Active Jobs, Scheduled, History pages) — fetch directly to `NEXT_PUBLIC_ELEVARUS_API_URL` from the browser (CORS is handled by the API's CORS middleware)
- **Route Handlers** (`/api/jobs/[jobId]/approve`, `/reject`) — proxied server-side, injecting `x-api-key: ELEVARUS_API_SECRET` so the secret is never exposed to the browser

Auth is handled by Supabase (`@supabase/ssr`). The dashboard middleware refreshes the session cookie on every request and redirects unauthenticated users to `/login`.
