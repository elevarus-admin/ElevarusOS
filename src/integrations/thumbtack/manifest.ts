/**
 * Thumbtack integration manifest.
 *
 * Thumbtack revenue is delivered via a shared sheet that updates daily.
 * The `hvac-thumbtack-import` agent ingests that sheet into Supabase on
 * a daily cron; downstream reporting agents (e.g. hvac-reporting) read
 * via `supabase_query` against `thumbtack_daily_sessions`.
 *
 * No direct API client — read access lives in the import agent's stage.
 *
 * Status check: `THUMBTACK_SHEET_ID` must be set for the integration to
 * be considered configured. Google Sheets API auth (service account JSON
 * or OAuth) is also required — see the import agent's scaffold for the
 * specific env vars once the share format is confirmed.
 */

import type { IntegrationManifest } from "../../core/integration-registry";

export const manifest: IntegrationManifest = {
  id:          "thumbtack",
  name:        "Thumbtack",
  description: "Daily HVAC sessions + owed revenue from a shared Thumbtack sheet. Imported daily into Supabase by the hvac-thumbtack-import agent; consumed by hvac-reporting via supabase_query.",

  status: () =>
    process.env.THUMBTACK_SHEET_ID ? "configured" : "unconfigured",

  supabaseTables: [
    {
      name:        "thumbtack_daily_sessions",
      description: "One row per (source, day) from the shared Thumbtack sheet's 'daily sessions' tab. `source` is 'hvac' for the HVAC feed; default vertical for now. Upsert key is (source, day).",
      columns: {
        source:       "Logical feed name. Default 'hvac'. Allows multiple Thumbtack sheets later.",
        day:          { description: "Sheet row date.", type: "date" },
        sessions:     { description: "Daily Thumbtack session count.", type: "integer" },
        owed_revenue: { description: "Sum of 'owed revenue' column for the day, USD.", type: "numeric(12,2)" },
        raw:          { description: "Verbatim sheet row (JSONB). Heavy — exclude from SELECT unless you need a column not promoted above.", type: "jsonb" },
        imported_at:  { description: "When this row was first written by the import agent.", type: "timestamptz" },
        updated_at:   { description: "Last upsert (sheet edits land here).", type: "timestamptz" },
      },
    },
    {
      name:        "thumbtack_sync_runs",
      description: "Run log for the hvac-thumbtack-import agent. Useful for debugging sync lag.",
      columns: {
        id:            { description: "Surrogate primary key.", type: "bigserial" },
        source:        "Logical feed (matches thumbtack_daily_sessions.source).",
        started_at:    { description: "Run start.", type: "timestamptz" },
        finished_at:   { description: "Run finish (NULL while running).", type: "timestamptz" },
        status:        "running | ok | error",
        rows_read:     { description: "Sheet rows read.", type: "integer" },
        rows_upserted: { description: "Rows written to thumbtack_daily_sessions.", type: "integer" },
        error_message: "Error text if status='error'.",
        notes:         { description: "Free-form JSONB.", type: "jsonb" },
      },
    },
  ],

  // No live tools — workflows read via the generic supabase_query against
  // `thumbtack_daily_sessions`. Keeping this empty until a real query
  // pattern emerges that benefits from a wrapper.
  liveTools: [],

  features: [
    "Daily Thumbtack sessions and owed revenue",
    "Imported from a shared sheet by the hvac-thumbtack-import agent",
    "Supabase-backed — query via supabase_query against thumbtack_daily_sessions",
    "Run log + observability via thumbtack_sync_runs",
  ],

  systemPromptBlurb:
    "Thumbtack revenue lives in `thumbtack_daily_sessions` (one row per (source, day) — `source='hvac'` for the HVAC feed). For 'what was HVAC owed revenue MTD?' or 'sessions trend last week' use `supabase_query` with `table: 'thumbtack_daily_sessions'`, filter `source = 'hvac'`, and aggregate `sum(owed_revenue)` / `sum(sessions)` over the date range. Source data is a shared Google Sheet that updates daily; the import agent runs every morning, so today's row may not be present until the morning sync completes.",

  exampleQuestions: [
    "What was HVAC's owed revenue MTD on Thumbtack?",
    "Show daily Thumbtack sessions for HVAC last week.",
    "When did the Thumbtack import last run successfully?",
  ],
};
