import { IStage } from "../../../core/stage.interface";
import { Job } from "../../../models/job.model";
import { logger } from "../../../core/logger";
import { getSupabaseClient, isSupabaseConfigured } from "../../../core/supabase-client";
import type {
  ThumbtackDailySession,
  ThumbtackSyncRunResult,
} from "../../../integrations/thumbtack";

/**
 * Stage 1 — Import Thumbtack sheet
 *
 * Reads the shared Thumbtack sheet ("daily sessions" tab) and upserts each
 * row into `thumbtack_daily_sessions` keyed on (source, day). A run-log
 * row is written to `thumbtack_sync_runs` for observability.
 *
 * The sheet is publicly accessible (Anyone with link → Viewer), so we hit
 * Google's gviz CSV-export endpoint directly — no auth, no Google API
 * library, no service-account creds. If permissions ever tighten, swap
 * `fetchSheetRows()` to use the Sheets API with credentials.
 *
 * Env vars:
 *   THUMBTACK_SHEET_ID    — Google Sheets file ID (required)
 *   THUMBTACK_SHEET_TAB   — Tab name (default 'daily sessions')
 */

export interface ImportThumbtackSheetOutput extends ThumbtackSyncRunResult {
  source:        string;
  rowsRead:      number;
  rowsUpserted:  number;
  status:        "ok" | "error";
  errorMessage?: string;
}

const SOURCE = "hvac";

export class ImportThumbtackSheetStage implements IStage {
  readonly stageName = "import-thumbtack-sheet";

  async run(job: Job): Promise<ImportThumbtackSheetOutput> {
    logger.info("Running import-thumbtack-sheet stage", { jobId: job.id });

    if (!isSupabaseConfigured()) {
      const msg = "Supabase not configured — set SUPABASE_URL + SUPABASE_SERVICE_KEY";
      logger.warn("import-thumbtack-sheet: skipping", { jobId: job.id, reason: msg });
      return { source: SOURCE, rowsRead: 0, rowsUpserted: 0, status: "error", errorMessage: msg };
    }

    const supabase = getSupabaseClient();
    const startedAt = new Date().toISOString();

    // Open a run-log row first so we can update status as we go
    const { data: runRow } = await supabase
      .from("thumbtack_sync_runs")
      .insert({ source: SOURCE, started_at: startedAt, status: "running" })
      .select("id")
      .single();
    const runId = runRow?.id as number | undefined;

    try {
      const rows = await fetchSheetRows();
      logger.info("import-thumbtack-sheet: rows fetched", { jobId: job.id, count: rows.length });

      let upserted = 0;
      if (rows.length > 0) {
        const payload = rows.map((r) => ({
          source:       SOURCE,
          day:          r.day,
          sessions:     r.sessions,
          owed_revenue: r.owedRevenue,
          raw:          r.raw ?? {},
          updated_at:   new Date().toISOString(),
        }));
        const { error, count } = await supabase
          .from("thumbtack_daily_sessions")
          .upsert(payload, { onConflict: "source,day", count: "exact" });
        if (error) throw new Error(`upsert failed: ${error.message}`);
        upserted = count ?? rows.length;
      }

      const finishedAt = new Date().toISOString();
      if (runId) {
        await supabase
          .from("thumbtack_sync_runs")
          .update({
            finished_at:   finishedAt,
            status:        "ok",
            rows_read:     rows.length,
            rows_upserted: upserted,
          })
          .eq("id", runId);
      }

      logger.info("import-thumbtack-sheet: complete", {
        jobId: job.id, rowsRead: rows.length, rowsUpserted: upserted,
      });

      return {
        source:       SOURCE,
        rowsRead:     rows.length,
        rowsUpserted: upserted,
        status:       "ok",
      };
    } catch (err) {
      const errorMessage = String(err);
      logger.error("import-thumbtack-sheet: failed", { jobId: job.id, error: errorMessage });
      if (runId) {
        await supabase
          .from("thumbtack_sync_runs")
          .update({
            finished_at:   new Date().toISOString(),
            status:        "error",
            error_message: errorMessage,
          })
          .eq("id", runId);
      }
      return {
        source:        SOURCE,
        rowsRead:      0,
        rowsUpserted:  0,
        status:        "error",
        errorMessage,
      };
    }
  }
}

// ─── Sheet fetch (public CSV export — no auth required) ──────────────────────

const DEFAULT_TAB = "daily sessions";

/** Column-name detector — case + whitespace insensitive substring match. */
function findColumnIndex(header: string[], wanted: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const target = norm(wanted);
  return header.findIndex((h) => norm(h) === target);
}

