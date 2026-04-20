import { logger } from "../../core/logger";
import type {
  MetaInsightRecord,
  MetaSpendOptions,
  MetaAdAccountSummary,
  MetaQueryOptions,
  MetaQueryRow,
  MetaInsightLevel,
} from "./types";

/** Meta's numeric `account_status` → human label. */
const ACCOUNT_STATUS_LABELS: Record<number, string> = {
  1:   "active",
  2:   "disabled",
  3:   "unsettled",
  7:   "pending_risk_review",
  9:   "in_grace_period",
  100: "pending_closure",
  101: "closed",
  102: "pending_settlement",
};

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE        = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

/**
 * Low-level Meta Graph API client.
 *
 * Handles auth, pagination, and raw HTTP — nothing business-logic specific.
 * For aggregated spend reports, use reports.ts instead.
 *
 * Auth:   ?access_token={token}  (System User token from Meta Business Manager)
 * Base:   https://graph.facebook.com/v21.0/
 *
 * Key notes:
 *   - Ad account IDs are passed without the "act_" prefix in instance.md;
 *     the client prepends it when building the URL.
 *   - The Insights API returns spend as a string (e.g. "1234.56") — parsed to float.
 *   - Pagination uses cursor-based `after` from paging.cursors.after.
 *   - `level=account` aggregates all campaigns; `level=campaign` breaks them out.
 *   - `time_range` takes { since, until } in YYYY-MM-DD format.
 *
 * Env vars:
 *   META_ACCESS_TOKEN — System User token from Meta Business Manager.
 *                       One token can read multiple ad accounts as long as the
 *                       System User has been granted access to each account.
 */
export class MetaAdsClient {
  readonly enabled: boolean;
  private readonly accessToken: string;

  constructor() {
    this.accessToken = process.env.META_ACCESS_TOKEN ?? "";
    this.enabled     = Boolean(this.accessToken);

    if (!this.enabled) {
      logger.info("MetaAdsClient: not configured (set META_ACCESS_TOKEN)");
    }
  }

  // ── Ad account discovery ──────────────────────────────────────────────────

  /**
   * List every ad account the configured System User token can access.
   *
   * GET /me/adaccounts
   * https://developers.facebook.com/docs/marketing-api/reference/user/adaccounts/
   *
   * Use this to discover accounts before wiring them into an instance.md
   * `meta.adAccountId` field. The returned `accountId` is already stripped
   * of the `act_` prefix and ready to drop into config.
   *
   * Pages 200 at a time; loops until exhausted.
   */
  async listAdAccounts(): Promise<MetaAdAccountSummary[]> {
    if (!this.enabled) return [];

    const params = new URLSearchParams({
      fields:       "account_id,name,account_status,currency,timezone_name,business_name,amount_spent",
      limit:        "200",
      access_token: this.accessToken,
    });

    const all: MetaAdAccountSummary[] = [];
    let nextUrl: string | null = `${GRAPH_BASE}/me/adaccounts?${params.toString()}`;

    while (nextUrl) {
      const data = await this.getUrl(nextUrl);
      if (!data) break;
      const rows: any[] = data.data ?? [];
      for (const r of rows) {
        const statusCode = Number(r.account_status ?? 0);
        all.push({
          accountId:     String(r.account_id ?? ""),
          name:          String(r.name ?? ""),
          businessName:  r.business_name ? String(r.business_name) : null,
          accountStatus: statusCode,
          status:        ACCOUNT_STATUS_LABELS[statusCode] ?? `unknown(${statusCode})`,
          currency:      String(r.currency ?? ""),
          timezone:      String(r.timezone_name ?? ""),
          amountSpent:   r.amount_spent ? String(r.amount_spent) : undefined,
        });
      }
      nextUrl = data.paging?.next ?? null;
    }

    return all;
  }

  // ── Insights ───────────────────────────────────────────────────────────────

