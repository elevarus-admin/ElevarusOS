/**
 * Ringba historical backfill
 *
 * Usage:
 *   npm run backfill:ringba                # walk back until 6 consecutive empty months
 *   npm run backfill:ringba -- --from 2024-01-01 --to 2026-04-17
 *   npm run backfill:ringba -- --months 24
 *
 * Walks backwards in monthly chunks from today (or --to). Each chunk pulls all
 * /callLogs records (paginated via offset, 20 records/request), upserts into
 * ringba_calls by inbound_call_id (idempotent), and advances sync_state's
 * low_water_mark so the live-API fallback in reports.ts knows Supabase is
 * authoritative for historical ranges.
 *
 * Safe to Ctrl-C — all upserts committed immediately.
 */

import { config } from "../src/config";
import { logger } from "../src/core/logger";
import { RingbaHttpClient, RingbaRepository } from "../src/integrations/ringba";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const fromArg   = getArg("from");
const toArg     = getArg("to");
const monthsArg = getArg("months");
const EMPTY_MONTHS_TO_STOP = 6;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function endOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
}

function prevMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
}

async function main(): Promise<void> {
  const client = new RingbaHttpClient();
  const repo   = new RingbaRepository();

  if (!client.enabled) {
    logger.error("backfill: RINGBA_API_KEY or RINGBA_ACCOUNT_ID missing — aborting");
    process.exit(1);
  }
  if (!repo.enabled) {
    logger.error("backfill: Supabase not configured — aborting");
    process.exit(1);
  }

  logger.info("backfill: starting", {
    from:   fromArg   ?? "(auto: stop on 6 empty months)",
    to:     toArg     ?? "today",
    months: monthsArg ?? null,
  });

  const campaigns = await client.listCampaigns();
  await repo.upsertCampaigns(campaigns);
  logger.info("backfill: campaigns loaded", { count: campaigns.length });

  const endDate = toArg ? new Date(`${toArg}T23:59:59Z`) : new Date();
  const lowerBound = fromArg
    ? new Date(`${fromArg}T00:00:00Z`)
    : monthsArg
      ? new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - Number(monthsArg), 1))
      : null;

  let cursor = startOfMonth(endDate);
  let consecutiveEmptyMonths = 0;
  let totalUpserted = 0;
  let latestMs      = 0;
  let earliestMs    = Infinity;

  process.on("SIGINT", () => {
    logger.info("backfill: SIGINT received, exiting. Data already written is preserved.");
    process.exit(0);
  });

  while (true) {
    if (lowerBound && cursor < startOfMonth(lowerBound)) break;

    const monthStart = ymd(cursor);
    const monthEnd   = ymd(endOfMonth(cursor));

    const records = await client.fetchCallLogs({ startDate: monthStart, endDate: monthEnd });

    if (records.length === 0) {
      consecutiveEmptyMonths++;
      logger.info(`backfill: ${monthStart} → ${monthEnd}: 0 records (empty ${consecutiveEmptyMonths}/${EMPTY_MONTHS_TO_STOP})`);
      if (!lowerBound && consecutiveEmptyMonths >= EMPTY_MONTHS_TO_STOP) {
        logger.info(`backfill: ${EMPTY_MONTHS_TO_STOP} consecutive empty months — reached end of history`);
        break;
      }
    } else {
      consecutiveEmptyMonths = 0;
      await repo.upsertCalls(records);

      let monthLatest = 0;
      let monthEarliest = Infinity;
      for (const r of records) {
        const ms = Number(r.callDt);
        if (Number.isFinite(ms) && ms > 0) {
          if (ms > monthLatest)   monthLatest   = ms;
          if (ms < monthEarliest) monthEarliest = ms;
        }
      }
      if (monthLatest   > latestMs)   latestMs   = monthLatest;
      if (monthEarliest < earliestMs) earliestMs = monthEarliest;

      totalUpserted += records.length;
      logger.info(`backfill: ${monthStart} → ${monthEnd}: ${records.length} records (unique calls upserted; running total: ${totalUpserted})`);
    }

    cursor = prevMonth(cursor);
  }

  const current = await repo.getSyncState("calls:global");

  const newHigh = latestMs > 0
    ? new Date(latestMs).toISOString()
    : current?.high_water_mark ?? null;

  const prevLow = current?.low_water_mark ? new Date(current.low_water_mark).getTime() : Infinity;
  const newLow  = earliestMs < prevLow && earliestMs !== Infinity
    ? new Date(earliestMs).toISOString()
    : current?.low_water_mark ?? null;

  await repo.setSyncState({
    sync_key:        "calls:global",
    high_water_mark: newHigh,
    low_water_mark:  newLow,
    last_error:      null,
    notes:           { lastBackfillAt: new Date().toISOString(), backfillUpserted: totalUpserted },
  });

  logger.info("backfill: complete", {
    totalUpserted,
    high_water_mark: newHigh,
    low_water_mark:  newLow,
  });
  process.exit(0);
}

main().catch((err) => {
  logger.error("backfill: fatal", { error: String(err) });
  process.exit(1);
});

void config;
