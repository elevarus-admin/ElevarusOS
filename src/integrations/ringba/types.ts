// ─── Ringba Integration Types ─────────────────────────────────────────────────
//
// Shared across all ElevarusOS agents that pull Ringba data.
// Source of truth for all Ringba API response shapes and report interfaces.

export interface RingbaCallRecord {
  inboundCallId:                string;
  campaignId:                   string;
  campaignName:                 string;
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
  buyer:                        string | null;
  targetName:                   string | null;
  publisherName:                string;
  isDuplicate:                  boolean;
  isLive:                       boolean;
  recordingUrl?:                string;
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
}
