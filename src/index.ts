/**
 * ElevarusOS — entry point
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * ElevarusOS is the workflow execution runtime. Jobs are submitted directly
 * via the Scheduler (cron), the REST API, or Slack intake adapters — no
 * external task board required.
 *
 *   Scheduler / API / Slack
 *         │
 *         ▼  orchestrator.submitJob()
 *   Orchestrator creates job + runs stages
 *         │
 *         ▼  (approval_notify stage)
 *   ApprovalStore.waitForApproval(jobId)  ← blocks until action received
 *         │  POST /api/jobs/:jobId/approve  or  Slack interactive button
 *         ▼  approvalStore.notifyApproval(jobId, true)
 *   Remaining stages (publish, completion)
 *         │
 *         ▼
 *   Job → "completed"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDING A NEW BOT INSTANCE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. Create src/agents/<id>/instance.md  (copy from src/agents/_template/)
 *    — OR — POST /api/instances  (creates the file)
 *
 * 2. Register it below — one line:
 *    registry.register(buildBlogWorkflowDefinition(notifiers, "<id>"));
 *
 * 3. Restart ElevarusOS — the bot is live immediately.
 *    Submit jobs via POST /api/jobs or the Scheduler cron.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RUN MODES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   npm run dev                   — daemon: Scheduler fires jobs; API server live
 *   npm run dev -- --once         — run one sample job directly
 *   npm run dev -- --once --bot   — specify which instance to test
 *       e.g. npm run dev -- --once --bot u65-reporting
 */

import { config }          from "./config";
import { logger }          from "./core/logger";
import { createJobStore }  from "./core/job-store";
import { Orchestrator }    from "./core/orchestrator";
import { WorkflowRegistry } from "./core/workflow-registry";
import { Scheduler }       from "./core/scheduler";
import { ApiServer }       from "./api/server";
import { LeadsProsperSyncWorker } from "./integrations/leadsprosper";
import { RingbaSyncWorker }       from "./integrations/ringba";
import { GoogleAdsSyncWorker }    from "./integrations/google-ads";
import { AgentBuilderDigestWorker } from "./core/agent-builder";

// Intake adapters
import { ClickUpIntakeAdapter } from "./adapters/intake/clickup.adapter";
import { EmailIntakeAdapter }   from "./adapters/intake/email.adapter";

// Notification adapters
import { SlackNotifyAdapter } from "./adapters/slack/notify.adapter";
import { EmailNotifyAdapter } from "./adapters/notify/email.adapter";

