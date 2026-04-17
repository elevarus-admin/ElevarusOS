/**
 * LeadsProsper Integration
 *
 * ElevarusOS's first Supabase-backed integration. Workflows read LP data from
 * the repository (Supabase); the sync worker is the only thing that talks to
 * the LP API. This split is the template for future Ringba/disposition work.
 *
 * Architecture:
 *   LeadsProsperClient        — thin HTTP wrapper (auth + pagination only)
 *   LeadsProsperRepository    — Supabase read/write, public interface for workflows
 *   LeadsProsperSyncWorker    — cron-driven sync: LP → Supabase
 */
export { LeadsProsperClient }     from "./client";
export { LeadsProsperRepository } from "./repository";
export { LeadsProsperSyncWorker } from "./sync";
export type {
  LPLead,
  LPLeadDataRaw,
  LPCampaign,
  LPLeadsPage,
  LPLeadStatus,
  LPSupplier,
  LPBuyer,
  LPClientRef,
  LPListLeadsOptions,
  LPLeadRow,
  LPCampaignRow,
  LPSyncStateRow,
} from "./types";