  /**
   * Fetch account-level or campaign-level insights for a date range.
   *
   * When campaignIds is empty, level=account is used to get total account spend.
   * When campaignIds are provided, level=campaign is used and results are
   * filtered client-side to only the requested campaigns.
   */
  async fetchInsights(opts: MetaSpendOptions): Promise<MetaInsightRecord[]> {
    if (!this.enabled) return [];

    const level = opts.campaignIds?.length ? "campaign" : "account";

    const params = new URLSearchParams({
      fields:       "spend,impressions,clicks,reach,cpm,cpc,ctr",
      level,
      time_range:   JSON.stringify({ since: opts.startDate, until: opts.endDate }),
      access_token: this.accessToken,
      limit:        "500",
    });

    const url  = `${GRAPH_BASE}/act_${opts.adAccountId}/insights`;
    const all: MetaInsightRecord[] = [];
    let   nextUrl: string | null   = `${url}?${params.toString()}`;

    while (nextUrl) {
      const data = await this.getUrl(nextUrl);
      if (!data) break;

      const rows: any[] = data.data ?? [];

      for (const row of rows) {
        // Campaign-level filter (client-side, belt-and-suspenders)
        if (opts.campaignIds?.length && row.campaign_id) {
          if (!opts.campaignIds.includes(row.campaign_id)) continue;
        }

        all.push({
          spend:       parseFloat(row.spend       ?? "0") || 0,
          impressions: parseInt(  row.impressions  ?? "0", 10) || 0,
          clicks:      parseInt(  row.clicks       ?? "0", 10) || 0,
          reach:       parseInt(  row.reach        ?? "0", 10) || 0,
          cpm:         parseFloat(row.cpm          ?? "0") || 0,
          cpc:         parseFloat(row.cpc          ?? "0") || 0,
          ctr:         parseFloat(row.ctr          ?? "0") || 0,
          dateStart:   row.date_start ?? opts.startDate,
          dateStop:    row.date_stop  ?? opts.endDate,
        });
      }

      // Cursor-based pagination
      nextUrl = data.paging?.next ?? null;
    }

    return all;
  }

