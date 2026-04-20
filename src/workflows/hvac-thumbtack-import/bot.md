---
type: import
name: HVAC Thumbtack Import Bot
version: 1.0.0
description: Daily import of the shared Thumbtack sheet into Supabase (thumbtack_daily_sessions). Single stage, no Claude. Consumed by hvac-reporting.
author: Elevarus

stages:
  - name: import-thumbtack-sheet
    label: Import Thumbtack Sheet
    description: Read sheet → parse rows → upsert (source, day) → write run-log row
    aiPowered: false

config: {}
---

# hvac-thumbtack-import — Bot Manifest

Daily import of the shared Thumbtack sheet (`daily sessions` tab) into Supabase
(`thumbtack_daily_sessions`). Upstream of `hvac-reporting`, which reads the
resulting Supabase rows for its P&L report.

## Stages

1. `import-thumbtack-sheet` — read sheet → upsert (source, day) → log run

## Status

PENDING — the sheet read is stubbed. Wire `THUMBTACK_SHEET_ID` and Google
Sheets API credentials, then implement `fetchSheetRows()` in
`stages/01-import-thumbtack-sheet.stage.ts`.
