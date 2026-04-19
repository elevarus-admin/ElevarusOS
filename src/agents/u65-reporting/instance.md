---
id: u65-reporting
name: U65 Campaign Report Bot
baseWorkflow: ppc-campaign-report
enabled: true

brand:
  voice: "Clear, concise, numbers-first. Campaign summaries for internal review. No fluff."
  audience: "Elevarus account managers and campaign leads reviewing U65 insurance campaign performance"
  tone: "Analytical and direct"
  industry: "Health insurance — Under-65 individual and family plans"

notify:
  approver: ~
  slackChannel: ~                    # TODO: set to U65 campaign Slack channel ID

schedule:
  enabled: false
  cron: "0 8 * * 1"                 # every Monday at 8am UTC
  description: Weekly Monday morning campaign summary

# ─── Campaign-specific config ─────────────────────────────────────────────────
# Passed into the reporting workflow as extra prompt context
campaign:
  name: Under-65 Health Insurance
  shortName: U65
  metrics:
    - Leads generated
    - Cost per lead
    - Conversion rate
    - Spend vs budget
    - Top performing ad sets
---

# U65 Campaign Report Bot

Produces weekly performance summaries for the Under-65 health insurance campaign.
Reports are structured for internal review and posted to the U65 Slack channel.

## Report structure

1. Weekly headline numbers (leads, CPL, spend, conversion)
2. Top-performing ad sets
3. Notable shifts vs previous week
4. Recommended actions for next week

## Data sources (TODO)

- Connect to ad platform API (Google Ads, Meta, etc.)
- Pull from CRM for lead quality data
- Add data source config to intake adapter
