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
