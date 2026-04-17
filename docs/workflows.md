# ElevarusOS — Workflows

## Overview

ElevarusOS currently has two base workflow types:

| Base workflow | Instances | Stages |
|---|---|---|
| `blog` | `elevarus-blog`, `nes-blog` | 9 |
| `ppc-campaign-report` | `final-expense-reporting`, `hvac-reporting`, `u65-reporting` | 4 |

The `workflowType` on a `Job` must exactly match the instance ID string used when registering the workflow in `src/index.ts` and when naming the instance directory under `src/instances/`.

---

## Blog workflow

**File:** `src/workflows/blog/blog.workflow.ts`
**Stages:** 9 (intake → normalization → research → outline → drafting → editorial → approval_notify → publish_placeholder → completion)

### Stage 1: `intake`

Validates and normalizes the raw `BlogRequest`. Checks for required fields (`title`, `brief`, `audience`, `targetKeyword`). Populates `missingFields` on the request if anything is absent. In practice, intake adapters (ClickUp, email) perform pre-validation before creating a job, so this stage mainly confirms structure.

Output shape:
```ts
{ validated: boolean; missingFields: string[]; normalizedRequest: BlogRequest }
```

### Stage 2: `normalization`

Enriches the request with defaults and derived values. Resolves audience personas, applies brand voice from the instance config (`brand.voice`, `brand.tone`, `brand.audience`), and ensures all downstream stages have a complete, consistent request to work from.

Output shape:
```ts
{ normalizedTitle: string; brief: string; audience: string; keyword: string }
```

### Stage 3: `research`

Uses Claude to research the topic specified in the brief. Generates a set of supporting facts, statistics, talking points, and source references. The research output is passed directly into the outline and drafting stages.

Output shape:
```ts
{ keyPoints: string[]; statistics: string[]; sources: string[]; researchSummary: string }
```

### Stage 4: `outline`

Uses Claude to build a structured blog post outline from the research output. Produces a hierarchical list of sections and sub-points. The outline is the blueprint for the drafting stage.

Output shape:
```ts
{ title: string; sections: Array<{ heading: string; points: string[] }> }
```

### Stage 5: `drafting`

Uses Claude to write the full blog post draft from the outline and research. Applies the instance's brand voice and tone from `instance.md`. The raw draft is stored on `stageRecord.output` and posted as an MC task comment for reference.

Output shape:
```ts
{ draft: string; wordCount: number; readingTimeMinutes: number }
```

### Stage 6: `editorial`

Uses Claude to review and edit the draft. Checks for clarity, tone consistency, factual accuracy against the research, SEO alignment with `targetKeyword`, and call-to-action placement. Produces the final polished draft. This output is posted as an MC task comment.

Output shape:
```ts
{ editedDraft: string; changesSummary: string; seoScore?: number }
```

### Stage 7: `approval_notify`

Sends an approval request (email and/or Slack) to the approver specified in `job.request.approver`. After this stage completes, MCWorker sets the MC task to `"review"` status and blocks via `waitForApproval()` until a human approves in the MC Task Board. The webhook at `POST /api/webhooks/mc` receives the approval event and calls `MCWorker.notifyApproval()` to unblock the workflow.

Output shape:
```ts
{ notified: boolean; notifiedAt: string; channel: string }
```

### Stage 8: `publish_placeholder`

Marks the content as ready for publishing and creates a `PublishRecord` on the job. This is a handoff stage — the actual CMS publish is performed externally. Future publish adapters (WordPress, Webflow, etc.) will extend this stage.

Output shape:
```ts
{ status: "pending" | "published"; targetPlatform?: string; handoffData?: unknown; createdAt: string }
```

### Stage 9: `completion`

Finalizes the job. Sends completion notifications, logs the final word count and timing, and records any post-publish metadata. The job transitions to `"completed"` after this stage.

Output shape:
```ts
{ completedAt: string; summary: string }
```

---

## Reporting workflow

**Files:**
- `src/workflows/final-expense-reporting/`
- `src/workflows/hvac-reporting/`
- `src/workflows/u65-reporting/`

