import { logger } from "../../core/logger";
import type {
  EverflowOffer,
  EverflowPartner,
  EverflowReportRow,
  EverflowReportFilters,
  EverflowOfferPayoutSummary,
} from "./types";

const BASE_URL = "https://api.eflow.team/v1/networks";

/**
 * Everflow Network API client.
 *
 * Auth:    X-Eflow-API-Key: {key}
 * Base:    https://api.eflow.team/v1/networks/
 *
 * Same shape as RingbaHttpClient/MetaAdsClient: `enabled` set from env at
 * construction; methods return `null`/`[]` (not throw) when disabled or on
 * failure; `null` is logged.
 *
 * Env vars:
 *   EVERFLOW_API_KEY — Network API key from
 *                      https://elevarus.everflowclient.io → API
 */
export class EverflowClient {
  readonly enabled: boolean;
  private readonly apiKey: string;

  constructor() {
    this.apiKey  = process.env.EVERFLOW_API_KEY ?? "";
    this.enabled = Boolean(this.apiKey);

    if (!this.enabled) {
      logger.info("EverflowClient: not configured (set EVERFLOW_API_KEY)");
    }
  }

  // ─── Discovery ─────────────────────────────────────────────────────────────

  /** GET /v1/networks/offers — paginated list of offers in the network. */
  async listOffers(): Promise<EverflowOffer[]> {
    const res = await this.get(`/offers?page_size=200`);
    if (!res) return [];
    return ((res.offers ?? []) as EverflowOffer[]);
  }

  /** GET /v1/networks/offers/{id} */
  async getOffer(offerId: number): Promise<EverflowOffer | null> {
    const res = await this.get(`/offers/${offerId}`);
    if (!res) return null;
    return res as EverflowOffer;
  }

  /** GET /v1/networks/affiliates — list partners. */
  async listPartners(): Promise<EverflowPartner[]> {
    const all: EverflowPartner[] = [];
    let page = 1;
    while (true) {
      const res = await this.get(`/affiliates?page=${page}&page_size=200`);
      if (!res) break;
      const rows: EverflowPartner[] = res.affiliates ?? [];
      all.push(...rows);
      if (rows.length < 200) break;
      page += 1;
      if (page > 25) break; // safety cap — 5000 partners
    }
    return all;
  }

  // ─── Reporting ─────────────────────────────────────────────────────────────

  /**
   * Pull entity reporting rows for an offer × partner breakdown over a
   * date range. Server-side aggregation by Everflow.
   *
   * POST /v1/networks/reporting/entity
   * Body shape (column-oriented):
   *   { from, to, timezone_id, currency_id, columns: [{column}],
   *     query: { filters: [{filter_id_value, resource_type}], settings: {...} } }
   *
   * For our use case (payouts by partner for one offer) we group by
   * `offer` and `affiliate` and filter by offer_id.
   */
  async getEntityReport(filters: EverflowReportFilters): Promise<EverflowReportRow[]> {
    if (!this.enabled) return [];

    const body: Record<string, unknown> = {
      from:        filters.startDate,
      to:          filters.endDate,
      timezone_id: 67,                              // America/Los_Angeles per Everflow's TZ table
      currency_id: "USD",
      columns: [
        { column: "offer" },
        { column: "affiliate" },
      ],
      query: {
        filters: [
          ...(filters.offerId
            ? [{ filter_id_value: String(filters.offerId), resource_type: "offer" }]
            : []),
          ...(filters.partnerIds && filters.partnerIds.length > 0
            ? filters.partnerIds.map((id) => ({
                filter_id_value: String(id),
                resource_type:   "affiliate",
              }))
            : []),
        ],
        settings: { mobile_app_kpis: false },
      },
    };

    const res = await this.post(`/reporting/entity`, body);
    if (!res) return [];

    // Everflow returns `{ table: [{ columns: [{column_type, label, id}], reporting: { ... metric fields ... } }] }`
    // We normalize into flat rows.
    const table: any[] = res.table ?? [];
    const rows: EverflowReportRow[] = [];
    for (const row of table) {
      const cols    = row.columns ?? [];
      const partner = cols.find((c: any) => c.column_type === "affiliate") ?? {};
      const offer   = cols.find((c: any) => c.column_type === "offer")     ?? {};
      const m       = row.reporting ?? row;
      rows.push({
        network_affiliate_id: Number(partner.id ?? 0),
        affiliate_name:       String(partner.label ?? ""),
        network_offer_id:     Number(offer.id ?? 0),
        offer_name:           String(offer.label ?? ""),
        conversions:          Number(m.cv ?? m.conversions ?? 0),
        payout:               Number(m.payout ?? 0),
        revenue:              Number(m.revenue ?? 0),
        profit:               Number(m.profit ?? (Number(m.revenue ?? 0) - Number(m.payout ?? 0))),
      });
    }
    return rows;
  }

