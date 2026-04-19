import cron, { ScheduledTask } from "node-cron";
import { logger } from "../../core/logger";
import { RingbaHttpClient } from "./client";
import { RingbaRepository } from "./repository";

/**
 * RingbaSyncWorker
 *
 * Keeps Supabase in sync with Ringba:
 *   - Campaign list refresh every tick (cheap)
 *   - Incremental call sync over a sliding window
 *     (high_water_mark − overlap) → now
 *
 * The 30-minute overlap is important. Ringba finalizes records a few minutes
 * after a call completes (connected_length, payout flags, buyer payout amount
 * can all be set post-hoc). Re-pulling the recent window catches those edits.
 *
 * No-op when RINGBA_API_KEY/RINGBA_ACCOUNT_ID or Supabase are missing.
 */
export class RingbaSyncWorker {
  readonly enabled: boolean;

  private readonly client = new RingbaHttpClient();
  private readonly repo   = new RingbaRepository();
  private readonly cronExpr:     string;
  private readonly overlapMs:    number;
  private readonly lookbackDays: number;
  private readonly syncKeyCalls     = "calls:global";
  private readonly syncKeyCampaigns = "campaigns:global";

  private task: ScheduledTask | null = null;
  private running  = false;
  private inFlight = false;

  constructor(opts: {
    cronExpr?:     string;   // default: every hour at :00
    overlapMs?:    number;   // default: 90 min re-pull overlap (covers hourly cadence + Ringba's post-call finalization window)
    lookbackDays?: number;   // default: 3 days cold-start window
  } = {}) {
    this.cronExpr     = opts.cronExpr     ?? "0 * * * *";
    this.overlapMs    = opts.overlapMs    ?? 90 * 60 * 1000;
    this.lookbackDays = opts.lookbackDays ?? 3;
    this.enabled      = this.client.enabled && this.repo.enabled;

    if (!this.enabled) {
      logger.info("RingbaSyncWorker: not enabled", {
        client:   this.client.enabled,
        supabase: this.repo.enabled,
      });
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(): void {
    if (!this.enabled || this.running) return;

    if (!cron.validate(this.cronExpr)) {
      logger.warn("RingbaSyncWorker: invalid cron expression — worker not started", {
        cronExpr: this.cronExpr,
      });
      return;
    }

    this.task = cron.schedule(this.cronExpr, () => {
      void this.runOnce().catch((err) => {
        logger.error("RingbaSyncWorker: tick failed", { error: String(err) });
      });
    });
    this.running = true;

    logger.info("RingbaSyncWorker started", { cronExpr: this.cronExpr });

    void this.runOnce().catch((err) => {
      logger.error("RingbaSyncWorker: initial run failed", { error: String(err) });
    });
  }

  stop(): void {
    this.task?.stop();
    this.task    = null;
    this.running = false;
    logger.info("RingbaSyncWorker stopped");
  }

  async runOnce(): Promise<void> {
    if (!this.enabled) return;
    if (this.inFlight) {
      logger.debug("RingbaSyncWorker: skipping tick — previous run still in flight");
      return;
    }
    this.inFlight = true;
    try {
      await this.syncCampaigns();
      await this.syncCalls();
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
    logger.info("RingbaSyncWorker: campaigns synced", { count: campaigns.length });
  }

  private async syncCalls(): Promise<void> {
    const state = await this.repo.getSyncState(this.syncKeyCalls);
    const now   = new Date();

    const windowStart = state?.high_water_mark
      ? new Date(new Date(state.high_water_mark).getTime() - this.overlapMs)
      : new Date(now.getTime() - this.lookbackDays * 24 * 60 * 60 * 1000);

    const startDate = toYMD(windowStart);
    const endDate   = toYMD(now);

    logger.info("RingbaSyncWorker: syncing calls window", {
      startDate,
      endDate,
      prevHighWaterMark: state?.high_water_mark ?? null,
    });

    try {
      const records = await this.client.fetchCallLogs({ startDate, endDate });
      await this.repo.upsertCalls(records);

      const latestMs = records.reduce((max, r) => {
        const ms = Number(r.callDt);
        return Number.isFinite(ms) && ms > max ? ms : max;
      }, 0);

      const newHigh = latestMs > 0
        ? new Date(latestMs).toISOString()
        : (state?.high_water_mark ?? null);

      // Low-water mark: the earliest point we have coverage from.
      // Only advance EARLIER — never later.
      const prevLow = state?.low_water_mark ? new Date(state.low_water_mark).getTime() : Infinity;
      const windowStartMs = windowStart.getTime();
      const newLow = windowStartMs < prevLow
        ? new Date(windowStartMs).toISOString()
        : state?.low_water_mark ?? null;

      await this.repo.setSyncState({
        sync_key:        this.syncKeyCalls,
        high_water_mark: newHigh,
        low_water_mark:  newLow,
        last_error:      null,
        notes:           { lastRecordCount: records.length, windowStart: startDate, windowEnd: endDate },
      });

      logger.info("RingbaSyncWorker: calls synced", {
        records:         records.length,
        high_water_mark: newHigh,
        low_water_mark:  newLow,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.repo.setSyncState({
        sync_key:        this.syncKeyCalls,
        high_water_mark: state?.high_water_mark ?? null,
        low_water_mark:  state?.low_water_mark  ?? null,
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
