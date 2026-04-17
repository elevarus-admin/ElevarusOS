import { logger } from "../../core/logger";
import type { MetaInsightRecord, MetaSpendOptions } from "./types";

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
