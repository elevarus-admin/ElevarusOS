# ElevarusOS Agent Squad

This file describes the agents managed by ElevarusOS and registered in Mission Control.

## Architecture

ElevarusOS is the workflow execution runtime. Mission Control is the control plane.
Agents are registered automatically at startup via `MCWorker.registerAgents()`.

**Stack:**
- Mission Control (this dashboard) — `:3000` — task board, agent registry, approvals, audit
- ElevarusOS — `:3001` — workflow execution, scheduling, Claude API, publishing

---

## Bot Instances (Workflow Agents)

These agents are registered automatically when ElevarusOS starts.
Each maps to a workflow type that handles a specific content or reporting use case.

### Blog Bots

| Agent ID | Name | Workflow |
|----------|------|----------|
| `elevarus-blog` | Elevarus Blog Bot | Blog content pipeline |
| `nes-blog` | NES Blog Bot | Blog content pipeline |
| `blog` | Default Blog Bot | Blog content pipeline (fallback) |

### Reporting Bots

| Agent ID | Name | Workflow |
|----------|------|----------|
| `u65-reporting` | U65 Reporting Bot | Campaign performance reports |
| `final-expense-reporting` | Final Expense Reporting Bot | Campaign performance reports |
| `hvac-reporting` | HVAC Reporting Bot | Campaign performance reports |

---

## Workflow Pipeline (Blog)

Each blog task runs through these stages in sequence:

1. **intake** — Validate and normalize the incoming request
2. **normalization** — Standardize fields and fill gaps
3. **research** — Gather topic research via Claude
4. **outline** — Generate a structured article outline
5. **drafting** — Write the full draft
6. **editorial** — Polish, fact-check, and refine
7. **approval_notify** — Notify approver → task moves to `review` in MC
8. **publish_placeholder** — Hand off to publish adapters (Slack, blog, email)
9. **completion** — Send completion notification

> After stage 7, the task pauses in MC's Task Board under **Review**.
> A human approves it → MC fires a webhook → ElevarusOS resumes stages 8–9.

## Workflow Pipeline (Reporting)

1. **data-collection** — Gather campaign metrics
2. **analysis** — Analyze performance vs. benchmarks
3. **summary** — Generate executive summary via Claude
4. **slack-publish** — Post report to Slack channel

---

## Adding a New Agent

1. Create `src/instances/<id>/instance.md` (copy from `src/instances/_template/`)
   — or — `POST http://localhost:3001/api/instances`

2. Register in `src/index.ts`:
   ```ts
   registry.register(buildBlogWorkflowDefinition(notifiers, "<id>"));
   ```

3. Restart ElevarusOS — the agent appears in MC automatically.

4. Create tasks in MC and assign to `<id>`, or let the scheduler fire them.

---

## Task Lifecycle

```
inbox → assigned → in_progress → review → done
                                    ↑
                            human approves in MC UI
                            MC fires webhook to ElevarusOS
                            workflow resumes
```

## Environment

- **ElevarusOS API:** `http://localhost:3001`
- **Health check:** `http://localhost:3001/api/health`
- **Webhook receiver:** `POST http://localhost:3001/api/webhooks/mc`
- **Submit job:** `POST http://localhost:3001/api/jobs`
