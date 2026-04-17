# ElevarusOS — Architecture

## System overview

ElevarusOS is a TypeScript daemon that executes multi-stage AI workflows on behalf of registered bot instances. Mission Control (MC) is the external task board and source of truth for task status. ElevarusOS owns workflow execution: it pulls tasks from MC, runs stages in sequence, handles approval gates, and reports outcomes back.

The platform is designed to be workflow-agnostic. The core runtime (MCWorker, Orchestrator, Scheduler) knows nothing about blogs, ad campaigns, or any specific content type. All workflow logic lives in `IStage` implementations registered under a unique `workflowType` string.

---

## Components

### Entry point — `src/index.ts`

`main()` bootstraps the platform in one of two modes:

**Daemon mode** (default — `npm run dev`):
1. Instantiates a `WorkflowRegistry` and registers every active workflow
2. Starts `MCWorker` — registers agents in MC, begins polling
3. Registers the ElevarusOS webhook URL with MC (if `ELEVARUS_PUBLIC_URL` is set)
4. Starts the `ApiServer` on `API_PORT` (default 3001)
5. Starts the `Scheduler` — fires cron jobs for instances with `schedule.enabled: true`
6. Listens for `SIGINT`/`SIGTERM` to trigger graceful shutdown

**Single-run mode** (`--once`):

```bash
npm run dev -- --once --bot final-expense-reporting
```

Bypasses MCWorker entirely. Creates an `Orchestrator` directly, builds a sample request for the specified instance, and runs the workflow to completion. Useful for local testing without MC credentials.

---

### Orchestrator — `src/core/orchestrator.ts`

The `Orchestrator` is used in `--once` mode and by the legacy intake-adapter path (ClickUp, email). It is not involved in daemon-mode execution — MCWorker handles that.

**Responsibilities:**
- Accepts `BlogRequest` objects from intake adapters or direct `submitJob()` calls
- Creates `Job` objects from the `WorkflowRegistry` stage list
- Runs stages sequentially via `runStageWithRetry()`
- Persists `Job` state to the configured `IJobStore` after every stage
- Fires `IDashboardBridge` callbacks (`onJobCreated`, `onJobUpdated`) when attached
- Sends failure notifications via `INotifyAdapter[]`

**Job status transitions:**

```
queued → running → awaiting_approval → completed
                                     → failed
```

`awaiting_approval` is set after the `approval_notify` stage completes. The Orchestrator does not implement the webhook-based approval gate — that is MCWorker's responsibility in daemon mode.

**Stage retry:**

Each stage is attempted up to `config.orchestrator.maxStageRetries + 1` times. Failed attempts use exponential backoff (`2000ms × attempt`). If all attempts fail, the job transitions to `failed`.

---

### WorkflowRegistry — `src/core/workflow-registry.ts`

A simple `Map<string, WorkflowDefinition>` wrapper.

```ts
interface WorkflowDefinition {
  type:   string;      // matches job.workflowType and MC agent name
  stages: IStage[];    // ordered, instantiated stage objects
}
```

`registry.register()` throws if the same `type` is registered twice — preventing accidental duplicates at startup.

`registry.get(type)` is called by both MCWorker and Orchestrator to retrieve the stage list for a given `workflowType`.

Stage names are derived at runtime from `stages.map(s => s.stageName)` — there is no separate name list to maintain.

---

### MCWorker — `src/core/mc-worker.ts`

The core daemon-mode engine. Replaces the deprecated `MissionControlBridge` and `DashboardPoller`.

#### Agent registration

At startup, `registerAgents()` iterates all instance IDs (including disabled ones) and calls `MCClient.registerAgent()` for each. Registration is idempotent — safe to call on every restart. The resulting MC agent IDs are stored in `agentIds: Map<string, number>`.

Agents with `baseWorkflow` containing `"reporting"` or equal to `"ppc-campaign-report"` are registered with `role: "researcher"`. All others use `role: "assistant"`.

#### Polling loop

`poll()` runs on a `setTimeout` loop at `config.orchestrator.pollIntervalMs`. On each tick, `checkAllQueues()` iterates every registered agent and calls `MCClient.pollQueue(agentName)`.

