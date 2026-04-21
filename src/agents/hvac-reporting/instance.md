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
  slackChannel: cli-hvac

# REVENUE — combined from two sources
#
# 1) Thumbtack — sessions + owed_revenue from the shared "daily sessions" sheet,
#    imported nightly by the `hvac-thumbtack-import` agent into the Supabase
#    table `thumbtack_daily_sessions` (source='hvac'). The data-collection stage
#    reads directly from that table for the yesterday + MTD windows.
#
# 2) Ringba — call revenue for the HVAC campaign. The data-collection stage
#    calls `getCampaignRevenue` with the name below.
ringba:
  campaignName: O&O_HVAC_SAVEONMYQUOTE.COM
  reportPeriod: mtd

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
    - Ringba campaign revenue (when configured)
    - Meta ad spend
    - P&L and ROI
---

# HVAC Campaign Report Bot

Produces daily P&L summaries for the HVAC lead-generation campaign.

## Cost basis

Single Meta ad account funds the campaign. Revenue comes from two sources
(Thumbtack sessions + Ringba calls); P&L = (Thumbtack owed + Ringba revenue) − Meta spend.

## Revenue sources

- **Thumbtack** — read from Supabase `thumbtack_daily_sessions` (populated nightly
  by the `hvac-thumbtack-import` agent). Column `owed_revenue` summed across the
  window. This is the bulk of HVAC revenue.
- **Ringba** — configured via the `ringba.campaignName` frontmatter block above.
  Adds call-driven revenue for the same campaign. Optional: if the block is
  omitted, the report runs Thumbtack-only.

If either source is unavailable for the window, the missing source contributes
`$0` and the run continues with whatever data is present. The data-collection
stage never zero-fills the *combined* revenue — if both sources fail, the
Slack line emits `📊 data unavailable`.

## Slack channel

Reports post to `#cli-hvac`.
