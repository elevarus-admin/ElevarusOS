import { logger } from "../../core/logger";
import { RingbaHttpClient } from "./client";
import { RingbaRepository } from "./repository";
import { getPstDateRange } from "../../core/date-time";
import type { RingbaRevenueReport } from "./types";

// ─── Date helpers ─────────────────────────────────────────────────────────────
// All ranges are anchored to America/Los_Angeles so "WTD", "MTD", and "today"
// match what a human in Elevarus's office (PT) expects, not UTC midnight.

export function getMTDRange(): { startDate: string; endDate: string } {
  return getPstDateRange("mtd");
}

export function getWTDRange(): { startDate: string; endDate: string } {
  return getPstDateRange("wtd");
}

export function getYTDRange(): { startDate: string; endDate: string } {
  return getPstDateRange("ytd");
}

/**
 * Unified entry point — accepts both Ringba's legacy period names
 * (mtd/wtd/ytd/custom) and the richer PT period names
 * (today/yesterday/last_week/last_month/last_7d/last_30d/last_90d).
 */
export function getDateRange(period: string, start?: string, end?: string) {
  const p = (period ?? "mtd").toLowerCase();
  if (p === "custom" && start && end) return { startDate: start, endDate: end };
  switch (p) {
    case "today":      return getPstDateRange("today");
    case "yesterday":  return getPstDateRange("yesterday");
    case "wtd":        return getPstDateRange("wtd");
    case "mtd":        return getPstDateRange("mtd");
    case "ytd":        return getPstDateRange("ytd");
    case "last_week":  return getPstDateRange("last_week");
    case "last_month": return getPstDateRange("last_month");
    case "last_7d":    return getPstDateRange("last_7d");
    case "last_30d":   return getPstDateRange("last_30d");
    case "last_90d":   return getPstDateRange("last_90d");
    default:           return getPstDateRange("mtd");
  }
}

// ─── Revenue report ───────────────────────────────────────────────────────────

/**
 * Pull a complete revenue report for a named Ringba campaign over a date range.
 *
 * ### Call counting
 *
 * Ringba's API returns one record per routing attempt (a single inbound call
 * may appear multiple times if it was tried at multiple buyers). The Ringba UI
 * "Incoming" count uses a **minimum call duration** (buffer time) to decide
 * which records count as real calls:
 *
 *   - `minCallDurationSeconds = 0`  → count all records (good for MTD/historical
 *     where all calls have finalized — matches the Ringba "Incoming" total).
 *   - `minCallDurationSeconds = 30` → filter out short routing failures / live
 *     calls — good for the "today" window where real-time data includes
 *     in-progress and sub-threshold calls.
 *
 * `paidCalls` always filters `hasPayout && !isDuplicate` regardless of duration,
 * which matches the Ringba UI "Paid" column.
 *
 * Output maps to the Slack report format:
 *   totalCalls    → "Total Calls"         (calls that met minCallDurationSeconds)
 *   paidCalls     → "Billable Calls"      (hasPayout = true, not a routing dup)
 *   totalRevenue  → "Ringba Revenue"      (sum of conversionAmount, all calls)
 *
 * @example
 * // MTD (historical — count everything)
 * const mtd = await getCampaignRevenue({
 *   campaignName: 'O&O_SOMQ_FINAL_EXPENSE',
 *   startDate: '2026-04-01',
 *   endDate:   '2026-04-17',
 *   minCallDurationSeconds: 0,   // default — all records count
 * });
 *
 * // Today (real-time — filter out sub-threshold calls)
 * const today = await getCampaignRevenue({
 *   campaignName: 'O&O_SOMQ_FINAL_EXPENSE',
 *   startDate: '2026-04-17',
 *   endDate:   '2026-04-17',
 *   minCallDurationSeconds: 30,  // drop calls < 30s (routing failures, live calls)
 * });
 */