All three reporting workflows share the same 4-stage pattern. They differ only in their instance configuration (`instance.md`): Ringba campaign name, Meta ad account ID, Slack channel, and the agent's `MISSION.md` which controls alert thresholds and report formatting.

**Stages:** data-collection → analysis → summary → slack-publish

---

### Stage 1: `data-collection`

**File:** `stages/01-data-collection.stage.ts`

Pulls four data sources in parallel using `Promise.all`:

| Source | Window | Filter |
|---|---|---|
| Ringba MTD | Month start → today | `minCallDurationSeconds: 0` (all calls, matches Ringba UI "Incoming" total) |
| Ringba Today | today → today | `minCallDurationSeconds: 30` (drops sub-threshold routing failures and live calls) |
| Meta MTD | Month start → today | `campaignIds: []` = entire ad account spend |
| Meta Today | today → today | Same ad account |

The `minCallDurationSeconds` difference between MTD and Today is intentional: the MTD window uses `0` to match the raw Ringba UI count, while the Today window uses `30` to filter out noise from very short calls.

Each fetch call is wrapped in `.catch()` — a failure in one source does not abort the stage. Missing sources result in `null` values in the output.

**P&L computation** is performed for both windows when both Ringba revenue and Meta spend are available:

```ts
interface ProfitLoss {
  revenue: number;   // Ringba totalRevenue
  adSpend: number;   // Meta totalSpend
  profit:  number;   // revenue - adSpend
  roi:     number;   // (profit / adSpend) * 100
  margin:  number;   // (profit / revenue) * 100
}
```

**Workspace snapshot:** After collection, the stage writes two files to `src/instances/<instanceId>/workspace/`:

- `WORKING.md` — formatted tables for Today and MTD metrics, plus a raw JSON dump. Overwritten on every run.
- `MEMORY.md` — append-only run history. One entry per run with date, call counts, revenue, spend, and P&L.

Output shape:
```ts
interface DataCollectionOutput {
  rawData:      Record<string, unknown>;  // all metrics as flat key-value pairs
  dataSource:   string;                  // "ringba+meta" | "ringba" | "manual" | "brief-json"
  collectedAt:  string;
  ringba?:      RingbaRevenueReport;     // MTD Ringba report
  meta?:        MetaSpendReport;         // MTD Meta report
  pl?:          ProfitLoss;              // MTD P&L
  ringbaToday?: RingbaRevenueReport;     // Today Ringba report
  metaToday?:   MetaSpendReport;         // Today Meta report
  plToday?:     ProfitLoss;             // Today P&L
}
```

---

### Stage 2: `analysis`

**File:** `stages/02-analysis.stage.ts`

Reads `DataCollectionOutput` from stage 1 via `requireStageOutput`. Loads the instance's `MISSION.md` and `soul.md` from `src/instances/<instanceId>/` to use as the Claude system prompt. This means alert thresholds, metric priorities, and analysis tone are all defined in the MC agent workspace, not in ElevarusOS templates.

Sends `rawData` to Claude and requests structured JSON:

Output shape:
```ts
interface AnalysisOutput {
  todayLabel: string;       // e.g. "Today — Apr 17"
  mtdLabel:   string;       // e.g. "Month to Date — Apr 1–17"
  today:      AnalysisPeriod;
  mtd:        AnalysisPeriod;
  keyTrends:  string[];     // 2–3 specific trends with numbers
  concerns:   string[];     // notable issues or anomalies
  alertLevel: "green" | "yellow" | "red";
}

interface AnalysisPeriod {
  calls:         string;
  billableCalls: string;
  billableRate:  string;
  revenue:       string;
  avgPayout?:    string;   // MTD only
  metaSpend?:    string;
  metaCPC?:      string;
  metaCTR?:      string;
  profit?:       string;
  roi?:          string;
  margin?:       string;   // MTD only
}
```

`alertLevel` thresholds are defined in the instance's `MISSION.md`. If `MISSION.md` is absent, Claude uses generic campaign analysis heuristics.

---

### Stage 3: `summary`

**File:** `stages/03-summary.stage.ts`

