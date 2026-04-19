import { logger } from "../../core/logger";
import type {
  RingbaCallRecord,
  RingbaCampaign,
  RingbaCallLogOptions,
  RingbaTagDefinition,
} from "./types";

/**
 * Explicit /calllogs value columns we always want returned.
 *
 * The Ringba API has two modes: default (no valueColumns → returns ~50
 * fields) and strict (valueColumns → returns ONLY those). As soon as we
 * opt into valueColumns to get tags, we must also enumerate every base
 * field or we lose it. This list mirrors the fields that were in the
 * default response, plus a few extras (publisherId, publisherSubId, etc.)
 * that we were previously dropping but want to keep.
 */
/**
 * Ringba's `/tags` endpoint returns ONLY system-defined tag types
 * (Campaign, Publisher, Geo, Technology, Date, Time, InboundNumber, etc.).
 * It does NOT enumerate custom User:* tags even when they're populated on
 * the account — discovered empirically.
 *
 * To capture User:* tags on calls we have to ASK for them by name, so we
 * ship a list of common tracking params that every account is likely to
 * use. Additional account-specific names can be added via the
 * RINGBA_USER_TAGS env var (comma-separated).
 *
 * If Ringba doesn't actually have a value for one of these, it simply
 * isn't returned on the record — harmless. If a User:* tag is populated
 * but not in this list, it's silently dropped — add it via env.
 */
const DEFAULT_USER_TAG_NAMES: readonly string[] = [
  // Standard UTM parameters
  "utm_campaign", "utm_content", "utm_source", "utm_medium", "utm_term",
  "utm_id",
  // Common click / ad IDs
  "gclid", "wbraid", "gbraid",     // Google
  "fbclid", "fbp", "fbc",          // Meta
  "ttclid",                        // TikTok
  "msclkid",                       // Microsoft / Bing
  "yclid",                         // Yandex
  "twclid",                        // X / Twitter
  "li_fat_id",                     // LinkedIn
  // Generic / Elevarus-common
  "sub1", "sub2", "sub3", "sub4",
  "pub_id", "source", "campaign", "content", "medium", "keyword",
  "landing_page", "referrer", "affiliate_id", "aff_id", "clickid",
  "transaction_id",
];

function loadUserTagNames(): string[] {
  const extra = (process.env.RINGBA_USER_TAGS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set([...DEFAULT_USER_TAG_NAMES, ...extra])];
}

const BASE_VALUE_COLUMNS: readonly string[] = [
  // Identity
  "inboundCallId",
  "campaignId", "campaignName",
  "publisherId", "publisherSubId", "publisherName",
  "targetId", "targetName",
  "buyerId", "buyer",
  "targetNumber", "number", "numberId",
  "numberPoolId", "numberPoolName", "isFromNumberPool",
  // Timing
  "callDt", "callCompletedDt", "callConnectionDt",
  "callLengthInSeconds", "connectedCallLengthInSeconds",
  "timeToCallInSeconds", "timeToConnectInSeconds",
  // Status flags
  "hasConnected", "hasConverted", "hasPayout", "hasRecording", "hasRpcCalculation",
  "isDuplicate", "isLive", "hasPreviouslyConnected",
  // Reasons / meta
  "endCallSource", "noConversionReason", "noPayoutReason", "incompleteCallReason",
  "previouseCallDateTime", "previouseCallTargetName",
  // Money
  "conversionAmount", "payoutAmount", "profitNet", "profitGross",
  "totalCost", "telcoCost", "bidAmount",
  // Media
  "recordingUrl",
  // Ring tree / RTB
  "ringTreeWinningBidTargetName", "ringTreeWinningBidTargetId",
  "ringTreeWinningBid", "ringTreeWinningBidMinimumRevenueAmount",
  "ringTreeWinningBidDynamicDuration",
  "pingTotalBidAmount", "pingSuccessCount", "pingFailCount",
  "winningBid", "winningBidCallAccepted",
  "avgPingTreeBidAmount",
];

/**
 * Low-level Ringba REST API v2 client.
 *
 * Handles auth, pagination, and raw HTTP — nothing business-logic specific.
 * For report aggregation, use reports.ts instead.
 *
 * Auth:  Authorization: Token {apiKey}  (NOT Bearer — confirmed against live API)
 * Base:  https://api.ringba.com/v2/{accountId}/
 *
 * Key quirks (discovered via live API testing):
 *   - /callLogs caps at 20 records per request regardless of pageSize
 *   - Pagination uses `offset` (not page number)
 *   - campaignIds filter in request body is unreliable — filter client-side
 *   - Revenue field is `conversionAmount` (NOT profitNet + totalCost)
 *   - Paid call flag is `hasPayout` (maps to "Paid" column in Ringba UI)
 *
 * Env vars:
 *   RINGBA_API_KEY     — from Ringba → Security → API Access Tokens
 *   RINGBA_ACCOUNT_ID  — RA_XXXXXXXX, visible in app.ringba.com URL
 */
