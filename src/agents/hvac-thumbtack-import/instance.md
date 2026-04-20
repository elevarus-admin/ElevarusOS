---
id: hvac-thumbtack-import
name: HVAC Thumbtack Import Bot
baseWorkflow: hvac-thumbtack-import
enabled: true

brand:
  voice: "Silent worker. Logs only — no Slack output."
  audience: "ElevarusOS internals — feeds hvac-reporting"
  tone: "n/a (no human-facing output)"
  industry: "Internal data ingestion"

notify:
  approver: ~
  slackChannel: ~     # no Slack output — this is a data-import worker

schedule:
  enabled: true
  cron: "0 6 * * *"             # Daily at 06:00 PT — early enough to land before
                                # morning hvac-reporting runs at 09:00 EST.
  timezone: America/Los_Angeles
  description: Daily Thumbtack sheet import at 06:00 PT
---

# HVAC Thumbtack Import Bot

A daily worker that ingests the shared Thumbtack sheet (`daily sessions` tab)
into Supabase (`thumbtack_daily_sessions`). Upstream of the `hvac-reporting`
bot, which reads the resulting rows for its P&L report.

## What it does

1. Read every row of the shared sheet's `daily sessions` tab
2. Parse `date`, `sessions`, `owed_revenue` columns
3. Upsert into `thumbtack_daily_sessions` keyed on `(source, day)` — re-imports
   safely overwrite
4. Append a row to `thumbtack_sync_runs` with row counts + status

No Slack output. Failures land in the run log + ElevarusOS logs.

## Pending wiring

The sheet read is stubbed pending:
- Confirmation of share format (Google Sheet URL, CSV email, …)
- `THUMBTACK_SHEET_ID` + auth credentials in `.env`
- Real implementation of `fetchSheetRows()` in
  `src/workflows/hvac-thumbtack-import/stages/01-import-thumbtack-sheet.stage.ts`