Reads `AnalysisOutput` from stage 2. Loads `MISSION.md` and `soul.md` from the instance workspace. Sends the analysis to Claude with a strict Slack message format template embedded in the user prompt.

**Slack message format (enforced in the prompt):**

```
<alert-emoji> *<Agent Name> — <MTD label>*


*<today label>*

• 📞 Calls: <N total>  |  ✅ Billable: <N> (<rate>%)
• 💰 Revenue: $<X,XXX.XX>
• 💸 Meta Spend: $<X,XXX.XX>
• 📊 P&L: <($X,XXX.XX) if loss or +$X,XXX.XX if gain>  |  ROI: <+/-><%>


*<MTD label>*

• 📞 Calls: <N total>  |  ✅ Billable: <N> (<rate>%)
• 💰 Revenue: $<X,XXX.XX>  |  Avg Payout: $<XX.XX>
• 💸 Meta Spend: $<X,XXX.XX>  |  CPC: $<X.XX>
• 📊 P&L: <($X,XXX.XX) if loss or +$X,XXX.XX if gain>  |  ROI: <+/-><%>  |  Margin: <%>


*Trends*

• <trend 1 — specific, with numbers>
• <trend 2 — specific, with numbers>
```

Formatting rules enforced in the prompt:
- Two blank lines (`\n\n`) between each section (after header, after Today block, after MTD block)
- Negative P&L uses parentheses: `($1,848.11)` — not a minus sign
- Positive P&L uses a plus sign: `+$1,234.56`
- No recommendations section — trends only
- Meta Spend and P&L lines are omitted only when that data is `null`
- All dollar amounts use comma-separated thousands

Output shape:
```ts
interface SummaryOutput {
  slackMessage:   string;                      // formatted Slack post (plain text with mrkdwn)
  markdownReport: string;                      // full report with ## headings and metric tables
  subject:        string;                      // e.g. "Final Expense Report — Apr 17 | MTD: ($1,848)"
  oneLiner:       string;                      // one-sentence MTD summary with key numbers
  alertLevel:     "green" | "yellow" | "red"; // passed through from analysis
}
```

The `alertLevel` determines the header emoji:
- `green` → ✅
- `yellow` → ⚠️
- `red` → 🚨

---

### Stage 4: `slack-publish`

**File:** `stages/04-slack-publish.stage.ts`

Reads `SummaryOutput` from stage 3. Resolves the target Slack channel from `instance.md` (`notify.slackChannel`).

**DRY_RUN mode:** If `DRY_RUN=true` is set in the environment, the stage prints the report to stdout and skips the Slack post. The stage still completes successfully and writes the workspace report.

**Posting:** Calls `postToSlack()` with Block Kit blocks built by `buildReportBlocks()`. The `text` field carries a plain-text fallback (`oneLiner + slackMessage`) for clients that do not render Block Kit.

**Workspace report:** On every run (including dry runs), the stage writes a dated report file:

```
src/instances/<instanceId>/workspace/reports/YYYY-MM-DD.md
```

Contents: publication timestamp, Slack channel, Slack message timestamp (for threading), alert level, the one-liner, the full Slack message, and the full markdown report.

**Skipping conditions** (stage still succeeds, no post sent):
- `DRY_RUN=true` — dry run mode
- `notify.slackChannel` not set in `instance.md` — warns and returns
- `SLACK_BOT_TOKEN` missing or invalid — `postToSlack()` returns `undefined`

Output shape:
```ts
interface SlackPublishOutput {
  published:   boolean;
  channel?:    string;   // Slack channel name or ID
  message:     string;   // the slackMessage string that was (or would have been) posted
  ts?:         string;   // Slack message timestamp — use for threading replies
  publishedAt: string;
}
```

---

## How to add a new reporting agent

Follow these steps to create a new reporting bot (for a new campaign or client) using the shared 4-stage reporting workflow pattern.

### Step 1: Create the instance directory

```bash
cp -r src/instances/_template src/instances/my-campaign-reporting
```

Edit `src/instances/my-campaign-reporting/instance.md`:

