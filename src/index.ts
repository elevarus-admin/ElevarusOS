/**
 * ElevarusOS — entry point
 *
 * Wires together all adapters, the orchestrator, and the blog workflow,
 * then starts the polling loop.
 *
 * Run modes:
 *   npm run dev              — start polling loop (daemon mode)
 *   npm run dev -- --once   — run a single manual test job and exit
 */

import { config } from "./config";
import { logger } from "./core/logger";
import { createJobStore } from "./core/job-store";
import { Orchestrator } from "./core/orchestrator";

// Intake adapters
import { ClickUpIntakeAdapter } from "./adapters/intake/clickup.adapter";
import { EmailIntakeAdapter } from "./adapters/intake/email.adapter";

// Notification adapters
import { SlackNotifyAdapter } from "./adapters/notify/slack.adapter";
import { EmailNotifyAdapter } from "./adapters/notify/email.adapter";

// Blog workflow
import { buildBlogWorkflow } from "./workflows/blog/blog.workflow";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info("ElevarusOS starting", {
    model: config.anthropic.model,
    logLevel: config.orchestrator.logLevel,
    jobStore: config.orchestrator.jobStore,
  });

  const jobStore = createJobStore();

  const intakeAdapters = [
    new ClickUpIntakeAdapter(),
    new EmailIntakeAdapter(),
  ];

  const notifiers = [
    new SlackNotifyAdapter(),
    new EmailNotifyAdapter(),
  ];

  const stages = buildBlogWorkflow(notifiers);

  const orchestrator = new Orchestrator(jobStore, intakeAdapters, notifiers, stages);

  // ─── Single-run test mode ────────────────────────────────────────────────

  if (process.argv.includes("--once")) {
    logger.info("Running in --once mode with sample job");

    const sampleRequest = {
      title: "5 Ways AI Is Transforming Agency Workflows in 2025",
      brief:
        "Explore how mid-size digital marketing agencies are using AI tools to reduce manual work, speed up content production, and improve client results.",
      audience:
        "Digital agency owners and operations leaders at companies with 10-50 employees",
      targetKeyword: "AI for marketing agencies",
      cta: "Book a free strategy call to see how Elevarus can help automate your agency workflows.",
      approver: "shane@elevarus.com",
      rawSource: {
        channel: "manual" as const,
        receivedAt: new Date().toISOString(),
        payload: { note: "sample job from --once mode" },
      },
      missingFields: [] as any[],
    };

    try {
      const job = await orchestrator.submitJob(sampleRequest);
      logger.info("Sample job finished", {
        jobId: job.id,
        status: job.status,
      });
    } catch (err) {
      logger.error("Sample job failed", { error: String(err) });
      process.exit(1);
    }

    process.exit(0);
    return;
  }

  // ─── Daemon mode ─────────────────────────────────────────────────────────

  orchestrator.start();

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info("Shutting down...");
    orchestrator.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
