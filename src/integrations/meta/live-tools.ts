/**
 * Meta live-API tools contributed to the Ask Elevarus bot via the manifest.
 *
 * Phase 1: account discovery. The existing `get_meta_spend` tool (in
 * src/core/qa-tools.ts) covers per-instance spend queries and is unaffected.
 */

import { MetaAdsClient } from "./client";
import { auditQueryTool } from "../../core/audit-log";
import { logger } from "../../core/logger";
import { loadInstanceConfig } from "../../core/instance-config";
import { getPstDateRange } from "../../core/date-time";
import type { QATool } from "../../core/qa-tools";
import type { MetaInsightLevel, MetaQueryRow } from "./types";

// ─── meta_list_ad_accounts ────────────────────────────────────────────────────

export const metaListAdAccountsTool: QATool = {
  spec: {
    name: "meta_list_ad_accounts",
    description:
      "List every Meta ad account the configured System User token can access (GET /me/adaccounts). Returns accountId, name, owning business, status, currency, timezone, and lifetime amount_spent. Use this to: (a) discover newly granted accounts before wiring them into instance.md, (b) answer 'which Meta accounts do we have access to?', (c) reconcile an account name the user mentioned to the numeric ID needed by `get_meta_spend`. The accountId in the result is already stripped of the `act_` prefix and is what gets dropped into instance.md `meta.adAccountId`.",
    input_schema: {
      type: "object",
      properties: {
        statusFilter: {
          type: "array",
          items: { type: "string" },
          description: "Optional status labels to keep (e.g. ['active']). Default: all statuses returned.",
        },
        nameContains: {
          type: "string",
          description: "Optional case-insensitive substring filter on account name OR business name.",
        },
      },
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params = (input ?? {}) as { statusFilter?: string[]; nameContains?: string };

    try {
      const client = new MetaAdsClient();
      if (!client.enabled) throw new Error("Meta not configured — META_ACCESS_TOKEN required.");

      let accounts = await client.listAdAccounts();
      const total = accounts.length;

      if (params.statusFilter && params.statusFilter.length > 0) {
        const wanted = new Set(params.statusFilter.map((s) => s.toLowerCase()));
        accounts = accounts.filter((a) => wanted.has(a.status.toLowerCase()));
      }
      if (params.nameContains) {
        const needle = params.nameContains.toLowerCase();
        accounts = accounts.filter((a) =>
          a.name.toLowerCase().includes(needle) ||
          (a.businessName ?? "").toLowerCase().includes(needle)
        );
      }

      const elapsed_ms = Date.now() - startedAt;

      await auditQueryTool(ctx, {
        tool_name:       "meta_list_ad_accounts",
        params,
        status:          "ok",
        row_count:       accounts.length,
        total_available: total,
        elapsed_ms,
      });

      return {
        accounts: accounts.map((a) => ({
          accountId:    a.accountId,
          name:         a.name,
          businessName: a.businessName,
          status:       a.status,
          currency:     a.currency,
          timezone:     a.timezone,
          amountSpent:  a.amountSpent ?? null,
        })),
        row_count:        accounts.length,
        total_available:  total,
        filtered:         accounts.length !== total,
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("meta_list_ad_accounts failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name:    "meta_list_ad_accounts",
        params,
        status:       "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

// ─── meta_query ───────────────────────────────────────────────────────────────
//
// Per-campaign / per-ad-set / per-ad Insights. This is the tool for
// "which ad has the best CPC?" style questions that `get_meta_spend` (which
// is account-total only) cannot answer.

interface MetaQueryToolInput {
  /** Required unless `instanceId` is provided. Numeric ID without `act_`. */
  adAccountId?: string;
  /** Shortcut — resolves to `meta.adAccountId` from the instance's instance.md. */
  instanceId?:  string;
  /** account | campaign | adset | ad. Default 'campaign'. */
  level?:       MetaInsightLevel;
  /** Optional field list. Identity fields are added automatically per level. */
  fields?:      string[];
  /** Optional breakdown dimensions (placement, age, gender, device_platform, …). */
  breakdowns?:  string[];
  /** Predefined PT date period. Default 'mtd'. Use period='custom' with startDate/endDate for ranges. */
  period?:      "today" | "yesterday" | "wtd" | "mtd" | "ytd" | "last_week" | "last_month" | "last_7d" | "last_30d" | "last_90d" | "custom";
  startDate?:   string;   // YYYY-MM-DD (PT). Required when period='custom'.
  endDate?:     string;
  /** Optional campaign_id filter (server-side). */
  campaignIds?: string[];
  /** Optional ad_id filter (server-side). */
  adIds?:       string[];
  /** Row cap (default 100, ceiling 500). */
  limit?:       number;
}

const DEFAULT_META_LIMIT = 100;
const HARD_META_CEILING  = 500;

export const metaQueryTool: QATool = {
  spec: {
    name: "meta_query",
    description:
      "Per-entity Meta Ads Insights. Unlike `get_meta_spend` (account totals only), this tool returns one row per campaign / ad set / ad. Use it for 'which ad has the best CPC?', 'top 5 campaigns by CTR last week', 'best-performing ad set by spend MTD' style questions. " +
      "Always provide either `adAccountId` or `instanceId` (shortcut to the instance's configured meta.adAccountId). Level defaults to 'campaign' — use 'ad' for the finest granularity. " +
      "Dates are PT-anchored; default period is 'mtd'. For statistical-significance reasoning: rows with < 1,000 impressions should not be used to declare a CTR/CPC winner — note the confidence caveat in your reply.",
    input_schema: {
      type: "object",
      properties: {
        adAccountId: { type: "string", description: "Numeric Meta ad account ID (no 'act_' prefix)." },
        instanceId:  { type: "string", description: "Shortcut — resolves to meta.adAccountId from the named instance's instance.md." },
        level: {
          type: "string",
          enum: ["account", "campaign", "adset", "ad"],
          description: "Aggregation level. Default 'campaign'.",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Explicit field list. When omitted, core metrics (spend, impressions, clicks, reach, frequency, ctr, cpc, cpm) are requested. Identity fields are added automatically per level.",
        },
        breakdowns: {
          type: "array",
          items: { type: "string" },
          description: "Optional breakdown dimensions — e.g. ['publisher_platform'], ['age','gender'], ['device_platform']. Not all combos are supported by Meta.",
        },
        period: {
          type: "string",
          enum: ["today", "yesterday", "wtd", "mtd", "ytd", "last_week", "last_month", "last_7d", "last_30d", "last_90d", "custom"],
          description: "Predefined PT date period. Default 'mtd'.",
        },
        startDate: { type: "string", description: "YYYY-MM-DD (PT). Required when period='custom'." },
        endDate:   { type: "string", description: "YYYY-MM-DD (PT). Required when period='custom'." },
        campaignIds: { type: "array", items: { type: "string" }, description: "Optional — restrict to these campaign IDs (server-side filter)." },
        adIds:       { type: "array", items: { type: "string" }, description: "Optional — restrict to these ad IDs (server-side filter)." },
        limit:       { type: "integer", description: `Max rows. Default ${DEFAULT_META_LIMIT}, hard ceiling ${HARD_META_CEILING}.` },
      },
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params    = (input ?? {}) as MetaQueryToolInput;

    try {
      // Resolve ad account: explicit > instanceId shortcut
      let adAccountId = params.adAccountId;
      if (!adAccountId && params.instanceId) {
        try {
          const cfg = loadInstanceConfig(params.instanceId);
          adAccountId = cfg.meta?.adAccountId;
        } catch { /* handled below */ }
      }
      if (!adAccountId) {
        throw new Error("Provide adAccountId or instanceId (with meta.adAccountId configured).");
      }

      // Resolve date range
      const period = params.period ?? "mtd";
      const { startDate, endDate } = getPstDateRange(period, params.startDate, params.endDate);

      const level = params.level ?? "campaign";
      const limit = Math.min(params.limit ?? DEFAULT_META_LIMIT, HARD_META_CEILING);

      const client = new MetaAdsClient();
      if (!client.enabled) throw new Error("Meta not configured — META_ACCESS_TOKEN required.");

      const rows = await client.queryInsights({
        adAccountId,
        startDate,
        endDate,
        level,
        fields:      params.fields,
        breakdowns:  params.breakdowns,
        campaignIds: params.campaignIds,
        adIds:       params.adIds,
        limit,
      });

      const elapsed_ms = Date.now() - startedAt;
      const truncated  = rows.length >= limit;

      await auditQueryTool(ctx, {
        tool_name:       "meta_query",
        params:          { ...params, resolvedAdAccountId: adAccountId, resolvedRange: `${startDate} → ${endDate}` },
        status:          truncated ? "capped" : "ok",
        row_count:       rows.length,
        total_available: rows.length,
        elapsed_ms,
      });

      return {
        adAccountId,
        level,
        period,
        startDate,
        endDate,
        rows,
        row_count:  rows.length,
        truncated,
        elapsed_ms,
        ...(truncated ? {
          expand_hint: `Returned ${rows.length} rows (hit the requested limit of ${limit}, ceiling ${HARD_META_CEILING}). Raise limit or narrow the date range / filters.`,
        } : {}),
        ...(rows.some((r) => (r.impressions ?? 0) < 1000) ? {
          confidence_note: "Some rows have < 1,000 impressions — flag as statistically inconclusive when comparing CTR or CPC between variants.",
        } : {}),
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("meta_query failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name:     "meta_query",
        params,
        status:        "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};
