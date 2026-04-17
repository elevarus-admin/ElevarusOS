// ─── LeadsProsper Integration Types ───────────────────────────────────────────
//
// Source of truth for all LeadsProsper API response shapes and the derived
// repository row shapes stored in Supabase.
//
// LP API docs: https://support.leadprosper.io/article/258-lead-prosper-analytics-api-cheat-sheet

// ── Raw API response shapes ───────────────────────────────────────────────────

export type LPLeadStatus =
  | "ACCEPTED"
  | "REJECTED"
  | "DUPLICATED"
  | "ERROR"
  | (string & {}); // tolerate unknown values — LP may add new states

export interface LPLeadDataRaw {
  lp_ping_id?:      string;
  lp_consent_bids?: string;
  lp_subid1?:       string;
  lp_subid2?:       string;
  lp_subid3?:       string;

  first_name?: string;
  last_name?:  string;
  email?:      string;
  phone?:      string;
  address?:    string;
  city?:       string;
  state?:      string;
  zip_code?:   string;
  ip_address?: string;

  [extra: string]: unknown;  // vertical-specific fields pass through untyped
}

export interface LPClientRef {
  id:   number;
  name: string;
}

export interface LPSupplier {
  id:     number;
  name:   string;
  client: LPClientRef;
}

export interface LPBuyer {
  id:            number;
  name:          string;
  client:        LPClientRef;
  status:        LPLeadStatus;
  error_code:    number;
  error_message: string;
  sell_price:    number;
}

export interface LPLead {
  id:             string;
  lead_date_ms:   string;          // ms-precision unix timestamp as string
  status:         LPLeadStatus;
  error_code:     number;
  error_message:  string;
  test:           boolean;
  cost:           number;
  revenue:        number;
  campaign_id:    number;
  campaign_name:  string;
  lead_data:      LPLeadDataRaw;
  supplier:       LPSupplier;
  buyers:         LPBuyer[];
}

export interface LPLeadsPage {
  leads:         LPLead[];
  search_after?: string;    // cursor for the next page; absent/empty = no more pages
}

export interface LPCampaign {
  id:   number;
  name: string;
  [extra: string]: unknown; // campaigns carry supplier/buyer/cap metadata we store as raw JSONB
}

// ── Client options ────────────────────────────────────────────────────────────

export interface LPListLeadsOptions {
  startDate:   string;   // YYYY-MM-DD
  endDate:     string;   // YYYY-MM-DD
  campaignId?: number;   // optional single-campaign filter
  status?:     "accepted" | "error" | "duplicated";
  timezone?:   string;   // IANA tz, defaults to LP campaign timezone
}

// ── Repository row shapes (what we write to / read from Supabase) ────────────

export interface LPLeadRow {
  id:                string;
  campaign_id:       number | null;
  campaign_name:     string | null;
  status:            string;
  error_code:        number;
  error_message:     string | null;
  is_test:           boolean;
  cost:              number | null;
  revenue:           number | null;
  lead_date:         string;          // ISO 8601
  phone:             string | null;
  phone_normalized?: string;          // generated column, read-only
  email:             string | null;
  state:             string | null;
  zip_code:          string | null;
  sub1:              string | null;
  sub2:              string | null;
  sub3:              string | null;
  supplier_id:       number | null;
  supplier_name:     string | null;
  lead_data:         LPLeadDataRaw;
  buyers:            LPBuyer[];
  raw:               LPLead;
}

export interface LPCampaignRow {
  id:              number;
  name:            string;
  raw:             LPCampaign;
  first_seen_at?:  string;
  last_synced_at?: string;
}

export interface LPSyncStateRow {
  sync_key:         string;
  last_synced_at:   string;
  high_water_mark:  string | null;
  last_error:       string | null;
  notes:            Record<string, unknown>;
}
