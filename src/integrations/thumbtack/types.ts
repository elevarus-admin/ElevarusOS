// ─── Thumbtack Integration Types ─────────────────────────────────────────────
//
// Source of truth: a shared Google Sheet that Thumbtack updates daily.
// The hvac-thumbtack-import agent reads it on a daily cron and upserts
// rows into Supabase (`thumbtack_daily_sessions`).

/** One row from the "daily sessions" tab of the shared sheet. */
export interface ThumbtackDailySession {
  /** ISO YYYY-MM-DD. */
  day:          string;
  /** Total Thumbtack session count for the day. */
  sessions:     number;
  /** Sum of the "owed revenue" column for the day (USD). */
  owedRevenue:  number;
  /** Verbatim sheet row, preserved for forensic / late-binding columns. */
  raw?:         Record<string, unknown>;
}

/** Result row written to `thumbtack_sync_runs` by the import agent. */
export interface ThumbtackSyncRunResult {
  source:        string;
  rowsRead:      number;
  rowsUpserted:  number;
  status:        "ok" | "error";
  errorMessage?: string;
}
