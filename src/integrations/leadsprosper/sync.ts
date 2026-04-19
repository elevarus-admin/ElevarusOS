import cron, { ScheduledTask } from "node-cron";
import { logger } from "../../core/logger";
import { LeadsProsperClient } from "./client";
import { LeadsProsperRepository } from "./repository";

/**
 * LeadsProsperSyncWorker
 *
 * Keeps Supabase in sync with LeadsProsper:
 *   - Full campaign-list refresh (cheap, runs every tick)
 *   - Incremental lead pull for all campaigns, over a sliding window that
 *     starts at `(high_water_mark - overlap)` and ends at `now`.
 *
 * The overlap is intentional — LP updates lead records post-hoc (e.g. when a
 * buyer accepts or rejects after the initial POST). Re-pulling the last few
 * minutes of leads on every tick ensures we capture those revisions.
 *
 * Graceful behavior:
 *   - If LEADSPROSPER_API_KEY is missing → worker logs and exits cleanly.
 *   - If Supabase is missing           → worker logs and exits cleanly.
 *   - If a sync tick errors            → logs, updates `last_error`, moves on.
 *     (We do not advance the high-water mark on error, so the next tick retries.)
 */
export class LeadsProsperSyncWorker {
  readonly enabled: boolean;

  private readonly client = new LeadsProsperClient();
  private readonly repo   = new LeadsProsperRepository();
  private readonly cronExpr:    string;
  private readonly overlapMs:   number;
  private readonly lookbackDays: number;
  private readonly syncKeyLeads     = "leads:global";
  private readonly syncKeyCampaigns = "campaigns:global";

  private task: ScheduledTask | null = null;
  private running = false;
  private inFlight = false;

  constructor(opts: {
    cronExpr?:     string;   // default: every hour at :00
    overlapMs?:    number;   // default: 90 minutes re-pull overlap (covers hourly cadence + LP post-route adjustments)
    lookbackDays?: number;   // default: 3 — cold-start window when no high-water mark
  } = {}) {
    this.cronExpr     = opts.cronExpr     ?? "0 * * * *";
    this.overlapMs    = opts.overlapMs    ?? 90 * 60 * 1000;
    this.lookbackDays = opts.lookbackDays ?? 3;
    this.enabled      = this.client.enabled && this.repo.enabled;

    if (!this.enabled) {
      logger.info("LeadsProsperSyncWorker: not enabled", {
        client:   this.client.enabled,
        supabase: this.repo.enabled,
      });
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (!this.enabled || this.running) return;

    if (!cron.validate(this.cronExpr)) {
      logger.warn("LeadsProsperSyncWorker: invalid cron expression — worker not started", {
        cronExpr: this.cronExpr,
      });
      return;
    }

    this.task = cron.schedule(this.cronExpr, () => {
      void this.runOnce().catch((err) => {
        logger.error("LeadsProsperSyncWorker: tick failed", { error: String(err) });
      });
    });
    this.running = true;

    logger.info("LeadsProsperSyncWorker started", { cronExpr: this.cronExpr });

    // Run once immediately so we don't wait 15 min after boot for first data.
    void this.runOnce().catch((err) => {
      logger.error("LeadsProsperSyncWorker: initial run failed", { error: String(err) });
    });
  }

  stop(): void {
    this.task?.stop();
    this.task    = null;
    this.running = false;
    logger.info("LeadsProsperSyncWorker stopped");
  }

  // ── Core sync ─────────────────────────────────────────────────────────────

  /**
   * One full sync tick. Safe to call manually (e.g. from a CLI or test).
   * Guards against overlapping runs — if a previous tick is still in flight,
   * this call is a no-op.
   */
  async runOnce(): Promise<void> {
    if (!this.enabled) return;
    if (this.inFlight) {
      logger.debug("LeadsProsperSyncWorker: skipping tick — previous run still in flight");
      return;
    }
    this.inFlight = true;
    try {
      await this.syncCampaigns();
      await this.syncLeads();
    } finally {
      this.inFlight = false;
    }
  }

  private async syncCampaigns(): Promise<void> {
    const campaigns = await this.client.listCampaigns();
    await this.repo.upsertCampaigns(campaigns);
    await this.repo.setSyncState({
      sync_key:        this.syncKeyCampaigns,
      high_water_mark: null,
      last_error:      null,
      notes:           { count: campaigns.length },
    });
    logger.info("LeadsProsperSyncWorker: campaigns synced", { count: campaigns.length });
  }

  private async syncLeads(): Promise<void> {
    const state = await this.repo.getSyncState(this.syncKeyLeads);
    const now   = new Date();

    const windowStart = state?.high_water_mark
      ? new Date(new Date(state.high_water_mark).getTime() - this.overlapMs)
      : new Date(now.getTime() - this.lookbackDays * 24 * 60 * 60 * 1000);

    const startDate = toYMD(windowStart);
    const endDate   = toYMD(now);

    logger.info("LeadsProsperSyncWorker: syncing leads window", {
      startDate,
      endDate,
      prevHighWaterMark: state?.high_water_mark ?? null,
    });

    try {
      const leads = await this.client.fetchAllLeads({ startDate, endDate });
      await this.repo.upsertLeads(leads);

      const latestMs = leads.reduce((max, l) => {
        const ms = Number(l.lead_date_ms);
        return Number.isFinite(ms) && ms > max ? ms : max;
      }, 0);

      const newHighWaterMark = latestMs > 0
        ? new Date(latestMs).toISOString()
        : (state?.high_water_mark ?? null);

      await this.repo.setSyncState({
        sync_key:        this.syncKeyLeads,
        high_water_mark: newHighWaterMark,
        last_error:      null,
        notes:           { lastCount: leads.length, windowStart: startDate, windowEnd: endDate },
      });

      logger.info("LeadsProsperSyncWorker: leads synced", {
        count:           leads.length,
        high_water_mark: newHighWaterMark,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.setSyncState({
        sync_key:        this.syncKeyLeads,
        high_water_mark: state?.high_water_mark ?? null,
        last_error:      message,
        notes:           { ...(state?.notes ?? {}), lastFailureAt: new Date().toISOString() },
      });
      throw err;
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}
