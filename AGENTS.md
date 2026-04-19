# ElevarusOS Agent Squad

This file describes the bot instances managed by ElevarusOS and their workflow pipelines.

## Architecture

ElevarusOS is the workflow execution runtime and control plane.

**Stack:**
- ElevarusOS API — `:3001` — job execution, scheduling, Claude API, publishing
- ElevarusOS Dashboard — `:3000` — live jobs, history, approval panel, agent registry

Agents are defined in `src/instances/` and registered automatically when ElevarusOS starts. Each instance maps to a `workflowType` that runs a specific content or reporting pipeline via the `Orchestrator`.

---

## Bot Instances (Workflow Agents)

### Blog Bots

| Agent ID | Name | Workflow |
|----------|------|----------|
| `elevarus-blog` | Elevarus Blog Bot | Blog content pipeline |
| `nes-blog` | NES Blog Bot | Blog content pipeline |

### Reporting Bots

| Agent ID | Name | Workflow |
|----------|------|----------|
| `u65-reporting` | U65 Reporting Bot | Campaign performance reports |
| `final-expense-reporting` | Final Expense Reporting Bot | Campaign performance reports |
| `hvac-reporting` | HVAC Reporting Bot | Campaign performance reports |

---

## Workflow Pipeline (Blog)

Each blog job runs through these stages in sequence:

1. **intake** — Validate and normalize the incoming request
2. **normalization** — Standardize fields and fill gaps
3. **research** — Gather topic research via Claude
4. **outline** — Generate a structured article outline
5. **drafting** — Write the full draft
6. **editorial** — Polish, fact-check, and refine
7. **approval_notify** — Send Slack Block Kit message with Approve/Reject buttons; job pauses until a human responds
8. **publish_placeholder** — Hand off to publish adapters (Slack, blog, email)
9. **completion** — Send completion notification

After stage 7, `ApprovalStore.waitForApproval()` blocks the workflow. A human approves via:
- **Dashboard** — `/jobs/:id` page → Approve/Reject panel
- **Slack** — Block Kit buttons on the approval message
- **API** — `POST /api/jobs/:id/approve` or `/reject`

On approval the workflow resumes with stages 8–9. On rejection the job is marked `rejected`.

## Workflow Pipeline (Reporting)

1. **data-collection** — Gather campaign metrics from Ringba/Meta
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

3. Restart ElevarusOS — the agent appears in the Dashboard automatically.

4. Submit a job via the Dashboard or API:
   ```bash
   curl -X POST http://localhost:3001/api/jobs \
     -H "Content-Type: application/json" \
     -d '{"workflowType":"<id>","title":"...","brief":"..."}'
   ```

---

## Job Lifecycle

```
queued → running → awaiting_approval → completed
                        │            → rejected
         Slack / Dashboard / API
              Approve / Reject
```

## Environment

- **ElevarusOS API:** `http://localhost:3001`
- **Health check:** `http://localhost:3001/api/health`
- **Submit job:** `POST http://localhost:3001/api/jobs`
- **Approve job:** `POST http://localhost:3001/api/jobs/:id/approve`
- **Reject job:** `POST http://localhost:3001/api/jobs/:id/reject`
- **Slack interactions:** `POST http://localhost:3001/api/webhooks/slack/interactions`
- **Dashboard:** `http://localhost:3000`
