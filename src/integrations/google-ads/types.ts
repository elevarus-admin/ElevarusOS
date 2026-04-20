// ─── Google Ads Integration Types ─────────────────────────────────────────────
//
// Shared across all ElevarusOS agents that pull Google Ads data.
// The customer ID (CID, 10 digits, no dashes) is the per-agent identifier —
// each MC agent configures its own account in instance.md.

/** A single sub-account under the MCC. */
export interface GoogleAdsCustomerSummary {
  /** 10-digit CID, no dashes. What goes in instance.md `googleAds.customerId`. */
  customerId:       string;
  /** Display name in Google Ads (descriptive_name). */
  descriptiveName:  string | null;
  /** True if this is a sub-MCC, false for a leaf advertiser account. */
  manager:          boolean;
  /** Parent CID in the hierarchy (null if at root). */
  parentManagerId:  string | null;
  /** 0 = MCC root, 1 = direct child, 2 = grandchild, ... */
  level:            number;
  /** ISO currency code. */
  currencyCode:     string | null;
  /** IANA timezone name. */
  timeZone:         string | null;
  /** Google's account status enum: ENABLED | CANCELED | SUSPENDED | CLOSED | ... */
  status:           string | null;
}

/** Daily account-level metrics row. */
export interface GoogleAdsDailyMetric {
  customerId:       string;
  date:             string;          // YYYY-MM-DD
  cost:             number;          // USD (cost_micros / 1e6)
  impressions:      number;
  clicks:           number;
  conversions:      number;
  conversionsValue: number;
  ctr:              number;          // fraction (0.0432 = 4.32%)
  avgCpc:           number;          // USD per click
}

/** Daily campaign-level metrics row. */
export interface GoogleAdsCampaignMetric {
  customerId:       string;
  campaignId:       string;
  campaignName:     string | null;
  campaignStatus:   string | null;
  date:             string;
  cost:             number;
  impressions:      number;
  clicks:           number;
  conversions:      number;
  conversionsValue: number;
}

/** Options for `getCustomerSpend()`. */
export interface GoogleAdsSpendOptions {
  customerId:   string;          // 10-digit CID, no dashes
  startDate:    string;          // YYYY-MM-DD inclusive
  endDate:      string;          // YYYY-MM-DD inclusive
  campaignIds?: string[];        // optional — filters to specific campaigns
}

/** Aggregated spend report. */
export interface GoogleAdsSpendReport {
  customerId:       string;
  startDate:        string;
  endDate:          string;
  totalCost:        number;          // USD, summed
  impressions:      number;
  clicks:           number;
  conversions:      number;
  conversionsValue: number;
  ctr:              number;          // fraction
  avgCpc:           number;          // USD
  campaignIds?:     string[];
}

/** Summary row from a sync worker run — written to google_ads_sync_runs. */
export interface GoogleAdsSyncRunResult {
  startedAt:        string;
  finishedAt:       string;
  status:           "ok" | "partial" | "error";
  customersSynced:  number;
  customersFailed:  number;
  rowsUpserted:     number;
  windowDays:       number;
  errorMessage:     string | null;
}
