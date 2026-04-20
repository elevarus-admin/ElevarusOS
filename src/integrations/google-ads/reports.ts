import { getSupabaseClient } from "../../core/supabase-client";
import { logger }            from "../../core/logger";
import type { GoogleAdsSpendOptions, GoogleAdsSpendReport } from "./types";

/**
 * Pull aggregated Google Ads spend for one customer (or specific campaigns)
 * over a date range. Reads from Supabase (synced nightly), NOT live API.
 *
 * For "spend so far today" use the live `google_ads_today_spend` tool —
 * the sync worker only refreshes once per day.
 *
 * Returns null when the customer has no rows in the given range (or Supabase
 * is unreachable). Mirrors the contract of meta/reports.ts:getAdAccountSpend.
 */
export async function getCustomerSpend(
  opts: GoogleAdsSpendOptions,
): Promise<GoogleAdsSpendReport | null> {
  try {
    const supabase = getSupabaseClient();

    if (opts.campaignIds && opts.campaignIds.length > 0) {
      return await campaignAggregation(supabase, opts);
    }
    return await accountAggregation(supabase, opts);
  } catch (err) {
    logger.warn("google-ads/reports: spend report failed", {
      customerId: opts.customerId,
      error:      String(err),
    });
    return null;
  }
}

async function accountAggregation(
  supabase: ReturnType<typeof getSupabaseClient>,
  opts:     GoogleAdsSpendOptions,
): Promise<GoogleAdsSpendReport | null> {
  const { data, error } = await supabase
    .from("google_ads_daily_metrics")
    .select("cost,impressions,clicks,conversions,conversions_value")
    .eq("customer_id", opts.customerId)
    .gte("date", opts.startDate)
    .lte("date", opts.endDate);

  if (error) {
    logger.warn("google-ads/reports: account query failed", { error: error.message });
    return null;
  }
  if (!data || data.length === 0) return null;

  return rollUp(opts, data.map((r) => ({
    cost:             Number(r.cost ?? 0),
    impressions:      Number(r.impressions ?? 0),
    clicks:           Number(r.clicks ?? 0),
    conversions:      Number(r.conversions ?? 0),
    conversionsValue: Number(r.conversions_value ?? 0),
  })));
}

async function campaignAggregation(
  supabase: ReturnType<typeof getSupabaseClient>,
  opts:     GoogleAdsSpendOptions,
): Promise<GoogleAdsSpendReport | null> {
  const { data, error } = await supabase
    .from("google_ads_campaign_metrics")
    .select("cost,impressions,clicks,conversions,conversions_value")
    .eq("customer_id", opts.customerId)
    .in("campaign_id", opts.campaignIds!)
    .gte("date", opts.startDate)
    .lte("date", opts.endDate);

  if (error) {
    logger.warn("google-ads/reports: campaign query failed", { error: error.message });
    return null;
  }
  if (!data || data.length === 0) return null;

  return rollUp(opts, data.map((r) => ({
    cost:             Number(r.cost ?? 0),
    impressions:      Number(r.impressions ?? 0),
    clicks:           Number(r.clicks ?? 0),
    conversions:      Number(r.conversions ?? 0),
    conversionsValue: Number(r.conversions_value ?? 0),
  })));
}

function rollUp(
  opts: GoogleAdsSpendOptions,
  rows: Array<{ cost: number; impressions: number; clicks: number; conversions: number; conversionsValue: number }>,
): GoogleAdsSpendReport {
  const totalCost        = rows.reduce((s, r) => s + r.cost,             0);
  const impressions      = rows.reduce((s, r) => s + r.impressions,      0);
  const clicks           = rows.reduce((s, r) => s + r.clicks,           0);
  const conversions      = rows.reduce((s, r) => s + r.conversions,      0);
  const conversionsValue = rows.reduce((s, r) => s + r.conversionsValue, 0);

  const ctr    = impressions > 0 ? clicks / impressions : 0;
  const avgCpc = clicks      > 0 ? totalCost / clicks   : 0;

  return {
    customerId:       opts.customerId,
    startDate:        opts.startDate,
    endDate:          opts.endDate,
    totalCost:        Math.round(totalCost * 100)        / 100,
    impressions,
    clicks,
    conversions:      Math.round(conversions * 100)      / 100,
    conversionsValue: Math.round(conversionsValue * 100) / 100,
    ctr:              Math.round(ctr    * 10000) / 10000,
    avgCpc:           Math.round(avgCpc *   100) /   100,
    campaignIds:      opts.campaignIds,
  };
}
