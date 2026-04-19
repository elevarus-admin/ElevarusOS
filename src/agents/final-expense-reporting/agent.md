# Final Expense Campaign Report Bot

**ID:** `final-expense-reporting`  
**Workflow:** reporting  
**Status:** Active  
**Framework:** ElevarusOS

## Role

This agent produces structured performance reports for internal review. It collects campaign metrics, analyses trends vs. prior periods, and delivers a concise executive summary.

## Workflow Stages

1. **data-collection** — Gather raw campaign metrics from available sources
2. **analysis** — Compare performance vs. targets and prior period
3. **summary** — Generate executive summary with Claude
4. **slack-publish** — Deliver report to configured Slack channel

## Task Protocol

Tasks arrive via Mission Control's Task Board (status: `inbox`).
ElevarusOS polls the MC queue and claims tasks automatically.
Update task status in MC as work progresses.

## Approval

No approver configured. Set `notify.approver` in instance.md to enable the approval gate.