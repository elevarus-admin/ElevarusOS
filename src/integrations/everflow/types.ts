// ─── Everflow Network API Types ──────────────────────────────────────────────
//
// Subset of the Everflow Network API surface that ElevarusOS uses.
// Reference: https://developers.everflow.io/  (Network API)
//
// Auth: X-Eflow-API-Key: <network api key>
// Base: https://api.eflow.team/v1/networks/

export interface EverflowOffer {
  network_offer_id: number;
  name:             string;
  network_id?:      number;
  offer_status?:    string;
}

export interface EverflowPartner {
  network_affiliate_id: number;
  name:                 string;
  account_status?:      string;
}

/**
 * One row of the entity reporting endpoint, scoped to offer × partner.
 * Field names mirror Everflow's `relationship` block.
 */
export interface EverflowReportRow {
  /** Numeric partner (affiliate) ID. */
  network_affiliate_id: number;
  /** Partner display name. */
  affiliate_name:       string;
  /** Numeric offer ID. */
  network_offer_id:     number;
  /** Offer display name. */
  offer_name:           string;
  /** Total events / clicks / conversions for the row, depending on filter. */
  conversions:          number;
  /** Total payout owed to the partner in USD. */
  payout:               number;
  /** Total revenue captured in USD. */
  revenue:              number;
  /** Profit (revenue − payout). Computed client-side when not present. */
  profit?:              number;
}

export interface EverflowReportFilters {
  /** Inclusive YYYY-MM-DD (PT) start date. */
  startDate:    string;
  endDate:      string;
  /** Restrict to a single offer (most common case). */
  offerId?:     number;
  /** Restrict to specific partners by ID. */
  partnerIds?:  number[];
  /** Optional partner-name substring filter applied client-side AFTER the API call. */
  partnerNameContains?: string;
}

/** Return shape from getOfferPayouts(). */
export interface EverflowOfferPayoutSummary {
  offerId:           number;
  offerName?:        string;
  startDate:         string;
  endDate:           string;
  totalPayout:       number;
  totalRevenue:      number;
  totalConversions:  number;
  rowCount:          number;
  /** Per-partner breakdown after exclusions are applied. */
  perPartner:        Array<{
    partnerId:   number;
    partnerName: string;
    payout:      number;
    revenue:     number;
    conversions: number;
  }>;
  /** Names that matched an exclude pattern and were dropped. */
  excludedPartners?: string[];
}
