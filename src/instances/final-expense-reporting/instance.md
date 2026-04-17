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

meta:
  adAccountId: "999576488367816"     # Final Expense Meta ad account
  campaignIds: []                    # empty = entire account spend

schedule:
  enabled: true
  cron: "0 9,11,13,15,17 * * 1-5"  # Mon-Fri every 2h: 9am, 11am, 1pm, 3pm, 5pm EST
  timezone: America/New_York
  description: Weekday campaign report every 2 hours 9am-5pm EST

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
