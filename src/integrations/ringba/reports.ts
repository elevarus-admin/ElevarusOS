import { logger } from "../../core/logger";
import { RingbaHttpClient } from "./client";
import type { RingbaRevenueReport } from "./types";

// ─── Date helpers ─────────────────────────────────────────────────────────────

const fmt = (d: Date): string => d.toISOString().slice(0, 10);

export function getMTDRange(): { startDate: string; endDate: string } {
  const today = new Date();
  return {
    startDate: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`,
    endDate:   fmt(today),
  };
}

export function getWTDRange(): { startDate: string; endDate: string } {
  const today = new Date();
  const day   = today.getDay();                  // 0 = Sun
  const diff  = day === 0 ? -6 : 1 - day;       // days back to Monday
  const monday = new Date(today);
  monday.setDate(today.getDate() + diff);
  return { startDate: fmt(monday), endDate: fmt(today) };
}

export function getYTDRange(): { startDate: string; endDate: string } {
  const today = new Date();
  return { startDate: `${today.getFullYear()}-01-01`, endDate: fmt(today) };
}

export function getDateRange(period: string, start?: string, end?: string) {
  if (period === "wtd") return getWTDRange();
  if (period === "ytd") return getYTDRange();
  if (period === "custom" && start && end) return { startDate: start, endDate: end };
  return getMTDRange(); // default
}

// ─── Revenue report ───────────────────────────────────────────────────────────

/**
 * Pull a complete revenue report for a named Ringba campaign over a date range.
 *
 * This is the primary function used by all ElevarusOS reporting agents.
 * Works for any campaign — just pass the campaign name from instance.md.
 *
 * Output maps directly to the Slack report format:
 *   totalCalls    → "Total Calls"         (all inbound calls)
 *   paidCalls     → "Total Billable Calls" (hasPayout = true)
 *   totalRevenue  → "Ringba Revenue"       (sum of conversionAmount)
 *
 * @example
 * const report = await getCampaignRevenue({
 *   campaignName: 'O&O_SOMQ_FINAL_EXPENSE',
 *   startDate: '2026-04-01',
 *   endDate:   '2026-04-30',
 * });
 */
export async function getCampaignRevenue(opts: {
  campaignName: string;
  startDate:    string;
  endDate:      string;
}): Promise<RingbaRevenueReport | null> {
  const client = new RingbaHttpClient();

  if (!client.enabled) {
    logger.warn("ringba/reports: client not configured — skipping revenue pull");
    return null;
  }

  logger.info("ringba/reports: fetching campaign revenue", opts);

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

  const paidCalls    = calls.filter((c) => c.hasPayout);
  const totalRevenue = round2(calls.reduce((s, c) => s + c.conversionAmount, 0));
  const totalPayout  = round2(calls.reduce((s, c) => s + c.payoutAmount, 0));

  const report: RingbaRevenueReport = {
    campaignId:   campaign?.id ?? "unknown",
    campaignName: opts.campaignName,
    startDate:    opts.startDate,
    endDate:      opts.endDate,
    totalCalls:   calls.length,
    paidCalls:    paidCalls.length,
    totalRevenue,
    totalPayout,
    avgPayout:    paidCalls.length > 0 ? round2(totalRevenue / paidCalls.length) : 0,
    calls,
  };

  logger.info("ringba/reports: revenue report ready", {
    campaign:     report.campaignName,
    totalCalls:   report.totalCalls,
    paidCalls:    report.paidCalls,
    totalRevenue: `$${report.totalRevenue.toFixed(2)}`,
  });

  return report;
}

/**
 * MTD revenue shortcut — pulls from 1st of current month through today.
 */
export async function getMTDRevenue(campaignName: string): Promise<RingbaRevenueReport | null> {
  const { startDate, endDate } = getMTDRange();
  return getCampaignRevenue({ campaignName, startDate, endDate });
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
