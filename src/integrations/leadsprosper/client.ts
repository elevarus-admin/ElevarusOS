import { logger } from "../../core/logger";
import type {
  LPCampaign,
  LPLead,
  LPLeadsPage,
  LPListLeadsOptions,
} from "./types";

/**
 * Low-level LeadsProsper REST API client.
 *
 * Handles auth, pagination cursors, and raw HTTP — no business logic.
 * Workflows should not call this directly; use LeadsProsperRepository to read
 * from Supabase, which the sync worker keeps up to date.
 *
 * Auth:  Authorization: Bearer {apiKey}
 * Base:  https://api.leadprosper.io/public
 *
 * Env vars:
 *   LEADSPROSPER_API_KEY  — from LP dashboard → Developer API Key
 */
export class LeadsProsperClient {
  readonly enabled: boolean;
  private readonly baseUrl = "https://api.leadprosper.io/public";
  private readonly apiKey: string;

  constructor() {
    this.apiKey  = process.env.LEADSPROSPER_API_KEY ?? "";
    this.enabled = Boolean(this.apiKey);

    if (!this.enabled) {
      logger.info("LeadsProsperClient: not configured (set LEADSPROSPER_API_KEY)");
    }
  }

  // ── Campaigns ──────────────────────────────────────────────────────────────

  /** All campaigns the account has access to. No pagination — LP returns all. */
  async listCampaigns(): Promise<LPCampaign[]> {
    const res = await this.get<LPCampaign[] | { campaigns: LPCampaign[] }>("/campaigns");
    if (!res) return [];
    return Array.isArray(res) ? res : (res.campaigns ?? []);
  }

  // ── Leads — cursor-paginated via `search_after` ───────────────────────────

  /**
   * Fetch ALL leads matching opts, auto-paginating until LP stops returning a
   * `search_after` cursor. Results cap at 100 per page on LP's side.
   *
   * LP requires `timezone`, `start_date`, `end_date`, and `campaign` for the
   * `/leads` endpoint. If no campaignId is passed, we iterate over every
   * campaign — LP does not support a "no campaign filter" mode.
   */
  async fetchAllLeads(opts: LPListLeadsOptions): Promise<LPLead[]> {
    if (!this.enabled) return [];

    if (opts.campaignId === undefined) {
      const campaigns = await this.listCampaigns();
      const out: LPLead[] = [];
      for (const c of campaigns) {
        const leads = await this.fetchAllLeads({ ...opts, campaignId: c.id });
        out.push(...leads);
      }
      return out;
    }

    const all: LPLead[] = [];
    let cursor: string | undefined;

    // Hard cap on pages to avoid runaway loops on a buggy response.
    for (let page = 0; page < 500; page++) {
      const res = await this.listLeadsPage({ ...opts, searchAfter: cursor });
      if (!res) break;

      all.push(...res.leads);

      if (!res.search_after || res.leads.length === 0) break;
      cursor = res.search_after;
    }

    return all;
  }

  async listLeadsPage(
    opts: LPListLeadsOptions & { searchAfter?: string },
  ): Promise<LPLeadsPage | null> {
    if (!this.enabled) return null;
    if (opts.campaignId === undefined) {
      throw new Error("listLeadsPage requires campaignId — use fetchAllLeads to iterate all campaigns");
    }

    const params = new URLSearchParams({
      start_date: opts.startDate,
      end_date:   opts.endDate,
      campaign:   String(opts.campaignId),
      timezone:   opts.timezone ?? "UTC",
    });
    if (opts.status)      params.set("status", opts.status);
    if (opts.searchAfter) params.set("search_after", opts.searchAfter);

    return this.get<LPLeadsPage>(`/leads?${params.toString()}`);
  }

  async getLead(leadId: string): Promise<LPLead | null> {
    return this.get<LPLead>(`/lead/${encodeURIComponent(leadId)}`);
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private get headers(): Record<string, string> {
    return {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${this.apiKey}`,
    };
  }

  async get<T>(path: string): Promise<T | null> {
    if (!this.enabled) return null;

    // Retry on 429 (rate limit) and 5xx with exponential backoff + jitter.
    // LP does not document rate limits but returns 429 under burst load; the
    // backfill's 15-campaigns × N-pages pattern reliably trips them.
    const MAX_ATTEMPTS = 6;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers });

        if (res.ok) return (await res.json()) as T;

        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
          const retryAfterHeader = res.headers.get("retry-after");
          const retryAfterMs = parseRetryAfter(retryAfterHeader);
          // Exponential: 2s, 4s, 8s, 16s, 32s — plus up to 500ms jitter.
          const backoffMs = Math.min(32000, 2000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
          const waitMs = Math.max(retryAfterMs, backoffMs);
          logger.warn("LeadsProsperClient: retrying", {
            path,
            status:      res.status,
            attempt,
            nextAttempt: attempt + 1,
            waitMs,
            retryAfter:  retryAfterHeader,
          });
          await sleep(waitMs);
          continue;
        }

        const body = await res.text().catch(() => "");
        logger.warn("LeadsProsperClient: GET failed", {
          path,
          status:  res.status,
          attempt,
          body:    body.slice(0, 300),
        });
        return null;
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) {
          const waitMs = Math.min(32000, 2000 * 2 ** (attempt - 1));
          logger.warn("LeadsProsperClient: network error — retrying", { path, attempt, waitMs, error: String(err) });
          await sleep(waitMs);
          continue;
        }
        logger.warn("LeadsProsperClient: GET error (giving up)", { path, attempt, error: String(err) });
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