/** Best-effort fuzzy match — for column variants like "owed_revenue" / "SUM of owed_revenue". */
function findColumnIndexFuzzy(header: string[], substring: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const target = norm(substring);
  return header.findIndex((h) => norm(h).includes(target));
}

/** Parse a money cell ("$1,234.56", "-$625.98", "$0.00", "") to a number. NaN on failure. */
function parseMoney(cell: string): number {
  const cleaned = cell.replace(/[$,\s]/g, "");
  if (cleaned === "" || cleaned === "-") return 0;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

/** Parse an integer cell. NaN on failure. */
function parseInteger(cell: string): number {
  const cleaned = cell.replace(/[,\s]/g, "");
  if (cleaned === "") return 0;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Convert M/D/YYYY (Google Sheets default) to ISO YYYY-MM-DD.
 * Returns null if the cell isn't a recognizable date.
 */
function parseSheetDate(cell: string): string | null {
  const s = cell.trim();
  if (!s) return null;
  // M/D/YYYY or MM/DD/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mo, d, y] = m;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Already-ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Fallback: let Date parse it
  const dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) {
    const y = dt.getUTCFullYear();
    const mo = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }
  return null;
}

/**
 * Minimal RFC-4180 CSV parser — handles quoted fields with embedded commas
 * and "" -> " escape. The Google gviz CSV export quotes every field that
 * contains a comma (e.g. "$1,234.56"), so a naive split on comma would
 * mis-parse our data. This is enough for our shape — not a general parser.
 */
function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }   // escaped quote
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (ch === "\r") { /* skip — handle on \n */ }
      else { field += ch; }
    }
  }
  // Trailing field / row
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Read every row from the configured tab of the shared Thumbtack sheet.
 *
 * Hits Google's public gviz CSV-export endpoint:
 *   https://docs.google.com/spreadsheets/d/{id}/gviz/tq?tqx=out:csv&sheet={tab}
 *
 * The endpoint requires the sheet to be shared "Anyone with link → Viewer"
 * (or more permissive). Returns an empty array on configuration miss or
 * fetch failure — the calling stage logs and writes a `thumbtack_sync_runs`
 * row in either case.
 */
async function fetchSheetRows(): Promise<ThumbtackDailySession[]> {
  const sheetId = process.env.THUMBTACK_SHEET_ID ?? "";
  const tab     = process.env.THUMBTACK_SHEET_TAB ?? DEFAULT_TAB;

  if (!sheetId) {
    logger.warn("import-thumbtack-sheet: THUMBTACK_SHEET_ID not set — returning 0 rows");
    return [];
  }

  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
  let csvText: string;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      logger.warn("import-thumbtack-sheet: sheet fetch failed", { url, status: res.status });
      return [];
    }
    csvText = await res.text();
  } catch (err) {
    logger.warn("import-thumbtack-sheet: sheet fetch threw", { url, error: String(err) });
    return [];
  }

  const grid = parseCsv(csvText);
  if (grid.length < 2) {
    logger.warn("import-thumbtack-sheet: sheet has no rows", { rowCount: grid.length });
    return [];
  }

  const header = grid[0];
  const dayCol      = findColumnIndex(header, "day");
  const sessionsCol = findColumnIndexFuzzy(header, "sessions");
  const owedCol     = findColumnIndexFuzzy(header, "owedrevenue");

  if (dayCol < 0 || sessionsCol < 0 || owedCol < 0) {
    logger.warn("import-thumbtack-sheet: required columns not found", {
      header,
      dayCol, sessionsCol, owedCol,
      hint: "Sheet must have columns matching 'day', a sessions column, and an owed_revenue column.",
    });
    return [];
  }

  const rows: ThumbtackDailySession[] = [];
  let skipped = 0;
  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i];
    if (cells.every((c) => c === "")) continue;     // blank line
    const day = parseSheetDate(cells[dayCol] ?? "");
    if (!day) { skipped++; continue; }
    const sessions    = parseInteger(cells[sessionsCol] ?? "");
    const owedRevenue = parseMoney(cells[owedCol] ?? "");
    if (Number.isNaN(sessions) || Number.isNaN(owedRevenue)) { skipped++; continue; }

    // Preserve the full row in `raw` so future report columns are recoverable
    // without a re-import. Use header keys so the JSONB is self-describing.
    const raw: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (key) raw[key] = cells[c] ?? "";
    }

    rows.push({ day, sessions, owedRevenue, raw });
  }

  if (skipped > 0) {
    logger.info("import-thumbtack-sheet: skipped malformed rows", { skipped });
  }
  return rows;
}
