/**
 * Everflow live-API tools contributed to the Ask Elevarus bot via the manifest.
 *
 * Phase 1: discovery + offer-payout summary. Built around the U65 reporting
 * use case: "pull payouts for offer 8, exclude any partner with INTERNAL in
 * the name."
 */

import { EverflowClient } from "./client";
import { auditQueryTool } from "../../core/audit-log";
import { logger } from "../../core/logger";
import type { QATool } from "../../core/qa-tools";

// ─── everflow_list_offers ─────────────────────────────────────────────────────

export const everflowListOffersTool: QATool = {
  spec: {
    name: "everflow_list_offers",
    description:
      "List all offers in the Everflow network (GET /v1/networks/offers). Returns network_offer_id, name, status. Use to discover offer IDs for `everflow_offer_payouts` (e.g. find 'offer 8' or 'the U65 offer').",
    input_schema: {
      type: "object",
      properties: {
        nameContains: { type: "string", description: "Optional case-insensitive substring filter on offer name." },
      },
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params = (input ?? {}) as { nameContains?: string };
    try {
      const c = new EverflowClient();
      if (!c.enabled) throw new Error("Everflow not configured — EVERFLOW_API_KEY required.");
      let offers = await c.listOffers();
      if (params.nameContains) {
        const needle = params.nameContains.toLowerCase();
        offers = offers.filter((o) => o.name.toLowerCase().includes(needle));
      }
      const elapsed_ms = Date.now() - startedAt;
      await auditQueryTool(ctx, { tool_name: "everflow_list_offers", params, status: "ok", row_count: offers.length, elapsed_ms });
      return {
        offers: offers.map((o) => ({
          offerId: o.network_offer_id,
          name:    o.name,
          status:  o.offer_status ?? null,
        })),
        row_count: offers.length,
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("everflow_list_offers failed", { error: String(err) });
      await auditQueryTool(ctx, { tool_name: "everflow_list_offers", params, status: "error", elapsed_ms, error_message: String(err) });
      return { error: String(err) };
    }
  },
};

// ─── everflow_offer_payouts ───────────────────────────────────────────────────

interface OfferPayoutsInput {
  offerId:                 number;
  startDate:               string;
  endDate:                 string;
  excludePartnerPatterns?: string[];
}

export const everflowOfferPayoutsTool: QATool = {
  spec: {
    name: "everflow_offer_payouts",
    description:
      "Sum payouts on a specific Everflow offer over a date range, with optional partner-name exclusion. Returns totalPayout, totalRevenue, totalConversions, and a per-partner breakdown. Designed for cost reporting where a subset of partners (e.g. `INTERNAL` test partners) should be excluded from the rollup. Date range is YYYY-MM-DD in PT (Everflow timezone_id 67 = America/Los_Angeles is hardcoded).",
    input_schema: {
      type: "object",
      properties: {
        offerId:   { type: "integer", description: "Everflow network_offer_id (e.g. 8 for U65)." },
        startDate: { type: "string", description: "YYYY-MM-DD (PT, inclusive)." },
        endDate:   { type: "string", description: "YYYY-MM-DD (PT, inclusive)." },
        excludePartnerPatterns: {
          type: "array",
          items: { type: "string" },
          description: "Case-insensitive substrings; partners whose name contains ANY pattern are dropped. e.g. ['INTERNAL'].",
        },
      },
      required: ["offerId", "startDate", "endDate"],
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params = (input ?? {}) as OfferPayoutsInput;
    try {
      if (!params.offerId)   throw new Error("offerId is required.");
      if (!params.startDate) throw new Error("startDate is required.");
      if (!params.endDate)   throw new Error("endDate is required.");

      const c = new EverflowClient();
      if (!c.enabled) throw new Error("Everflow not configured.");

      const summary = await c.getOfferPayouts({
        offerId:                params.offerId,
        startDate:              params.startDate,
        endDate:                params.endDate,
        excludePartnerPatterns: params.excludePartnerPatterns,
      });
      const elapsed_ms = Date.now() - startedAt;

      if (!summary) {
        await auditQueryTool(ctx, { tool_name: "everflow_offer_payouts", params, status: "error", elapsed_ms, error_message: "summary null" });
        return { error: "Failed to fetch payouts. Check offer ID + date range." };
      }

      await auditQueryTool(ctx, {
        tool_name:       "everflow_offer_payouts",
        params,
        status:          "ok",
        row_count:       summary.rowCount,
        elapsed_ms,
      });

      return summary;
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("everflow_offer_payouts failed", { error: String(err) });
      await auditQueryTool(ctx, { tool_name: "everflow_offer_payouts", params, status: "error", elapsed_ms, error_message: String(err) });
      return { error: String(err) };
    }
  },
};
