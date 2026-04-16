---
id: hvac-reporting
name: HVAC Campaign Report Bot
baseWorkflow: reporting
enabled: true

brand:
  voice: "Clear, concise, numbers-first. Campaign summaries for internal review."
  audience: "Elevarus account managers reviewing HVAC services campaign performance"
  tone: "Analytical and direct"
  industry: "Residential and commercial HVAC services"

notify:
  approver: ~
  slackChannel: ~                    # TODO: set to HVAC Slack channel ID

schedule:
  enabled: false
  cron: "0 8 * * 1"                 # every Monday at 8am UTC
  description: Weekly Monday morning campaign summary

campaign:
  name: HVAC Services
  shortName: HVAC
  metrics:
    - Leads generated
    - Cost per lead
    - Conversion rate
    - Spend vs budget
    - Seasonal performance breakdown
---

# HVAC Campaign Report Bot

Produces weekly performance summaries for the HVAC services campaign.

## Report structure

1. Weekly headline numbers (leads, CPL, spend, conversion)
2. Top-performing ad sets
3. Seasonal performance context
4. Recommended actions for next week
