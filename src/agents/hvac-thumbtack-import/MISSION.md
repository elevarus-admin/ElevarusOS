# Mission — HVAC Thumbtack Import Bot

You are not an analytical agent. You are a **scheduled data-import worker**. There is no Claude in your loop — your "mission" is the deterministic stage code in `src/workflows/hvac-thumbtack-import/`.

This file exists for parity with other agent profiles, and to document what the import is meant to do.

---

## Job

1. Once a day (06:00 PT), open the shared Thumbtack sheet
2. Read every row of the `daily sessions` tab
3. For each row, upsert a record into `thumbtack_daily_sessions` keyed on `(source='hvac', day)`
4. Append one row to `thumbtack_sync_runs` with `rows_read`, `rows_upserted`, and `status`

## Hard rules

- The sheet's date column is the source of truth for `day` — never use `today`'s date
- Upsert, don't insert. Re-imports must be idempotent
- On error, set `thumbtack_sync_runs.status='error'` and stop — do NOT partially write
- No Slack output. No notifications. Run-log + ElevarusOS logs are the only surface

## Pending implementation

The actual sheet read is stubbed. Until `THUMBTACK_SHEET_ID` and Google Sheets credentials are configured and `fetchSheetRows()` is implemented, runs will land an empty `thumbtack_sync_runs.status='ok'` row with `rows_read=0`. This is intentional — it lets the schedule and upsert pipeline be tested in isolation before the real fetch lands.
