/**
 * ElevarusOS API Server
 *
 * Lightweight REST API exposing bot status, job history, and instance configs.
 * Runs on port 3001 (configurable via API_PORT env var).
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
 *   POST /api/jobs                  — submit a new job manually
 *                                     body: { workflowType, title, brief, audience,
 *                                             targetKeyword, cta, approver? }
 *
 *   GET  /api/schedule              — upcoming scheduled runs per instance
 *
 * ─── Auth ────────────────────────────────────────────────────────────────────
 *
 * Optional: set API_SECRET in .env to require x-api-key header on all routes.
 * Leave unset to run open (fine for local/internal use).
 */

import * as fs from "fs";
import * as path from "path";
import express, { Request, Response, NextFunction } from "express";
import { IJobStore } from "../core/job-store";
import { WorkflowRegistry } from "../core/workflow-registry";
import { Orchestrator } from "../core/orchestrator";
import { listInstanceIds, loadInstanceConfig } from "../core/instance-config";
import { syncBotsToDashboard } from "../core/dashboard-sync";
import { logger } from "../core/logger";
import { BlogRequest } from "../models/blog-request.model";

const INSTANCES_DIR = path.resolve(__dirname, "../instances");

export interface ApiServerOptions {
  port: number;
  jobStore: IJobStore;
  registry: WorkflowRegistry;
  /** Optional — required only for POST /api/jobs */
  orchestrator?: Orchestrator;
}

export class ApiServer {
  private readonly app = express();