**Re-run guard:** Before executing a claimed task, MCWorker checks `runningTaskIds: Set<number>`. If the task ID is already present (possible if MC's queue returns an in-progress task on a subsequent poll cycle), the task is skipped. The ID is added at claim time and removed in the `finally` block of `executeTask()`.

**Resolution check:** If a claimed task already has a `resolution` containing `"completed"` (the workflow finished in a prior process run but Aegis approval hadn't gone through), MCWorker self-approves via Aegis and closes the task without re-running stages. This prevents duplicate Slack posts on restart.

#### Task execution

`executeTask()` wraps `_executeTaskInner()` in a try/finally to guarantee `runningTaskIds` cleanup.

`_executeTaskInner()`:
1. Looks up the workflow in the registry
2. Builds a `Job` object from the MC task (metadata carries `request` fields if the task was created by ElevarusOS)
3. Optionally persists the `Job` to Supabase
4. Marks the MC task `in_progress`
5. Iterates `workflow.stages` and calls `runStageWithRetry()` for each

After each successful stage, MCWorker:
- Updates the MC task description and metadata (best-effort, non-blocking)
- Posts key stage outputs as MC task comments (`summary`, `editorial`, `drafting` stages)
- Saves the updated `Job` to Supabase

On workflow completion:
- Sets `job.status = "completed"`
- Updates the MC task `resolution` field
- Calls `MCClient.submitAegisApproval()` — Aegis auto-advances the task to `"done"` on approval
- Falls back to a direct `status: "done"` update if Aegis is disabled for the workspace

#### Approval gate

When the `approval_notify` stage name is encountered:

1. The stage runs (sends email/Slack notification to the approver)
2. The MC task is set to `"review"` status
3. `waitForApproval()` is called — this returns a `Promise<boolean>` that blocks until:
   - A webhook arrives at `POST /api/webhooks/mc` with the MC task ID → `notifyApproval()` resolves the promise
   - The 24-hour timeout fires (resolves `false`)
4. On approval: `job.approval` is updated, the MC task returns to `"in_progress"`, and the remaining stages run
5. On timeout or rejection: the task is marked `"failed"`

`approvalCallbacks: Map<number, (approved: boolean) => void>` stores the pending resolver keyed by MC task ID. `stop()` rejects all pending callbacks so workflows do not hang during shutdown.

---

### Scheduler — `src/core/scheduler.ts`

Wraps `node-cron`. At startup, `start()` iterates all enabled instance configs and registers a cron task for each instance with `schedule.enabled: true` and a valid `schedule.cron` expression.

Per-instance timezone is supported via `cfg.schedule.timezone` (passed to `node-cron`). The default is `UTC`.

When a cron fires, it calls `triggerFn(instanceId)`. In daemon mode, `triggerFn` calls `MCWorker.createTask()` — which creates an MC task that MCWorker picks up on the next poll cycle. If MC is not configured, `triggerFn` falls back to direct `Orchestrator.submitJob()`.

**Cron format:** Standard 5-field (`min hour day month weekday`), UTC unless `timezone` is set.

---

### Job model — `src/models/job.model.ts`

```ts
interface Job {
  id:           string;         // UUID
  workflowType: string;         // matches WorkflowDefinition.type
  status:       JobStatus;
  request:      BlogRequest;    // intake payload (title, brief, audience, keyword, cta, approver)
  stages:       StageRecord[];  // one record per stage, in order
  createdAt:    string;         // ISO 8601
  updatedAt:    string;
  completedAt?: string;
  error?:       string;
  approval:     ApprovalState;
  publishRecord?: PublishRecord;
}

type JobStatus =
  | "queued" | "running" | "awaiting_approval"
  | "approved" | "failed" | "completed";

interface StageRecord {
  name:         string;       // matches IStage.stageName
  status:       StageStatus;  // pending | running | completed | failed | skipped
  startedAt?:   string;
  completedAt?: string;
  attempts:     number;
  error?:       string;
  output?:      unknown;      // structured output passed to downstream stages
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

**Helper functions:**

```ts
// Throws if the named stage has not yet completed successfully.
requireStageOutput<T>(job: Job, stageName: string): T

// Returns undefined if the stage has not yet completed.
getStageOutput<T>(job: Job, stageName: string): T | undefined
```

---

## Data flow diagram

```
Human / API / Scheduler
        │
        │  createTask()
        ▼
MC Task Board (inbox → in_progress)
        │
        │  GET /api/tasks/queue  (pollIntervalMs)
        ▼
MCWorker.checkAllQueues()
        │
        │  task not in runningTaskIds
        ▼
MCWorker.executeTask(mcTask, agentName)
        │
        │  runningTaskIds.add(task.id)
        │  buildJobFromMCTask()
        │  client.updateTask(in_progress)
        ▼
for each stage in workflow.stages:
  ├── [approval_notify] ──────────────────────────────────────────────────┐
  │       stage.run(job)                                                   │
  │       client.updateTask(review)                                        │
  │       waitForApproval() ← blocks ← notifyApproval() ← webhook POST   │
  │       [approved] client.updateTask(in_progress) → continue            │
  │       [timeout]  client.updateTask(failed) → return                   │
  │                                                                        │
  └── [all other stages]                                                   │
          runStageWithRetry(job, stage, stageRecord)                       │
            └── stage.run(job)  → stageRecord.output                      │
          client.updateTask(description + metadata)   [non-blocking]      │
          postStageOutputComment(mcTaskId, stageName) [non-blocking]      │
          saveJobOptional(job)                                             │
                                                                          │
◄─────────────────────────────────────────────────────────────────────────┘
        │
        │  all stages complete
        ▼
job.status = "completed"
client.updateTask(resolution: "Workflow completed successfully")
client.submitAegisApproval()  →  MC task "done"
runningTaskIds.delete(task.id)
```

---

## Workflow anatomy

A `WorkflowDefinition` is built by a factory function and registered once in `src/index.ts`:

```ts
// In src/index.ts:
registry.register(buildFinalExpenseReportingWorkflow(notifiers));

// The factory (src/workflows/final-expense-reporting/final-expense-reporting.workflow.ts):
export function buildFinalExpenseReportingWorkflow(notifiers: INotifyAdapter[]): WorkflowDefinition {
  return {
    type: "final-expense-reporting",   // must match the instance directory name
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
// collected.rawData is now available for the Claude prompt

// In SummaryStage.run():
const analysis = requireStageOutput<AnalysisOutput>(job, "analysis");
// analysis.alertLevel, keyTrends, etc. drive the summary prompt
```

The `workflowType` on the job (`job.workflowType`) is the instance ID string. Every stage can call `loadInstanceConfig(job.workflowType)` to read the instance's `instance.md` frontmatter for per-instance config (Ringba campaign name, Meta ad account ID, Slack channel, etc.).
