# ElevarusOS — Instance Configuration Guide

An **instance** is a named deployment of a base workflow with its own brand identity, schedule, integrations, and Slack routing. Every bot that runs inside ElevarusOS is an instance. Two instances can share the same base workflow (e.g. two blog bots both using `blog`) while producing entirely different output because their configuration, prompts, and MISSION.md differ.

---

## What Lives in an Instance

Each instance has its own directory under `src/instances/<id>/` containing:

| File | Purpose |
|------|---------|
| `instance.md` | Configuration frontmatter — id, brand, schedule, integrations |
| `MISSION.md` | Agent operating manual — injected into every analysis and summary stage as the primary instruction source |
| `WORKING.md` | Operational status log — last confirmed working state, known behaviors, active flags |
| `soul.md` | Agent identity and voice — injected as secondary context in Claude prompts |
| `MEMORY.md` | Persistent cross-run memory — learnings, patterns, and client-specific context |
| `workspace/` | Ephemeral per-run scratch files (reports, intermediate outputs) |

---

## `instance.md` Frontmatter Schema

All configuration lives in YAML frontmatter at the top of `instance.md`. Fields not marked optional are required.

### Required fields

```yaml
id: your-instance-id          # Must match the directory name exactly
name: Your Bot Instance Name  # Shown in logs and the MC UI
baseWorkflow: blog            # Which base workflow to run: blog | ppc-campaign-report
enabled: true                 # Set false to disable without deleting
```

### `brand` — voice and audience

Injected into every Claude prompt via `{{BRAND_VOICE}}`, `{{BRAND_AUDIENCE}}`, `{{BRAND_TONE}}`, and `{{BRAND_INDUSTRY}}` placeholders.

```yaml
brand:
  voice: "Conversational but authoritative. Data-driven."
  audience: "Digital agency owners at 10–50 person shops."
  tone: "Confident, practical, forward-thinking"
  industry: "AI-powered agency operations"   # optional
```

| Field | Description |
|-------|-------------|
| `voice` | Writing style directive injected into all content prompts |
| `audience` | Who is reading the output — shapes vocabulary and assumed knowledge |
| `tone` | Emotional register — e.g. "Analytical and direct" for reporting bots |
| `industry` | Domain context — helps Claude anchor examples and references |

### `notify` — delivery routing

```yaml
notify:
  approver: shane@elevarus.com    # Email address for approval requests (blog workflow)
  slackChannel: cli-final-expense # Slack channel name or ID for report delivery
```

| Field | Description |
|-------|-------------|
| `approver` | Who receives the MC approval email when a blog draft is ready for review |
| `slackChannel` | Slack channel where the bot posts its output. Use `~` to disable Slack delivery |

### `schedule` — cron-based automation

```yaml
schedule:
  enabled: true
  cron: "0 9,11,13,15,17 * * 1-5"   # 5-field cron expression
  timezone: America/New_York          # IANA timezone string (defaults to UTC if omitted)
  description: "Weekday report every 2h, 9am–5pm EST"
```

| Field | Description |
|-------|-------------|
| `enabled` | Set `true` to activate the ElevarusOS scheduler for this instance |
| `cron` | 5-field cron expression: `minute hour day-of-month month day-of-week`. See examples below |
| `timezone` | IANA timezone string. Defaults to UTC if omitted. Use `America/New_York` for US Eastern |
| `description` | Human-readable label — shown in logs, not parsed by the scheduler |

**Common cron examples:**

| Schedule | Expression |
|----------|-----------|
| Every Monday at 9am UTC | `0 9 * * 1` |
| Every weekday at 8am UTC | `0 8 * * 1-5` |
| Mon–Fri at 9am, 11am, 1pm, 3pm, 5pm | `0 9,11,13,15,17 * * 1-5` |
| First day of each month at 6am | `0 6 1 * *` |
| Every 30 minutes on weekdays | `*/30 * * * 1-5` |

Timezone defaults to UTC. To schedule in Eastern Time, set `timezone: America/New_York` — the scheduler converts the cron expression to the correct UTC offset, handling DST automatically.

### `ringba` — Ringba call data source

Used by the `ppc-campaign-report` base workflow.

```yaml
ringba:
  campaignName: O&O_SOMQ_FINAL_EXPENSE   # Exact campaign name in Ringba
  reportPeriod: mtd                       # mtd | wtd | custom
  startDate: ~                            # Required only when reportPeriod: custom (YYYY-MM-DD)
  endDate: ~                              # Required only when reportPeriod: custom (YYYY-MM-DD)
```

| Field | Values | Description |
|-------|--------|-------------|
| `campaignName` | string | Exact campaign name as it appears in Ringba — used in API query |
| `reportPeriod` | `mtd` `wtd` `custom` | Default date window for reports. `mtd` = month-to-date, `wtd` = week-to-date |
| `startDate` | `YYYY-MM-DD` | Only used when `reportPeriod: custom` |
| `endDate` | `YYYY-MM-DD` | Only used when `reportPeriod: custom` |

### `meta` — Meta Ads data source

```yaml
meta:
  adAccountId: "999576488367816"   # Meta ad account ID (string to preserve leading digits)
  campaignIds: []                  # Specific campaign IDs to filter; empty = entire account
```

| Field | Description |
|-------|-------------|
| `adAccountId` | The Meta Ads account ID. Always quote as a string — numeric IDs can lose precision |
| `campaignIds` | Array of Meta campaign IDs to scope the spend query. Empty array pulls all campaigns in the account |

