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

/**
 * Level of granularity for an Insights query. Follows Meta's Graph API enum.
 *   - account  — one row per ad account (what get_meta_spend returns)
 *   - campaign — one row per campaign
 *   - adset    — one row per ad set (within campaign)
 *   - ad       — one row per ad (within ad set)
 */
export type MetaInsightLevel = "account" | "campaign" | "adset" | "ad";

/**
 * Options for MetaAdsClient.queryInsights(). Superset of MetaSpendOptions —
 * supports level, breakdowns, custom field lists, and filtering.
 */
export interface MetaQueryOptions {
  adAccountId:  string;
  /** YYYY-MM-DD. PT-anchored by convention. */
  startDate:    string;
  endDate:      string;
  level?:       MetaInsightLevel;   // default 'campaign'
  /**
   * Explicit field list. When omitted, a sensible default for the level is
   * used (see src/integrations/meta/client.ts → defaultFieldsForLevel).
   * Identity fields (campaign_id/_name, adset_id/_name, ad_id/_name) are
   * always added for level>=campaign.
   */
  fields?:      string[];
  /** Optional breakdown dimensions (e.g. ['age','gender'], ['publisher_platform']). */
  breakdowns?:  string[];
  /** Optional campaign_id filter (applied server-side via filtering param). */
  campaignIds?: string[];
  /** Optional ad_id filter (applied server-side). */
  adIds?:       string[];
  /** Max rows to return after pagination. */
  limit?:       number;
}

/**
 * One row of a MetaQuery result. Identity + metric fields vary by level,
 * so the shape is mostly loose — Claude reads what's there. The numeric
 * fields are always coerced to number (Meta returns strings).
 */
export interface MetaQueryRow {
  level:        MetaInsightLevel;
  date_start:   string;
  date_stop:    string;
  account_id?:  string;
  campaign_id?: string;
  campaign_name?: string;
  adset_id?:    string;
  adset_name?:  string;
  ad_id?:       string;
  ad_name?:     string;
  spend?:       number;
  impressions?: number;
  clicks?:      number;
  reach?:       number;
  frequency?:   number;
  ctr?:         number;
  cpc?:         number;
  cpm?:         number;
  /** Any non-enumerated fields (breakdowns, actions, etc.) come through here verbatim. */
  extras?:      Record<string, unknown>;
}

/**
 * Summary row from /me/adaccounts. Each entry is one ad account the
 * configured System User token has been granted access to. Use to discover
 * accounts before configuring an instance.
 *
 * `accountStatus` mapping (Meta enum → label):
 *   1=active, 2=disabled, 3=unsettled, 7=pending_risk_review,
 *   9=in_grace_period, 100=pending_closure, 101=closed,
 *   102=pending_settlement
 */
export interface MetaAdAccountSummary {
  /** Numeric ID without the `act_` prefix — what goes in instance.md `meta.adAccountId`. */
  accountId:    string;
  /** Display name in Meta Ads Manager. */
  name:         string;
  /** Owning Business Manager name (optional — null when account is personal-owned). */
  businessName: string | null;
  /** Numeric Meta status code. See enum mapping in the JSDoc above. */
  accountStatus: number;
  /** Human-readable status label derived from accountStatus. */
  status:       string;
  /** ISO currency code (USD, EUR, ...). */
  currency:     string;
  /** IANA-ish timezone Meta returns (e.g. "America/Los_Angeles"). */
  timezone:     string;
  /** Lifetime amount spent in account-currency minor units (Meta returns string). */
  amountSpent?: string;
}