  /**
   * Per-campaign / per-ad-set / per-ad insights for a date range.
   *
   * This is the flexible counterpart to `fetchInsights`: supports all four
   * Meta levels (account | campaign | adset | ad), custom field lists,
   * breakdowns, and server-side campaign/ad filtering. Use for
   * "which ad has the best CPC" style questions that need a breakout
   * rather than an account total.
   *
   * Pagination handled internally via `paging.next`. Hard row ceiling is
   * the caller's `limit` (default 100). For most accounts, a single page
   * (500 rows) suffices for any level=campaign|adset date range.
   */
  async queryInsights(opts: MetaQueryOptions): Promise<MetaQueryRow[]> {
    if (!this.enabled) return [];

    const level  = opts.level ?? "campaign";
    const fields = resolveFields(level, opts.fields);
    const limit  = Math.min(opts.limit ?? 100, 500);

    const params = new URLSearchParams({
      fields:       fields.join(","),
      level,
      time_range:   JSON.stringify({ since: opts.startDate, until: opts.endDate }),
      access_token: this.accessToken,
      limit:        String(limit),
    });
    if (opts.breakdowns && opts.breakdowns.length > 0) {
      params.set("breakdowns", opts.breakdowns.join(","));
    }
    // Server-side filtering — Meta expects JSON-encoded filtering array
    const filters: Array<{ field: string; operator: string; value: string[] }> = [];
    if (opts.campaignIds && opts.campaignIds.length > 0) {
      filters.push({ field: "campaign.id", operator: "IN", value: opts.campaignIds });
    }
    if (opts.adIds && opts.adIds.length > 0) {
      filters.push({ field: "ad.id", operator: "IN", value: opts.adIds });
    }
    if (filters.length > 0) {
      params.set("filtering", JSON.stringify(filters));
    }

    const url = `${GRAPH_BASE}/act_${opts.adAccountId}/insights`;
    const all: MetaQueryRow[] = [];
    let nextUrl: string | null = `${url}?${params.toString()}`;

    while (nextUrl && all.length < limit) {
      const data = await this.getUrl(nextUrl);
      if (!data) break;
      const rows: any[] = data.data ?? [];

      for (const r of rows) {
        if (all.length >= limit) break;
        all.push(normalizeRow(r, level));
      }

      nextUrl = data.paging?.next ?? null;
    }

    return all;
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private async getUrl(url: string): Promise<any | null> {
    try {
      const res = await fetch(url);
      const json = await res.json() as any;

      if (!res.ok || json.error) {
        logger.warn("MetaAdsClient: API error", {
          status:  res.status,
          code:    json.error?.code,
          message: json.error?.message?.slice(0, 200),
        });
        return null;
      }

      return json;
    } catch (err) {
      logger.warn("MetaAdsClient: fetch error", { url: url.slice(0, 80), error: String(err) });
      return null;
    }
  }
}

// ─── Helpers for queryInsights ───────────────────────────────────────────────

/** Default field list per level. Identity fields are always included. */
function defaultFieldsForLevel(level: MetaInsightLevel): string[] {
  const core = ["spend", "impressions", "clicks", "reach", "frequency", "ctr", "cpc", "cpm"];
  if (level === "account")  return [...core];
  if (level === "campaign") return [...core, "campaign_id", "campaign_name"];
  if (level === "adset")    return [...core, "campaign_id", "campaign_name", "adset_id", "adset_name"];
  return [...core, "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name"];
}

/** Caller fields + the identity fields needed to interpret the row. */
function resolveFields(level: MetaInsightLevel, caller?: string[]): string[] {
  const defaults = defaultFieldsForLevel(level);
  if (!caller || caller.length === 0) return defaults;
  const required: string[] = [];
  if (level === "campaign" || level === "adset" || level === "ad") {
    required.push("campaign_id", "campaign_name");
  }
  if (level === "adset" || level === "ad") {
    required.push("adset_id", "adset_name");
  }
  if (level === "ad") {
    required.push("ad_id", "ad_name");
  }
  return [...new Set([...required, ...caller])];
}

/** Coerce Meta's stringy numerics and split known identity fields off `extras`. */
function normalizeRow(r: any, level: MetaInsightLevel): MetaQueryRow {
  const asNum = (v: unknown): number | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    const n = parseFloat(String(v));
    return Number.isFinite(n) ? n : undefined;
  };
  const asInt = (v: unknown): number | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) ? n : undefined;
  };

  const known = new Set([
    "date_start", "date_stop", "account_id",
    "campaign_id", "campaign_name", "adset_id", "adset_name", "ad_id", "ad_name",
    "spend", "impressions", "clicks", "reach", "frequency", "ctr", "cpc", "cpm",
  ]);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (!known.has(k)) extras[k] = v;
  }

  return {
    level,
    date_start:     String(r.date_start ?? ""),
    date_stop:      String(r.date_stop  ?? ""),
    account_id:     r.account_id      ? String(r.account_id)      : undefined,
    campaign_id:    r.campaign_id     ? String(r.campaign_id)     : undefined,
    campaign_name:  r.campaign_name   ? String(r.campaign_name)   : undefined,
    adset_id:       r.adset_id        ? String(r.adset_id)        : undefined,
    adset_name:     r.adset_name      ? String(r.adset_name)      : undefined,
    ad_id:          r.ad_id           ? String(r.ad_id)           : undefined,
    ad_name:        r.ad_name         ? String(r.ad_name)         : undefined,
    spend:          asNum(r.spend),
    impressions:    asInt(r.impressions),
    clicks:         asInt(r.clicks),
    reach:          asInt(r.reach),
    frequency:      asNum(r.frequency),
    ctr:            asNum(r.ctr),
    cpc:            asNum(r.cpc),
    cpm:            asNum(r.cpm),
    extras:         Object.keys(extras).length > 0 ? extras : undefined,
  };
}
