import { logger } from "../../core/logger";
import type {
  GoogleAdsCustomerSummary,
  GoogleAdsDailyMetric,
  GoogleAdsCampaignMetric,
} from "./types";

const API_VERSION = "v21";
const API_BASE    = `https://googleads.googleapis.com/${API_VERSION}`;
const TOKEN_URL   = "https://oauth2.googleapis.com/token";

/**
 * Low-level Google Ads API client.
 *
 * Wraps OAuth refresh-token flow + GAQL searchStream over raw fetch (no SDK).
 * Auth headers on every request:
 *   Authorization:       Bearer <access_token>     (refreshed lazily, cached)
 *   developer-token:     <dev_token>               (from MCC API Center)
 *   login-customer-id:   <MCC ID, no dashes>       (scopes to manager hierarchy)
 *
 * Pattern mirrors src/integrations/meta/client.ts — methods no-op when not
 * configured (return [] / null) and never throw at construction time.
 */
export class GoogleAdsClient {
  readonly enabled: boolean;
  private readonly devToken:     string;
  private readonly clientId:     string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;
  private readonly mccId:        string;

  // Access-token cache (Google access tokens last ~1 hour).
  private accessToken: string | null = null;
  private accessTokenExpiresAt:    number = 0;

  constructor() {
    this.devToken     = process.env.GOOGLE_ADS_DEVELOPER_TOKEN     ?? "";
    this.clientId     = process.env.GOOGLE_ADS_CLIENT_ID           ?? "";
    this.clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET       ?? "";
    this.refreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN       ?? "";
    this.mccId        = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID   ?? "";

    this.enabled = Boolean(
      this.devToken && this.clientId && this.clientSecret && this.refreshToken && this.mccId
    );

    if (!this.enabled) {
      logger.info("GoogleAdsClient: not configured (set GOOGLE_ADS_* env vars)");
    }
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.accessTokenExpiresAt - 60_000) {
      return this.accessToken;
    }

    const body = new URLSearchParams({
      client_id:     this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type:    "refresh_token",
    });

