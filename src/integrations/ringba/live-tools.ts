/**
 * Ringba live-API tools contributed to the Ask Elevarus bot via the manifest.
 *
 * These tools hit the Ringba REST API directly (not the Supabase mirror) —
 * use them when Supabase is missing a field, when the user explicitly asks
 * for fresh data, or when the sync worker is behind.
 */

import { RingbaHttpClient } from "./client";
import { auditQueryTool }   from "../../core/audit-log";
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
