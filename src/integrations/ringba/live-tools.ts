/**
 * Ringba live-API tools contributed to the Ask Elevarus bot via the manifest.
 *
 * These tools hit the Ringba REST API directly (not the Supabase mirror) —
 * use them when Supabase is missing a field, when the user explicitly asks
 * for fresh data, or when the sync worker is behind.
 */

import { RingbaHttpClient } from "./client";
import { auditQueryTool }   from "../../core/audit-log";
import { getSupabaseClient } from "../../core/supabase-client";
import { logger }           from "../../core/logger";
import type { QATool }      from "../../core/qa-tools";

const DEFAULT_ROW_CAP = 2000;
const HARD_ROW_CEILING = 10_000;

interface RingbaLiveQueryInput {
  startDate:  string;
  endDate:    string;
  campaigns?: string[];
  publishers?: string[];
  buyers?:    string[];
  targets?:   string[];
  onlyPaid?:  boolean;
  excludeDuplicates?: boolean;
  minCallDurationSeconds?: number;
  select?:    string[];
  limit?:     number;
}

/**
 * Fields in the raw RingbaCallRecord that we expose. When `select` is omitted
 * we return this compact subset. Claude can ask for more with explicit select.
 */
const DEFAULT_SELECT = [
  "inboundCallId",
  "campaignName",
  "publisherName",
  "buyer",
  "callDt",
  "callLengthInSeconds",
  "hasPayout",
  "hasConnected",
  "isDuplicate",
  "conversionAmount",
  "payoutAmount",
] as const;

