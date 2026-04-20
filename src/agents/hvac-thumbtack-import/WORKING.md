# Working — HVAC Thumbtack Import Bot

Operational status log.

---

## Status

**SCAFFOLDED — sheet fetch is stubbed**

Last confirmed working: 2026-04-19 (created)

The pipeline (Supabase upsert + run logging) is fully implemented. `fetchSheetRows()` returns an empty array until:
1. Share format is confirmed (Google Sheet URL? CSV email? Thumbtack API export?)
2. `THUMBTACK_SHEET_ID` + `GOOGLE_SHEETS_CREDENTIALS_JSON` are added to `.env`
3. The function body is implemented to call the Sheets API

---

## Configuration

| Setting | Value |
|---------|-------|
| Schedule | Daily at 06:00 PT |
| Cron expression | `0 6 * * *` |
| Timezone | `America/Los_Angeles` |
| Base workflow | `hvac-thumbtack-import` |
| Slack channel | (none — silent worker) |
| Supabase target | `thumbtack_daily_sessions` (upsert), `thumbtack_sync_runs` (insert) |

---

## Change Log

| Date | Change |
|------|--------|
| 2026-04-19 | Agent + workflow + manifest + Supabase migration scaffolded. Sheet fetch stubbed pending share-format clarification. |
