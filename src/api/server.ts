/**
 * ElevarusOS API Server
 *
 * Lightweight REST API exposing bot status, job history, instance configs,
 * and an inbound webhook receiver for Mission Control events.
 *
 * ─── Endpoints ───────────────────────────────────────────────────────────────
 *
 *   GET  /api/health                — liveness + uptime check
 *
 *   GET  /api/bots                  — list all registered instances with last-job summary
 *   GET  /api/bots/:instanceId      — single instance config + job stats
 *
 *   GET  /api/jobs                  — list jobs (query: ?status=&instanceId=&limit=)
 *   GET  /api/jobs/:jobId           — full job detail (all stages + outputs)
 *   POST /api/jobs                  — submit a new job (creates MC task in daemon mode)
 *                                     body: { workflowType, title, brief, audience,
 *                                             targetKeyword, cta, approver? }
 *
 *   GET  /api/schedule              — upcoming scheduled runs per instance
 *
 *   GET  /api/instances             — list all instance configs
 *   POST /api/instances             — create a new bot instance
 *
 *   POST /api/webhooks/mc           — Mission Control webhook receiver
 *                                     Receives signed task.updated events and
 *                                     routes approvals to MCWorker.
 *
 * ─── Auth ────────────────────────────────────────────────────────────────────
 *
 * Optional: set API_SECRET in .env to require x-api-key header on all routes
 * (except /api/webhooks/mc which uses HMAC signature verification instead).
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import express, { Request, Response, NextFunction } from "express";
import { IJobStore } from "../core/job-store";
import { WorkflowRegistry } from "../core/workflow-registry";
import { Orchestrator } from "../core/orchestrator";
import { MCWorker } from "../core/mc-worker";
import { scaffoldInstanceWorkspace } from "../core/workspace-scaffold";
import { listInstanceIds, loadInstanceConfig } from "../core/instance-config";
import { logger } from "../core/logger";
import { BlogRequest } from "../models/blog-request.model";
import { getCampaignRevenue, getDateRange } from "../integrations/ringba";
import {
  verifySlackSignature,
  handleSlackEvent,
  SlackEventEnvelope,
} from "../core/slack-events";
import { config } from "../config";

const INSTANCES_DIR = path.resolve(__dirname, "../instances");

export interface ApiServerOptions {
  port:         number;
  jobStore:     IJobStore;
  registry:     WorkflowRegistry;
  /** Optional — required for POST /api/jobs in direct/--once mode */
  orchestrator?: Orchestrator;
  /** Optional — when present, POST /api/jobs creates an MC task instead */
  mcWorker?:    MCWorker;
}

export class ApiServer {
  private readonly app = express();

  constructor(private readonly options: ApiServerOptions) {
    // Raw body needed for webhook HMAC verification — must come before json()
    this.app.use("/api/webhooks/mc",    express.raw({ type: "application/json" }));
    this.app.use("/api/webhooks/slack", express.raw({ type: "application/json" }));
    this.app.use(express.json());
    this.app.use(this.authMiddleware.bind(this));
    this.registerRoutes();
  }

  start(): void {
    this.app.listen(this.options.port, () => {
      logger.info("API server started", { port: this.options.port });
    });
  }

  // ─── Auth middleware ────────────────────────────────────────────────────────

  private authMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Webhook endpoints authenticate via HMAC — skip API key check
    if (req.path.startsWith("/api/webhooks/mc"))    { next(); return; }
    if (req.path.startsWith("/api/webhooks/slack")) { next(); return; }

    const secret = process.env.API_SECRET;
    if (!secret) { next(); return; }

