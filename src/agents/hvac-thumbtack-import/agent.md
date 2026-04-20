# HVAC Thumbtack Import Bot

**ID:** `hvac-thumbtack-import`
**Workflow:** import (single-stage)
**Status:** Active (sheet fetch stubbed)
**Framework:** ElevarusOS

## Role

Background data-import worker. Reads the shared Thumbtack sheet's `daily sessions` tab once a day and lands the rows in `thumbtack_daily_sessions` so `hvac-reporting` can read them via Supabase.

No Slack output. No Claude calls. One stage, one query, one upsert.

## Workflow Stages

1. **import-thumbtack-sheet** — fetch sheet rows → upsert (source, day) → write run-log row

## Schedule

Daily at 06:00 PT — early enough to land before the morning hvac-reporting cron at 09:00 EST.
