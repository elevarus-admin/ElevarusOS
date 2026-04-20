/**
 * Google Ads sync worker.
 *
 * Pulls account-level + campaign-level metrics from Google Ads API and upserts
 * into Supabase. Designed to run nightly @ 02:00 PT (cron) or on-demand via
 * `npm run sync:google-ads`.
 *
 * Default window: last 3 days, to absorb Google's ~3h reporting lag and any
 * late-attribution bumps. Override with `--days=N` for backfills.
 *
 * Behavior:
 *   1. Refresh `google_ads_customers` from listCustomerClients() under the MCC.
 *   2. For each leaf customer (manager=false, status=ENABLED):
 *      a. fetchDailyMetrics() → upsert google_ads_daily_metrics
 *      b. fetchCampaignMetrics() → upsert google_ads_campaign_metrics
 *   3. Log a row in google_ads_sync_runs.
 *   4. Errors on individual accounts don't abort the run — counted as failed.
 */

import cron, { ScheduledTask } from "node-cron";
import { GoogleAdsClient }      from "./client";
import { getSupabaseClient }    from "../../core/supabase-client";
import { logger }               from "../../core/logger";
import type { GoogleAdsSyncRunResult } from "./types";

const DEFAULT_WINDOW_DAYS = 3;

interface SyncOptions {
  windowDays?: number;
  /** When set, only sync this customer (useful for backfills / debugging). */
  customerId?: string;
}

