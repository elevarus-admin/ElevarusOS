---
id: hvac-reporting
name: HVAC Campaign Report Bot
baseWorkflow: ppc-campaign-report
enabled: true

brand:
  voice: "Clear, concise, numbers-first. Campaign summaries for internal review."
  audience: "Elevarus account managers reviewing HVAC lead-gen campaign performance"
  tone: "Analytical and direct"
  industry: "Home services — HVAC (heating, ventilation, air conditioning)"

notify:
  approver: ~
  slackChannel: cli-hvac     # TODO: confirm or rename — Shane to specify

# REVENUE — Thumbtack (NOT Ringba)
# HVAC revenue comes from a shared Thumbtack report ("daily sessions" tab,
# sum of "owed revenue" column, sheet updated daily). The proposed
# `hvac-thumbtack-report-import` agent will ingest that sheet into Supabase
# and this agent will read from there. Open question: what's the share
# format? (Google Sheet? CSV email? Thumbtack API?) — once known, build
# the import agent and add a `thumbtack:` block here.
#
# thumbtack:
#   sheetId: <Google Sheet ID once known>
#   tabName: "daily sessions"
#   revenueColumn: "owed revenue"

# EXPENSES — single Meta ad account
meta:
  adAccountId: "24568971736103024"   # SaveOnMyQuote.com. - HVAC (verified visible to token 2026-04-19)
  campaignIds: []                    # empty = entire account spend

schedule:
  enabled: true
  cron: "0 9 * * 1-5"              # Once daily, Mon-Fri at 9am EST
  timezone: America/New_York
  description: Weekday campaign report, once daily at 9am EST (reports yesterday + MTD; Thumbtack sheet updates overnight)

campaign:
  name: HVAC Lead Generation
  shortName: HVAC
  metrics:
    - Sessions (Thumbtack)
    - Owed revenue (Thumbtack daily sessions)
    - Meta ad spend
    - P&L and ROI
    - Top performing ad sets
---

# HVAC Campaign Report Bot

Produces performance summaries for the HVAC lead-generation campaign.

## Cost basis

P&L for HVAC is simpler than U65: one ad account on Meta, revenue from a single Thumbtack report.

## Revenue source

Thumbtack does not (yet) feed via API. The current data source is a **shared report** updated daily — "daily sessions" tab, sum of the "owed revenue" column.

Until the `hvac-thumbtack-report-import` agent is built, this workflow's revenue numbers will be missing. The data-collection stage should report `revenue: data unavailable` rather than zero-fill.

## Slack channel

Reports post to `#cli-hvac` (subject to confirmation — placeholder).
