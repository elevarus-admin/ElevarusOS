import { MetaAdsClient } from "./client";
import type { MetaSpendOptions, MetaSpendReport } from "./types";
import { logger } from "../../core/logger";

const client = new MetaAdsClient();

/**
 * Pull aggregated ad spend for an ad account (or specific campaigns) over a
 * date range. This is the primary function used by the data-collection stage.
 *
 * When opts.campaignIds is empty (the default), returns total account-level spend —
 * every dollar spent across all campaigns in the account.
 *
 * When opts.campaignIds is provided, returns spend aggregated only for those
 * campaigns — useful when one ad account runs multiple unrelated verticals.
 *
 * Returns null if the Meta integration is not configured or the API call fails.
 */
export async function getAdAccountSpend(
  opts: MetaSpendOptions,
): Promise<MetaSpendReport | null> {
  if (!client.enabled) {
    logger.info("meta/reports: META_ACCESS_TOKEN not set — skipping Meta pull");
    return null;
  }

  logger.info("meta/reports: fetching ad account spend", {
    adAccountId: opts.adAccountId,
    startDate:   opts.startDate,
    endDate:     opts.endDate,
    campaigns:   opts.campaignIds?.length ?? "all",
  });

  try {
    const rows = await client.fetchInsights(opts);

    if (rows.length === 0) {
      logger.warn("meta/reports: no insight rows returned", { adAccountId: opts.adAccountId });
      return null;
    }

    // Aggregate all rows (account-level returns 1 row; campaign-level may return N)
    const totalSpend   = rows.reduce((s, r) => s + r.spend,       0);
    const impressions  = rows.reduce((s, r) => s + r.impressions,  0);
    const clicks       = rows.reduce((s, r) => s + r.clicks,       0);

    // Weighted averages for rate metrics
    const cpm = impressions > 0 ? (totalSpend / impressions) * 1000 : 0;
    const cpc = clicks      > 0 ? totalSpend / clicks               : 0;
    const ctr = impressions > 0 ? (clicks / impressions) * 100      : 0;

    const report: MetaSpendReport = {
      adAccountId: opts.adAccountId,
      startDate:   opts.startDate,
      endDate:     opts.endDate,
      totalSpend:  Math.round(totalSpend * 100) / 100,
      impressions,
      clicks,
      cpm:         Math.round(cpm * 100) / 100,
      cpc:         Math.round(cpc * 100) / 100,
      ctr:         Math.round(ctr * 100) / 100,
      campaignIds: opts.campaignIds,
    };

    logger.info("meta/reports: spend report ready", {
      adAccountId: report.adAccountId,
      totalSpend:  `$${report.totalSpend.toFixed(2)}`,
      impressions: report.impressions,
      clicks:      report.clicks,
    });

    return report;
  } catch (err) {
    logger.warn("meta/reports: failed to build spend report", {
      adAccountId: opts.adAccountId,
      error:       String(err),
    });
    return null;
  }
}
