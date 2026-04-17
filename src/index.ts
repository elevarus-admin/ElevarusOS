/**
 * ElevarusOS — entry point
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ARCHITECTURE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Mission Control (MC) is the source of truth for all tasks and agent state.
 * ElevarusOS is the workflow execution runtime.
 *
 *   MC Task Board  ←──────────────────────────────────────┐
 *         │                                               │
 *         ▼  (MCWorker polls queue)                       │ status updates
 *   MCWorker claims task                                  │
 *         │                                               │
 *         ▼                                               │
 *   Workflow stages run (Claude API, research, drafting)  │
 *         │                                               │
 *         ▼  (approval_notify stage)                      │
 *   MC task → "review"  ──── Human approves in MC UI ─────┘
 *         │  (webhook fires → notifyApproval)
 *         ▼
 *   Remaining stages (publish, completion)
 *         │
 *         ▼
 *   MC task → "done"
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ADDING A NEW BOT INSTANCE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. Create src/instances/<id>/instance.md  (copy from src/instances/_template/)
 *    — OR — POST /api/instances  (creates the file + registers in MC)
 *
 * 2. Register it below — one line:
 *    registry.register(buildBlogWorkflowDefinition(notifiers, "<id>"));
 *
 * 3. Restart ElevarusOS — the bot appears in MC automatically.
 *    Assign tasks to it in the MC Task Board; MCWorker picks them up.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RUN MODES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   npm run dev                   — daemon: MCWorker polls MC; scheduler fires tasks
 *   npm run dev -- --once         — run one sample job directly (no MC required)
 *   npm run dev -- --once --bot   — specify which instance to test
 *       e.g. npm run dev -- --once --bot u65-reporting
 */

import { config }          from "./config";
import { logger }          from "./core/logger";
import { createJobStore }  from "./core/job-store";
import { Orchestrator }    from "./core/orchestrator";
import { WorkflowRegistry } from "./core/workflow-registry";
import { Scheduler }       from "./core/scheduler";
import { MCWorker }        from "./core/mc-worker";
import { MCClient }        from "./core/mc-client";
import { ApiServer }       from "./api/server";
import { LeadsProsperSyncWorker } from "./integrations/leadsprosper";
import { RingbaSyncWorker }       from "./integrations/ringba";

// Intake adapters
import { ClickUpIntakeAdapter } from "./adapters/intake/clickup.adapter";
import { EmailIntakeAdapter }   from "./adapters/intake/email.adapter";

// Notification adapters
import { SlackNotifyAdapter } from "./adapters/notify/slack.adapter";
import { EmailNotifyAdapter } from "./adapters/notify/email.adapter";

