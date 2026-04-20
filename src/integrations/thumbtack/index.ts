/**
 * Thumbtack Integration
 *
 * Daily Thumbtack sessions + owed revenue for HVAC, sourced from a shared
 * Google Sheet. The hvac-thumbtack-import agent ingests the sheet into
 * Supabase on a daily cron; downstream reporting reads via supabase_query
 * against `thumbtack_daily_sessions`.
 *
 * No live HTTP client — all reads go through Supabase. The actual sheet
 * fetch lives in src/workflows/hvac-thumbtack-import/stages/.
 *
 * Env vars (set on the import agent's stage, not here):
 *   THUMBTACK_SHEET_ID            — Google Sheets file ID
 *   THUMBTACK_SHEET_TAB           — tab/worksheet name (default 'daily sessions')
 *   GOOGLE_SHEETS_CREDENTIALS_JSON — service-account creds (or per-method auth)
 */

export type {
  ThumbtackDailySession,
  ThumbtackSyncRunResult,
} from "./types";
