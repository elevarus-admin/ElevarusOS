# HVAC Campaign Report Bot

**ID:** `hvac-reporting`
**Workflow:** reporting
**Status:** Active (revenue source pending)
**Framework:** ElevarusOS

## Role

Produces structured P&L reports for the HVAC lead-generation campaign. One Meta ad account on the expense side, Thumbtack on the revenue side.

## Workflow Stages

1. **data-collection** — Pull Meta spend + Thumbtack revenue (revenue source pending)
2. **analysis** — Compare P&L vs. targets and prior period
3. **summary** — Generate executive summary with Claude
4. **slack-publish** — Deliver report to `#cli-hvac`

## Data sources

| Source | Status | Notes |
|---|---|---|
| Meta Ads | active | account `24568971736103024` (SaveOnMyQuote.com. - HVAC) |
| Thumbtack revenue | **pending** | shared report, "daily sessions" tab, "owed revenue" column. Needs `hvac-thumbtack-report-import` agent to ingest into Supabase first. |

## Approval

No approver configured. Set `notify.approver` in `instance.md` to enable the approval gate.
