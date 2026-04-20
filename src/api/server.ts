/**
 * ElevarusOS API Server
 *
 * Lightweight REST API exposing bot status, job history, instance configs,
 * approval actions, and inbound Slack webhook receivers.
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
 *   GET  /api/jobs/:jobId/output    — stage outputs for a completed job
 *   POST /api/jobs                  — submit a new job (runs via Orchestrator)
 *                                     body: { workflowType, title, brief, audience,
 *                                             targetKeyword, cta, approver? }
 *   POST /api/jobs/:jobId/approve   — approve a pending approval gate
 *   POST /api/jobs/:jobId/reject    — reject a pending approval gate
 *
 *   GET  /api/schedule              — upcoming scheduled runs per instance
 *
 *   GET  /api/instances             — list all instance configs
 *   POST /api/instances             — create a new bot instance
 *
 *   POST /api/webhooks/slack              — Slack Events API receiver (Q&A bot)
 *   POST /api/webhooks/slack/interactions — Slack interactive components (Approve/Reject buttons)
 *
 * ─── Auth ────────────────────────────────────────────────────────────────────
 *
 * Optional: set API_SECRET in .env to require x-api-key header on all routes
 * (except webhook endpoints which use Slack HMAC signature verification).
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import express, { Request, Response, NextFunction } from "express";
import { IJobStore } from "../core/job-store";
import { WorkflowRegistry } from "../core/workflow-registry";
import { Orchestrator } from "../core/orchestrator";
import { approvalStore } from "../core/approval-store";
import { scaffoldInstanceWorkspace } from "../core/workspace-scaffold";
import { listInstanceIds, loadInstanceConfig } from "../core/instance-config";
import { logger } from "../core/logger";
import { BlogRequest } from "../models/blog-request.model";
import { getCampaignRevenue, getDateRange } from "../integrations/ringba";
import {
  verifySlackSignature,
  handleSlackEvent,
  SlackEventEnvelope,
} from "../adapters/slack/events";
import { config } from "../config";
import { INTEGRATION_MANIFESTS } from "../core/integration-registry";
import { buildAgentBuilderRouter } from "./agent-builder.routes";

const AGENTS_DIR = path.resolve(__dirname, "../agents");

export interface ApiServerOptions {
  port:          number;
  jobStore:      IJobStore;
  registry:      WorkflowRegistry;
  /** Required for POST /api/jobs — runs workflows directly */
  orchestrator?: Orchestrator;
}

export class ApiServer {
  private readonly app = express();

  constructor(private readonly options: ApiServerOptions) {
    // CORS — allow the dashboard (and any configured origin) to call the API
    // from the browser. The dashboard runs on port 3000; the API on 3001.
    //
    // Default whitelist covers common dev variations: http/https × localhost/127.0.0.1
    // on port 3000. The previous default ("http://localhost:3000" only) silently
    // failed when the dashboard was loaded via 127.0.0.1, https, or a tunnel —
    // CORS would skip its headers and the browser would throw "Failed to fetch."
    //
    // For ngrok/LAN/production origins, set CORS_ORIGINS=<csv> in .env.
    // Anywhere/wildcard: set CORS_ORIGINS=*.
    const DEFAULT_DEV_ORIGINS = [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "https://localhost:3000",
      "https://127.0.0.1:3000",
    ];
    const explicitOrigins = (process.env.CORS_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    const allowedOrigins = explicitOrigins.length > 0
      ? explicitOrigins
      : DEFAULT_DEV_ORIGINS;

    /** True if the request origin is allowed. Wildcard or exact match. */
    const isOriginAllowed = (origin: string): boolean => {
      if (!origin) return false;
      if (allowedOrigins.includes("*")) return true;
      if (allowedOrigins.includes(origin)) return true;
      return false;
    };

    this.app.use((req: Request, res: Response, next: NextFunction) => {
      const origin = req.headers.origin ?? "";
      if (isOriginAllowed(origin)) {
        res.setHeader("Access-Control-Allow-Origin",  origin);
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-api-key, Authorization");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Vary",                         "Origin");
      } else if (origin) {
        // Helpful one-time warning per unknown origin so we know to add it.
        logUnknownOrigin(origin, allowedOrigins);
      }
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    });

    // Raw body needed for Slack HMAC signature verification — must come before json()
    // /api/webhooks/slack/interactions uses urlencoded (Slack sends payload= field)
    this.app.use("/api/webhooks/slack/interactions", express.raw({ type: "application/x-www-form-urlencoded" }));
    this.app.use("/api/webhooks/slack",              express.raw({ type: "application/json" }));
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
    // Public endpoints — no API key required.
    //
    // Both /api/foo and bare /foo forms are accepted because DigitalOcean
    // App Platform routing can strip the matched path prefix before
    // forwarding to the service (depends on preserve_path_prefix setting).
    // We accept both shapes to be robust.
    //
    //   health           — DO probe + uptime monitors
    //   webhooks/slack/* — Slack HMAC verified inside handler
    //   openapi.json     — public spec
    //   api-reference    — public Scalar HTML viewer
    const p = req.path;
    if (
      p === "/api/health"          || p === "/health"          ||
      p === "/api/openapi.json"    || p === "/openapi.json"    ||
      p === "/api-reference"       ||
      p.startsWith("/api/webhooks/slack") || p.startsWith("/webhooks/slack")
    ) { next(); return; }

    const secret = process.env.API_SECRET;
    if (!secret) { next(); return; }

    // Read methods are allowed without x-api-key. The dashboard's browser-side
    // code fetches these directly (e.g. GET /api/jobs) and can't carry a
    // secret. CORS (CORS_ORIGINS) already restricts which browser origins
    // can call the API, and reads expose only non-sensitive aggregate data.
    // Writes (POST/PUT/PATCH/DELETE) still require the shared secret.
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }

    const key = req.headers["x-api-key"];
    if (key !== secret) {
      // One-line diagnostic so future routing surprises are obvious in logs.
      logger.warn("api: 401 — path not in allowlist + no x-api-key", { path: p, method: req.method });
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
    r.post("/api/jobs/:jobId/approve",    this.handleAsync(this.approveJob.bind(this)));
    r.post("/api/jobs/:jobId/reject",     this.handleAsync(this.rejectJob.bind(this)));
    r.post("/api/jobs/:jobId/cancel",     this.handleAsync(this.cancelJob.bind(this)));

    // ── Schedule ─────────────────────────────────────────────────────────────
    r.get("/api/schedule",     this.handleAsync(this.getSchedule.bind(this)));

    // ── Instances ────────────────────────────────────────────────────────────
    r.get("/api/instances",    this.handleAsync(this.listInstances.bind(this)));
    r.post("/api/instances",   this.handleAsync(this.createInstance.bind(this)));

    // ── Analytics ─────────────────────────────────────────────────────────────
    r.get("/api/analytics/tokens", this.handleAsync(this.getTokenAnalytics.bind(this)));

    // ── Workflows ─────────────────────────────────────────────────────────────
    r.get("/api/workflows", this.handleAsync(this.listWorkflows.bind(this)));

    // ── Integrations ──────────────────────────────────────────────────────────
    r.get("/api/integrations", this.handleAsync(this.getIntegrations.bind(this)));

    // ── Agent Builder ─────────────────────────────────────────────────────────
    // Multi-step wizard that produces a ClickUp PRD for a new agent.
    // Slack uses the tool-based surface (see src/core/agent-builder/slack-tools.ts).
    r.use("/api/agent-builder", buildAgentBuilderRouter());

    // ── OpenAPI spec ──────────────────────────────────────────────────────────
    r.get("/api/openapi.json", (_req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.json(this.buildOpenApiSpec());
    });

    // ── Scalar API Reference (standalone HTML — no Next.js CSS pollution) ─────
    // Rendered in an iframe from the dashboard (port 3000 → port 3001).
    // Do NOT set X-Frame-Options: SAMEORIGIN — that blocks cross-port iframes.
    r.get("/api-reference", (_req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // Allow embedding from the dashboard (any localhost origin in dev)
      res.setHeader("Content-Security-Policy", "frame-ancestors 'self' http://localhost:* http://127.0.0.1:*");
      res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ElevarusOS API Reference</title>
  <style>body { margin: 0; }</style>
</head>
<body>
  <script
    id="api-reference"
    data-url="/api/openapi.json"
    src="https://cdn.jsdelivr.net/npm/@scalar/api-reference/dist/browser/standalone.min.js">
  </script>
</body>
</html>`);
    });

    // ── File editor (agents + workflows .md files) ────────────────────────────
    r.get("/api/files", this.handleAsync(this.readFile.bind(this)));
    r.put("/api/files", this.handleAsync(this.writeFile.bind(this)));

    // ── Settings ──────────────────────────────────────────────────────────────
    r.get("/api/settings",        this.handleAsync(this.getSettings.bind(this)));
    r.put("/api/settings/:key",   this.handleAsync(this.updateSetting.bind(this)));

    // ── Data APIs — callable by MC agents as tools ────────────────────────────
    // MC agents call these to fetch data they can't get natively.
    // Returns structured JSON the agent uses to format its own report.
    r.get("/api/data/ringba/revenue",  this.handleAsync(this.getRingbaRevenue.bind(this)));
    r.get("/api/data/ringba/campaigns", this.handleAsync(this.getRingbaCampaigns.bind(this)));

    // ── Action APIs — MC agents call these to trigger deliveries ─────────────
    r.post("/api/actions/slack",        this.handleAsync(this.postSlackMessage.bind(this)));

    // ── Slack webhook receivers ───────────────────────────────────────────────
    // Order matters: the more-specific /interactions route must be registered
    // before the generic /api/webhooks/slack route (Express prefix matching)
    r.post("/api/webhooks/slack/interactions", this.handleAsync(this.receiveSlackInteraction.bind(this)));
    r.post("/api/webhooks/slack",              this.handleAsync(this.receiveSlackWebhook.bind(this)));

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

  /**
   * GET /api/jobs
   *
   * Query params:
   *   status      — filter by job status
   *   instanceId  — filter by workflowType
   *   limit       — max results (default 50, cap 200)
   *   offset      — records to skip for pagination (default 0)
   *
   * Response includes `total` (count before pagination), `limit`, and `offset`
   * so the dashboard can compute total pages.
   */
  private async listJobs(req: Request, res: Response): Promise<void> {
    const status     = typeof req.query.status     === "string" ? req.query.status     : undefined;
    const instanceId = typeof req.query.instanceId === "string" ? req.query.instanceId : undefined;
    const limitRaw   = typeof req.query.limit      === "string" ? req.query.limit      : "50";
    const offsetRaw  = typeof req.query.offset     === "string" ? req.query.offset     : "0";
    const maxResults = Math.min(parseInt(limitRaw,  10) || 50,  200);
    const skipCount  = Math.max(parseInt(offsetRaw, 10) || 0,   0);

    let jobs = await this.options.jobStore.list();
    if (status)     jobs = jobs.filter((j) => j.status === status);
    if (instanceId) jobs = jobs.filter((j) => j.workflowType === instanceId);

    jobs = jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const total   = jobs.length;
    const paged   = jobs.slice(skipCount, skipCount + maxResults);

    const rows = paged.map((j) => ({
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

    res.json({ jobs: rows, total, limit: maxResults, offset: skipCount });
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

    if (!this.options.orchestrator) {
      res.status(503).json({ error: "Orchestrator not available" });
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

    // Fire-and-forget — the workflow runs asynchronously; clients poll /api/jobs/:jobId
    const jobPromise = this.options.orchestrator.submitJob(request, workflowType);
    jobPromise.catch((err) => {
      logger.error("API-submitted job failed", { error: String(err) });
    });

    // Give orchestrator a tick to create and persist the job record
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

  /**
   * POST /api/jobs/:jobId/approve
   *
   * Approves a job that is currently awaiting_approval.
   * Resolves the in-process ApprovalStore gate, allowing the workflow to continue.
   *
   * Body (optional):
   *   approvedBy  string  — identifier of who approved (email, user ID, etc.)
   *   notes       string  — optional approval notes
   */
  private async approveJob(req: Request, res: Response): Promise<void> {
    const jobId = String(req.params.jobId);
    const { approvedBy, notes } = req.body ?? {};

    const job = await this.options.jobStore.get(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    if (job.status !== "awaiting_approval") {
      res.status(409).json({
        error:      `Job is not awaiting approval (current status: ${job.status})`,
        jobId,
        status:     job.status,
      });
      return;
    }

    // Update the job approval state so it's persisted even if the daemon restarts
    job.approval.approved  = true;
    job.approval.approvedBy = approvedBy ?? "api";
    job.approval.approvedAt = new Date().toISOString();
    if (notes) job.approval.notes = notes;
    await this.options.jobStore.save(job);

    const resolved = approvalStore.notifyApproval(jobId, true);
    logger.info("Job approved via API", { jobId, approvedBy: approvedBy ?? "api", resolved });

    res.json({
      message:   "Job approved",
      jobId,
      resolved,
      hint:      resolved ? undefined : "Daemon may have restarted — approval state persisted but workflow callback was lost",
    });
  }

  /**
   * POST /api/jobs/:jobId/reject
   *
   * Rejects a job that is currently awaiting_approval.
   * The workflow will stop and the job will be marked "rejected".
   *
   * Body (optional):
   *   rejectedBy  string  — identifier of who rejected
   *   reason      string  — rejection reason / feedback
   */
  private async rejectJob(req: Request, res: Response): Promise<void> {
    const jobId = String(req.params.jobId);
    const { rejectedBy, reason } = req.body ?? {};

    const job = await this.options.jobStore.get(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    if (job.status !== "awaiting_approval") {
      res.status(409).json({
        error:  `Job is not awaiting approval (current status: ${job.status})`,
        jobId,
        status: job.status,
      });
      return;
    }

    if (reason) job.approval.notes = reason;
    await this.options.jobStore.save(job);

    const resolved = approvalStore.notifyApproval(jobId, false);
    logger.info("Job rejected via API", { jobId, rejectedBy: rejectedBy ?? "api", resolved });

    res.json({
      message:  "Job rejected",
      jobId,
      resolved,
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

  /** Shared helper — returns parsed configs for all agent instances. */
  private loadAllInstances(): Array<{ id: string; name: string; baseWorkflow: string; enabled: boolean }> {
    const instanceIds = listInstanceIds(true);
    return instanceIds.flatMap((id) => {
      try {
        const cfg = loadInstanceConfig(id);
        return [{ id: cfg.id, name: cfg.name, baseWorkflow: cfg.baseWorkflow, enabled: cfg.enabled }];
      } catch {
        return [];
      }
    });
  }

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
          instanceDir:  path.join(AGENTS_DIR, id),
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

    const instanceDir = path.join(AGENTS_DIR, id);
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

    logger.info("API: instance created", { id, name, baseWorkflow });

    res.status(201).json({
      message:      "Instance created",
      id,
      name,
      baseWorkflow,
      instanceDir,
      nextStep: `Add registry.register(build${baseWorkflow === "blog" ? "Blog" : "PPCCampaignReport"}WorkflowDefinition(notifiers, "${id}")); to src/index.ts and restart.`,
    });
  }

  // ─── Slack Interactive Components receiver ───────────────────────────────────

  /**
   * POST /api/webhooks/slack/interactions
   *
   * Receives interactive component payloads from Slack (button clicks on the
   * approval notification message). Slack sends application/x-www-form-urlencoded
   * with a single `payload` field containing JSON.
   *
   * Security: v0 HMAC-SHA256 via x-slack-signature + x-slack-request-timestamp.
   * Configure SLACK_SIGNING_SECRET in .env.
   *
   * Actions handled:
   *   approve_job  — calls approvalStore.notifyApproval(jobId, true)
   *   reject_job   — calls approvalStore.notifyApproval(jobId, false)
   *
   * Slack expects a 2xx within 3s. We verify + ack immediately, then dispatch.
   * We also update the original message to show the decision (no more buttons).
   */
  private async receiveSlackInteraction(req: Request, res: Response): Promise<void> {
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
      logger.warn("Slack interactions: signature verification failed", { error: verified.error });
      res.status(401).json({ error: verified.error ?? "Invalid signature" });
      return;
    }

    // Parse application/x-www-form-urlencoded payload
    let interactionPayload: {
      type:         string;
      actions?:     Array<{ action_id: string; value: string }>;
      user?:        { id: string; name: string };
      response_url?: string;
      message?:     { ts: string; channel?: string };
      channel?:     { id: string };
    };

    try {
      const urlEncoded = rawBody.toString("utf8");
      const params     = new URLSearchParams(urlEncoded);
      const raw        = params.get("payload");
      if (!raw) throw new Error("Missing payload field");
      interactionPayload = JSON.parse(raw);
    } catch (err) {
      res.status(400).json({ error: "Invalid interaction payload" });
      return;
    }

    // Ack immediately — Slack retries if no 2xx within 3s
    res.status(200).send("");

    // Process asynchronously
    void this.handleSlackInteraction(interactionPayload);
  }

  private async handleSlackInteraction(payload: {
    type:          string;
    actions?:      Array<{ action_id: string; value: string }>;
    user?:         { id: string; name: string };
    response_url?: string;
    message?:      { ts: string; channel?: string };
    channel?:      { id: string };
  }): Promise<void> {
    if (payload.type !== "block_actions") return;

    const action = payload.actions?.[0];
    if (!action) return;

    const jobId    = action.value;
    const actionId = action.action_id;
    const userName = payload.user?.name ?? "unknown";

    logger.info("Slack interaction received", { actionId, jobId, userName });

    if (actionId !== "approve_job" && actionId !== "reject_job") {
      logger.warn("Slack interaction: unknown action_id", { actionId });
      return;
    }

    const approved = actionId === "approve_job";

    // Resolve the in-process approval gate
    const resolved = approvalStore.notifyApproval(jobId, approved);
    logger.info("Slack interaction processed", { jobId, approved, resolved, userName });

    // Replace the original message to confirm the decision (removes buttons)
    if (payload.response_url) {
      const label = approved ? "✅ Approved" : "❌ Rejected";
      try {
        await fetch(payload.response_url, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            replace_original: true,
            text:             `${label} by @${userName} — job \`${jobId}\``,
          }),
        });
      } catch (err) {
        logger.warn("Slack interaction: failed to update original message", { error: String(err) });
      }
    }
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
      const { postToSlack } = await import("../adapters/slack/client");
      const ts = await postToSlack({ channel, text, blocks: blocks as any });
      res.json({ published: ts !== undefined, ts: ts ?? null, channel });
    } catch (err) {
      logger.error("POST /api/actions/slack error", { error: String(err) });
      res.status(500).json({ error: "Failed to post to Slack" });
    }
  }

  // ─── Cancel job ──────────────────────────────────────────────────────────────

  private async cancelJob(req: Request, res: Response): Promise<void> {
    const jobId = String(req.params.jobId);
    if (!this.options.orchestrator) {
      res.status(503).json({ error: "Orchestrator not available" });
      return;
    }
    const result = await this.options.orchestrator.cancelJob(jobId);
    if (!result.cancelled) {
      res.status(409).json({ error: result.error ?? "Cannot cancel job" });
      return;
    }
    res.json({ cancelled: true, jobId });
  }

  // ─── Token analytics ─────────────────────────────────────────────────────────

  private async getTokenAnalytics(req: Request, res: Response): Promise<void> {
    const days = Math.min(parseInt(String(req.query.days ?? "30"), 10), 365);
    const instanceId = req.query.instanceId as string | undefined;

    // Compute from in-memory job store (works without Supabase)
    const allJobs = await this.options.jobStore.list();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const jobs = allJobs.filter(j => {
      if (j.createdAt < cutoff) return false;
      // Include all jobs that have progressed past queued so partial
      // usage from running/awaiting_approval jobs is visible in the charts.
      if (j.status === "queued") return false;
      if (instanceId && j.workflowType !== instanceId) return false;
      return true;
    });

    // Aggregate totals
    const totals = jobs.reduce((acc, j) => {
      const u = j.totalUsage;
      if (!u) return acc;
      return {
        inputTokens:      acc.inputTokens  + u.inputTokens,
        outputTokens:     acc.outputTokens + u.outputTokens,
        totalTokens:      acc.totalTokens  + u.totalTokens,
        estimatedCostUsd: acc.estimatedCostUsd + u.estimatedCostUsd,
      };
    }, { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 });

    // By day
    const byDayMap = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number; jobCount: number }>();
    for (const j of jobs) {
      const day = j.createdAt.slice(0, 10);
      const existing = byDayMap.get(day) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, jobCount: 0 };
      const u = j.totalUsage;
      byDayMap.set(day, {
        inputTokens:  existing.inputTokens  + (u?.inputTokens  ?? 0),
        outputTokens: existing.outputTokens + (u?.outputTokens ?? 0),
        costUsd:      existing.costUsd      + (u?.estimatedCostUsd ?? 0),
        jobCount:     existing.jobCount + 1,
      });
    }
    const byDay = Array.from(byDayMap.entries())
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => a.day.localeCompare(b.day));

    // By workflow
    const byWorkflowMap = new Map<string, { totalTokens: number; costUsd: number; jobCount: number }>();
    for (const j of jobs) {
      const existing = byWorkflowMap.get(j.workflowType) ?? { totalTokens: 0, costUsd: 0, jobCount: 0 };
      const u = j.totalUsage;
      byWorkflowMap.set(j.workflowType, {
        totalTokens: existing.totalTokens + (u?.totalTokens ?? 0),
        costUsd:     existing.costUsd + (u?.estimatedCostUsd ?? 0),
        jobCount:    existing.jobCount + 1,
      });
    }
    const byWorkflow = Array.from(byWorkflowMap.entries())
      .map(([workflowType, v]) => ({ workflowType, ...v }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    res.json({ days, totals, byDay, byWorkflow });
  }

  // ─── Integrations ─────────────────────────────────────────────────────────────

  // ─── Workflows ────────────────────────────────────────────────────────────────

  private async listWorkflows(_req: Request, res: Response): Promise<void> {
    const registry = this.options.registry;
    const allInstances = await this.loadAllInstances();

    // Scan filesystem for prompt files per workflow directory
    const workflowsRoot = path.resolve(process.cwd(), "src/workflows");
    const promptsByType = new Map<string, string[]>();
    try {
      const dirs = fs.readdirSync(workflowsRoot, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory() || d.name.startsWith("_")) continue;
        const promptsDir = path.join(workflowsRoot, d.name, "prompts");
        try {
          const files = fs.readdirSync(promptsDir)
            .filter(f => f.endsWith(".md"))
            .sort();
          promptsByType.set(d.name, files);
        } catch {
          promptsByType.set(d.name, []);
        }
      }
    } catch {
      // Workflows directory not found — proceed with registry only
    }

    // Build full list: union of registered types + directory entries
    const allTypes = new Set([
      ...registry.registeredTypes,
      ...promptsByType.keys(),
    ]);

    const workflows = Array.from(allTypes).sort().map(type => {
      const def = registry.get(type);
      const stages = def ? def.stages.map(s => s.stageName) : [];
      const prompts = promptsByType.get(type) ?? [];

      // Find agents whose baseWorkflow matches this workflow type,
      // OR whose id matches (agents are often named after their workflow dir)
      const linkedAgents = allInstances
        .filter(inst => inst.baseWorkflow === type || inst.id === type)
        .map(inst => ({ id: inst.id, name: inst.name, enabled: inst.enabled }));

      return {
        type,
        registered: !!def,
        stages,
        prompts,
        linkedAgents,
        promptPath: `src/workflows/${type}/prompts`,
      };
    });

    res.json({ workflows });
  }

  // ─── Integrations ─────────────────────────────────────────────────────────────

  private async getIntegrations(_req: Request, res: Response): Promise<void> {
    // Pull every registered integration from the central registry — adding a
    // new manifest in src/core/integration-registry.ts auto-surfaces it on the
    // dashboard. (The previous hand-curated array silently missed Everflow.)
    const integrations = INTEGRATION_MANIFESTS.map(m => ({
      id:          m.id,
      name:        m.name,
      description: m.description,
      enabled:     m.status() === "configured",
      tables:      (m.supabaseTables ?? []).map(t => ({
        name:        t.name,
        description: t.description,
        columns:     Object.entries(t.columns ?? {}).map(([col, def]) => ({
          name:        col,
          type:        typeof def === "string" ? "text" : (def as any).type ?? "text",
          description: typeof def === "string" ? def : (def as any).description ?? "",
        })),
      })),
      liveTools:   (m.liveTools ?? []).map(t => t.spec.name),
      features:    m.features ?? [],
    }));

    // Add Slack integration manually (no manifest file yet)
    const slackEnabled = !!(process.env.SLACK_BOT_TOKEN);
    integrations.push({
      id:          "slack",
      name:        "Slack",
      description: "Approval notifications, Block Kit buttons, and Q&A bot.",
      enabled:     slackEnabled,
      tables:      [],
      liveTools:   [],
      features:    ["Approval notifications", "Block Kit buttons", "Q&A bot"],
    });

    res.json({ integrations });
  }

  // ─── File editor ──────────────────────────────────────────────────────────────

  // Use process.cwd() (repo root) rather than __dirname so that this works
  // both under ts-node (src/api/) and from compiled output (dist/api/).
  private readonly EDITABLE_PREFIXES = [
    path.resolve(process.cwd(), "src/agents"),
    path.resolve(process.cwd(), "src/workflows"),
  ];

  private resolveEditablePath(rawPath: string): string | null {
    if (!rawPath.endsWith(".md")) return null;
    if (rawPath.includes("..")) return null;
    const abs = path.resolve(process.cwd(), rawPath);
    const allowed = this.EDITABLE_PREFIXES.some(p => abs.startsWith(p));
    if (!allowed) return null;
    return abs;
  }

  private async readFile(req: Request, res: Response): Promise<void> {
    const rawPath = String(req.query.path ?? "");
    const abs = this.resolveEditablePath(rawPath);
    if (!abs) {
      res.status(400).json({ error: "Invalid or disallowed path. Only .md files under src/agents/ and src/workflows/ are accessible." });
      return;
    }
    if (!fs.existsSync(abs)) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const content = fs.readFileSync(abs, "utf8");
    const stat = fs.statSync(abs);
    res.json({ path: rawPath, content, lastModified: stat.mtime.toISOString() });
  }

  private async writeFile(req: Request, res: Response): Promise<void> {
    const rawPath = String(req.query.path ?? "");
    const abs = this.resolveEditablePath(rawPath);
    if (!abs) {
      res.status(400).json({ error: "Invalid or disallowed path." });
      return;
    }
    const { content } = req.body as { content?: string };
    if (typeof content !== "string") {
      res.status(400).json({ error: "body.content (string) is required" });
      return;
    }
    fs.writeFileSync(abs, content, "utf8");
    logger.info("File updated via API", { path: rawPath });
    res.json({ success: true, path: rawPath, savedAt: new Date().toISOString() });
  }

  // ─── Settings ─────────────────────────────────────────────────────────────────

  private _settings: Record<string, unknown> = {
    alert_daily_cost_usd:   { threshold: 50,  enabled: false },
    alert_job_failure_rate: { threshold: 20,  enabled: false },
    display_prefs:          { showCostEstimates: true, historyPageSize: 25, dateFormat: "relative" },
  };

  private async getSettings(_req: Request, res: Response): Promise<void> {
    res.json({ settings: this._settings });
  }

  private async updateSetting(req: Request, res: Response): Promise<void> {
    const key = String(req.params.key);
    const { value } = req.body as { value: unknown };
    if (value === undefined) {
      res.status(400).json({ error: "body.value is required" });
      return;
    }
    this._settings[key] = value;
    res.json({ key, value, updatedAt: new Date().toISOString() });
  }

  // ─── OpenAPI spec ─────────────────────────────────────────────────────────────

  private buildOpenApiSpec(): object {
    return {
      openapi: "3.0.3",
      info: {
        title: "ElevarusOS API",
        version: "1.0.0",
        description: "Internal orchestration API for ElevarusOS agent workflows. All endpoints require `x-api-key` header unless running in development mode.",
      },
      servers: [{ url: "http://localhost:3001", description: "Local dev" }],
      components: {
        securitySchemes: {
          ApiKey: { type: "apiKey", in: "header", name: "x-api-key" },
        },
        schemas: {
          Job: {
            type: "object",
            properties: {
              jobId:           { type: "string", format: "uuid" },
              workflowType:    { type: "string", example: "final-expense-reporting" },
              status:          { type: "string", enum: ["queued","running","awaiting_approval","approved","rejected","failed","completed"] },
              title:           { type: "string" },
              createdAt:       { type: "string", format: "date-time" },
              updatedAt:       { type: "string", format: "date-time" },
              completedAt:     { type: "string", format: "date-time", nullable: true },
              currentStage:    { type: "string", nullable: true },
              completedStages: { type: "integer" },
              totalStages:     { type: "integer" },
              approvalPending: { type: "boolean" },
              error:           { type: "string", nullable: true },
            },
          },
          Stage: {
            type: "object",
            properties: {
              name:        { type: "string" },
              status:      { type: "string", enum: ["pending","running","completed","failed","skipped"] },
              attempts:    { type: "integer" },
              startedAt:   { type: "string", format: "date-time", nullable: true },
              completedAt: { type: "string", format: "date-time", nullable: true },
              error:       { type: "string", nullable: true },
              hasOutput:   { type: "boolean" },
              usage: {
                type: "object",
                nullable: true,
                properties: {
                  inputTokens:      { type: "integer" },
                  outputTokens:     { type: "integer" },
                  totalTokens:      { type: "integer" },
                  estimatedCostUsd: { type: "number" },
                },
              },
            },
          },
          Instance: {
            type: "object",
            properties: {
              id:           { type: "string" },
              name:         { type: "string" },
              baseWorkflow: { type: "string" },
              enabled:      { type: "boolean" },
              schedule:     { type: "object" },
              notify:       { type: "object" },
            },
          },
          TokenAnalytics: {
            type: "object",
            properties: {
              days:   { type: "integer" },
              totals: {
                type: "object",
                properties: {
                  inputTokens:      { type: "integer" },
                  outputTokens:     { type: "integer" },
                  totalTokens:      { type: "integer" },
                  estimatedCostUsd: { type: "number" },
                },
              },
              byDay: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    day:          { type: "string", format: "date" },
                    inputTokens:  { type: "integer" },
                    outputTokens: { type: "integer" },
                    costUsd:      { type: "number" },
                    jobCount:     { type: "integer" },
                  },
                },
              },
              byWorkflow: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    workflowType: { type: "string" },
                    totalTokens:  { type: "integer" },
                    costUsd:      { type: "number" },
                    jobCount:     { type: "integer" },
                  },
                },
              },
            },
          },
          Error: {
            type: "object",
            properties: { error: { type: "string" } },
          },
        },
      },
      security: [{ ApiKey: [] }],
      paths: {
        "/api/health": {
          get: {
            summary: "Health check",
            security: [],
            tags: ["System"],
            responses: {
              "200": { description: "Server is healthy", content: { "application/json": { schema: { type: "object", properties: { status: { type: "string" }, uptime: { type: "number" }, ts: { type: "string" } } } } } },
            },
          },
        },
        "/api/jobs": {
          get: {
            summary: "List all jobs",
            tags: ["Jobs"],
            parameters: [
              { name: "status", in: "query", schema: { type: "string" }, description: "Filter by status" },
              { name: "limit",  in: "query", schema: { type: "integer", default: 50 }, description: "Max results" },
              { name: "offset", in: "query", schema: { type: "integer", default: 0 },  description: "Pagination offset" },
            ],
            responses: {
              "200": { description: "Job list", content: { "application/json": { schema: { type: "object", properties: { jobs: { type: "array", items: { $ref: "#/components/schemas/Job" } }, total: { type: "integer" } } } } } },
            },
          },
          post: {
            summary: "Submit a new job",
            tags: ["Jobs"],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["workflowType", "title"],
                    properties: {
                      workflowType: { type: "string", example: "final-expense-reporting" },
                      title:        { type: "string", example: "Weekly PPC Report" },
                      metadata:     { type: "object", additionalProperties: true },
                    },
                  },
                },
              },
            },
            responses: {
              "202": { description: "Job accepted", content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } } },
              "400": { description: "Invalid request", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            },
          },
        },
        "/api/jobs/{jobId}": {
          get: {
            summary: "Get job detail",
            tags: ["Jobs"],
            parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            responses: {
              "200": { description: "Job detail with stages", content: { "application/json": { schema: { allOf: [{ $ref: "#/components/schemas/Job" }, { type: "object", properties: { stages: { type: "array", items: { $ref: "#/components/schemas/Stage" } } } }] } } } },
              "404": { description: "Not found", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
            },
          },
        },
        "/api/jobs/{jobId}/output": {
          get: {
            summary: "Get job output (rendered content)",
            tags: ["Jobs"],
            parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
            responses: {
              "200": { description: "Structured output from completed job stages" },
              "404": { description: "Not found" },
            },
          },
        },
        "/api/jobs/{jobId}/approve": {
          post: {
            summary: "Approve a job awaiting human review",
            tags: ["Jobs"],
            parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
            requestBody: { content: { "application/json": { schema: { type: "object", properties: { notes: { type: "string" } } } } } },
            responses: {
              "200": { description: "Approved" },
              "404": { description: "Not found" },
            },
          },
        },
        "/api/jobs/{jobId}/reject": {
          post: {
            summary: "Reject a job awaiting human review",
            tags: ["Jobs"],
            parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
            requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string" } } } } } },
            responses: {
              "200": { description: "Rejected" },
              "404": { description: "Not found" },
            },
          },
        },
        "/api/jobs/{jobId}/cancel": {
          post: {
            summary: "Cancel a running or queued job",
            tags: ["Jobs"],
            parameters: [{ name: "jobId", in: "path", required: true, schema: { type: "string" } }],
            responses: {
              "200": { description: "Job cancelled or error reason", content: { "application/json": { schema: { type: "object", properties: { cancelled: { type: "boolean" }, error: { type: "string" } } } } } },
            },
          },
        },
        "/api/instances": {
          get: {
            summary: "List registered agent instances",
            tags: ["Agents"],
            responses: {
              "200": { description: "Instance list", content: { "application/json": { schema: { type: "object", properties: { instances: { type: "array", items: { $ref: "#/components/schemas/Instance" } } } } } } },
            },
          },
        },
        "/api/schedule": {
          get: {
            summary: "Get scheduled agent next-run times",
            tags: ["Agents"],
            responses: {
              "200": { description: "Schedule entries" },
            },
          },
        },
        "/api/analytics/tokens": {
          get: {
            summary: "Token usage analytics",
            tags: ["Analytics"],
            parameters: [
              { name: "days",       in: "query", schema: { type: "integer", default: 30, maximum: 365 }, description: "Lookback window in days" },
              { name: "instanceId", in: "query", schema: { type: "string" }, description: "Filter by workflow type" },
            ],
            responses: {
              "200": { description: "Token analytics", content: { "application/json": { schema: { $ref: "#/components/schemas/TokenAnalytics" } } } },
            },
          },
        },
        "/api/integrations": {
          get: {
            summary: "List configured integrations",
            tags: ["Integrations"],
            responses: {
              "200": { description: "Integration list with tables and live tools" },
            },
          },
        },
        "/api/files": {
          get: {
            summary: "Read an editable .md file",
            tags: ["Files"],
            parameters: [{ name: "path", in: "query", required: true, schema: { type: "string" }, description: "Relative path under src/agents/ or src/workflows/" }],
            responses: {
              "200": { description: "File content", content: { "application/json": { schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, lastModified: { type: "string" } } } } } },
              "403": { description: "Path not allowed" },
              "404": { description: "File not found" },
            },
          },
          put: {
            summary: "Write an editable .md file",
            tags: ["Files"],
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: { type: "object", required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string" } } },
                },
              },
            },
            responses: {
              "200": { description: "Written OK" },
              "403": { description: "Path not allowed" },
            },
          },
        },
        "/api/settings": {
          get: {
            summary: "Get all dashboard settings",
            tags: ["Settings"],
            responses: { "200": { description: "Settings map" } },
          },
        },
        "/api/settings/{key}": {
          put: {
            summary: "Update a setting value",
            tags: ["Settings"],
            parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }],
            requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["value"], properties: { value: {} } } } } },
            responses: { "200": { description: "Updated" } },
          },
        },
      },
    };
  }

  // ─── Utility ─────────────────────────────────────────────────────────────────

  private handleAsync(fn: (req: Request, res: Response) => Promise<void>) {
    return (req: Request, res: Response, next: NextFunction): void => {
      fn(req, res).catch(next);
    };
  }
}

// ─── CORS helpers ─────────────────────────────────────────────────────────────

/**
 * Warn once per unknown origin so we know which one to add to CORS_ORIGINS
 * — but only once, otherwise every poll-interval browser request would log.
 */
const _seenUnknownOrigins = new Set<string>();
function logUnknownOrigin(origin: string, allowedOrigins: string[]): void {
  if (_seenUnknownOrigins.has(origin)) return;
  _seenUnknownOrigins.add(origin);
  logger.warn("CORS: blocked request from unconfigured origin", {
    origin,
    allowed: allowedOrigins,
    fix:     `Add this origin to CORS_ORIGINS in .env (comma-separated). e.g. CORS_ORIGINS=${[...allowedOrigins, origin].join(",")}`,
  });
}
