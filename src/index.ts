/**
 * ElevarusOS — entry point
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDING A NEW BOT INSTANCE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. Create src/instances/<id>/instance.md  (copy from src/instances/_template/)
 * 2. Optionally add prompt overrides to src/instances/<id>/prompts/
 * 3. Register it below — one line:
 *
 *    registry.register(buildBlogWorkflowDefinition(notifiers, "<id>"));
 *    // or for reporting:
 *    registry.register(buildReportingWorkflowDefinition(notifiers, "<id>"));
 *
 * 4. Set workflowType: "<id>" on any job request you want routed to it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RUN MODES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   npm run dev                   — start polling + scheduler (daemon mode)
 *   npm run dev -- --once         — run one sample blog job (Elevarus Blog Bot)
 *   npm run dev -- --once --bot   — specify which instance to test
 *       e.g. npm run dev -- --once --bot u65-reporting
 */

import { config } from "./config";
import { logger } from "./core/logger";
import { createJobStore } from "./core/job-store";
import { Orchestrator } from "./core/orchestrator";
import { WorkflowRegistry } from "./core/workflow-registry";
import { Scheduler } from "./core/scheduler";
import { ApiServer } from "./api/server";
import { MissionControlBridge } from "./adapters/bridge/mission-control.bridge";
import { syncInstancesToSupabase } from "./core/instance-sync";
import { syncBotsToDashboard } from "./core/dashboard-sync";
import { DashboardPoller } from "./core/dashboard-poller";

// Intake adapters
import { ClickUpIntakeAdapter } from "./adapters/intake/clickup.adapter";
import { EmailIntakeAdapter } from "./adapters/intake/email.adapter";

// Notification adapters
import { SlackNotifyAdapter } from "./adapters/notify/slack.adapter";
import { EmailNotifyAdapter } from "./adapters/notify/email.adapter";

// Workflow builders
import { buildBlogWorkflowDefinition } from "./workflows/blog/blog.workflow";
import { buildReportingWorkflowDefinition } from "./workflows/reporting/reporting.workflow";

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

  // ─── Workflow registry ─────────────────────────────────────────────────────
  // Each registered entry is a named bot instance.
  // workflowType on the job must match the instanceId exactly.
  //
  // Blog bot instances:

  const registry = new WorkflowRegistry();

  registry.register(buildBlogWorkflowDefinition(notifiers, "blog"));           // default fallback
  registry.register(buildBlogWorkflowDefinition(notifiers, "elevarus-blog"));
  registry.register(buildBlogWorkflowDefinition(notifiers, "nes-blog"));

  // Reporting bot instances:
  registry.register(buildReportingWorkflowDefinition(notifiers, "u65-reporting"));
  registry.register(buildReportingWorkflowDefinition(notifiers, "final-expense-reporting"));
  registry.register(buildReportingWorkflowDefinition(notifiers, "hvac-reporting"));

  // ─── Orchestrator ──────────────────────────────────────────────────────────

  const orchestrator = new Orchestrator(jobStore, intakeAdapters, notifiers, registry);

  // ─── Mission Control bridge (dashboard UI) ────────────────────────────────
  // Set MISSION_CONTROL_URL + MISSION_CONTROL_API_KEY in .env to enable.
  // Start Mission Control:  cd dashboard && pnpm dev  (port 3000)

  const bridge = new MissionControlBridge(jobStore);
  orchestrator.setBridge(bridge);

  // Restore MC task ID map from job store (survives restarts)
  await bridge.restoreTaskIdMap();

  // Sync instance configs to Supabase (no-op if Supabase not configured)
  await syncInstancesToSupabase();

  // Register bot instances as agents in Mission Control dashboard
  await syncBotsToDashboard();

  // ─── API server ───────────────────────────────────────────────────────────
  // GET  /api/health | /api/bots | /api/jobs | /api/schedule
  // POST /api/jobs   — submit a job manually
  // Optional auth: set API_SECRET in .env to require x-api-key header.

  const apiServer = new ApiServer({
    port: parseInt(process.env.API_PORT ?? "3001", 10),
    jobStore,
    registry,
    orchestrator,
  });
  apiServer.start();

  // ─── Single-run test mode ─────────────────────────────────────────────────

  if (process.argv.includes("--once")) {
    const botArg = process.argv.indexOf("--bot");
    const instanceId = botArg !== -1 ? process.argv[botArg + 1] : "elevarus-blog";

    logger.info(`Running in --once mode`, { instanceId });

    const sampleRequest = buildSampleRequest(instanceId);

    try {
      const job = await orchestrator.submitJob(sampleRequest, instanceId);
      logger.info("Sample job finished", {
        jobId: job.id,
        status: job.status,
        instanceId,
      });
    } catch (err) {
      logger.error("Sample job failed", { error: String(err) });
      process.exit(1);
    }

    process.exit(0);
    return;
  }

  // ─── Daemon mode ──────────────────────────────────────────────────────────

  orchestrator.start();

  // Scheduler — fires jobs for instances with schedule.enabled: true
  const scheduler = new Scheduler(async (instanceId) => {
    const req = buildSampleRequest(instanceId);
    await orchestrator.submitJob(req, instanceId);
  });
  scheduler.start();

  // Dashboard poller — detects approvals made in Mission Control and syncs them back
  const dashboardPoller = new DashboardPoller(jobStore, bridge);
  dashboardPoller.start();

  // Graceful shutdown
  const shutdown = (): void => {
    logger.info("Shutting down...");
    orchestrator.stop();
    scheduler.stop();
    dashboardPoller.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ─── Sample requests for --once mode ──────────────────────────────────────────

function buildSampleRequest(instanceId: string) {
  const isReporting = instanceId.includes("reporting");

  if (isReporting) {
    return {
      title: `Campaign Performance — Week of ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
      brief: JSON.stringify({
        leads: 47,
        cpl: 38.50,
        spend: 1809.50,
        budget: 2000,
        conversion_rate: "4.2%",
        top_ad_set: "Awareness — 45-64 Homeowners",
        vs_last_week: { leads: "+8%", cpl: "-5%", spend: "+2%" },
      }),
      audience: "Elevarus account managers",
      targetKeyword: instanceId.replace("-reporting", "").toUpperCase(),
      cta: "Review full report",
      approver: "shane@elevarus.com",
      workflowType: instanceId,
      rawSource: {
        channel: "manual" as const,
        receivedAt: new Date().toISOString(),
        payload: { note: `sample ${instanceId} report from --once mode` },
      },
      missingFields: [] as any[],
    };
  }

  return {
    title: "5 Ways AI Is Transforming Agency Workflows in 2025",
    brief: "Explore how mid-size digital marketing agencies are using AI tools to reduce manual work, speed up content production, and improve client results.",
    audience: "Digital agency owners and operations leaders at companies with 10-50 employees",
    targetKeyword: "AI for marketing agencies",
    cta: "Book a free strategy call to see how Elevarus can help automate your agency workflows.",
    approver: "shane@elevarus.com",
    workflowType: instanceId,
    rawSource: {
      channel: "manual" as const,
      receivedAt: new Date().toISOString(),
      payload: { note: `sample ${instanceId} blog from --once mode` },
    },
    missingFields: [] as any[],
  };
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
