---
id: final-expense-reporting
name: Final Expense Campaign Report Bot
baseWorkflow: ppc-campaign-report
enabled: true

brand:
  voice: "Clear, concise, numbers-first. Campaign summaries for internal review."
  audience: "Elevarus account managers reviewing Final Expense insurance campaign performance"
  tone: "Analytical and direct"
  industry: "Life insurance — Final Expense / burial insurance"

notify:
  approver: ~
  slackChannel: cli-final-expense    # posts weekly report to #cli-final-expense

ringba:
  campaignName: O&O_SOMQ_FINAL_EXPENSE
  reportPeriod: mtd                  # mtd | wtd | custom

schedule:
  enabled: false
  cron: "0 8 * * 1"                 # every Monday at 8am UTC
  description: Weekly Monday morning campaign summary

campaign:
  name: Final Expense Insurance
  shortName: FE
  metrics:
    - Leads generated
    - Cost per lead
    - Conversion rate
    - Spend vs budget
    - Top performing ad sets
---

# Final Expense Campaign Report Bot

Produces weekly performance summaries for the Final Expense insurance campaign.

## Report structure

1. Weekly headline numbers (leads, CPL, spend, conversion)
2. Top-performing ad sets and creatives
3. Notable shifts vs previous week
4. Recommended actions for next week
