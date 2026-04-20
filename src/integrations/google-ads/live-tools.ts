/**
 * Google Ads live-API + Supabase-backed tools contributed to the Ask Elevarus
 * bot via the manifest.
 *
 * - google_ads_list_accounts: lists every sub-account under the MCC. Reads
 *   from the Supabase mirror (refreshed nightly by the sync worker); falls
 *   back to a live API call when the mirror is empty.
 *
 * - google_ads_today_spend: live API passthrough for "spend so far today"
 *   questions. Bounded to today only since the nightly sync lags by ~1 day.
 */

import { GoogleAdsClient }   from "./client";
import { getSupabaseClient } from "../../core/supabase-client";
import { auditQueryTool }    from "../../core/audit-log";
import { logger }            from "../../core/logger";
import type { QATool }       from "../../core/qa-tools";
import type { GoogleAdsCustomerSummary } from "./types";

// ─── google_ads_list_accounts ────────────────────────────────────────────────

interface ListAccountsInput {
  statusFilter?: string[];
  nameContains?: string;
  includeManagers?: boolean;
}

export const googleAdsListAccountsTool: QATool = {
  spec: {
    name: "google_ads_list_accounts",
    description:
      "List every Google Ads sub-account under the configured MCC (9899477831). " +
      "Reads from `google_ads_customers` in Supabase (synced nightly); falls back to a live API call if the table is empty. " +
      "Returns customerId, descriptiveName, manager (true=sub-MCC), status, currency, timezone. " +
      "Use this to (a) discover newly granted accounts before wiring them into instance.md, " +
      "(b) answer 'which Google Ads accounts do we have access to?', " +
      "(c) reconcile an account name the user mentions to the numeric CID needed by other tools. " +
      "By default returns leaf advertiser accounts only — set includeManagers=true to also return sub-MCCs.",
    input_schema: {
      type: "object",
      properties: {
        statusFilter: {
          type: "array",
          items: { type: "string" },
          description: "Optional status labels to keep (e.g. ['ENABLED']). Default: all statuses returned.",
        },
        nameContains: {
          type: "string",
          description: "Optional case-insensitive substring filter on descriptiveName.",
        },
        includeManagers: {
          type: "boolean",
          description: "If true, include sub-MCC manager accounts. Default false.",
        },
      },
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params = (input ?? {}) as ListAccountsInput;

    try {
      const supabase = getSupabaseClient();
      let { data, error } = await supabase
        .from("google_ads_customers")
        .select("customer_id,descriptive_name,manager,parent_manager_id,level,currency_code,time_zone,status")
        .order("descriptive_name", { ascending: true });

      // Fallback: live API if the mirror is empty (e.g. first run before sync)
      let liveFallback = false;
      let accounts: GoogleAdsCustomerSummary[] = [];

      if (error) throw new Error(`Supabase query failed: ${error.message}`);

      if (!data || data.length === 0) {
        liveFallback = true;
        const client = new GoogleAdsClient();
        if (!client.enabled) throw new Error("Google Ads not configured.");
        accounts = await client.listCustomerClients();
      } else {
        accounts = data.map((r) => ({
          customerId:      String(r.customer_id),
          descriptiveName: r.descriptive_name ?? null,
          manager:         Boolean(r.manager),
          parentManagerId: r.parent_manager_id ?? null,
          level:           Number(r.level ?? 1),
          currencyCode:    r.currency_code ?? null,
          timeZone:        r.time_zone     ?? null,
          status:          r.status        ?? null,
        }));
      }

      const total = accounts.length;

      const includeManagers = Boolean(params.includeManagers);
      if (!includeManagers) accounts = accounts.filter((a) => !a.manager);

      if (params.statusFilter && params.statusFilter.length > 0) {
        const wanted = new Set(params.statusFilter.map((s) => s.toUpperCase()));
        accounts = accounts.filter((a) => a.status && wanted.has(a.status.toUpperCase()));
      }
      if (params.nameContains) {
        const needle = params.nameContains.toLowerCase();
        accounts = accounts.filter((a) => (a.descriptiveName ?? "").toLowerCase().includes(needle));
      }

      const elapsed_ms = Date.now() - startedAt;

      await auditQueryTool(ctx, {
        tool_name:       "google_ads_list_accounts",
        params,
        status:          "ok",
        row_count:       accounts.length,
        total_available: total,
        elapsed_ms,
      });

      return {
        accounts: accounts.map((a) => ({
          customerId:      a.customerId,
          descriptiveName: a.descriptiveName,
          manager:         a.manager,
          status:          a.status,
          currencyCode:    a.currencyCode,
          timeZone:        a.timeZone,
        })),
        row_count:       accounts.length,
        total_available: total,
        filtered:        accounts.length !== total,
        source:          liveFallback ? "live_api" : "supabase",
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("google_ads_list_accounts failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name:     "google_ads_list_accounts",
        params,
        status:        "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

// ─── google_ads_today_spend ──────────────────────────────────────────────────

interface TodaySpendInput {
  customerIds?: string[];   // optional: which sub-accounts to include
  nameContains?: string;    // optional: filter customers by name first
}

export const googleAdsTodaySpendTool: QATool = {
  spec: {
    name: "google_ads_today_spend",
    description:
      "Live-API passthrough for Google Ads spend SO FAR TODAY (PT). " +
      "Use ONLY when the user asks about today's intraday spend — for any other date range, " +
      "use `supabase_query` against `google_ads_daily_metrics` (synced nightly @ 02:00 PT). " +
      "Returns one row per customer with cost, impressions, clicks, conversions for today's date. " +
      "When customerIds are not provided, queries every ENABLED leaf account (skips sub-MCCs and CANCELED accounts).",
    input_schema: {
      type: "object",
      properties: {
        customerIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of 10-digit CIDs (no dashes). If omitted, all ENABLED leaf accounts.",
        },
        nameContains: {
          type: "string",
          description: "Optional case-insensitive substring filter on account name (applied before fetching).",
        },
      },
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params = (input ?? {}) as TodaySpendInput;
    const today = todayInPT();

    try {
      const client = new GoogleAdsClient();
      if (!client.enabled) throw new Error("Google Ads not configured.");

      let customerIds = params.customerIds;
      if (!customerIds || customerIds.length === 0) {
        const supabase = getSupabaseClient();
        let q = supabase
          .from("google_ads_customers")
          .select("customer_id,descriptive_name")
          .eq("manager", false)
          .eq("status", "ENABLED");
        const { data, error } = await q;
        if (error) throw new Error(`Could not list customers: ${error.message}`);
        let candidates = data ?? [];
        if (params.nameContains) {
          const needle = params.nameContains.toLowerCase();
          candidates = candidates.filter((r) => (r.descriptive_name ?? "").toLowerCase().includes(needle));
        }
        customerIds = candidates.map((r) => String(r.customer_id));
      }

      const results: Array<{ customerId: string; date: string; cost: number; impressions: number; clicks: number; conversions: number; error?: string }> = [];

      // Sequential to avoid hammering the API; small N (~30 accounts).
      for (const cid of customerIds) {
        try {
          const rows = await client.fetchDailyMetrics(cid, today, today);
          if (rows.length === 0) {
            results.push({ customerId: cid, date: today, cost: 0, impressions: 0, clicks: 0, conversions: 0 });
          } else {
            // Single-day query returns at most one row
            const r = rows[0];
            results.push({
              customerId:  cid,
              date:        r.date,
              cost:        r.cost,
              impressions: r.impressions,
              clicks:      r.clicks,
              conversions: r.conversions,
            });
          }
        } catch (err) {
          results.push({ customerId: cid, date: today, cost: 0, impressions: 0, clicks: 0, conversions: 0, error: String(err) });
        }
      }

      const elapsed_ms = Date.now() - startedAt;
      const totalCost = Math.round(results.reduce((s, r) => s + r.cost, 0) * 100) / 100;

      await auditQueryTool(ctx, {
        tool_name: "google_ads_today_spend",
        params,
        status:    "ok",
        row_count: results.length,
        elapsed_ms,
      });

      return {
        date:      today,
        accounts:  results,
        totalCost,
        row_count: results.length,
        source:    "live_api",
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("google_ads_today_spend failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name:     "google_ads_today_spend",
        params,
        status:        "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function todayInPT(): string {
  // YYYY-MM-DD in America/Los_Angeles
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year:  "numeric",
    month: "2-digit",
    day:   "2-digit",
  }).format(new Date());
}
