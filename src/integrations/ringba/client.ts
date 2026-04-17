import { logger } from "../../core/logger";
import type {
  RingbaCallRecord,
  RingbaCampaign,
  RingbaCallLogOptions,
} from "./types";

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

  // ── Call Logs — offset-paginated ──────────────────────────────────────────

  /**
   * Fetch ALL call logs for a date range via offset pagination.
   * The API caps at 20 records per request, so we loop automatically.
   * Client-side campaign filtering applied because API-side filter is unreliable.
   */
  async fetchCallLogs(opts: RingbaCallLogOptions): Promise<RingbaCallRecord[]> {
    if (!this.enabled) return [];

    const { startDate, endDate } = opts;
    const all: RingbaCallRecord[] = [];
    let offset = 0;
    let total  = Infinity;

    while (offset < total) {
      const res = await this.post("/callLogs", {
        reportStart: `${startDate}T00:00:00`,
        reportEnd:   `${endDate}T23:59:59`,
        page:        0,
        offset,
      });

      if (!res?.report) break;

      const records: any[] = res.report.records ?? [];
      total = res.report.totalCount ?? records.length;

      if (records.length === 0) break;

      const filtered = records.filter((r) => {
        if (opts.campaignId   && r.campaignId   !== opts.campaignId)   return false;
        if (opts.campaignName && r.campaignName?.toLowerCase() !== opts.campaignName.toLowerCase()) return false;
        return true;
      });

      all.push(...filtered.map(this.parseRecord));
      offset += records.length;
    }

    return all;
  }

  // ── Record parser ─────────────────────────────────────────────────────────

  private parseRecord = (r: any): RingbaCallRecord => ({
    inboundCallId:                r.inboundCallId                ?? "",
    campaignId:                   r.campaignId                   ?? "",
    campaignName:                 r.campaignName                 ?? "",
    inboundPhoneNumber:           r.inboundPhoneNumber           ?? "",
    callDt:                       r.callDt                       ?? 0,
    callLengthInSeconds:          r.callLengthInSeconds          ?? 0,
    connectedCallLengthInSeconds: r.connectedCallLengthInSeconds ?? 0,
    hasConnected:                 r.hasConnected                 ?? false,
    hasConverted:                 r.hasConverted                 ?? false,
    hasPayout:                    r.hasPayout                    ?? false,
    noConversionReason:           r.noConversionReason           ?? null,
    conversionAmount:             parseFloat(r.conversionAmount  ?? "0") || 0,
    payoutAmount:                 parseFloat(r.payoutAmount      ?? "0") || 0,
    profitNet:                    parseFloat(r.profitNet         ?? "0") || 0,
    totalCost:                    parseFloat(r.totalCost         ?? "0") || 0,
    buyer:                        r.buyer                        ?? null,
    targetName:                   r.targetName                   ?? null,
    publisherName:                r.publisherName                ?? "",
    isDuplicate:                  r.isDuplicate                  ?? false,
    isLive:                       r.isLive                       ?? false,
    recordingUrl:                 r.recordingUrl                 ?? undefined,
  });

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
