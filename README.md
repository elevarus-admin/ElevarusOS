# ElevarusOS

ElevarusOS is an internal AI agent orchestration platform. It runs multi-stage AI workflows on behalf of registered bot instances — blog content bots, PPC campaign reporting bots, and more — and exposes a REST API and web dashboard for monitoring and control.

---

## Architecture overview

```
Scheduler (node-cron)
      │
      │  triggerFn(instanceId)
      ▼
Orchestrator.submitJob()
      │
      ▼
Workflow stages run sequentially (IStage implementations)
      │
      ▼  [blog only] approval_notify stage
ApprovalStore.waitForApproval()  ←──── Slack button / API call
      │                                POST /api/jobs/:id/approve
      │                                        │
      │  approved                              │
      ▼                                        │
Remaining stages complete ◄──────────────────-┘
      │
      ▼
job.status = "completed"
```

| Component | Role |
|---|---|
| **Orchestrator** | Core executor: accepts `submitJob()` calls, runs stages sequentially, manages retries, persists state |
| **ApprovalStore** | In-process singleton: blocks workflows at the approval gate; resolves via API call or Slack interaction |
| **Scheduler** | `node-cron` wrapper: fires `submitJob()` on per-instance cron schedules |
| **WorkflowRegistry** | Maps `workflowType` strings to ordered `IStage[]` lists |
| **IStage** | Interface implemented by every workflow step |
| **ApiServer** | Express REST API on port 3001: job management, approval endpoints, Slack interaction webhook |
| **Dashboard** | Next.js web UI on port 3000: live jobs, history, approval panel, agent registry |

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

# 3. Start API + Dashboard
make start

# 4. Or run in API-only mode with hot reload
make dev

# 5. Run a single test job without the full daemon
npm run once -- --bot elevarus-blog
npm run once -- --bot final-expense-reporting
```

Open the dashboard at **http://localhost:3000** (login with your Supabase credentials).
The API is at **http://localhost:3001/api/health**.

---

## Project structure

```
src/
├── index.ts                    # Entry point — daemon & --once modes, registry bootstrap
├── config/                     # Environment config loader
├── core/
│   ├── orchestrator.ts         # Primary executor: runs stages, manages job lifecycle
│   ├── approval-store.ts       # Singleton approval gate (blocks workflow until human approves)
│   ├── workflow-registry.ts    # WorkflowDefinition map
│   ├── scheduler.ts            # node-cron wrapper
│   ├── stage.interface.ts      # IStage, requireStageOutput, getStageOutput
│   ├── slack-client.ts         # Slack Web API wrapper
│   ├── claude-client.ts        # Anthropic SDK wrapper (claudeJSON)
│   ├── instance-config.ts      # Parses instance.md frontmatter
│   ├── job-store.ts            # In-memory / file / Supabase job store factory
│   └── logger.ts               # Structured logger
├── models/
│   ├── job.model.ts            # Job, StageRecord, JobStatus types
│   └── blog-request.model.ts   # BlogRequest (shared request shape)
├── workflows/
│   ├── blog/                   # 9-stage blog workflow
│   │   ├── blog.workflow.ts
│   │   ├── stages/
│   │   └── prompts/
│   ├── final-expense-reporting/
│   ├── hvac-reporting/
│   └── u65-reporting/
├── instances/
│   ├── _template/              # Copy this to create a new instance
│   ├── elevarus-blog/
│   ├── nes-blog/
│   ├── final-expense-reporting/
│   ├── hvac-reporting/
│   └── u65-reporting/
├── adapters/
│   ├── intake/                 # ClickUp, Email intake adapters
│   └── slack/                  # Slack notification and approval adapters
├── api/
│   └── server.ts               # Express API server
└── integrations/
    ├── ringba.ts               # Ringba revenue API
    └── meta.ts                 # Meta Ads spend API

dashboard/                      # Next.js App Router web UI (port 3000)
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
   ```
4. Restart ElevarusOS — the agent appears in the dashboard automatically

---

## Active agents

| Instance ID | Type | Workflow | Schedule | Slack channel |
|---|---|---|---|---|
| `elevarus-blog` | Blog | blog | On-demand | — |
| `nes-blog` | Blog | blog | On-demand | — |
| `final-expense-reporting` | Reporting | ppc-campaign-report | Mon–Fri 9am–5pm ET every 2h | `#cli-final-expense` |
| `hvac-reporting` | Reporting | ppc-campaign-report | Disabled (manual) | — |
| `u65-reporting` | Reporting | ppc-campaign-report | Disabled (manual) | — |

---

## Documentation

| Doc | Contents |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System design, component details, data flow |
| [docs/workflows.md](docs/workflows.md) | Blog and reporting workflow stage-by-stage reference |
| [docs/instances.md](docs/instances.md) | How to create and configure a new bot instance |
| [docs/environment.md](docs/environment.md) | All environment variables with descriptions |
| [docs/api.md](docs/api.md) | REST API reference |
| [docs/integrations.md](docs/integrations.md) | Ringba and Meta API setup |
