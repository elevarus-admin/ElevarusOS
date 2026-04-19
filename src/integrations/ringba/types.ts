// ─── Ringba Integration Types ─────────────────────────────────────────────────
//
// Shared across all ElevarusOS agents that pull Ringba data.
// Source of truth for all Ringba API response shapes and report interfaces.

export interface RingbaCallRecord {
  inboundCallId:                string;
  campaignId:                   string;
  campaignName:                 string;
  publisherId?:                 string;
  publisherSubId?:              string;
  publisherName:                string;
  targetId?:                    string;
  targetName:                   string | null;
  buyerId?:                     string;
  buyer:                        string | null;
  inboundPhoneNumber:           string;
  callDt:                       number;    // Unix ms timestamp
  callLengthInSeconds:          number;
  connectedCallLengthInSeconds: number;
  hasConnected:                 boolean;
  hasConverted:                 boolean;
  hasPayout:                    boolean;   // true = billable — buyer paid for this call
  noConversionReason:           string | null;
  conversionAmount:             number;    // Revenue from buyer (what they pay us)
  payoutAmount:                 number;    // Payout to publisher
  profitNet:                    number;
  totalCost:                    number;
  isDuplicate:                  boolean;
  isLive:                       boolean;
  recordingUrl?:                string;
  /**
   * Custom + system tag values captured at call time. Populated from
   * `valueColumns: [{column: "tag:TagType:TagName"}, ...]` requests.
   * Keys are `"TagType:TagName"` strings (e.g. `"User:utm_campaign"`).
   * Values are strings (Ringba's tag values are always rendered as text).
   */
  tagValues?:                   Record<string, string>;
  /**
   * Full, untransformed API record as received from Ringba. Preserved
   * so we never silently drop a field a future report might need. Mirrors
   * what `raw` stores on the DB row.
   */
  rawRecord?:                   Record<string, unknown>;
}

export interface RingbaTagDefinition {
  tagType:   string;   // e.g. "User", "Geo", "Campaign"
  tagName:   string;   // e.g. "utm_campaign", "Country", "Name"
  tagSource: string;   // e.g. "JSTag", "System"
}

export interface RingbaCampaign {
  id:      string;
  name:    string;
  enabled: boolean;
}

/**
 * The primary output of a Ringba revenue pull.
 * Maps to the three core metrics in the Pamela-style Slack report:
 *   totalCalls   → "Total Calls"
 *   paidCalls    → "Total Billable Calls"
 *   totalRevenue → "Ringba Revenue"
 */
export interface RingbaRevenueReport {
  campaignId:    string;
  campaignName:  string;
  startDate:     string;   // YYYY-MM-DD
  endDate:       string;   // YYYY-MM-DD
  totalCalls:    number;   // all inbound calls
  paidCalls:     number;   // calls where hasPayout = true
  totalRevenue:  number;   // sum of conversionAmount (buyer revenue, USD)
  totalPayout:   number;   // sum of payoutAmount (publisher payout, USD)
  avgPayout:     number;   // totalRevenue / paidCalls
  calls:         RingbaCallRecord[];
}

/** Options for the paginated /callLogs fetch */
export interface RingbaCallLogOptions {
  startDate:     string;   // YYYY-MM-DD
  endDate:       string;   // YYYY-MM-DD
  campaignId?:   string;
  campaignName?: string;
  /**
   * Optional override for the full set of valueColumns to request. When
   * omitted, fetchCallLogs auto-enumerates the base columns + every
   * registered tag from `/tags`.
   */
  valueColumns?: string[];
  /**
   * When true (default), discover tags from `/tags` and include them in
   * valueColumns. Set false to skip the tag discovery call.
   */
  includeTags?:  boolean;
}