---

## Step-by-Step: Add a New Reporting Agent

### 1. Copy the template

```bash
cp -r src/instances/_template src/instances/hvac-reporting
```

Rename the directory to your new instance ID. The `id` field in `instance.md` must match the directory name exactly.

### 2. Fill in the frontmatter

Open `src/instances/{new-id}/instance.md` and configure:

- `id` — must match the directory name
- `name` — human-readable label for logs and MC UI
- `baseWorkflow: ppc-campaign-report`
- `ringba.campaignName` — copy the exact string from Ringba
- `meta.adAccountId` — quoted string from Meta Business Manager
- `notify.slackChannel` — Slack channel name (without `#`)
- `schedule.enabled`, `schedule.cron`, `schedule.timezone`

### 3. Add a workflow builder

Create `src/workflows/{new-id}/{new-id}.workflow.ts`. The easiest approach is to copy the final-expense-reporting workflow and rename the exported function and instance ID reference:

```typescript
// src/workflows/hvac-reporting/hvac-reporting.workflow.ts
export function buildHvacReportingWorkflow(notifiers: INotifyAdapter[]): WorkflowDefinition {
  return {
    instanceId: "hvac-reporting",
    stages: [
      new DataCollectionStage(),
      new AnalysisStage(),
      new SummaryStage(),
      new SlackPublishStage(),
    ],
    notifiers,
  };
}
```

### 4. Register in `src/index.ts`

Add one import and one registry line:

```typescript
import { buildHvacReportingWorkflow } from "./workflows/hvac-reporting/hvac-reporting.workflow";

// inside main():
registry.register(buildHvacReportingWorkflow(notifiers));
```

### 5. Restart ElevarusOS

```bash
npm run dev
```

On startup, ElevarusOS reads all `instance.md` files and registers each active instance in MC. The new agent appears in the MC task board and the scheduler activates its cron if `schedule.enabled: true`.

---

## Active Instances

| Instance | Base Workflow | Enabled | Schedule | Slack Channel | Notes |
|----------|--------------|---------|----------|---------------|-------|
| `elevarus-blog` | blog | yes | On-demand | — | Internal Elevarus marketing blog |
| `nes-blog` | blog | yes | On-demand | — | HVAC client blog content |
| `final-expense-reporting` | ppc-campaign-report | yes | Mon–Fri every 4h, 9am–5pm EST | `#cli-final-expense` | Full Ringba + Meta integration |
| `hvac-reporting` | ppc-campaign-report | yes | Disabled (cron configured but `enabled: false`) | Not yet set | Pending Slack channel assignment |
| `u65-reporting` | ppc-campaign-report | yes | Disabled (cron configured but `enabled: false`) | Not yet set | Pending Slack channel assignment |

### final-expense-reporting — full config

| Setting | Value |
|---------|-------|
| `id` | `final-expense-reporting` |
| `name` | Final Expense Campaign Report Bot |
| `baseWorkflow` | ppc-campaign-report |
| `ringba.campaignName` | `O&O_SOMQ_FINAL_EXPENSE` |
| `ringba.reportPeriod` | mtd |
| `meta.adAccountId` | `999576488367816` |
| `meta.campaignIds` | `[]` (entire account) |
| `notify.slackChannel` | `cli-final-expense` |
| `schedule.cron` | `0 9,11,13,15,17 * * 1-5` |
| `schedule.timezone` | `America/New_York` |
| `schedule.description` | Weekday campaign report every 2 hours 9am–5pm EST |

---

## Scheduling

The ElevarusOS Scheduler reads every active instance's `schedule` block on startup. If `schedule.enabled: true`, it creates an in-process cron job using the provided expression and timezone.

**Timezone behavior.** The `timezone` field is optional and defaults to UTC. When set to an IANA string like `America/New_York`, the scheduler converts the cron expression to account for UTC offset and DST transitions. Always verify scheduling intent with `America/New_York` during daylight saving transitions — a `9am` cron fires at 9am local time year-round.

**Cron expression format.** ElevarusOS uses the standard 5-field format:

```
┌──────── minute (0–59)
│ ┌────── hour (0–23)
│ │ ┌──── day of month (1–31)
│ │ │ ┌── month (1–12)
│ │ │ │ ┌ day of week (0–7, 0 and 7 = Sunday)
│ │ │ │ │
0 9 * * 1-5
```

Use [crontab.guru](https://crontab.guru) to build and verify expressions before committing them.

---

## MC Recurring Tasks

Mission Control supports its own recurring task templates via `metadata.recurrence.cron_expr` in the task configuration. These operate independently of the ElevarusOS scheduler.

**Key distinction:**

- **ElevarusOS Scheduler** — runs inside the ElevarusOS process. On each fire, it creates a new job, executes all workflow stages (data collection → analysis → summary → Slack publish), and resolves. The scheduler does not create MC tasks.
- **MC Recurring Templates** — configured in MC. On each fire, MC spawns a new child task on the task board. MCWorker picks it up and routes it to the matching ElevarusOS workflow via `workflowType`.

Both mechanisms can coexist for the same instance. A typical setup uses the ElevarusOS scheduler for automated reporting (no MC task created) and MC recurring templates for human-reviewable deliverables like blog drafts (task created, moves through review/approval states).
