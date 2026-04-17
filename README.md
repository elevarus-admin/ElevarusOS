# ElevarusOS

ElevarusOS is an internal AI agent orchestration platform that connects Mission Control (MC) to structured, multi-stage workflows. Each registered bot instance polls the MC task queue, executes its workflow stages (data collection, Claude-powered analysis, Slack publishing, human approval gates, and more), and reports status back to MC in real time. The platform currently runs blog content bots and PPC campaign reporting bots, and is designed to add new agent types without modifying the core runtime.

---

## Architecture overview

```
MC Task Board
      │
      ▼  MCWorker polls GET /api/tasks/queue
MCWorker claims task
      │
      ▼
Workflow stages run (IStage implementations)
      │
      ▼  [blog only] approval_notify stage
MC task → "review"  ──── Human approves in MC UI ──── webhook → notifyApproval()
      │
      ▼
Remaining stages complete
      │
      ▼
Aegis quality-review self-approval → MC task "done"
```

| Component | Role |
|---|---|
| **MCWorker** | Core daemon: registers agents in MC, polls the task queue, claims and executes tasks, routes approval webhooks |
| **Orchestrator** | Legacy / `--once` mode executor: runs workflows directly without MC, used for local testing |
| **WorkflowRegistry** | Maps `workflowType` strings to ordered `IStage[]` lists |
| **Scheduler** | `node-cron` wrapper: fires `triggerFn(instanceId)` on a per-instance cron schedule |
| **IStage** | Interface implemented by every workflow step; stages receive `Job` and return structured output |

See [docs/architecture.md](docs/architecture.md) for the full technical breakdown.

---

## Quick start

```bash
# 1. Clone and install
git clone <repo-url> ElevarusOS
cd ElevarusOS
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY at minimum (see docs/environment.md)

# 3. Run in daemon mode (connects to Mission Control)
npm run dev

# 4. Or run a single test job without MC
npm run dev -- --once --bot elevarus-blog
npm run dev -- --once --bot final-expense-reporting
```

> Daemon mode requires `MISSION_CONTROL_URL` and `MISSION_CONTROL_API_KEY`. Without them, MCWorker will not poll but the API server and Scheduler still start.

---

## Project structure

```
src/
├── index.ts                    # Entry point — daemon & --once modes, registry bootstrap
├── config/                     # Environment config loader
├── core/
│   ├── mc-worker.ts            # Daemon engine: poll, claim, execute, approve
│   ├── orchestrator.ts         # --once / direct-run executor
│   ├── workflow-registry.ts    # WorkflowDefinition map
│   ├── scheduler.ts            # node-cron wrapper
│   ├── stage.interface.ts      # IStage, requireStageOutput, getStageOutput
│   ├── mc-client.ts            # Mission Control API client
│   ├── slack-client.ts         # Slack Web API wrapper
│   ├── claude-client.ts        # Anthropic SDK wrapper (claudeJSON)
│   ├── instance-config.ts      # Parses instance.md frontmatter
│   ├── job-store.ts            # In-memory / Supabase job store factory
│   └── logger.ts               # Structured logger
├── models/
│   ├── job.model.ts            # Job, StageRecord, JobStatus types
│   └── blog-request.model.ts   # BlogRequest (shared request shape)
├── workflows/
│   ├── blog/                   # 9-stage blog workflow
│   │   ├── blog.workflow.ts
│   │   ├── stages/
│   │   └── prompts/
│   ├── final-expense-reporting/ # 4-stage reporting workflow
│   ├── hvac-reporting/          # 4-stage reporting workflow
│   └── u65-reporting/           # 4-stage reporting workflow
├── instances/
│   ├── _template/              # Copy this to create a new instance
│   ├── elevarus-blog/
│   ├── nes-blog/
│   ├── final-expense-reporting/
│   ├── hvac-reporting/
│   └── u65-reporting/
├── adapters/
│   ├── intake/                 # ClickUp, Email intake adapters
│   └── notify/                 # Slack, Email notification adapters
├── api/
│   └── server.ts               # Express API server
└── integrations/
    ├── ringba.ts               # Ringba revenue API
    └── meta.ts                 # Meta Ads spend API
```

---

## Adding a new agent instance

See [docs/instances.md](docs/instances.md) for the full walkthrough.

The short version:

1. Copy `src/instances/_template/` to `src/instances/<your-id>/`
2. Edit `instance.md` — set `id`, `name`, `baseWorkflow`, `schedule`, and any integration config
3. Register the workflow in `src/index.ts`:
   ```ts
   registry.register(buildBlogWorkflowDefinition(notifiers, "your-id"));
   // or for reporting:
   registry.register(buildYourReportingWorkflow(notifiers));
   ```
4. Restart ElevarusOS — the agent appears in MC automatically

---

## Active agents

| Instance ID | Type | Workflow | Schedule | Slack channel |
|---|---|---|---|---|
| `elevarus-blog` | Blog | blog | Manual / MC task | — |
| `nes-blog` | Blog | blog | Manual / MC task | — |
| `final-expense-reporting` | Reporting | ppc-campaign-report | Mon–Fri 9am–5pm ET every 2h | `#cli-final-expense` |
| `hvac-reporting` | Reporting | ppc-campaign-report | Disabled (manual) | — |
| `u65-reporting` | Reporting | ppc-campaign-report | Disabled (manual) | — |

---

## Documentation

| Doc | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System design, component details, data flow diagram |
| [docs/workflows.md](docs/workflows.md) | Blog and reporting workflow stage-by-stage reference |
| [docs/instances.md](docs/instances.md) | How to create and configure a new bot instance |
| [docs/environment.md](docs/environment.md) | All environment variables with descriptions |
| [docs/api.md](docs/api.md) | REST API reference |
| [docs/integrations.md](docs/integrations.md) | Ringba and Meta API setup |