export async function getCampaignRevenue(opts: {
  campaignName:           string;
  startDate:              string;
  endDate:                string;
  /** Minimum call length (seconds) for a record to count toward totalCalls.
   *  Default: 0 (all records count — correct for MTD/historical).
   *  Set to 30 for "today" to drop sub-threshold routing failures. */
  minCallDurationSeconds?: number;
  /** Force-read from live API, skipping the Supabase repository. Default: false. */
  liveOnly?: boolean;
}): Promise<RingbaRevenueReport | null> {
  const minDuration = opts.minCallDurationSeconds ?? 0;

  logger.info("ringba/reports: fetching campaign revenue", {
    campaignName: opts.campaignName,
    startDate:    opts.startDate,
    endDate:      opts.endDate,
    minDuration,
    source:       opts.liveOnly ? "live-only" : "auto (supabase→live)",
  });

  // ── Supabase path ───────────────────────────────────────────────────────
  // Prefer the Supabase repository when its sync has coverage for the
  // requested date range. This avoids hammering the Ringba API and returns
  // byte-for-byte the same numbers (same aggregation logic, same fields).
  if (!opts.liveOnly) {
    const repo = new RingbaRepository();
    if (repo.enabled) {
      const covered = await repo.hasCoverage("calls:global", opts.startDate, opts.endDate);
      if (covered) {
        // Resolve campaign ID from Supabase so the repo can use the
        // campaign_id index instead of unnesting every campaign.
        const campaignId = await resolveCampaignIdFromRepo(opts.campaignName);
        const report = await repo.getRevenueReport({
          campaignId,
          campaignName:           opts.campaignName,
          startDate:              opts.startDate,
          endDate:                opts.endDate,
          minCallDurationSeconds: minDuration,
        });
        if (report) {
          logger.info("ringba/reports: revenue report ready (supabase)", {
            campaign:     report.campaignName,
            totalCalls:   report.totalCalls,
            paidCalls:    report.paidCalls,
            totalRevenue: `$${report.totalRevenue.toFixed(2)}`,
          });
          return report;
        }
      } else {
        logger.info("ringba/reports: Supabase has no coverage for requested range — falling back to live API", {
          startDate: opts.startDate,
          endDate:   opts.endDate,
        });
      }
    }
  }

  // ── Live-API fallback ───────────────────────────────────────────────────
  const client = new RingbaHttpClient();

  if (!client.enabled) {
    logger.warn("ringba/reports: client not configured — skipping revenue pull");
    return null;
  }

  // Resolve campaign ID for cleaner client-side filtering
  const campaign = await client.findCampaignByName(opts.campaignName);
  if (!campaign) {
    logger.warn("ringba/reports: campaign not found by name — filtering by name in results", {
      name: opts.campaignName,
    });
  }

  const calls = await client.fetchCallLogs({
    startDate:    opts.startDate,
    endDate:      opts.endDate,
    campaignId:   campaign?.id,
    campaignName: campaign ? undefined : opts.campaignName,
  });

  // ── totalCalls: records that met the minimum duration threshold.
  //    For MTD (minDuration=0) this equals calls.length — matches Ringba UI "Incoming".
  //    For today (minDuration=30) this drops short routing failures and live calls.
  const countableCalls = calls.filter((c) => (c.callLengthInSeconds ?? 0) >= minDuration);

  // ── paidCalls: buyer paid, not a routing duplicate, met duration threshold.
  //    Same minDuration applies so paidCalls can never exceed totalCalls.
  //    With minDuration=0 (MTD) this matches the Ringba UI "Paid" column exactly.
  const paidCalls = calls.filter(
    (c) => c.hasPayout && !c.isDuplicate && (c.callLengthInSeconds ?? 0) >= minDuration
  );

  // ── Revenue: sum of conversionAmount across all records (duplicates have $0 so safe).
  const totalRevenue = round2(calls.reduce((s, c) => s + c.conversionAmount, 0));
  const totalPayout  = round2(calls.reduce((s, c) => s + c.payoutAmount, 0));

  const report: RingbaRevenueReport = {
    campaignId:   campaign?.id ?? "unknown",
    campaignName: opts.campaignName,
    startDate:    opts.startDate,
    endDate:      opts.endDate,
    totalCalls:   countableCalls.length,
    paidCalls:    paidCalls.length,
    totalRevenue,
    totalPayout,
    avgPayout:    paidCalls.length > 0 ? round2(totalRevenue / paidCalls.length) : 0,
    calls,
  };

  logger.info("ringba/reports: revenue report ready (live)", {
    campaign:     report.campaignName,
    totalCalls:   report.totalCalls,
    paidCalls:    report.paidCalls,
    totalRevenue: `$${report.totalRevenue.toFixed(2)}`,
  });

  return report;
}

// ─── Campaign ID resolution ──────────────────────────────────────────────────

/** Lookup a campaign ID by name from the ringba_campaigns table. */
async function resolveCampaignIdFromRepo(campaignName: string): Promise<string | undefined> {
  try {
    const { getSupabaseClient } = await import("../../core/supabase-client");
    const { data } = await getSupabaseClient()
      .from("ringba_campaigns")
      .select("id")
      .ilike("name", campaignName)
      .maybeSingle();
    return (data as { id: string } | null)?.id;
  } catch {
    return undefined;
  }
}

/**
 * MTD revenue shortcut — pulls from 1st of current month through today.
 * Uses minCallDurationSeconds=0 (all records count, matching Ringba UI "Incoming").
 */
export async function getMTDRevenue(campaignName: string): Promise<RingbaRevenueReport | null> {
  const { startDate, endDate } = getMTDRange();
  return getCampaignRevenue({ campaignName, startDate, endDate, minCallDurationSeconds: 0 });
}

/**
 * WTD revenue shortcut — pulls from Monday of current week through today.
 */
export async function getWTDRevenue(campaignName: string): Promise<RingbaRevenueReport | null> {
  const { startDate, endDate } = getWTDRange();
  return getCampaignRevenue({ campaignName, startDate, endDate });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