// Workflow builders
import { buildBlogWorkflowDefinition }         from "./workflows/blog/blog.workflow";
import { buildFinalExpenseReportingWorkflow }   from "./workflows/final-expense-reporting/final-expense-reporting.workflow";
import { buildU65ReportingWorkflow }            from "./workflows/u65-reporting/u65-reporting.workflow";
import { buildHvacReportingWorkflow }           from "./workflows/hvac-reporting/hvac-reporting.workflow";
import { buildHvacThumbtackImportWorkflow }     from "./workflows/hvac-thumbtack-import/hvac-thumbtack-import.workflow";

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info("ElevarusOS starting", {
    model:    config.anthropic.model,
    logLevel: config.orchestrator.logLevel,
    jobStore: config.orchestrator.jobStore,
  });

  const jobStore = createJobStore();

  const notifiers = [
    new SlackNotifyAdapter(),
    new EmailNotifyAdapter(),
  ];

  const intakeAdapters = [new ClickUpIntakeAdapter(), new EmailIntakeAdapter()];

  // ─── Workflow registry ─────────────────────────────────────────────────────

  const registry = new WorkflowRegistry();

  // Blog bots
  registry.register(buildBlogWorkflowDefinition(notifiers, "blog"));           // default — kept for the --once smoke path

  // Reporting bots
  registry.register(buildFinalExpenseReportingWorkflow(notifiers));
  registry.register(buildU65ReportingWorkflow(notifiers));
  registry.register(buildHvacReportingWorkflow(notifiers));

  // Background data-import workers
  registry.register(buildHvacThumbtackImportWorkflow(notifiers));

  // ─── Single-run test mode (--once) ────────────────────────────────────────
  // Runs a workflow directly via Orchestrator — no daemon required.
  // Useful for local testing and CI smoke tests.

  if (process.argv.includes("--once")) {
    const botArg     = process.argv.indexOf("--bot");
    const instanceId = botArg !== -1 ? process.argv[botArg + 1] : "elevarus-blog";

    logger.info("Running in --once mode (direct execution)", { instanceId });

    const orchestrator  = new Orchestrator(jobStore, intakeAdapters, notifiers, registry);
    const sampleRequest = buildSampleRequest(instanceId);

    try {
      const job = await orchestrator.submitJob(sampleRequest, instanceId);
      logger.info("Sample job finished", { jobId: job.id, status: job.status, instanceId });
    } catch (err) {
      logger.error("Sample job failed", { error: String(err) });
      process.exit(1);
    }

    process.exit(0);
    return;
  }

  // ─── Daemon mode ──────────────────────────────────────────────────────────

  // ── Single shared Orchestrator ────────────────────────────────────────────
  // All job submissions (Scheduler, API, Slack) share one Orchestrator so the
  // job store stays consistent and the ApprovalStore singleton is reachable
  // from both the running stages and the API webhook handlers.

  const orchestrator = new Orchestrator(jobStore, intakeAdapters, notifiers, registry);

  // ── API server ─────────────────────────────────────────────────────────────
  // GET  /api/health | /api/bots | /api/jobs | /api/schedule | /api/instances
  // POST /api/jobs                    — submit a job immediately
  // POST /api/instances               — scaffold a new bot
  // POST /api/jobs/:jobId/approve     — approve a pending job
  // POST /api/jobs/:jobId/reject      — reject a pending job
  // POST /api/webhooks/slack          — Slack Events API receiver
  // POST /api/webhooks/slack/interactions — Slack interactive button handler

  const apiServer = new ApiServer({
    port:        parseInt(process.env.API_PORT ?? "3001", 10),
    jobStore,
    registry,
    orchestrator,
  });
  apiServer.start();

  // ── Scheduler ─────────────────────────────────────────────────────────────
  // Fires jobs for instances with schedule.enabled: true in instance.md.
  // Each scheduled run submits directly to the shared Orchestrator.

  const scheduler = new Scheduler(async (instanceId) => {
    const req = buildSampleRequest(instanceId);
    logger.info("Scheduler: submitting job", { instanceId, title: req.title });
    // Fire-and-forget — orchestrator handles the job lifecycle asynchronously
    orchestrator.submitJob(req, instanceId).catch((err) => {
      logger.error("Scheduler: job failed", { instanceId, error: String(err) });
    });
  });
  scheduler.start();

  // ── Data sync workers ─────────────────────────────────────────────────────
  // Keep Supabase in sync with external platforms. Each worker runs on its own
  // cron, no-ops if its API key / Supabase credentials are missing.

  const lpSync             = new LeadsProsperSyncWorker();
  const ringbaSync         = new RingbaSyncWorker();
  const googleAdsSync      = new GoogleAdsSyncWorker();
  const agentBuilderDigest = new AgentBuilderDigestWorker();
  lpSync.start();
  ringbaSync.start();
  googleAdsSync.start();
  agentBuilderDigest.start();

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  const shutdown = (): void => {
    logger.info("Shutting down...");
    scheduler.stop();
    lpSync.stop();
    ringbaSync.stop();
    googleAdsSync.stop();
    agentBuilderDigest.stop();
    process.exit(0);
  };

  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);
}

// ─── Sample requests (used by --once and Scheduler) ──────────────────────────

function buildSampleRequest(instanceId: string) {
  const isReporting = instanceId.includes("reporting");

  if (isReporting) {
    return {
      title: `Campaign Performance — Week of ${new Date().toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
      })}`,
      brief: JSON.stringify({
        leads:           47,
        cpl:             38.50,
        spend:           1809.50,
        budget:          2000,
        conversion_rate: "4.2%",
        top_ad_set:      "Awareness — 45-64 Homeowners",
        vs_last_week:    { leads: "+8%", cpl: "-5%", spend: "+2%" },
      }),
      audience:      "Elevarus account managers",
      targetKeyword: instanceId.replace("-reporting", "").toUpperCase(),
      cta:           "Review full report",
      approver:      "shane@elevarus.com",
      workflowType:  instanceId,
      rawSource: {
        channel:    "manual" as const,
        receivedAt: new Date().toISOString(),
        payload:    { note: `sample ${instanceId} report` },
      },
      missingFields: [] as any[],
    };
  }

  return {
    title:         "5 Ways AI Is Transforming Agency Workflows in 2025",
    brief:         "Explore how mid-size digital marketing agencies are using AI tools to reduce manual work, speed up content production, and improve client results.",
    audience:      "Digital agency owners and operations leaders at companies with 10-50 employees",
    targetKeyword: "AI for marketing agencies",
    cta:           "Book a free strategy call to see how Elevarus can help automate your agency workflows.",
    approver:      "shane@elevarus.com",
    workflowType:  instanceId,
    rawSource: {
      channel:    "manual" as const,
      receivedAt: new Date().toISOString(),
      payload:    { note: `sample ${instanceId} blog` },
    },
    missingFields: [] as any[],
  };
}

main().catch((err) => {
  console.error("Fatal error during startup:", err);
  process.exit(1);
});