export class RingbaHttpClient {
  readonly enabled: boolean;
  readonly accountId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor() {
    this.apiKey    = process.env.RINGBA_API_KEY    ?? "";
    this.accountId = process.env.RINGBA_ACCOUNT_ID ?? "";
    this.enabled   = Boolean(this.apiKey && this.accountId);
    this.baseUrl   = `https://api.ringba.com/v2/${this.accountId}`;

    if (!this.enabled) {
      logger.info("RingbaHttpClient: not configured (set RINGBA_API_KEY + RINGBA_ACCOUNT_ID)");
    }
  }

  // ── Campaigns ──────────────────────────────────────────────────────────────

  async listCampaigns(): Promise<RingbaCampaign[]> {
    const res = await this.get("/campaigns");
    if (!res) return [];
    const items: any[] = Array.isArray(res) ? res : (res.campaigns ?? res.result ?? []);
    return items.map((c: any) => ({
      id:      c.id      ?? c.campaignId   ?? "",
      name:    c.name    ?? c.campaignName ?? "",
      enabled: c.enabled ?? true,
    }));
  }

  async findCampaignByName(name: string): Promise<RingbaCampaign | null> {
    const campaigns = await this.listCampaigns();
    return campaigns.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? null;
  }

  // ── Tags — discovery ───────────────────────────────────────────────────────

  /** Cached tag definition list. Refreshed lazily (see listTags()). */
  private tagCache: { at: number; tags: RingbaTagDefinition[] } | null = null;
  /** Tag definitions are stable per account — refresh hourly is plenty. */
  private static readonly TAG_CACHE_TTL_MS = 60 * 60 * 1000;

  /**
   * List every tag definition registered on this account. Tags are returned
   * by type + name — the /calllogs body references them as
   * `tag:{tagType}:{tagName}` in valueColumns.
   *
   * Cached to avoid hitting the endpoint on every sync tick. Set
   * `forceRefresh: true` to bypass.
   */
  async listTags(forceRefresh = false): Promise<RingbaTagDefinition[]> {
    if (!this.enabled) return [];
    if (!forceRefresh &&
        this.tagCache &&
        Date.now() - this.tagCache.at < RingbaHttpClient.TAG_CACHE_TTL_MS) {
      return this.tagCache.tags;
    }
    const res = await this.get("/tags");
    const items: unknown = res;
    const tags: RingbaTagDefinition[] = Array.isArray(items)
      ? items
          .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
          .map((t) => ({
            tagType:   String(t.tagType   ?? ""),
            tagName:   String(t.tagName   ?? ""),
            tagSource: String(t.tagSource ?? ""),
          }))
          .filter((t) => t.tagType && t.tagName)
      : [];
    this.tagCache = { at: Date.now(), tags };
    return tags;
  }

  // ── Call Logs — offset-paginated ──────────────────────────────────────────

  /**
   * Fetch ALL call logs for a date range via offset pagination.
   * The API caps at 20 records per request, so we loop automatically.
   * Client-side campaign filtering applied because API-side filter is unreliable.
   *
   * By default includes every tag discovered via `/tags` in the request so
   * tag values (including user-defined tags like utm_campaign) land in the
   * record's `tagValues` map.
   */
  async fetchCallLogs(opts: RingbaCallLogOptions): Promise<RingbaCallRecord[]> {
    if (!this.enabled) return [];

    const { startDate, endDate } = opts;

    // Build valueColumns: base fields + all enumerated tags + known User:* tags.
    //
    // Ringba's /tags endpoint only returns system-defined tag types (Campaign,
    // Publisher, Geo, etc.) — User:* tags are NOT enumerated there even when
    // populated. So we always request a known User:* tag list (UTMs, click
    // IDs, affiliate params) alongside the enumerated system tags. Values
    // Ringba doesn't have for a given call are simply omitted from the
    // response and parseRecord drops them — harmless.
    let valueColumns: string[];
    if (opts.valueColumns && opts.valueColumns.length > 0) {
      valueColumns = [...opts.valueColumns];
    } else {
      const columns = [...BASE_VALUE_COLUMNS];
      if (opts.includeTags !== false) {
        const tags = await this.listTags();
        for (const t of tags) {
          columns.push(`tag:${t.tagType}:${t.tagName}`);
        }
        for (const name of loadUserTagNames()) {
          columns.push(`tag:User:${name}`);
        }
      }
      valueColumns = columns;
    }

    const all: RingbaCallRecord[] = [];
    let offset = 0;
    let total  = Infinity;

    while (offset < total) {
      const res = await this.post("/calllogs", {
        reportStart: `${startDate}T00:00:00`,
        reportEnd:   `${endDate}T23:59:59`,
        offset,
        valueColumns: valueColumns.map((c) => ({ column: c })),
      });

      if (!res?.report) break;

      const records: unknown[] = res.report.records ?? [];
      total = res.report.totalCount ?? records.length;

      if (records.length === 0) break;

      const filtered = (records as Record<string, unknown>[]).filter((r) => {
        if (opts.campaignId   && r.campaignId   !== opts.campaignId)   return false;
        if (opts.campaignName &&
            String(r.campaignName ?? "").toLowerCase() !== opts.campaignName.toLowerCase()) return false;
        return true;
      });

      all.push(...filtered.map(this.parseRecord));
      offset += records.length;
    }

    return all;
  }

