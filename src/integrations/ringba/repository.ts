import { getSupabaseClient, isSupabaseConfigured } from "../../core/supabase-client";
import { logger } from "../../core/logger";
import type {
  RingbaCallRecord,
  RingbaCampaign,
  RingbaRevenueReport,
} from "./types";

/**
 * Supabase-backed read/write layer for Ringba call data.
 *
 * This is the primary interface workflows should use to read Ringba data.
 * RingbaHttpClient is only called by the sync worker in normal operation.
 *
 * When Supabase is not configured, every method is a safe no-op.
 */
export class RingbaRepository {
  readonly enabled = isSupabaseConfigured();

  // ── Writes (sync worker only) ─────────────────────────────────────────────

  async upsertCampaigns(campaigns: RingbaCampaign[]): Promise<void> {
    if (!this.enabled || campaigns.length === 0) return;

    const rows = campaigns.map((c) => ({
      id:             c.id,
      name:           c.name,
      enabled:        c.enabled,
      raw:            c,
      last_synced_at: new Date().toISOString(),
    }));

    const { error } = await getSupabaseClient()
      .from("ringba_campaigns")
      .upsert(rows, { onConflict: "id" });

    if (error) {
      logger.warn("RingbaRepository: upsertCampaigns failed", { error: error.message });
    }
  }

