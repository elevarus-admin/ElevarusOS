import { getSupabaseClient, isSupabaseConfigured } from "../../core/supabase-client";
import { logger } from "../../core/logger";
import type {
  LPCampaign,
  LPCampaignRow,
  LPLead,
  LPLeadRow,
  LPSyncStateRow,
} from "./types";

/**
 * Supabase-backed read/write layer for LeadsProsper data.
 *
 * This is the primary interface workflows should use to read LP data.
 * Do NOT call LeadsProsperClient directly from a workflow — the sync worker
 * is the only thing that talks to the LP API in normal operation.
 *
 * When Supabase is not configured, every method is a safe no-op (read methods
 * return []/null; writes log a warning).
 */
export class LeadsProsperRepository {
  readonly enabled = isSupabaseConfigured();

  // ── Writes (used by the sync worker) ──────────────────────────────────────

  async upsertCampaigns(campaigns: LPCampaign[]): Promise<void> {
    if (!this.enabled || campaigns.length === 0) return;

    const rows: Omit<LPCampaignRow, "first_seen_at">[] = campaigns.map((c) => ({
      id:             c.id,
      name:           c.name,
      raw:            c,
      last_synced_at: new Date().toISOString(),
    }));

    const { error } = await getSupabaseClient()
      .from("lp_campaigns")
      .upsert(rows, { onConflict: "id" });

    if (error) {
      logger.warn("LeadsProsperRepository: upsertCampaigns failed", { error: error.message });
    }
  }

  async upsertLeads(leads: LPLead[]): Promise<void> {
    if (!this.enabled || leads.length === 0) return;

    const rows = leads.map(mapLeadToRow);

    // Supabase has per-request size limits — batch large syncs.
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const { error } = await getSupabaseClient()
        .from("lp_leads")
        .upsert(batch, { onConflict: "id" });

      if (error) {
        logger.warn("LeadsProsperRepository: upsertLeads batch failed", {
          batchStart: i,
          batchSize:  batch.length,
          error:      error.message,
        });
      }
    }
  }

  async setSyncState(state: Omit<LPSyncStateRow, "last_synced_at"> & { last_synced_at?: string }): Promise<void> {
    if (!this.enabled) return;

    const row: LPSyncStateRow = {
      ...state,
      last_synced_at: state.last_synced_at ?? new Date().toISOString(),
    };

    const { error } = await getSupabaseClient()
      .from("lp_sync_state")
      .upsert(row, { onConflict: "sync_key" });

    if (error) {
      logger.warn("LeadsProsperRepository: setSyncState failed", { error: error.message });
    }
  }

  async getSyncState(syncKey: string): Promise<LPSyncStateRow | null> {
    if (!this.enabled) return null;

    const { data, error } = await getSupabaseClient()
      .from("lp_sync_state")
      .select("*")
      .eq("sync_key", syncKey)
      .maybeSingle();

    if (error) {
      logger.warn("LeadsProsperRepository: getSyncState failed", { syncKey, error: error.message });
      return null;
    }
    return (data as LPSyncStateRow | null) ?? null;
  }

  // ── Reads (used by workflows and reconciliation) ──────────────────────────

  /** Leads in a date range, optionally filtered by campaign. Returns [] when Supabase is off. */
  async getLeadsByDateRange(opts: {
    startDate:   string;   // ISO 8601
    endDate:     string;   // ISO 8601
    campaignId?: number;
    status?:     string;
  }): Promise<LPLeadRow[]> {
    if (!this.enabled) return [];

    let query = getSupabaseClient()
      .from("lp_leads")
      .select("*")
      .gte("lead_date", opts.startDate)
      .lte("lead_date", opts.endDate)
      .order("lead_date", { ascending: false });

    if (opts.campaignId !== undefined) query = query.eq("campaign_id", opts.campaignId);
    if (opts.status)                   query = query.eq("status",      opts.status);

    const { data, error } = await query;
    if (error) {
      logger.warn("LeadsProsperRepository: getLeadsByDateRange failed", { error: error.message });
      return [];
    }
    return (data as LPLeadRow[] | null) ?? [];
  }

  /**
   * Reconciliation lookup: find LP leads matching a phone number within a
   * time window. Used by future Ringba/disposition reconciliation flows.
   *
   * `phone` can be any format — it's normalized (digits-only) internally.
   */
  async findLeadsByPhone(opts: {
    phone:          string;
    startDate:      string;
    endDate:        string;
    statusFilter?:  string;
  }): Promise<LPLeadRow[]> {
    if (!this.enabled) return [];

    const normalized = opts.phone.replace(/\D/g, "");
    if (!normalized) return [];

    let query = getSupabaseClient()
      .from("lp_leads")
      .select("*")
      .eq("phone_normalized", normalized)
      .gte("lead_date", opts.startDate)
      .lte("lead_date", opts.endDate)
      .order("lead_date", { ascending: false });

    if (opts.statusFilter) query = query.eq("status", opts.statusFilter);

    const { data, error } = await query;
    if (error) {
      logger.warn("LeadsProsperRepository: findLeadsByPhone failed", { error: error.message });
      return [];
    }
    return (data as LPLeadRow[] | null) ?? [];
  }

  async listCampaigns(): Promise<LPCampaignRow[]> {
    if (!this.enabled) return [];
    const { data, error } = await getSupabaseClient()
      .from("lp_campaigns")
      .select("*")
      .order("name");

    if (error) {
      logger.warn("LeadsProsperRepository: listCampaigns failed", { error: error.message });
      return [];
    }
    return (data as LPCampaignRow[] | null) ?? [];
  }
}

// ─── Mappers ────────────────────────────────────────────────────────────────

function mapLeadToRow(lead: LPLead): Omit<LPLeadRow, "phone_normalized"> {
  const leadDateMs = Number(lead.lead_date_ms);
  const leadDate   = Number.isFinite(leadDateMs) && leadDateMs > 0
    ? new Date(leadDateMs).toISOString()
    : new Date().toISOString();

  return {
    id:            lead.id,
    campaign_id:   lead.campaign_id ?? null,
    campaign_name: lead.campaign_name ?? null,
    status:        lead.status,
    error_code:    lead.error_code ?? 0,
    error_message: lead.error_message || null,
    is_test:       Boolean(lead.test),
    cost:          Number.isFinite(lead.cost)    ? lead.cost    : null,
    revenue:       Number.isFinite(lead.revenue) ? lead.revenue : null,
    lead_date:     leadDate,
    phone:         lead.lead_data?.phone    ?? null,
    email:         lead.lead_data?.email    ?? null,
    state:         lead.lead_data?.state    ?? null,
    zip_code:      lead.lead_data?.zip_code ?? null,
    sub1:          lead.lead_data?.lp_subid1 ?? null,
    sub2:          lead.lead_data?.lp_subid2 ?? null,
    sub3:          lead.lead_data?.lp_subid3 ?? null,
    supplier_id:   lead.supplier?.id   ?? null,
    supplier_name: lead.supplier?.name ?? null,
    lead_data:     lead.lead_data ?? {},
    buyers:        lead.buyers    ?? [],
    raw:           lead,
  };
}
