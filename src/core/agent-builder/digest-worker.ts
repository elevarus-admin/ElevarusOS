/**
 * Agent Builder weekly digest worker.
 *
 * Cron-driven Slack post summarizing past 7 days of Agent Builder activity.
 * Default schedule: 09:00 PT every Friday. Mirrors the lifecycle pattern of
 * RingbaSyncWorker / LeadsProsperSyncWorker / GoogleAdsSyncWorker so
 * src/index.ts wires it up uniformly.
 *
 * Each tick:
 *   1. Sweeps idle sessions (>7 days no activity) → status='abandoned'
 *   2. Builds digest data from agent_builder_sessions
 *   3. Posts Block Kit message to AGENT_BUILDER_DIGEST_CHANNEL
 *      (falls back to SLACK_NOTIFY_CHANNEL)
 *
 * No-ops when (a) no Slack token, (b) no digest channel configured,
 * (c) Supabase not configured.
 */

import cron, { ScheduledTask } from "node-cron";
import { logger }              from "../logger";
import { postToSlack }         from "../../adapters/slack/client";
import { isSupabaseConfigured } from "../supabase-client";
import { markIdleSessionsAbandoned } from "./session";
import { buildDigestData, renderDigest } from "./digest";

const DEFAULT_CRON     = "0 9 * * 5";         // 09:00 every Friday
const DEFAULT_TIMEZONE = "America/Los_Angeles";
const IDLE_DAYS        = 7;

export class AgentBuilderDigestWorker {
  readonly enabled: boolean;
  private readonly cronExpr:  string;
  private readonly timezone:  string;
  private readonly channel:   string;
  private task: ScheduledTask | null = null;
  private running  = false;
  private inFlight = false;

  constructor(opts: { cronExpr?: string; timezone?: string; channel?: string } = {}) {
    this.cronExpr = opts.cronExpr ?? DEFAULT_CRON;
    this.timezone = opts.timezone ?? DEFAULT_TIMEZONE;
    this.channel  = opts.channel
                 ?? process.env.AGENT_BUILDER_DIGEST_CHANNEL
                 ?? process.env.SLACK_NOTIFY_CHANNEL
                 ?? "";

    const hasSlack    = Boolean(process.env.SLACK_BOT_TOKEN);
    const hasChannel  = Boolean(this.channel);
    const hasSupabase = isSupabaseConfigured();
    this.enabled = hasSlack && hasChannel && hasSupabase;

    if (!this.enabled) {
      logger.info("AgentBuilderDigestWorker: not enabled", {
        slack:    hasSlack,
        channel:  hasChannel,
        supabase: hasSupabase,
        hint:     "Set AGENT_BUILDER_DIGEST_CHANNEL (or SLACK_NOTIFY_CHANNEL) and SLACK_BOT_TOKEN.",
      });
    }
  }

  start(): void {
    if (!this.enabled || this.running) return;

    if (!cron.validate(this.cronExpr)) {
      logger.warn("AgentBuilderDigestWorker: invalid cron expression — worker not started", {
        cronExpr: this.cronExpr,
      });
      return;
    }

    this.task = cron.schedule(
      this.cronExpr,
      () => {
        void this.runOnce().catch((err) => {
          logger.error("AgentBuilderDigestWorker: tick failed", { error: String(err) });
        });
      },
      { timezone: this.timezone },
    );
    this.running = true;

    logger.info("AgentBuilderDigestWorker started", {
      cronExpr: this.cronExpr,
      timezone: this.timezone,
      channel:  this.channel,
    });
  }

  stop(): void {
    this.task?.stop();
    this.task    = null;
    this.running = false;
    logger.info("AgentBuilderDigestWorker stopped");
  }

  async runOnce(): Promise<{ posted: boolean; ts?: string; sessionsSwept: number }> {
    if (!this.enabled) return { posted: false, sessionsSwept: 0 };
    if (this.inFlight) {
      logger.debug("AgentBuilderDigestWorker: skipping tick — previous run still in flight");
      return { posted: false, sessionsSwept: 0 };
    }
    this.inFlight = true;
    try {
      const sessionsSwept = await markIdleSessionsAbandoned(IDLE_DAYS);
      const data          = await buildDigestData();
      const rendered      = renderDigest(data);

      const ts = await postToSlack({
        channel: this.channel,
        text:    rendered.text,
        blocks:  rendered.blocks,
      });

      logger.info("AgentBuilderDigestWorker: digest posted", {
        channel:        this.channel,
        ts,
        sessionsSwept,
        submitted:      data.submitted.length,
        open:           data.open.length,
        abandoned:      data.abandoned.length,
      });
      return { posted: Boolean(ts), ts, sessionsSwept };
    } finally {
      this.inFlight = false;
    }
  }
}

// ── CLI entry ────────────────────────────────────────────────────────────────
//
// Usage:
//   npx ts-node src/core/agent-builder/digest-worker.ts            # post the digest now
//   npx ts-node src/core/agent-builder/digest-worker.ts --dry-run  # render to stdout, no Slack post

if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv").config();

  const dryRun = process.argv.includes("--dry-run");

  (async () => {
    if (dryRun) {
      const sessionsSwept = await markIdleSessionsAbandoned(IDLE_DAYS);
      const data          = await buildDigestData();
      const rendered      = renderDigest(data);
      console.log(`(dry-run — would have posted to channel and swept ${sessionsSwept} idle sessions)\n`);
      console.log("=== TEXT ===\n" + rendered.text);
      console.log("\n=== BLOCKS ===\n" + JSON.stringify(rendered.blocks, null, 2));
      process.exit(0);
    }

    const worker = new AgentBuilderDigestWorker();
    if (!worker.enabled) {
      console.error("Worker not enabled — see logs above for missing config.");
      process.exit(1);
    }
    const result = await worker.runOnce();
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  })().catch((err) => { console.error("Failed:", err); process.exit(1); });
}