export const ringbaLiveQueryTool: QATool = {
  spec: {
    name: "ringba_live_query",
    description:
      "Query the Ringba REST API directly (bypassing the 15-minute Supabase sync) when you need fresh data, a field not in ringba_calls, or calls from the last few minutes. Accepts a date range plus optional filters on campaigns[], publishers[], buyers[], targets[]. Prefer supabase_query for historical / aggregate queries — only reach for this when Supabase doesn't have what you need.",
    input_schema: {
      type: "object",
      properties: {
        startDate:  { type: "string", description: "YYYY-MM-DD (inclusive)." },
        endDate:    { type: "string", description: "YYYY-MM-DD (inclusive)." },
        campaigns:  { type: "array", items: { type: "string" }, description: "Optional list of Ringba campaign names." },
        publishers: { type: "array", items: { type: "string" }, description: "Optional list of publisher_name values to include (case-insensitive)." },
        buyers:     { type: "array", items: { type: "string" }, description: "Optional list of buyer names to include." },
        targets:    { type: "array", items: { type: "string" }, description: "Optional list of Ringba target names to include." },
        onlyPaid:           { type: "boolean", description: "If true, return only calls where hasPayout=true AND isDuplicate=false." },
        excludeDuplicates:  { type: "boolean", description: "If true (default), drop isDuplicate=true calls." },
        minCallDurationSeconds: { type: "integer", description: "Drop calls shorter than this. 0 = keep all (default)." },
        select:     {
          type: "array",
          items: { type: "string" },
          description: `Fields to return. Defaults to a compact subset: ${DEFAULT_SELECT.join(", ")}.`,
        },
        limit: {
          type: "integer",
          description: `Max records. Default ${DEFAULT_ROW_CAP}, hard ceiling ${HARD_ROW_CEILING}.`,
        },
      },
      required: ["startDate", "endDate"],
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params    = (input ?? {}) as RingbaLiveQueryInput;

    try {
      if (!params.startDate || !params.endDate) {
        throw new Error("startDate and endDate are required.");
      }

      const client = new RingbaHttpClient();
      if (!client.enabled) {
        throw new Error("Ringba not configured — RINGBA_API_KEY + RINGBA_ACCOUNT_ID required.");
      }

      const limit = Math.min(params.limit ?? DEFAULT_ROW_CAP, HARD_ROW_CEILING);
      const excludeDuplicates = params.excludeDuplicates ?? true;
      const minDuration       = params.minCallDurationSeconds ?? 0;
      const select            = params.select && params.select.length > 0
        ? params.select
        : [...DEFAULT_SELECT];

      // If a single campaign name is provided we can push the filter server-side.
      // For multiple, we fetch the union (single API call per name) and merge.
      const campaignNames = params.campaigns ?? [];
      const fetches = campaignNames.length > 0
        ? campaignNames.map((name) => client.fetchCallLogs({
            startDate: params.startDate,
            endDate:   params.endDate,
            campaignName: name,
          }))
        : [client.fetchCallLogs({ startDate: params.startDate, endDate: params.endDate })];

      const pages = await Promise.all(fetches);
      let calls = pages.flat();

      // Client-side filters
      const publishersLower = params.publishers?.map((p) => p.toLowerCase());
      const buyersLower     = params.buyers?.map((b) => b.toLowerCase());
      const targetsLower    = params.targets?.map((t) => t.toLowerCase());

      calls = calls.filter((c) => {
        if (excludeDuplicates && c.isDuplicate) return false;
        if (params.onlyPaid && (!c.hasPayout || c.isDuplicate)) return false;
        if ((c.callLengthInSeconds ?? 0) < minDuration) return false;
        if (publishersLower && !publishersLower.includes((c.publisherName ?? "").toLowerCase())) return false;
        if (buyersLower     && !buyersLower.includes((c.buyer ?? "").toLowerCase()))             return false;
        if (targetsLower    && !targetsLower.includes((c.targetName ?? "").toLowerCase()))       return false;
        return true;
      });

      const totalAvailable = calls.length;
      const truncated      = totalAvailable > limit;
      const windowed       = truncated ? calls.slice(0, limit) : calls;

      const rows = windowed.map((c) => {
        const row: Record<string, unknown> = {};
        for (const k of select) {
          // Light normalization — callDt is a number (ms); surface ISO too for readability.
          if (k === "callDt" && typeof c.callDt === "number") {
            row.callDt    = c.callDt;
            row.callDtIso = new Date(c.callDt).toISOString();
          } else {
            row[k] = (c as unknown as Record<string, unknown>)[k];
          }
        }
        return row;
      });

      const elapsed_ms = Date.now() - startedAt;

      await auditQueryTool(ctx, {
        tool_name:       "ringba_live_query",
        params,
        status:          truncated ? "capped" : "ok",
        row_count:       rows.length,
        total_available: totalAvailable,
        elapsed_ms,
      });

      return {
        rows,
        row_count:       rows.length,
        total_available: totalAvailable,
        truncated,
        elapsed_ms,
        columns:         select,
        ...(truncated
          ? { expand_hint: `Live query matched ${totalAvailable} calls; showing first ${limit}. Ask user to narrow the filter or re-run with higher limit (ceiling ${HARD_ROW_CEILING}).` }
          : {}),
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("ringba_live_query failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name:     "ringba_live_query",
        params,
        status:        "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

// ─── ringba_tag_rollup (RPC-backed) ───────────────────────────────────────────

interface TagRollupInput {
  tagKey:             string;
  startDate:          string;    // ISO or YYYY-MM-DD
  endDate:            string;    // ISO or YYYY-MM-DD
  campaigns?:         string[];
  publishers?:        string[];
  buyers?:            string[];
  onlyPaid?:          boolean;
  excludeDuplicates?: boolean;
  includeEmpty?:      boolean;
  limit?:             number;
}

const MAX_ROLLUP_ROWS = 10_000;

function normaliseDate(s: string, endOfDay = false): string {
  // YYYY-MM-DD → ISO at 00:00Z / 23:59:59Z; otherwise assume caller passed ISO.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return endOfDay ? `${s}T23:59:59Z` : `${s}T00:00:00Z`;
  }
  return s;
}

export const ringbaTagRollupTool: QATool = {
  spec: {
    name: "ringba_tag_rollup",
    description:
      "Aggregate Ringba calls by a tag value (e.g. User:utm_campaign, User:utm_content, Publisher:Name, Geo:SubDivisionCode). Returns one row per distinct tag value with call_count, paid_calls (has_payout AND NOT is_duplicate), revenue (sum of payout_amount on paid calls), total_payout (sum of all payout_amount), and RPC (revenue per paid call). Server-side aggregation via the ringba_tag_rollup Postgres RPC — fast even over millions of rows. This is the right tool for 'revenue by utm_campaign', 'top utm_content', 'RPC by publisher' questions. Call list_ringba_tags first to see which tag keys are actually populated.",
    input_schema: {
      type: "object",
      properties: {
        tagKey:     { type: "string", description: "Tag path in the form 'TagType:TagName'. e.g. 'User:utm_campaign', 'Publisher:Name', 'Geo:SubDivisionCode'." },
        startDate:  { type: "string", description: "YYYY-MM-DD or ISO timestamp (inclusive)." },
        endDate:    { type: "string", description: "YYYY-MM-DD or ISO timestamp (inclusive; treated as 23:59:59Z for date-only)." },
        campaigns:  { type: "array", items: { type: "string" }, description: "Optional campaign_name filter (exact match, case-sensitive)." },
        publishers: { type: "array", items: { type: "string" }, description: "Optional publisher_name filter (exact match, case-sensitive)." },
        buyers:     { type: "array", items: { type: "string" }, description: "Optional winning_buyer filter (exact match, case-sensitive)." },
        onlyPaid:   { type: "boolean", description: "If true, restrict to has_payout=true AND is_duplicate=false. Default false — keeps all qualifying calls and differentiates via paid_calls column." },
        excludeDuplicates: { type: "boolean", description: "If true (default), drop is_duplicate=true rows entirely. Recommended for most reports." },
        includeEmpty: { type: "boolean", description: "If true, include rows where the tag key is missing (bucketed as '(missing)'). Default false — missing-key rows are dropped." },
        limit:      { type: "integer", description: `Max tag values returned. Default 1000, ceiling ${MAX_ROLLUP_ROWS}.` },
      },
      required: ["tagKey", "startDate", "endDate"],
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params    = (input ?? {}) as TagRollupInput;

    try {
      if (!params.tagKey || !params.startDate || !params.endDate) {
        throw new Error("tagKey, startDate, endDate are all required.");
      }

      const supabase = getSupabaseClient();
      const limit = Math.min(params.limit ?? 1000, MAX_ROLLUP_ROWS);

      const { data, error } = await supabase.rpc("ringba_tag_rollup", {
        p_tag_key:            params.tagKey,
        p_start_date:         normaliseDate(params.startDate, false),
        p_end_date:           normaliseDate(params.endDate, true),
        p_campaigns:          params.campaigns  ?? null,
        p_publishers:         params.publishers ?? null,
        p_buyers:             params.buyers     ?? null,
        p_only_paid:          params.onlyPaid   ?? false,
        p_exclude_duplicates: params.excludeDuplicates ?? true,
        p_include_empty:      params.includeEmpty     ?? false,
        p_limit:              limit,
      });
      if (error) throw new Error(error.message);

      const rows = (data ?? []) as Array<{
        tag_value:    string;
        call_count:   number;
        paid_calls:   number;
        revenue:      string | number;
        total_payout: string | number;
        rpc:          string | number;
      }>;
      const elapsed_ms = Date.now() - startedAt;

      await auditQueryTool(ctx, {
        tool_name:  "ringba_tag_rollup",
        params,
        status:     "ok",
        row_count:  rows.length,
        elapsed_ms,
      });

      return {
        tag_key:    params.tagKey,
        range:      { start: normaliseDate(params.startDate, false), end: normaliseDate(params.endDate, true) },
        rows,
        row_count:  rows.length,
        elapsed_ms,
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("ringba_tag_rollup failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name:     "ringba_tag_rollup",
        params,
        status:        "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

// ─── ringba_tag_timeseries (RPC-backed) ───────────────────────────────────────

interface TagTimeseriesInput extends TagRollupInput {
  bucket?: "hour" | "day" | "week" | "month";
}

export const ringbaTagTimeseriesTool: QATool = {
  spec: {
    name: "ringba_tag_timeseries",
    description:
      "Same aggregation as ringba_tag_rollup, but bucketed by time — returns one row per (bucket_start, tag_value). Good for trend questions: 'utm_campaign revenue per day this week', 'Publisher:Name paid-call volume by hour today'. Default bucket is 'day'; supports 'hour' | 'day' | 'week' | 'month'.",
    input_schema: {
      type: "object",
      properties: {
        tagKey:     { type: "string", description: "Tag path 'TagType:TagName'." },
        startDate:  { type: "string", description: "YYYY-MM-DD or ISO." },
        endDate:    { type: "string", description: "YYYY-MM-DD or ISO." },
        bucket:     { type: "string", description: "Time bucket: hour | day | week | month. Default 'day'." },
        campaigns:  { type: "array", items: { type: "string" } },
        publishers: { type: "array", items: { type: "string" } },
        buyers:     { type: "array", items: { type: "string" } },
        onlyPaid:           { type: "boolean" },
        excludeDuplicates:  { type: "boolean" },
        includeEmpty:       { type: "boolean" },
        limit:              { type: "integer", description: `Max rows (bucket × tag_value). Default 5000, ceiling ${MAX_ROLLUP_ROWS}.` },
      },
      required: ["tagKey", "startDate", "endDate"],
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params    = (input ?? {}) as TagTimeseriesInput;

    try {
      if (!params.tagKey || !params.startDate || !params.endDate) {
        throw new Error("tagKey, startDate, endDate are all required.");
      }

      const supabase = getSupabaseClient();
      const limit = Math.min(params.limit ?? 5000, MAX_ROLLUP_ROWS);

      const { data, error } = await supabase.rpc("ringba_tag_timeseries", {
        p_tag_key:            params.tagKey,
        p_start_date:         normaliseDate(params.startDate, false),
        p_end_date:           normaliseDate(params.endDate, true),
        p_bucket:             params.bucket ?? "day",
        p_campaigns:          params.campaigns  ?? null,
        p_publishers:         params.publishers ?? null,
        p_buyers:             params.buyers     ?? null,
        p_only_paid:          params.onlyPaid   ?? false,
        p_exclude_duplicates: params.excludeDuplicates ?? true,
        p_include_empty:      params.includeEmpty     ?? false,
        p_limit:              limit,
      });
      if (error) throw new Error(error.message);

      const rows = (data ?? []) as Array<{
        bucket_start: string;
        tag_value:    string;
        call_count:   number;
        paid_calls:   number;
        revenue:      string | number;
        total_payout: string | number;
        rpc:          string | number;
      }>;
      const elapsed_ms = Date.now() - startedAt;

      await auditQueryTool(ctx, {
        tool_name:  "ringba_tag_timeseries",
        params,
        status:     "ok",
        row_count:  rows.length,
        elapsed_ms,
      });

      return {
        tag_key:    params.tagKey,
        bucket:     params.bucket ?? "day",
        range:      { start: normaliseDate(params.startDate, false), end: normaliseDate(params.endDate, true) },
        rows,
        row_count:  rows.length,
        elapsed_ms,
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("ringba_tag_timeseries failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name:     "ringba_tag_timeseries",
        params,
        status:        "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};