// Workflow builders
import { buildBlogWorkflowDefinition }         from "./workflows/blog/blog.workflow";
import { buildFinalExpenseReportingWorkflow }   from "./workflows/final-expense-reporting/final-expense-reporting.workflow";
import { buildU65ReportingWorkflow }            from "./workflows/u65-reporting/u65-reporting.workflow";
import { buildHvacReportingWorkflow }           from "./workflows/hvac-reporting/hvac-reporting.workflow";

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

  // ─── Workflow registry ─────────────────────────────────────────────────────
  // Each entry is a named bot instance. workflowType on the task must match
  // the instanceId exactly so MCWorker routes the right workflow.

  const registry = new WorkflowRegistry();

  // Blog bots
  registry.register(buildBlogWorkflowDefinition(notifiers, "blog"));           // default
  registry.register(buildBlogWorkflowDefinition(notifiers, "elevarus-blog"));
  registry.register(buildBlogWorkflowDefinition(notifiers, "nes-blog"));

  // Reporting bots — one workflow per MC agent
  registry.register(buildFinalExpenseReportingWorkflow(notifiers));
  registry.register(buildU65ReportingWorkflow(notifiers));
  registry.register(buildHvacReportingWorkflow(notifiers));

  // ─── Single-run test mode (--once) ────────────────────────────────────────
  // Runs a workflow directly via Orchestrator — no MC required.
  // Useful for local testing and CI smoke tests.

  if (process.argv.includes("--once")) {
    const botArg     = process.argv.indexOf("--bot");
    const instanceId = botArg !== -1 ? process.argv[botArg + 1] : "elevarus-blog";

    logger.info("Running in --once mode (direct execution, no MC)", { instanceId });

    const intakeAdapters = [new ClickUpIntakeAdapter(), new EmailIntakeAdapter()];
    const orchestrator   = new Orchestrator(jobStore, intakeAdapters, notifiers, registry);
    const sampleRequest  = buildSampleRequest(instanceId);

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

  // ── MCWorker (daemon workhorse) ────────────────────────────────────────────
  // Registers agents in MC, polls the task queue, executes workflows, and
  // routes approval webhook events back to the right workflow.
  //
  // Requires: MISSION_CONTROL_URL + MISSION_CONTROL_API_KEY in .env
  // If not set, daemon runs without MC (intake adapters drive jobs directly).

  const mcWorker = new MCWorker(registry, notifiers, jobStore);
  await mcWorker.start();

  // ── Webhook registration ───────────────────────────────────────────────────
  // Register ElevarusOS as a webhook receiver in MC so approvals flow back
  // automatically instead of being polled.
  //
  // MC will POST to: ELEVARUS_PUBLIC_URL/api/webhooks/mc
  // Set ELEVARUS_PUBLIC_URL in .env (e.g. https://elevarus.ngrok.io or
  // http://host.docker.internal:3001 for Docker, or leave blank for localhost).

  if (mcWorker.enabled) {
    const publicUrl  = (process.env.ELEVARUS_PUBLIC_URL ?? "").replace(/\/$/, "");
    const webhookUrl = publicUrl
      ? `${publicUrl}/api/webhooks/mc`
      : null;

    if (webhookUrl) {
      const mcClient = new MCClient();
      await mcClient.registerWebhook(webhookUrl, ["task.updated", "task.created"]);
    } else {
      logger.info(
        "MCWorker: ELEVARUS_PUBLIC_URL not set — MC webhook not registered. " +
        "Set it to enable push-based approvals (e.g. ELEVARUS_PUBLIC_URL=http://host.docker.internal:3001). " +
        "Without it, approvals require a manual call to POST /api/webhooks/mc."
      );
    }
  }

  // ── API server ─────────────────────────────────────────────────────────────
  // GET  /api/health | /api/bots | /api/jobs | /api/schedule | /api/instances
  // POST /api/jobs      — creates MC task (daemon) or runs directly (--once)
  // POST /api/instances — scaffold + register new bot
  // POST /api/webhooks/mc — MC webhook receiver (approval events)

  const apiServer = new ApiServer({
    port:      parseInt(process.env.API_PORT ?? "3001", 10),
    jobStore,
    registry,
    mcWorker,
    // Orchestrator not needed in daemon mode — MCWorker handles execution
  });
  apiServer.start();

  // ── Scheduler ─────────────────────────────────────────────────────────────
  // Fires jobs for instances with schedule.enabled: true.
  // In daemon mode, creates MC tasks (picked up by MCWorker).
  // Falls back to direct job submission if MC is not configured.

  const scheduler = new Scheduler(async (instanceId) => {
    if (mcWorker.enabled) {
      const req = buildSampleRequest(instanceId);
      await mcWorker.createTask({
        instanceId,
        title:       req.title,
        description: req.brief,
        tags:        [instanceId, instanceId.includes("reporting") ? "reporting" : "blog"],
        metadata: {
          request: {
            title:    req.title,
            brief:    req.brief,
            audience: req.audience,
            keyword:  req.targetKeyword,
            cta:      req.cta,
            approver: req.approver,
          },
        },
      });
      logger.info("Scheduler: MC task created", { instanceId, title: req.title });
    } else {
      // MC not configured — run directly (legacy path)
      const intakeAdapters = [new ClickUpIntakeAdapter(), new EmailIntakeAdapter()];
      const orchestrator   = new Orchestrator(jobStore, intakeAdapters, notifiers, registry);
      const req            = buildSampleRequest(instanceId);
      await orchestrator.submitJob(req, instanceId);
    }
  });
  scheduler.start();

  // ── Data sync workers ─────────────────────────────────────────────────────
  // Keep Supabase in sync with external platforms. Each worker runs on its own
  // cron, no-ops if its API key / Supabase is missing. Workflows read the
  // resulting Supabase rows via integration repositories — never the API
  // directly.

  const lpSync     = new LeadsProsperSyncWorker();
  const ringbaSync = new RingbaSyncWorker();
  lpSync.start();
  ringbaSync.start();

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  const shutdown = (): void => {
    logger.info("Shutting down...");
    mcWorker.stop();
    scheduler.stop();
    lpSync.stop();
    ringbaSync.stop();
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
        leads:          47,
        cpl:            38.50,
        spend:          1809.50,
        budget:         2000,
        conversion_rate: "4.2%",
        top_ad_set:     "Awareness — 45-64 Homeowners",
        vs_last_week:   { leads: "+8%", cpl: "-5%", spend: "+2%" },
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