    const res = await fetch(TOKEN_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    body.toString(),
    });
    const json = await res.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string };

    if (!res.ok || !json.access_token) {
      throw new Error(`Google Ads token refresh failed: ${json.error ?? res.status} ${json.error_description ?? ""}`);
    }

    this.accessToken          = json.access_token;
    this.accessTokenExpiresAt = now + ((json.expires_in ?? 3600) * 1000);
    return this.accessToken;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    return {
      Authorization:       `Bearer ${token}`,
      "developer-token":   this.devToken,
      "login-customer-id": this.mccId,
      "Content-Type":      "application/json",
    };
  }

  // ── Account discovery ────────────────────────────────────────────────────

  /**
   * Enumerate every customer client (sub-account) under the configured MCC.
   *
   * GAQL against `customer_client` from the MCC's perspective. Returns the
   * MCC itself at level 0 plus every descendant. Use the `manager` flag to
   * separate sub-MCCs from leaf advertiser accounts.
   */
  async listCustomerClients(): Promise<GoogleAdsCustomerSummary[]> {
    if (!this.enabled) return [];

    const query = `
      SELECT
        customer_client.id,
        customer_client.descriptive_name,
        customer_client.manager,
        customer_client.level,
        customer_client.currency_code,
        customer_client.time_zone,
        customer_client.status
      FROM customer_client
    `.replace(/\s+/g, " ").trim();

    const rows = await this.searchStream(this.mccId, query);
    return rows.map((row) => {
      const c = row.customerClient ?? {};
      return {
        customerId:      String(c.id ?? ""),
        descriptiveName: c.descriptiveName ?? null,
        manager:         Boolean(c.manager),
        parentManagerId: this.mccId,           // every row is under the MCC
        level:           Number(c.level ?? 0),
        currencyCode:    c.currencyCode ?? null,
        timeZone:        c.timeZone ?? null,
        status:          c.status ?? null,
      } satisfies GoogleAdsCustomerSummary;
    });
  }

  // ── Reporting (live, when sync is stale or for "today" queries) ──────────

  /**
   * Pull daily account-level metrics for one customer over a date range.
   * Used by the sync worker AND the live `today_spend` tool.
   */
  async fetchDailyMetrics(
    customerId: string,
    startDate:  string,
    endDate:    string,
  ): Promise<GoogleAdsDailyMetric[]> {
    if (!this.enabled) return [];

    const query = `
      SELECT
        segments.date,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.conversions,
        metrics.conversions_value,
        metrics.ctr,
        metrics.average_cpc
      FROM customer
      WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
    `.replace(/\s+/g, " ").trim();

    const rows = await this.searchStream(customerId, query);
    return rows.map((row) => {
      const m = row.metrics  ?? {};
      const s = row.segments ?? {};
      return {
        customerId,
        date:             String(s.date ?? startDate),
        cost:             microsToDollars(m.costMicros),
        impressions:      Number(m.impressions ?? 0),
        clicks:           Number(m.clicks      ?? 0),
        conversions:      Number(m.conversions ?? 0),
        conversionsValue: Number(m.conversionsValue ?? 0),
        ctr:              Number(m.ctr        ?? 0),
        avgCpc:           microsToDollars(m.averageCpc),
      } satisfies GoogleAdsDailyMetric;
    });
  }

  /**
   * Pull daily campaign-level metrics for one customer over a date range.
   */
  async fetchCampaignMetrics(
    customerId: string,
    startDate:  string,
    endDate:    string,
  ): Promise<GoogleAdsCampaignMetric[]> {
    if (!this.enabled) return [];

    const query = `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        segments.date,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.conversions,
        metrics.conversions_value
      FROM campaign
      WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
    `.replace(/\s+/g, " ").trim();

    const rows = await this.searchStream(customerId, query);
    return rows.map((row) => {
      const c = row.campaign ?? {};
      const m = row.metrics  ?? {};
      const s = row.segments ?? {};
      return {
        customerId,
        campaignId:       String(c.id ?? ""),
        campaignName:     c.name   ?? null,
        campaignStatus:   c.status ?? null,
        date:             String(s.date ?? startDate),
        cost:             microsToDollars(m.costMicros),
        impressions:      Number(m.impressions ?? 0),
        clicks:           Number(m.clicks      ?? 0),
        conversions:      Number(m.conversions ?? 0),
        conversionsValue: Number(m.conversionsValue ?? 0),
      } satisfies GoogleAdsCampaignMetric;
    });
  }

  // ── HTTP / GAQL ──────────────────────────────────────────────────────────

  /**
   * Issue a GAQL query via :searchStream against one customer.
   * Returns a flat array of row objects (concatenated across stream chunks).
   */
  private async searchStream(customerId: string, query: string): Promise<any[]> {
    const headers = await this.authHeaders();
    const url     = `${API_BASE}/customers/${customerId}/googleAds:searchStream`;

    const res  = await fetch(url, {
      method:  "POST",
      headers,
      body:    JSON.stringify({ query }),
    });
    const json = await res.json() as Array<{ results?: any[] }> | { error?: { message?: string; code?: number; status?: string } };

    if (!res.ok) {
      const errMsg = (json as any)?.error?.message ?? JSON.stringify(json);
      logger.warn("GoogleAdsClient: searchStream failed", {
        customerId,
        status:  res.status,
        message: String(errMsg).slice(0, 300),
      });
      throw new Error(`Google Ads searchStream ${customerId}: ${res.status} — ${errMsg}`);
    }

    const chunks = Array.isArray(json) ? json : [];
    const out: any[] = [];
    for (const chunk of chunks) {
      for (const row of chunk.results ?? []) out.push(row);
    }
    return out;
  }
}

/** Google's micros → dollars conversion. cost_micros is int64 string in JSON. */
function microsToDollars(micros: unknown): number {
  if (micros === null || micros === undefined) return 0;
  const n = typeof micros === "string" ? parseInt(micros, 10) : Number(micros);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n / 1_000_000) * 100) / 100;
}