```yaml
---
id: my-campaign-reporting          # must match the directory name exactly
name: My Campaign Report Bot
baseWorkflow: ppc-campaign-report
enabled: true

brand:
  voice: "Clear, concise, numbers-first."
  audience: "Elevarus account managers reviewing My Campaign performance"
  tone: "Analytical and direct"
  industry: "Your industry here"

notify:
  approver: ~
  slackChannel: your-slack-channel-name   # Slack channel name or ID

ringba:
  campaignName: YOUR_RINGBA_CAMPAIGN_NAME   # must match exactly in Ringba
  reportPeriod: mtd                          # mtd | wtd | custom

meta:
  adAccountId: "your-meta-ad-account-id"
  campaignIds: []                            # empty = entire account; or list specific IDs

schedule:
  enabled: true
  cron: "0 9,17 * * 1-5"           # weekdays at 9am and 5pm UTC
  timezone: America/New_York         # optional; defaults to UTC
  description: Weekday campaign report twice daily
---
```

### Step 2: Add MISSION.md to the instance

Create `src/instances/my-campaign-reporting/MISSION.md`. This file is the Claude system prompt for the analysis and summary stages. Define:

- Alert thresholds (what P&L or ROI triggers `yellow` vs `red`)
- Which metrics to prioritize
- Tone and formatting preferences
- Any campaign-specific context

Example:
```markdown
You produce campaign performance reports for the My Campaign reporting bot.

## Alert thresholds
- green: ROI >= 20%
- yellow: ROI 0–20% or any concern flagged
- red: ROI negative, or spend exceeds budget by more than 10%

## Report priorities
Lead with P&L and ROI. Secondary: call volume and billable rate. Tertiary: Meta spend efficiency.

## Tone
Direct and analytical. No filler. Every sentence must contain a number.
```

### Step 3: Create the workflow builder

Create `src/workflows/my-campaign-reporting/my-campaign-reporting.workflow.ts`:

```ts
import { WorkflowDefinition } from "../../core/workflow-registry";
import { INotifyAdapter }     from "../../adapters/notify/notify.interface";
import { DataCollectionStage } from "../final-expense-reporting/stages/01-data-collection.stage";
import { AnalysisStage }       from "../final-expense-reporting/stages/02-analysis.stage";
import { SummaryStage }        from "../final-expense-reporting/stages/03-summary.stage";
import { SlackPublishStage }   from "../final-expense-reporting/stages/04-slack-publish.stage";

export function buildMyCampaignReportingWorkflow(
  _notifiers: INotifyAdapter[]
): WorkflowDefinition {
  return {
    type: "my-campaign-reporting",   // must match instance directory name
    stages: [
      new DataCollectionStage(),
      new AnalysisStage(),
      new SummaryStage(),
      new SlackPublishStage(),
    ],
  };
}
```

> The four reporting stages are generic — they read all campaign-specific configuration from `instance.md` and `MISSION.md` at runtime via `loadInstanceConfig(job.workflowType)`. You can reuse them directly unless you need custom data sources.

### Step 4: Register the workflow in `src/index.ts`

```ts
import { buildMyCampaignReportingWorkflow } from "./workflows/my-campaign-reporting/my-campaign-reporting.workflow";

// In main(), after the other registry.register() calls:
registry.register(buildMyCampaignReportingWorkflow(notifiers));
```

### Step 5: Verify environment variables

Confirm these are set in `.env` for the new integrations:

```
RINGBA_API_KEY=...
RINGBA_ACCOUNT_ID=...
META_ACCESS_TOKEN=...
SLACK_BOT_TOKEN=...
```

Invite the Slack bot to the target channel in Slack: `/invite @YourBotName`

### Step 6: Test with dry run

```bash
DRY_RUN=true npm run dev -- --once --bot my-campaign-reporting
```

This runs the full 4-stage workflow, prints the formatted report to stdout, and writes the workspace snapshot — without posting to Slack or requiring MC credentials.

### Step 7: Restart the daemon

```bash
npm run dev
```

ElevarusOS registers the new agent in MC on startup. The bot appears in the MC Task Board. The Scheduler picks up the cron configuration automatically.
