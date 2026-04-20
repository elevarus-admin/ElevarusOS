# Tools — HVAC Thumbtack Import Bot

This is a stage-code worker, not an agentic Claude bot. The "tools" here are
the libraries the stage uses.

---

## Stage code

`src/workflows/hvac-thumbtack-import/stages/01-import-thumbtack-sheet.stage.ts`

## Supabase tables written

| Table | Operation | Key |
|-------|-----------|-----|
| `thumbtack_daily_sessions` | upsert | `(source, day)` |
| `thumbtack_sync_runs`      | insert + update | surrogate `id` |

## Environment (pending)

| Var | Required | Description |
|-----|----------|-------------|
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | yes | Already configured |
| `THUMBTACK_SHEET_ID` | **pending** | Google Sheets file ID |
| `THUMBTACK_SHEET_TAB` | optional | Tab name (default `'daily sessions'`) |
| `GOOGLE_SHEETS_CREDENTIALS_JSON` | **pending** | Service-account JSON, single-line. Sheet must be shared to the service account email as Viewer. |