  /**
   * High-level: total payouts for one offer over a date range, with a
   * partner-name exclusion filter applied client-side.
   */
  async getOfferPayouts(args: {
    offerId:               number;
    startDate:             string;
    endDate:               string;
    excludePartnerPatterns?: string[];
  }): Promise<EverflowOfferPayoutSummary | null> {
    if (!this.enabled) return null;

    const offer  = await this.getOffer(args.offerId);
    const rows   = await this.getEntityReport({
      offerId:   args.offerId,
      startDate: args.startDate,
      endDate:   args.endDate,
    });

    const patterns = (args.excludePartnerPatterns ?? []).map((p) => p.toLowerCase());
    const excluded: string[] = [];
    const kept = rows.filter((r) => {
      const name = r.affiliate_name.toLowerCase();
      const hit = patterns.some((p) => name.includes(p));
      if (hit) excluded.push(r.affiliate_name);
      return !hit;
    });

    return {
      offerId:          args.offerId,
      offerName:        offer?.name,
      startDate:        args.startDate,
      endDate:          args.endDate,
      totalPayout:      kept.reduce((s, r) => s + r.payout, 0),
      totalRevenue:     kept.reduce((s, r) => s + r.revenue, 0),
      totalConversions: kept.reduce((s, r) => s + r.conversions, 0),
      rowCount:         kept.length,
      perPartner: kept.map((r) => ({
        partnerId:   r.network_affiliate_id,
        partnerName: r.affiliate_name,
        payout:      r.payout,
        revenue:     r.revenue,
        conversions: r.conversions,
      })),
      excludedPartners: excluded.length > 0 ? excluded : undefined,
    };
  }

  // ─── HTTP helpers ──────────────────────────────────────────────────────────

  private get headers(): Record<string, string> {
    return {
      "Content-Type":   "application/json",
      "X-Eflow-API-Key": this.apiKey,
    };
  }

  async get(path: string): Promise<any | null> { return this.request("GET", path); }
  async post(path: string, body: unknown): Promise<any | null> { return this.request("POST", path, body); }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<any | null> {
    if (!this.enabled) return null;

    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const init: RequestInit = { method, headers: this.headers };
        if (body !== undefined) init.body = JSON.stringify(body);

        const res = await fetch(`${BASE_URL}${path}`, init);
        if (res.ok) return res.json();

        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
          const wait = Math.min(16000, 1000 * 2 ** (attempt - 1));
          logger.warn("EverflowClient: retrying", { method, path, status: res.status, attempt, waitMs: wait });
          await sleep(wait);
          continue;
        }
        const text = await res.text().catch(() => "");
        logger.warn("EverflowClient: request failed", { method, path, status: res.status, body: text.slice(0, 300) });
        return null;
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) {
          const wait = Math.min(16000, 1000 * 2 ** (attempt - 1));
          logger.warn("EverflowClient: network error — retrying", { method, path, attempt, waitMs: wait, error: String(err) });
          await sleep(wait);
          continue;
        }
        logger.warn("EverflowClient: request error (giving up)", { method, path, error: String(err) });
        return null;
      }
    }
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
