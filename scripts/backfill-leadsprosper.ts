/**
 * LeadsProsper historical backfill
 *
 * Usage:
 *   npm run backfill:lp                # walk back until 6 consecutive empty months
 *   npm run backfill:lp -- --from 2024-01-01 --to 2026-04-17
 *   npm run backfill:lp -- --months 24 # fixed lookback: last 24 months only
 *
 * Behavior:
 *   - Walks backwards in monthly chunks from today (or --to)
 *   - Calls LP `/leads` per campaign per month, paginating via search_after
 *   - Upserts into Supabase (lp_leads) — idempotent, safe to re-run
 *   - Terminates when it hits 6 consecutive empty months (no more history),
 *     or when --from / --months bound is reached, or on SIGINT
 *
 * Advances lp_sync_state.high_water_mark only at the end, so the 15-min
 * incremental sync worker resumes seamlessly after backfill.
 */

import { config } from "../src/config";
import { logger } from "../src/core/logger";
import {
  LeadsProsperClient,
  LeadsProsperRepository,
} from "../src/integrations/leadsprosper";

// ── CLI args ─────────────────────────────────────────────────────────────────

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

const fromArg   = getArg("from");
const toArg     = getArg("to");
const monthsArg = getArg("months");
const EMPTY_MONTHS_TO_STOP = 6;

// ── Date helpers (UTC-only to avoid tz drift during multi-month walk) ────────

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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const client = new LeadsProsperClient();
  const repo   = new LeadsProsperRepository();

  if (!client.enabled) {
    logger.error("backfill: LEADSPROSPER_API_KEY missing — aborting");
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

  // Seed campaigns first — needed because /leads requires campaign=<id>.
  const campaigns = await client.listCampaigns();
  await repo.upsertCampaigns(campaigns);
  logger.info("backfill: campaigns loaded", { count: campaigns.length });

  // Determine walk bounds
  const endDate = toArg ? new Date(`${toArg}T23:59:59Z`) : new Date();
  const lowerBound = fromArg
    ? new Date(`${fromArg}T00:00:00Z`)
    : monthsArg
      ? new Date(Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth() - Number(monthsArg), 1))
      : null;  // null = walk until empty-month threshold

  let cursor = startOfMonth(endDate);
  let consecutiveEmptyMonths = 0;
  let totalInserted = 0;
  let latestLeadMs  = 0;

  // Ctrl-C exits cleanly — already-upserted rows are durable
  process.on("SIGINT", () => {
    logger.info("backfill: SIGINT received, exiting. Data already written is preserved.");
    process.exit(0);
  });

  while (true) {
    if (lowerBound && cursor < startOfMonth(lowerBound)) break;

    const monthStart = ymd(cursor);
    const monthEnd   = ymd(endOfMonth(cursor));

    const leads = await client.fetchAllLeads({
      startDate: monthStart,
      endDate:   monthEnd,
    });

    if (leads.length === 0) {
      consecutiveEmptyMonths++;
      logger.info(`backfill: ${monthStart} → ${monthEnd}: 0 leads (empty ${consecutiveEmptyMonths}/${EMPTY_MONTHS_TO_STOP})`);
      if (!lowerBound && consecutiveEmptyMonths >= EMPTY_MONTHS_TO_STOP) {
        logger.info(`backfill: ${EMPTY_MONTHS_TO_STOP} consecutive empty months — reached end of history`);
        break;
      }
    } else {
      consecutiveEmptyMonths = 0;
      await repo.upsertLeads(leads);
      totalInserted += leads.length;

      const maxMs = leads.reduce((m, l) => {
        const ms = Number(l.lead_date_ms);
        return Number.isFinite(ms) && ms > m ? ms : m;
      }, 0);
      if (maxMs > latestLeadMs) latestLeadMs = maxMs;

      logger.info(`backfill: ${monthStart} → ${monthEnd}: ${leads.length} leads upserted (running total: ${totalInserted})`);
    }

    cursor = prevMonth(cursor);
  }

  // Advance sync-state high-water mark if we pulled any lead newer than what's
  // already there. Non-destructive: the 15-min incremental will still overlap.
  if (latestLeadMs > 0) {
    const current = await repo.getSyncState("leads:global");
    const currentMs = current?.high_water_mark ? new Date(current.high_water_mark).getTime() : 0;
    if (latestLeadMs > currentMs) {
      await repo.setSyncState({
        sync_key:        "leads:global",
        high_water_mark: new Date(latestLeadMs).toISOString(),
        last_error:      null,
        notes:           { lastBackfillAt: new Date().toISOString(), backfillInserted: totalInserted },
      });
    }
  }

  logger.info("backfill: complete", {
    totalLeadsUpserted: totalInserted,
    latestLeadDate:     latestLeadMs ? new Date(latestLeadMs).toISOString() : null,
  });
  process.exit(0);
}

main().catch((err) => {
  logger.error("backfill: fatal", { error: String(err) });
  process.exit(1);
});

// Touch config so TS doesn't drop the import (also ensures .env is loaded via src/config)
void config;
