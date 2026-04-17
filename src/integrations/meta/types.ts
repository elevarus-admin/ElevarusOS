// ─── Meta Ads Integration Types ───────────────────────────────────────────────
//
// Shared across all ElevarusOS agents that pull Meta Ads data.
// The ad account ID is the per-agent identifier — each MC agent configures
// its own account in instance.md.

/** A single insight row returned from the Meta Ads Insights API. */
export interface MetaInsightRecord {
  spend:        number;   // USD, total spend for the period
  impressions:  number;
  clicks:       number;
  reach:        number;
  cpm:          number;   // cost per 1000 impressions
  cpc:          number;   // cost per click
  ctr:          number;   // click-through rate (%)
  dateStart:    string;   // YYYY-MM-DD
  dateStop:     string;   // YYYY-MM-DD
}

/**
 * The primary output of a Meta ad account spend pull.
 * When campaignIds is empty, this reflects total account-level spend.
 * When campaignIds are specified, this reflects the aggregated spend
 * across only those campaigns.
 */
export interface MetaSpendReport {
  adAccountId:  string;
  startDate:    string;   // YYYY-MM-DD
  endDate:      string;   // YYYY-MM-DD
  totalSpend:   number;   // USD
  impressions:  number;
  clicks:       number;
  cpm:          number;
  cpc:          number;
  ctr:          number;
  campaignIds?: string[]; // empty = entire account
}

/** Options for pulling spend from a Meta ad account. */
export interface MetaSpendOptions {
  adAccountId:  string;    // numeric account ID (without act_ prefix)
  startDate:    string;    // YYYY-MM-DD
  endDate:      string;    // YYYY-MM-DD
  campaignIds?: string[];  // optional — filters to specific campaigns
}