export async function runGoogleAdsSync(opts: SyncOptions = {}): Promise<GoogleAdsSyncRunResult> {
  const startedAt  = new Date();
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const supabase   = getSupabaseClient();
  const client     = new GoogleAdsClient();

  if (!client.enabled) {
    throw new Error("Google Ads not configured — see .env (GOOGLE_ADS_*)");
  }

  // Insert sync_runs row at start (status = running) so we have an ID to update
  const { data: runRow, error: runErr } = await supabase
    .from("google_ads_sync_runs")
    .insert({ window_days: windowDays })
    .select("id")
    .single();
  if (runErr || !runRow) {
    throw new Error(`Could not create sync_runs row: ${runErr?.message}`);
  }
  const runId = runRow.id as string;

  let customersSynced = 0;
  let customersFailed = 0;
  let rowsUpserted    = 0;
  let lastError: string | null = null;

  try {
    // ── 1. Refresh the customer directory ─────────────────────────────────
    logger.info("google-ads/sync: refreshing customer directory");
    const customers = await client.listCustomerClients();

    const customerRows = customers.map((c) => ({
      customer_id:       c.customerId,
      descriptive_name:  c.descriptiveName,
      manager:           c.manager,
      parent_manager_id: c.parentManagerId,
      level:             c.level,
      currency_code:     c.currencyCode,
      time_zone:         c.timeZone,
      status:            c.status,
      last_synced_at:    new Date().toISOString(),
    }));

    if (customerRows.length > 0) {
      const { error: upsertErr } = await supabase
        .from("google_ads_customers")
        .upsert(customerRows, { onConflict: "customer_id" });
      if (upsertErr) throw new Error(`customer upsert: ${upsertErr.message}`);
      rowsUpserted += customerRows.length;
    }

    // ── 2. Pick which leaf accounts to sync ───────────────────────────────
    let leaves = customers.filter((c) => !c.manager && c.status === "ENABLED");
    if (opts.customerId) {
      leaves = leaves.filter((c) => c.customerId === opts.customerId);
      if (leaves.length === 0) throw new Error(`Customer ${opts.customerId} not found / not ENABLED leaf`);
    }

    // ── 3. Date window ────────────────────────────────────────────────────
    const today = new Date();
    const start = new Date(today.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000);
    const startDate = isoDate(start);
    const endDate   = isoDate(today);

    logger.info(`google-ads/sync: ${leaves.length} leaf accounts, window ${startDate} → ${endDate}`);

    // ── 4. Per-account pull ───────────────────────────────────────────────
    for (const c of leaves) {
      try {
        // Daily account metrics
        const daily = await client.fetchDailyMetrics(c.customerId, startDate, endDate);
        if (daily.length > 0) {
          const dailyRows = daily.map((r) => ({
            customer_id:       r.customerId,
            date:              r.date,
            cost:              r.cost,
            impressions:       r.impressions,
            clicks:            r.clicks,
            conversions:       r.conversions,
            conversions_value: r.conversionsValue,
            ctr:               r.ctr,
            avg_cpc:           r.avgCpc,
            synced_at:         new Date().toISOString(),
          }));
          const { error } = await supabase
            .from("google_ads_daily_metrics")
            .upsert(dailyRows, { onConflict: "customer_id,date" });
          if (error) throw new Error(`daily upsert: ${error.message}`);
          rowsUpserted += dailyRows.length;
        }

        // Campaign metrics
        const camp = await client.fetchCampaignMetrics(c.customerId, startDate, endDate);
        if (camp.length > 0) {
          const campRows = camp.map((r) => ({
            customer_id:       r.customerId,
            campaign_id:       r.campaignId,
            campaign_name:     r.campaignName,
            campaign_status:   r.campaignStatus,
            date:              r.date,
            cost:              r.cost,
            impressions:       r.impressions,
            clicks:            r.clicks,
            conversions:       r.conversions,
            conversions_value: r.conversionsValue,
            synced_at:         new Date().toISOString(),
          }));
          const { error } = await supabase
            .from("google_ads_campaign_metrics")
            .upsert(campRows, { onConflict: "customer_id,campaign_id,date" });
          if (error) throw new Error(`campaign upsert: ${error.message}`);
          rowsUpserted += campRows.length;
        }

        customersSynced += 1;
      } catch (err) {
        customersFailed += 1;
        lastError = String(err);
        logger.warn("google-ads/sync: customer failed", { customerId: c.customerId, name: c.descriptiveName, error: lastError });
      }
    }
  } catch (err) {
    lastError = String(err);
    logger.error("google-ads/sync: fatal", { error: lastError });
  }

  const finishedAt = new Date();
  const status: GoogleAdsSyncRunResult["status"] =
    lastError && customersSynced === 0 ? "error" :
    customersFailed > 0                ? "partial" :
    "ok";

  await supabase
    .from("google_ads_sync_runs")
    .update({
      finished_at:      finishedAt.toISOString(),
      status,
      customers_synced: customersSynced,
      customers_failed: customersFailed,
      rows_upserted:    rowsUpserted,
      error_message:    lastError,
    })
    .eq("id", runId);

  logger.info("google-ads/sync: done", { status, customersSynced, customersFailed, rowsUpserted });

  return {
    startedAt:       startedAt.toISOString(),
    finishedAt:      finishedAt.toISOString(),
    status,
    customersSynced,
    customersFailed,
    rowsUpserted,
    windowDays,
    errorMessage:    lastError,
  };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── Scheduled worker (daemon) ────────────────────────────────────────────────
//
// Wraps `runGoogleAdsSync()` in a node-cron task. Mirrors the shape of
// RingbaSyncWorker / LeadsProsperSyncWorker so src/index.ts can start/stop it
// uniformly. Default schedule: 02:00 PT daily, with a 3-day rolling window.

export class GoogleAdsSyncWorker {
  readonly enabled: boolean;
  private readonly cronExpr:   string;
  private readonly timezone:   string;
  private readonly windowDays: number;
  private task: ScheduledTask | null = null;
  private running  = false;
  private inFlight = false;

  constructor(opts: { cronExpr?: string; timezone?: string; windowDays?: number } = {}) {
    this.cronExpr   = opts.cronExpr   ?? "0 2 * * *";              // 02:00 daily
    this.timezone   = opts.timezone   ?? "America/Los_Angeles";
    this.windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;

    const client = new GoogleAdsClient();
    this.enabled = client.enabled;

    if (!this.enabled) {
      logger.info("GoogleAdsSyncWorker: not enabled (Google Ads credentials missing)");
    }
  }

  start(): void {
    if (!this.enabled || this.running) return;

    if (!cron.validate(this.cronExpr)) {
      logger.warn("GoogleAdsSyncWorker: invalid cron expression — worker not started", {
        cronExpr: this.cronExpr,
      });
      return;
    }

    this.task = cron.schedule(this.cronExpr, () => {
      void this.runOnce().catch((err) => {
        logger.error("GoogleAdsSyncWorker: tick failed", { error: String(err) });
      });
    }, { timezone: this.timezone });
    this.running = true;

    logger.info("GoogleAdsSyncWorker started", {
      cronExpr:   this.cronExpr,
      timezone:   this.timezone,
      windowDays: this.windowDays,
    });
    // No initial run — Google's daily quota is 15k ops; start-on-boot would
    // burn ~5k ops every daemon restart. Wait for the cron tick instead.
  }

  stop(): void {
    this.task?.stop();
    this.task    = null;
    this.running = false;
    logger.info("GoogleAdsSyncWorker stopped");
  }

  async runOnce(): Promise<void> {
    if (!this.enabled) return;
    if (this.inFlight) {
      logger.debug("GoogleAdsSyncWorker: skipping tick — previous run still in flight");
      return;
    }
    this.inFlight = true;
    try {
      await runGoogleAdsSync({ windowDays: this.windowDays });
    } finally {
      this.inFlight = false;
    }
  }
}

// ── CLI entry ────────────────────────────────────────────────────────────────
//
// Usage:
//   npx ts-node src/integrations/google-ads/sync-worker.ts
//   npx ts-node src/integrations/google-ads/sync-worker.ts --days=90
//   npx ts-node src/integrations/google-ads/sync-worker.ts --customer=8951980121

if (require.main === module) {
  // Defer dotenv to runtime so the worker can be imported by the scheduler
  // without re-loading env vars.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv").config();

  const argv = process.argv.slice(2);
  const days       = pickArg(argv, "--days");
  const customerId = pickArg(argv, "--customer");

  const opts: SyncOptions = {};
  if (days)       opts.windowDays = parseInt(days, 10);
  if (customerId) opts.customerId = customerId;

  runGoogleAdsSync(opts)
    .then((result) => {
      console.log("\n=== Google Ads Sync Result ===");
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === "error" ? 1 : 0);
    })
    .catch((err) => {
      console.error("Sync failed:", err);
      process.exit(1);
    });
}

function pickArg(argv: string[], flag: string): string | undefined {
  const arg = argv.find((a) => a.startsWith(`${flag}=`));
  return arg ? arg.slice(flag.length + 1) : undefined;
}
