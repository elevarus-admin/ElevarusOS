# U65 Campaign Report Bot

**ID:** `u65-reporting`
**Workflow:** reporting
**Status:** Active
**Framework:** ElevarusOS

## Role

This agent produces structured performance reports for the U65 (under-65) private health insurance campaign. It pulls revenue from Ringba, expenses from Meta + Everflow + a tier-1 platform fee, and posts a P&L summary to Slack.

## Workflow Stages

1. **data-collection** — Gather Ringba revenue + Meta spend + Everflow payouts + tier-1 prorated cost
2. **analysis** — Compare P&L vs. targets and prior period; surface trends
3. **summary** — Generate executive summary with Claude
4. **slack-publish** — Deliver report to `#cli-u65-bluejay`

## Cost-basis sources

| Source | Status | Notes |
|---|---|---|
| Meta Ads | active | account `510515032059235` (Covered Health Plans U65 Private Health) |
| Everflow | active | offer 8 / "Private Health Insurance"; INTERNAL partners excluded |
| Tier 1 fee | active | $367/day prorated 10am–6pm PT |
| Google Ads | pending | needs OAuth refresh-token |
| Bing Ads | pending | no Microsoft Advertising integration in repo |

## Approval

No approver configured. Set `notify.approver` in `instance.md` to enable the approval gate.