  constructor(private readonly options: ApiServerOptions) {
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
      res.json({
        status: "ok",
        uptime: process.uptime(),
        ts: new Date().toISOString(),
      });
    });

    // ── Bots ────────────────────────────────────────────────────────────────
    r.get("/api/bots", this.handleAsync(this.getBots.bind(this)));
    r.get("/api/bots/:instanceId", this.handleAsync(this.getBot.bind(this)));

    // ── Jobs ─────────────────────────────────────────────────────────────────
    r.get("/api/jobs", this.handleAsync(this.listJobs.bind(this)));
    r.get("/api/jobs/:jobId", this.handleAsync(this.getJob.bind(this)));
    r.post("/api/jobs", this.handleAsync(this.submitJob.bind(this)));

    // ── Schedule ─────────────────────────────────────────────────────────────
    r.get("/api/schedule", this.handleAsync(this.getSchedule.bind(this)));

    // ── Instances (agent management) ─────────────────────────────────────────
    r.get("/api/instances", this.handleAsync(this.listInstances.bind(this)));
    r.post("/api/instances", this.handleAsync(this.createInstance.bind(this)));

    // ── 404 catch-all ────────────────────────────────────────────────────────
    r.use((_req, res) => {
      res.status(404).json({ error: "Not found" });
    });
  }

  // ─── Handlers ───────────────────────────────────────────────────────────────

  private async getBots(_req: Request, res: Response): Promise<void> {
    const instanceIds = listInstanceIds(true); // include disabled
    const jobs = await this.options.jobStore.list();

    const bots = instanceIds.map((id) => {
      try {
        const cfg = loadInstanceConfig(id);
        const instanceJobs = jobs.filter((j) => j.workflowType === id);
        const sorted = [...instanceJobs].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt)
        );
        const last = sorted[0];
        const running = instanceJobs.filter((j) =>
          j.status === "running" || j.status === "awaiting_approval"
        ).length;

        return {
          instanceId: id,
          name: cfg.name,
          baseWorkflow: cfg.baseWorkflow,
          enabled: cfg.enabled,
          brand: { voice: cfg.brand.voice, tone: cfg.brand.tone },
          schedule: cfg.schedule,
          notify: { approver: cfg.notify.approver },
          stats: {
            total: instanceJobs.length,
            running,
            lastJobId: last?.id,
            lastJobStatus: last?.status,
            lastJobAt: last?.createdAt,
            lastJobTitle: last?.request.title,
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

    const jobs = await this.options.jobStore.list();
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
        total: instanceJobs.length,
        byStatus,
        recentJobs: instanceJobs.slice(0, 5).map((j) => ({
          jobId: j.id,
          status: j.status,
          title: j.request.title,
          createdAt: j.createdAt,
          completedAt: j.completedAt,
        })),
      },
    });
  }

  private async listJobs(req: Request, res: Response): Promise<void> {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const instanceId = typeof req.query.instanceId === "string" ? req.query.instanceId : undefined;
    const limitRaw = typeof req.query.limit === "string" ? req.query.limit : "50";
    const maxResults = Math.min(parseInt(limitRaw, 10), 200);

    let jobs = await this.options.jobStore.list();

    if (status) {
      jobs = jobs.filter((j) => j.status === status);
    }
    if (instanceId) {
      jobs = jobs.filter((j) => j.workflowType === instanceId);
    }

    // Sort newest-first, apply limit
    jobs = jobs
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, maxResults);

    const rows = jobs.map((j) => ({
      jobId: j.id,
      workflowType: j.workflowType,
      status: j.status,
      title: j.request.title,
      createdAt: j.createdAt,
      updatedAt: j.updatedAt,
      completedAt: j.completedAt,
      currentStage: j.stages.find((s) => s.status === "running")?.name ?? null,
      completedStages: j.stages.filter((s) => s.status === "completed").length,
      totalStages: j.stages.length,
      approvalPending: j.status === "awaiting_approval",
      error: j.error ?? null,
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
      jobId: job.id,
      workflowType: job.workflowType,
      status: job.status,
      title: job.request.title,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt ?? null,
      error: job.error ?? null,
      request: job.request,
      approval: job.approval,
      publishRecord: job.publishRecord ?? null,
      stages: job.stages.map((s) => ({
        name: s.name,
        status: s.status,
        attempts: s.attempts,
        startedAt: s.startedAt ?? null,
        completedAt: s.completedAt ?? null,
        error: s.error ?? null,
        // Omit raw output by default — can be large
        hasOutput: s.output !== undefined,
      })),
    });
  }

  private async submitJob(req: Request, res: Response): Promise<void> {
    if (!this.options.orchestrator) {
      res.status(503).json({ error: "Orchestrator not available" });
      return;
    }

    const {
      workflowType,
      title,
      brief,
      audience,
      targetKeyword,
      cta,
      approver,
    } = req.body ?? {};

    // Validate required fields
    const missing: string[] = [];
    if (!workflowType) missing.push("workflowType");
    if (!title) missing.push("title");
    if (!brief) missing.push("brief");
    if (missing.length) {
      res.status(400).json({ error: `Missing required fields: ${missing.join(", ")}` });
      return;
    }

    // Verify the workflow is registered
    if (!this.options.registry.get(workflowType)) {
      res.status(400).json({
        error: `Unknown workflowType "${workflowType}"`,
        registered: this.options.registry.registeredTypes,
      });
      return;
    }

    const request: BlogRequest = {
      title,
      brief,
      audience: audience ?? "",
      targetKeyword: targetKeyword ?? "",
      cta: cta ?? "",
      approver: approver ?? undefined,
      workflowType,
      rawSource: {
        channel: "manual",
        receivedAt: new Date().toISOString(),
        payload: { source: "api", submittedBy: "api-call" },
      },
      missingFields: [],
    };

    // Submit but don't await the full run — return the job ID immediately.
    // The job runs asynchronously; poll GET /api/jobs/:jobId to track progress.
    let jobId: string;
    try {
      // submitJob is async and long-running — fire-and-forget after getting ID
      const jobPromise = this.options.orchestrator.submitJob(request, workflowType);

      // Respond immediately with a pending status.
      // We can't easily get the job ID without a small refactor, so we snapshot
      // immediately after save by polling jobs (simplest approach for now).
      jobPromise.catch((err) => {
        logger.error("API-submitted job failed", { error: String(err) });
      });

      // Give the orchestrator a tick to create + save the job
      await new Promise((r) => setTimeout(r, 50));

      const allJobs = await this.options.jobStore.list();
      const newest = allJobs
        .filter((j) => j.workflowType === workflowType)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

      jobId = newest?.id ?? "unknown";
    } catch (err) {
      res.status(500).json({ error: String(err) });
      return;
    }

    res.status(202).json({
      message: "Job submitted",
      jobId,
      workflowType,
      pollUrl: `/api/jobs/${jobId}`,
    });
  }

  private async getSchedule(_req: Request, res: Response): Promise<void> {
    const instanceIds = listInstanceIds(false); // only enabled

    const schedule = instanceIds.map((id) => {
      try {
        const cfg = loadInstanceConfig(id);
        if (!cfg.schedule.enabled) return null;
        return {
          instanceId: id,
          name: cfg.name,
          cron: cfg.schedule.cron ?? null,
          description: cfg.schedule.description ?? null,
          timezone: "UTC",
        };
      } catch {
        return null;
      }
    }).filter(Boolean);

    res.json({ schedule });
  }

  // ─── Instance handlers ────────────────────────────────────────────────────────

  private async listInstances(_req: Request, res: Response): Promise<void> {
    const instanceIds = listInstanceIds(true);
    const instances = instanceIds.map((id) => {
      try {
        const cfg = loadInstanceConfig(id);
        return {
          id: cfg.id,
          name: cfg.name,
          baseWorkflow: cfg.baseWorkflow,
          enabled: cfg.enabled,
          brand: cfg.brand,
          notify: cfg.notify,
          schedule: cfg.schedule,
          instanceDir: path.join(INSTANCES_DIR, id),
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
   * Creates a new bot instance from a template and syncs it to the dashboard.
   *
   * Body:
   *   id            string   — unique slug (e.g. "acme-blog")
   *   name          string   — human-readable name
   *   baseWorkflow  string   — "blog" | "reporting"
   *   voice         string   — brand voice/style
   *   audience      string   — target reader description
   *   tone          string   — tone descriptor
   *   industry?     string   — optional industry context
   *   approver?     string   — approver email
   *   slackChannel? string   — Slack channel ID
   *
   * After creation, register the new workflow in src/index.ts and restart.
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

    // Validate ID — must be URL-safe slug
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
      res.status(400).json({ error: "id must be a lowercase slug (letters, numbers, hyphens)" });
      return;
    }

    if (!["blog", "reporting"].includes(baseWorkflow)) {
      res.status(400).json({ error: 'baseWorkflow must be "blog" or "reporting"' });
      return;
    }

    const instanceDir = path.join(INSTANCES_DIR, id);
    if (fs.existsSync(instanceDir)) {
      res.status(409).json({ error: `Instance "${id}" already exists` });
      return;
    }

    // Create directory + instance.md
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
      approver     ? `  approver: ${approver}` : `  # approver: approver@example.com`,
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
      `1. Add \`registry.register(build${baseWorkflow === "blog" ? "Blog" : "Reporting"}WorkflowDefinition(notifiers, "${id}"));\` to \`src/index.ts\``,
      `2. Restart ElevarusOS — the bot will appear in the dashboard automatically`,
      `3. Submit a test job: \`npm run dev -- --once --bot ${id}\``,
    ].join("\n");

    fs.writeFileSync(path.join(instanceDir, "instance.md"), instanceMd, "utf8");

    // Sync to dashboard immediately (non-fatal if MC isn't running)
    try {
      await syncBotsToDashboard([id]);
    } catch {
      // Dashboard sync is best-effort
    }

    logger.info("API: instance created", { id, name, baseWorkflow });

    res.status(201).json({
      message: "Instance created",
      id,
      name,
      baseWorkflow,
      instanceDir,
      nextStep: `Add registry.register(build${baseWorkflow === "blog" ? "Blog" : "Reporting"}WorkflowDefinition(notifiers, "${id}")); to src/index.ts and restart.`,
    });
  }

  // ─── Utility ─────────────────────────────────────────────────────────────────

  /** Wraps an async handler to forward errors to Express error middleware. */
  private handleAsync(
    fn: (req: Request, res: Response) => Promise<void>
  ) {
    return (req: Request, res: Response, next: NextFunction): void => {
      fn(req, res).catch(next);
    };
  }
}