  /**
   * Upsert raw call records. Groups by inboundCallId, picks a "winning"
   * record per call (non-duplicate + hasPayout preferred), and preserves
   * every routing attempt in the `routing_attempts` JSONB column.
   */
  async upsertCalls(records: RingbaCallRecord[]): Promise<void> {
    if (!this.enabled || records.length === 0) return;

    const grouped = new Map<string, RingbaCallRecord[]>();
    for (const r of records) {
      if (!r.inboundCallId) continue;
      const list = grouped.get(r.inboundCallId) ?? [];
      list.push(r);
      grouped.set(r.inboundCallId, list);
    }

    const rows = Array.from(grouped.entries()).map(([inboundCallId, attempts]) => {
      const winner = pickWinningRecord(attempts);
      return {
        inbound_call_id:          inboundCallId,
        campaign_id:              winner.campaignId || null,
        campaign_name:            winner.campaignName || null,
        inbound_phone:            winner.inboundPhoneNumber || null,
        call_dt:                  msToIso(winner.callDt),
        call_length_seconds:      winner.callLengthInSeconds ?? 0,
        connected_length_seconds: winner.connectedCallLengthInSeconds ?? 0,
        has_connected:            Boolean(winner.hasConnected),
        has_converted:            Boolean(winner.hasConverted),
        has_payout:               Boolean(winner.hasPayout),
        is_duplicate:             Boolean(winner.isDuplicate),
        no_conversion_reason:     winner.noConversionReason ?? null,
        conversion_amount:        winner.conversionAmount ?? 0,
        payout_amount:            winner.payoutAmount ?? 0,
        profit_net:               winner.profitNet ?? 0,
        total_cost:               winner.totalCost ?? 0,
        winning_buyer:            winner.buyer ?? null,
        target_name:              winner.targetName ?? null,
        publisher_name:           winner.publisherName || null,
        recording_url:            winner.recordingUrl ?? null,
        routing_attempt_count:    attempts.length,
        routing_attempts:         attempts,
        raw:                      winner,
      };
    });

    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const { error } = await getSupabaseClient()
        .from("ringba_calls")
        .upsert(batch, { onConflict: "inbound_call_id" });

      if (error) {
        logger.warn("RingbaRepository: upsertCalls batch failed", {
          batchStart: i,
          batchSize:  batch.length,
          error:      error.message,
        });
      }
    }
  }

  async setSyncState(state: {
    sync_key:         string;
    high_water_mark?: string | null;
    low_water_mark?:  string | null;
    last_error?:      string | null;
    notes?:           Record<string, unknown>;
  }): Promise<void> {
    if (!this.enabled) return;

    const row = {
      sync_key:        state.sync_key,
      last_synced_at:  new Date().toISOString(),
      high_water_mark: state.high_water_mark ?? null,
      low_water_mark:  state.low_water_mark  ?? null,
      last_error:      state.last_error      ?? null,
      notes:           state.notes           ?? {},
    };

    const { error } = await getSupabaseClient()
      .from("ringba_sync_state")
      .upsert(row, { onConflict: "sync_key" });

    if (error) {
      logger.warn("RingbaRepository: setSyncState failed", { error: error.message });
    }
  }

  async getSyncState(syncKey: string): Promise<{
    sync_key:        string;
    last_synced_at:  string;
    high_water_mark: string | null;
    low_water_mark:  string | null;
    last_error:      string | null;
    notes:           Record<string, unknown>;
  } | null> {
    if (!this.enabled) return null;
    const { data, error } = await getSupabaseClient()
      .from("ringba_sync_state")
      .select("*")
      .eq("sync_key", syncKey)
      .maybeSingle();
    if (error) {
      logger.warn("RingbaRepository: getSyncState failed", { syncKey, error: error.message });
      return null;
    }
    return (data as any) ?? null;
  }

  // ── Reads (workflows + reconciliation) ────────────────────────────────────

  /**
   * Reproduce RingbaRevenueReport from Supabase using the SAME aggregation
   * semantics as the live-API version (see reports.ts). All filtering is
   * done over the unnested `routing_attempts` JSONB so the numbers match
   * Ringba's UI columns byte-for-byte.
   *
   * Returns null when Supabase is not configured. Returns an empty report
   * (zero calls) when no data is found — callers can use that to decide
   * whether to fall back to the live API.
   */
  async getRevenueReport(opts: {
    campaignId?:            string;
    campaignName:           string;
    startDate:              string;             // YYYY-MM-DD
    endDate:                string;             // YYYY-MM-DD
    minCallDurationSeconds: number;
    includeCalls?:          boolean;            // default: false (expensive)
  }): Promise<RingbaRevenueReport | null> {
    if (!this.enabled) return null;

    const rangeStart = `${opts.startDate}T00:00:00Z`;
    const rangeEnd   = `${opts.endDate}T23:59:59Z`;

    let query = getSupabaseClient()
      .from("ringba_calls")
      .select("routing_attempts, inbound_call_id, campaign_id, campaign_name")
      .gte("call_dt", rangeStart)
      .lte("call_dt", rangeEnd);

    if (opts.campaignId) {
      query = query.eq("campaign_id", opts.campaignId);
    }

    const { data, error } = await query;
    if (error) {
      logger.warn("RingbaRepository: getRevenueReport failed", { error: error.message });
      return null;
    }

    const callsBuffer: RingbaCallRecord[] = [];
    let totalCalls    = 0;
    let paidCalls     = 0;
    let totalRevenue  = 0;
    let totalPayout   = 0;
    let resolvedCampaignId = opts.campaignId ?? "";

    for (const row of data ?? []) {
      const attempts: RingbaCallRecord[] = (row as any).routing_attempts ?? [];
      if (!resolvedCampaignId && (row as any).campaign_id) {
        resolvedCampaignId = (row as any).campaign_id;
      }

      for (const r of attempts) {
        // Post-filter by campaign name when campaignId wasn't available upstream
        if (opts.campaignId === undefined &&
            opts.campaignName &&
            r.campaignName?.toLowerCase() !== opts.campaignName.toLowerCase()) {
          continue;
        }

        const duration = r.callLengthInSeconds ?? 0;
        if (duration >= opts.minCallDurationSeconds) totalCalls++;
        if (r.hasPayout && !r.isDuplicate && duration >= opts.minCallDurationSeconds) paidCalls++;
        totalRevenue += Number(r.conversionAmount ?? 0);
        totalPayout  += Number(r.payoutAmount    ?? 0);

        if (opts.includeCalls) callsBuffer.push(r);
      }
    }

    totalRevenue = round2(totalRevenue);
    totalPayout  = round2(totalPayout);

    return {
      campaignId:   resolvedCampaignId || "unknown",
      campaignName: opts.campaignName,
      startDate:    opts.startDate,
      endDate:      opts.endDate,
      totalCalls,
      paidCalls,
      totalRevenue,
      totalPayout,
      avgPayout:    paidCalls > 0 ? round2(totalRevenue / paidCalls) : 0,
      calls:        callsBuffer,
    };
  }

  /**
   * Find Ringba calls matching a phone number in a time window.
   * Used by reconciliation code to join LP leads ↔ Ringba calls.
   */
  async findCallsByPhone(opts: {
    phone:     string;
    startDate: string;  // ISO 8601
    endDate:   string;
  }): Promise<Array<{ inbound_call_id: string; call_dt: string; campaign_name: string | null; has_payout: boolean; conversion_amount: number; raw: RingbaCallRecord }>> {
    if (!this.enabled) return [];

    const normalized = opts.phone.replace(/\D/g, "");
    if (!normalized) return [];

    const { data, error } = await getSupabaseClient()
      .from("ringba_calls")
      .select("inbound_call_id, call_dt, campaign_name, has_payout, conversion_amount, raw")
      .eq("phone_normalized", normalized)
      .gte("call_dt", opts.startDate)
      .lte("call_dt", opts.endDate)
      .order("call_dt", { ascending: false });

    if (error) {
      logger.warn("RingbaRepository: findCallsByPhone failed", { error: error.message });
      return [];
    }
    return (data as any[]) ?? [];
  }

  /**
   * True if our sync has covered the requested range (inclusive).
   * Workflows use this to decide whether Supabase is authoritative for a
   * given date range or whether to fall back to the live API.
   */
  async hasCoverage(syncKey: string, startDate: string, endDate: string): Promise<boolean> {
    const state = await this.getSyncState(syncKey);
    if (!state || !state.high_water_mark || !state.low_water_mark) return false;
    const low  = new Date(state.low_water_mark).getTime();
    const high = new Date(state.high_water_mark).getTime();
    const s    = new Date(`${startDate}T00:00:00Z`).getTime();
    const e    = new Date(`${endDate}T23:59:59Z`).getTime();
    return low <= s && high >= e;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function pickWinningRecord(records: RingbaCallRecord[]): RingbaCallRecord {
  if (records.length === 1) return records[0]!;

  // Preference order:
  //   1. hasPayout && !isDuplicate  (the buyer that actually paid us)
  //   2. hasConverted && !isDuplicate
  //   3. hasConnected && !isDuplicate
  //   4. !isDuplicate
  //   5. whatever's first
  const score = (r: RingbaCallRecord): number => {
    let s = 0;
    if (!r.isDuplicate)  s += 10;
    if (r.hasPayout)     s +=  4;
    if (r.hasConverted)  s +=  2;
    if (r.hasConnected)  s +=  1;
    return s;
  };
  let winner = records[0]!;
  let best   = score(winner);
  for (const r of records.slice(1)) {
    const s = score(r);
    if (s > best) { winner = r; best = s; }
  }
  return winner;
}

function msToIso(ms: number | undefined): string {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return new Date().toISOString();
  return new Date(t).toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