    const key = req.headers["x-api-key"];
    if (key !== secret) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  }

  // ─── Route registration ─────────────────────────────────────────────────────

  private registerRoutes(): void {
    const r = this.app;

    // ── Health ──────────────────────────────────────────────────────────────
    r.get("/api/health", (_req, res) => {
      res.json({ status: "ok", uptime: process.uptime(), ts: new Date().toISOString() });
    });

    // ── Bots ────────────────────────────────────────────────────────────────
    r.get("/api/bots",            this.handleAsync(this.getBots.bind(this)));
    r.get("/api/bots/:instanceId", this.handleAsync(this.getBot.bind(this)));

    // ── Jobs ─────────────────────────────────────────────────────────────────
    r.get("/api/jobs",                    this.handleAsync(this.listJobs.bind(this)));
    r.get("/api/jobs/:jobId",             this.handleAsync(this.getJob.bind(this)));
    r.get("/api/jobs/:jobId/output",      this.handleAsync(this.getJobOutput.bind(this)));
    r.post("/api/jobs",                   this.handleAsync(this.submitJob.bind(this)));

    // ── Schedule ─────────────────────────────────────────────────────────────
    r.get("/api/schedule",     this.handleAsync(this.getSchedule.bind(this)));

    // ── Instances ────────────────────────────────────────────────────────────
    r.get("/api/instances",    this.handleAsync(this.listInstances.bind(this)));
    r.post("/api/instances",   this.handleAsync(this.createInstance.bind(this)));

    // ── Data APIs — callable by MC agents as tools ────────────────────────────
    // MC agents call these to fetch data they can't get natively.
    // Returns structured JSON the agent uses to format its own report.
    r.get("/api/data/ringba/revenue",  this.handleAsync(this.getRingbaRevenue.bind(this)));
    r.get("/api/data/ringba/campaigns", this.handleAsync(this.getRingbaCampaigns.bind(this)));

    // ── Action APIs — MC agents call these to trigger deliveries ─────────────
    r.post("/api/actions/slack",        this.handleAsync(this.postSlackMessage.bind(this)));

    // ── Mission Control webhook receiver ──────────────────────────────────────
    r.post("/api/webhooks/mc", this.handleAsync(this.receiveMCWebhook.bind(this)));

    // ── Slack Events API receiver (Q&A bot) ───────────────────────────────────
    r.post("/api/webhooks/slack", this.handleAsync(this.receiveSlackWebhook.bind(this)));

    // ── 404 catch-all ────────────────────────────────────────────────────────
    r.use((_req, res) => {
      res.status(404).json({ error: "Not found" });
    });
  }

  // ─── Handlers ───────────────────────────────────────────────────────────────

  private async getBots(_req: Request, res: Response): Promise<void> {
    const instanceIds = listInstanceIds(true);
    const jobs        = await this.options.jobStore.list();

    const bots = instanceIds.map((id) => {
      try {
        const cfg          = loadInstanceConfig(id);
        const instanceJobs = jobs.filter((j) => j.workflowType === id);
        const sorted       = [...instanceJobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const last         = sorted[0];
        const running      = instanceJobs.filter(
          (j) => j.status === "running" || j.status === "awaiting_approval"
        ).length;

        return {
          instanceId:   id,
          name:         cfg.name,
          baseWorkflow: cfg.baseWorkflow,
          enabled:      cfg.enabled,
          brand:        { voice: cfg.brand.voice, tone: cfg.brand.tone },
          schedule:     cfg.schedule,
          notify:       { approver: cfg.notify.approver },
          stats: {
            total:         instanceJobs.length,
            running,
            lastJobId:     last?.id,
            lastJobStatus: last?.status,
            lastJobAt:     last?.createdAt,
            lastJobTitle:  last?.request.title,
          },
        };
      } catch {
        return { instanceId: id, error: "config unavailable" };
      }
    });

    res.json({ bots });
  }

  private async getBot(req: Request, res: Response): Promise<void> {
    const instanceId = String(req.params.instanceId);

    let cfg;
    try {
      cfg = loadInstanceConfig(instanceId);
    } catch {
      res.status(404).json({ error: `Instance "${instanceId}" not found` });
      return;
    }

    const jobs         = await this.options.jobStore.list();
    const instanceJobs = jobs
      .filter((j) => j.workflowType === instanceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const byStatus = instanceJobs.reduce<Record<string, number>>((acc, j) => {
      acc[j.status] = (acc[j.status] ?? 0) + 1;
      return acc;
    }, {});

    res.json({
      instanceId,
      config: cfg,
      stats: {
        total:      instanceJobs.length,
        byStatus,
        recentJobs: instanceJobs.slice(0, 5).map((j) => ({
          jobId:       j.id,
          status:      j.status,
          title:       j.request.title,
          createdAt:   j.createdAt,
          completedAt: j.completedAt,
        })),
      },
    });
  }

  private async listJobs(req: Request, res: Response): Promise<void> {
    const status     = typeof req.query.status     === "string" ? req.query.status     : undefined;
    const instanceId = typeof req.query.instanceId === "string" ? req.query.instanceId : undefined;
    const limitRaw   = typeof req.query.limit      === "string" ? req.query.limit      : "50";
    const maxResults = Math.min(parseInt(limitRaw, 10), 200);

    let jobs = await this.options.jobStore.list();
    if (status)     jobs = jobs.filter((j) => j.status === status);
    if (instanceId) jobs = jobs.filter((j) => j.workflowType === instanceId);

    jobs = jobs
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, maxResults);

    const rows = jobs.map((j) => ({
      jobId:           j.id,
      workflowType:    j.workflowType,
      status:          j.status,
      title:           j.request.title,
      createdAt:       j.createdAt,
      updatedAt:       j.updatedAt,
      completedAt:     j.completedAt,
      currentStage:    j.stages.find((s) => s.status === "running")?.name ?? null,
      completedStages: j.stages.filter((s) => s.status === "completed").length,
      totalStages:     j.stages.length,
      approvalPending: j.status === "awaiting_approval",
      error:           j.error ?? null,
    }));

    res.json({ jobs: rows, total: rows.length });
  }

  private async getJob(req: Request, res: Response): Promise<void> {
    const job = await this.options.jobStore.get(String(req.params.jobId));
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    res.json({
      jobId:        job.id,
      workflowType: job.workflowType,
      status:       job.status,
      title:        job.request.title,
      createdAt:    job.createdAt,
      updatedAt:    job.updatedAt,
      completedAt:  job.completedAt ?? null,
      error:        job.error ?? null,
      request:      job.request,
      approval:     job.approval,
      publishRecord: job.publishRecord ?? null,
      stages: job.stages.map((s) => ({
        name:        s.name,
        status:      s.status,
        attempts:    s.attempts,
        startedAt:   s.startedAt ?? null,
        completedAt: s.completedAt ?? null,
        error:       s.error ?? null,
        hasOutput:   s.output !== undefined,
      })),
    });
  }

  /**
   * POST /api/jobs
   *
   * In daemon mode (MCWorker configured): creates a task in MC and returns
   * immediately. MCWorker picks it up via queue polling.
   *
   * In --once/direct mode (orchestrator only): runs the workflow synchronously
   * and returns the job ID.
   */
  /**
   * GET /api/jobs/:jobId/output
   *
   * Returns the full stage outputs for a completed job.
   * The summary/report content lives in the "summary" stage output (reporting)
   * or the "editorial" stage output (blog).
   *
   * Example:
   *   curl http://localhost:3001/api/jobs/<id>/output | jq '.stages.summary.markdownReport'
   */
  private async getJobOutput(req: Request, res: Response): Promise<void> {
    const job = await this.options.jobStore.get(String(req.params.jobId));
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    // Build a map of stageName → output for all stages that have output
    const stages: Record<string, unknown> = {};
    for (const s of job.stages) {
      if (s.output !== undefined) {
        stages[s.name] = s.output;
      }
    }

    // Surface the most useful output at the top level for easy access
    const summary  = stages["summary"]  as Record<string, unknown> | undefined;
    const editorial = stages["editorial"] as Record<string, unknown> | undefined;
    const draft    = stages["drafting"]  as Record<string, unknown> | undefined;

    res.json({
      jobId:        job.id,
      workflowType: job.workflowType,
      status:       job.status,
      title:        job.request.title,
      completedAt:  job.completedAt ?? null,

      // Top-level shortcuts for the most-wanted outputs
      report:       summary?.markdownReport   ?? null,
      slackMessage: summary?.slackMessage     ?? null,
      alertLevel:   summary?.alertLevel       ?? null,
      oneLiner:     summary?.oneLiner         ?? null,
      finalDraft:   editorial?.editedDraft ?? editorial?.draft ?? editorial?.content ?? null,
      initialDraft: draft?.draft ?? draft?.content ?? null,

      // Full stage-by-stage outputs
      stages,
    });
  }

  private async submitJob(req: Request, res: Response): Promise<void> {
    const { workflowType, title, brief, audience, targetKeyword, cta, approver } = req.body ?? {};

    const missing: string[] = [];
    if (!workflowType) missing.push("workflowType");
    if (!title)        missing.push("title");
    if (!brief)        missing.push("brief");
    if (missing.length) {
      res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
      return;
    }

    if (!this.options.registry.get(workflowType)) {
      res.status(400).json({
        error:      `Unknown workflowType "${workflowType}"`,
        registered: this.options.registry.registeredTypes,
      });
      return;
    }

    // ── Daemon mode: create MC task ──────────────────────────────────────────
    if (this.options.mcWorker?.enabled) {
      const mcTaskId = await this.options.mcWorker.createTask({
        instanceId:  workflowType,
        title,
        description: brief,
        metadata: {
          request: { title, brief, audience, keyword: targetKeyword, cta, approver },
        },
      });

      res.status(202).json({
        message:   "Task created in Mission Control",
        mcTaskId,
        workflowType,
        mcUrl:     `${process.env.MISSION_CONTROL_URL ?? "http://localhost:3000"}/tasks`,
      });
      return;
    }

    // ── Direct mode: run via orchestrator ────────────────────────────────────
    if (!this.options.orchestrator) {
      res.status(503).json({ error: "No orchestrator or MCWorker available" });
      return;
    }

    const request: BlogRequest = {
      title,
      brief,
      audience:      audience      ?? "",
      targetKeyword: targetKeyword ?? "",
      cta:           cta           ?? "",
      approver:      approver      ?? undefined,
      workflowType,
      rawSource: {
        channel:    "manual",
        receivedAt: new Date().toISOString(),
        payload:    { source: "api" },
      },
      missingFields: [],
    };

    const jobPromise = this.options.orchestrator.submitJob(request, workflowType);
    jobPromise.catch((err) => {
      logger.error("API-submitted job failed", { error: String(err) });
    });

    // Give orchestrator a tick to create and save the job
    await new Promise((r) => setTimeout(r, 50));

    const allJobs = await this.options.jobStore.list();
    const newest  = allJobs
      .filter((j) => j.workflowType === workflowType)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    res.status(202).json({
      message:     "Job submitted",
      jobId:       newest?.id ?? "unknown",
      workflowType,
      pollUrl:     `/api/jobs/${newest?.id ?? "unknown"}`,
    });
  }

  private async getSchedule(_req: Request, res: Response): Promise<void> {
    const instanceIds = listInstanceIds(false);

    const schedule = instanceIds
      .map((id) => {
        try {
          const cfg = loadInstanceConfig(id);
          if (!cfg.schedule.enabled) return null;
          return {
            instanceId:  id,
            name:        cfg.name,
            cron:        cfg.schedule.cron ?? null,
            description: cfg.schedule.description ?? null,
            timezone:    "UTC",
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    res.json({ schedule });
  }

  // ─── Instance handlers ────────────────────────────────────────────────────────

  private async listInstances(_req: Request, res: Response): Promise<void> {
    const instanceIds = listInstanceIds(true);
    const instances   = instanceIds.map((id) => {
      try {
        const cfg = loadInstanceConfig(id);
        return {
          id:           cfg.id,
          name:         cfg.name,
          baseWorkflow: cfg.baseWorkflow,
          enabled:      cfg.enabled,
          brand:        cfg.brand,
          notify:       cfg.notify,
          schedule:     cfg.schedule,
          instanceDir:  path.join(INSTANCES_DIR, id),
        };
      } catch {
        return { id, error: "config unavailable" };
      }
    });
    res.json({ instances });
  }

  /**
   * POST /api/instances
   *
   * Creates a new bot instance from a template and registers it in MC.
   *
   * Body:
   *   id            string   — unique slug (e.g. "acme-blog")
   *   name          string   — human-readable name
   *   baseWorkflow  string   — "blog" | "ppc-campaign-report"
   *   voice         string   — brand voice/style
   *   audience      string   — target reader description
   *   tone          string   — tone descriptor
   *   industry?     string   — optional industry context
   *   approver?     string   — approver email
   *   slackChannel? string   — Slack channel ID
   */
  private async createInstance(req: Request, res: Response): Promise<void> {
    const {
      id, name, baseWorkflow = "blog",
      voice = "", audience = "", tone = "", industry,
      approver, slackChannel,
    } = req.body ?? {};

    if (!id || !name) {
      res.status(400).json({ error: "id and name are required" });
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
      res.status(400).json({ error: "id must be a lowercase slug (letters, numbers, hyphens)" });
      return;
    }
    if (!["blog", "ppc-campaign-report"].includes(baseWorkflow)) {
      res.status(400).json({ error: 'baseWorkflow must be "blog" or "ppc-campaign-report"' });
      return;
    }

    const instanceDir = path.join(INSTANCES_DIR, id);
    if (fs.existsSync(instanceDir)) {
      res.status(409).json({ error: `Instance "${id}" already exists` });
      return;
    }

    fs.mkdirSync(instanceDir, { recursive: true });

    const instanceMd = [
      `---`,
      `id: ${id}`,
      `name: ${name}`,
      `baseWorkflow: ${baseWorkflow}`,
      `enabled: true`,
      ``,
      `brand:`,
      `  voice: "${voice}"`,
      `  audience: "${audience}"`,
      `  tone: "${tone}"`,
      industry ? `  industry: "${industry}"` : `  # industry: ""`,
      ``,
      `notify:`,
      approver     ? `  approver: ${approver}`         : `  # approver: approver@example.com`,
      slackChannel ? `  slackChannel: ${slackChannel}` : `  # slackChannel: ~`,
      ``,
      `schedule:`,
      `  enabled: false`,
      `  # cron: "0 9 * * 1"`,
      `  # description: "Weekly run on Mondays at 9am UTC"`,
      `---`,
      ``,
      `# ${name}`,
      ``,
      `${name} — a ${baseWorkflow} bot instance built on ElevarusOS.`,
      ``,
      `## Next steps`,
      ``,
      `1. Add \`registry.register(build${baseWorkflow === "blog" ? "Blog" : "PPCCampaignReport"}WorkflowDefinition(notifiers, "${id}"));\` to \`src/index.ts\``,
      `2. Restart ElevarusOS — the bot will appear in Mission Control automatically`,
      `3. Submit a test job via the MC Task Board or: POST /api/jobs`,
    ].join("\n");

    fs.writeFileSync(path.join(instanceDir, "instance.md"), instanceMd, "utf8");

    // Scaffold standard MC workspace files (agent.md, soul.md, identity.md, etc.)
    try {
      const cfg = loadInstanceConfig(id);
      scaffoldInstanceWorkspace(cfg, true);
    } catch {
      // Non-fatal
    }

    const mcRegistered = false; // MCWorker picks up new agents on next restart

    logger.info("API: instance created", { id, name, baseWorkflow });

    res.status(201).json({
      message:      "Instance created",
      id,
      name,
      baseWorkflow,
      instanceDir,
      mcRegistered,
      nextStep: `Add registry.register(build${baseWorkflow === "blog" ? "Blog" : "PPCCampaignReport"}WorkflowDefinition(notifiers, "${id}")); to src/index.ts and restart.`,
    });
  }

  // ─── Mission Control webhook receiver ────────────────────────────────────────

  /**
   * POST /api/webhooks/mc
   *
   * Receives signed webhook events from Mission Control.
   * MC sends this when tasks are updated — we watch for approval events
   * (task moved to "done" or "quality_review" while status was "review").
   *
   * Security: HMAC-SHA256 signature verified via X-MC-Signature header.
   * Configure MC_WEBHOOK_SECRET to match the secret used when registering.
   *
   * Events handled:
   *   task.updated  — routes approval to MCWorker.notifyApproval()
   *   agent.*       — logged for observability
   */
  private async receiveMCWebhook(req: Request, res: Response): Promise<void> {
    // Verify HMAC signature (if secret is configured)
    const secret = process.env.MC_WEBHOOK_SECRET;
    if (secret) {
      const signature = req.headers["x-mc-signature"] as string | undefined;
      if (!signature) {
        res.status(401).json({ error: "Missing X-MC-Signature" });
        return;
      }
      const rawBody = req.body as Buffer;
      const expected = "sha256=" + crypto
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");

      if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        res.status(401).json({ error: "Invalid signature" });
        return;
      }
    }

    // Parse payload
    let payload: {
      event:   string;
      task?:   { id: number; status: string; assigned_to?: string };
      agent?:  { id: number; name: string; status: string };
    };

    try {
      const raw = req.body instanceof Buffer ? req.body.toString("utf8") : JSON.stringify(req.body);
      payload   = JSON.parse(raw);
    } catch {
      res.status(400).json({ error: "Invalid JSON payload" });
      return;
    }

    const { event, task } = payload;

    logger.debug("MCWorker: webhook received", { event, taskId: task?.id, status: task?.status });

    // ── Approval events ──────────────────────────────────────────────────────
    // MC fires task.updated when a human moves a task to "done" or "quality_review"
    if (event === "task.updated" && task) {
      const approved = task.status === "done" || task.status === "quality_review";
      if (approved && this.options.mcWorker) {
        this.options.mcWorker.notifyApproval(task.id, true);
      }
    }

    // Acknowledge receipt immediately — MC expects a 2xx within 10s
    res.status(200).json({ received: true, event });
  }

  // ─── Slack Events API receiver ────────────────────────────────────────────────

  /**
   * POST /api/webhooks/slack
   *
   * Receives signed events from the Slack Events API. In Phase 1, handles
   * app_mention and message.im events and posts a static echo reply. Later
   * phases route to the QA workflow (see docs/qa-bot.md).
   *
   * Security: v0 HMAC-SHA256 via x-slack-signature + x-slack-request-timestamp.
   * Configure SLACK_SIGNING_SECRET to match the Slack app.
   *
   * Slack expects a 2xx within 3s. We verify, parse, ack, then dispatch the
   * event asynchronously so slow replies don't trigger Slack retries.
   */
  private async receiveSlackWebhook(req: Request, res: Response): Promise<void> {
    const signingSecret = config.slack.signingSecret;
    if (!signingSecret) {
      res.status(503).json({ error: "SLACK_SIGNING_SECRET not configured" });
      return;
    }

    const rawBody   = req.body instanceof Buffer ? req.body : Buffer.from("");
    const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
    const signature = req.headers["x-slack-signature"]         as string | undefined;

    const verified = verifySlackSignature(rawBody, timestamp, signature, signingSecret);
    if (!verified.ok) {
      logger.warn("Slack webhook: signature verification failed", { error: verified.error });
      res.status(401).json({ error: verified.error ?? "Invalid signature" });
      return;
    }

    let envelope: SlackEventEnvelope;
    try {
      envelope = JSON.parse(rawBody.toString("utf8")) as SlackEventEnvelope;
    } catch {
      res.status(400).json({ error: "Invalid JSON payload" });
      return;
    }

    // URL verification is a synchronous challenge-response — return the
    // challenge value in the body before doing anything else.
    if (envelope.type === "url_verification") {
      const response = await handleSlackEvent(envelope, {
        registry: this.options.registry,
        jobStore: this.options.jobStore,
      });
      res.status(200).json(response);
      return;
    }

    // For real events, ack immediately so Slack doesn't retry, then dispatch.
    res.status(200).json({ ok: true });

    handleSlackEvent(envelope, {
        registry: this.options.registry,
        jobStore: this.options.jobStore,
      }).catch((err) => {
      logger.error("Slack event handler failed", {
        eventId:   envelope.event_id,
        eventType: envelope.event?.type,
        error:     String(err),
      });
    });
  }

  // ─── Data APIs ────────────────────────────────────────────────────────────────
  //
  // MC agents call these endpoints to fetch data they need for their reports.
  // The agent (Claude) then formats the report using its own MISSION.md instructions.

  /**
   * GET /api/data/ringba/revenue
   *
   * Returns revenue metrics for a campaign/period.
   * MC agents call this as a tool during task execution.
   *
   * Query params:
   *   instanceId  — instance ID to read ringba config from (e.g. "final-expense-reporting")
   *   campaign    — Ringba campaign name (overrides instance config)
   *   period      — mtd | wtd | ytd | custom (default: mtd)
   *   startDate   — YYYY-MM-DD (required when period=custom)
   *   endDate     — YYYY-MM-DD (required when period=custom)
   *
   * Returns: { campaign, period, startDate, endDate, totalCalls, paidCalls,
   *            totalRevenue, totalPayout, avgPayout, pulledAt }
   */
  private async getRingbaRevenue(req: Request, res: Response): Promise<void> {
    const { instanceId, campaign, period = "mtd", startDate, endDate } = req.query as Record<string, string>;

    // Resolve campaign name — from query param or instance config
    let campaignName = campaign;
    if (!campaignName && instanceId) {
      try {
        const cfg = loadInstanceConfig(instanceId);
        campaignName = (cfg as any).ringba?.campaignName;
      } catch { /* ignore */ }
    }

    if (!campaignName) {
      res.status(400).json({ error: "Provide ?campaign= or ?instanceId= with ringba.campaignName configured" });
      return;
    }

    const range = getDateRange(period, startDate, endDate);

    try {
      const report = await getCampaignRevenue({
        campaignName,
        startDate: range.startDate,
        endDate:   range.endDate,
      });

      if (!report) {
        res.status(503).json({ error: "Ringba not configured — set RINGBA_API_KEY + RINGBA_ACCOUNT_ID" });
        return;
      }

      // Return metrics only — omit the full calls array (too large for agent context)
      res.json({
        campaign:     report.campaignName,
        campaignId:   report.campaignId,
        period:       `${report.startDate} → ${report.endDate}`,
        startDate:    report.startDate,
        endDate:      report.endDate,
        totalCalls:   report.totalCalls,
        paidCalls:    report.paidCalls,
        totalRevenue: report.totalRevenue,
        totalPayout:  report.totalPayout,
        avgPayout:    report.avgPayout,
        pulledAt:     new Date().toISOString(),
      });
    } catch (err) {
      logger.error("GET /api/data/ringba/revenue error", { error: String(err) });
      res.status(500).json({ error: "Failed to fetch Ringba revenue" });
    }
  }

  /**
   * GET /api/data/ringba/campaigns
   * Lists all Ringba campaigns — useful for MC agents discovering available campaigns.
   */
  private async getRingbaCampaigns(_req: Request, res: Response): Promise<void> {
    const { RingbaHttpClient } = await import("../integrations/ringba");
    const client = new RingbaHttpClient();
    if (!client.enabled) {
      res.status(503).json({ error: "Ringba not configured" });
      return;
    }
    const campaigns = await client.listCampaigns();
    res.json({ campaigns, count: campaigns.length });
  }

  // ─── Action APIs ──────────────────────────────────────────────────────────────
  //
  // MC agents call these to trigger deliveries after they've formatted the output.

  /**
   * POST /api/actions/slack
   *
   * Posts a message to a Slack channel on behalf of an MC agent.
   * The agent provides the pre-formatted message — ElevarusOS handles delivery.
   *
   * Body: { channel, text, blocks? }
   * Returns: { published, ts, channel }
   */
  private async postSlackMessage(req: Request, res: Response): Promise<void> {
    const { channel, text, blocks } = req.body as {
      channel: string;
      text:    string;
      blocks?: unknown[];
    };

    if (!channel || !text) {
      res.status(400).json({ error: "body.channel and body.text are required" });
      return;
    }

    try {
      const { postToSlack } = await import("../core/slack-client");
      const ts = await postToSlack({ channel, text, blocks: blocks as any });
      res.json({ published: ts !== undefined, ts: ts ?? null, channel });
    } catch (err) {
      logger.error("POST /api/actions/slack error", { error: String(err) });
      res.status(500).json({ error: "Failed to post to Slack" });
    }
  }

  // ─── Utility ─────────────────────────────────────────────────────────────────

  private handleAsync(fn: (req: Request, res: Response) => Promise<void>) {
    return (req: Request, res: Response, next: NextFunction): void => {
      fn(req, res).catch(next);
    };
  }
}
