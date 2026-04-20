---
id: u65-reporting
name: U65 Campaign Report Bot
baseWorkflow: ppc-campaign-report
enabled: true

brand:
  voice: "Clear, concise, numbers-first. Campaign summaries for internal review."
  audience: "Elevarus account managers reviewing U65 (under-65) private health insurance campaign performance"
  tone: "Analytical and direct"
  industry: "Under-65 private health insurance"

notify:
  approver: ~
  slackChannel: cli-u65-bluejay

# REVENUE — Ringba campaign feeding U65 (TODO: confirm exact campaign name)
# ringba:
#   campaignName: <U65 Ringba campaign name>
#   reportPeriod: mtd

# EXPENSES — multiple cost sources, summed in the analysis stage:
#   meta + everflow + tier1Cost + (later) googleAds + bingAds

meta:
  adAccountId: "510515032059235"     # Covered Health Plans U65 Private Health (Mindstate Management LLC)
  campaignIds: []                    # empty = entire account spend

everflow:
  offerId: 8                         # "Private Health Insurance" — verified live 2026-04-19
  excludePartnerPatterns:
    - INTERNAL                       # drops _Internal U65 CHP META, _INTERNAL U65 Google, INTERNAL Covered Health Plans Bing

tier1Cost:
  dailyAmount: 367                   # USD per business day
  businessHoursStart: 10             # 10:00 PT
  businessHoursEnd: 18               # 18:00 PT (6:00 PM)
  timezone: America/Los_Angeles

# googleAds:                         # PENDING — needs OAuth refresh-token (see docs/prd-google-ads-integration.md)
#   customerId: "6475741945"         # 647-574-1945 with hyphens stripped
#
# bingAds:                           # PENDING — no Microsoft Advertising integration in repo yet
#   accountId: "150502647"
#   accountNumber: "F119KGNK"

schedule:
  enabled: true
  cron: "0 9,11,13,15,17 * * 1-5"  # Mon-Fri every 2h: 9am, 11am, 1pm, 3pm, 5pm EST
  timezone: America/New_York
  description: Weekday campaign report every 2 hours 9am-5pm EST

campaign:
  name: U65 Private Health Insurance
  shortName: U65
  metrics:
    - Leads generated
    - Cost per lead (CPL = expenses / leads)
    - Conversion rate
    - Revenue (Ringba)
    - Expenses (meta + everflow payouts + tier1 prorated + future google/bing)
    - P&L and ROI
    - Top performing ad sets
---

# U65 Campaign Report Bot

Produces performance summaries for the U65 (under-65 private health insurance) campaign.

## Cost basis

P&L on this campaign sums multiple expense sources, not just Meta:

1. **Meta** ad spend — `meta.adAccountId`
2. **Everflow** partner payouts on offer 8, excluding `INTERNAL` test partners
3. **Tier 1** flat fee — $367/business day, prorated 10am–6pm PT
4. **Google Ads** (pending — OAuth not configured)
5. **Bing Ads** (pending — no integration yet)

The data-collection stage should sum what's available and label the rest as "data unavailable" so reports remain honest.

## Slack channel

Reports post to `#cli-u65-bluejay`.
