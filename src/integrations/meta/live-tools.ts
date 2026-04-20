/**
 * Meta live-API tools contributed to the Ask Elevarus bot via the manifest.
 *
 * Phase 1: account discovery. The existing `get_meta_spend` tool (in
 * src/core/qa-tools.ts) covers per-instance spend queries and is unaffected.
 */

import { MetaAdsClient } from "./client";
import { auditQueryTool } from "../../core/audit-log";
import { logger } from "../../core/logger";
import type { QATool } from "../../core/qa-tools";

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