  // ── Record parser ─────────────────────────────────────────────────────────

  /**
   * Convert a raw /calllogs record into our RingbaCallRecord shape.
   *
   * - Every `tag:TagType:TagName` key is extracted into a flat `tagValues`
   *   map keyed `"TagType:TagName"` (prefix stripped). Tags that Ringba
   *   didn't return (empty value) are still captured as empty strings; the
   *   sync layer drops empties when writing to Supabase.
   * - The untouched raw record is preserved on `rawRecord` and used as the
   *   `raw` JSONB value in the DB row — nothing silently dropped.
   */
  private parseRecord = (r: Record<string, unknown>): RingbaCallRecord => {
    const tagValues: Record<string, string> = {};
    for (const [k, v] of Object.entries(r)) {
      if (!k.startsWith("tag:")) continue;
      const key = k.slice(4); // strip "tag:" → "TagType:TagName"
      if (v === null || v === undefined) continue;
      const s = String(v);
      if (s.length === 0) continue;
      tagValues[key] = s;
    }

    const asStr   = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
    const asNum   = (v: unknown): number => {
      const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
      return Number.isFinite(n) ? n : 0;
    };
    const asBool  = (v: unknown): boolean => v === true || v === "true";
    const asStrOrNull = (v: unknown): string | null => {
      if (v === null || v === undefined || v === "") return null;
      return String(v);
    };

    return {
      inboundCallId:                asStr(r.inboundCallId),
      campaignId:                   asStr(r.campaignId),
      campaignName:                 asStr(r.campaignName),
      publisherId:                  asStr(r.publisherId)     || undefined,
      publisherSubId:               asStr(r.publisherSubId)  || undefined,
      publisherName:                asStr(r.publisherName),
      targetId:                     asStr(r.targetId)        || undefined,
      targetName:                   asStrOrNull(r.targetName),
      buyerId:                      asStr(r.buyerId)         || undefined,
      buyer:                        asStrOrNull(r.buyer),
      inboundPhoneNumber:           asStr(r.inboundPhoneNumber),
      callDt:                       typeof r.callDt === "number" ? r.callDt : asNum(r.callDt),
      callLengthInSeconds:          asNum(r.callLengthInSeconds),
      connectedCallLengthInSeconds: asNum(r.connectedCallLengthInSeconds),
      hasConnected:                 asBool(r.hasConnected),
      hasConverted:                 asBool(r.hasConverted),
      hasPayout:                    asBool(r.hasPayout),
      noConversionReason:           asStrOrNull(r.noConversionReason),
      conversionAmount:             asNum(r.conversionAmount),
      payoutAmount:                 asNum(r.payoutAmount),
      profitNet:                    asNum(r.profitNet),
      totalCost:                    asNum(r.totalCost),
      isDuplicate:                  asBool(r.isDuplicate),
      isLive:                       asBool(r.isLive),
      recordingUrl:                 asStr(r.recordingUrl) || undefined,
      tagValues,
      rawRecord:                    r,
    };
  };

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private get headers(): Record<string, string> {
    return {
      "Content-Type":  "application/json",
      "Authorization": `Token ${this.apiKey}`,
    };
  }

  async get(path: string): Promise<any | null> {
    return this.request("GET", path);
  }

  async post(path: string, body: unknown): Promise<any | null> {
    return this.request("POST", path, body);
  }

  /**
   * Shared request helper with 429/5xx retry and exponential backoff.
   * Used by GET /campaigns and POST /callLogs; the latter is paginated, so
   * retrying at the request level keeps the outer loop simple.
   */
  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<any | null> {
    if (!this.enabled) return null;

    const MAX_ATTEMPTS = 6;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const init: RequestInit = { method, headers: this.headers };
        if (body !== undefined) init.body = JSON.stringify(body);

        const res = await fetch(`${this.baseUrl}${path}`, init);
        if (res.ok) return res.json();

        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
          const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
          const backoff = Math.min(32000, 2000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
          const waitMs = Math.max(retryAfter, backoff);
          logger.warn("RingbaHttpClient: retrying", {
            method, path, status: res.status, attempt, waitMs,
          });
          await sleep(waitMs);
          continue;
        }

        const text = await res.text().catch(() => "");
        logger.warn("RingbaHttpClient: request failed", {
          method, path, status: res.status, attempt,
          body: text.slice(0, 300),
        });
        return null;
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) {
          const waitMs = Math.min(32000, 2000 * 2 ** (attempt - 1));
          logger.warn("RingbaHttpClient: network error — retrying", {
            method, path, attempt, waitMs, error: String(err),
          });
          await sleep(waitMs);
          continue;
        }
        logger.warn("RingbaHttpClient: request error (giving up)", { method, path, attempt, error: String(err) });
        return null;
      }
    }
    return null;
  }
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
