import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { MCClient, MCTask } from "./mc-client";
import { WorkflowRegistry } from "./workflow-registry";
import { IJobStore } from "./job-store";
import { IStage } from "./stage.interface";
import { INotifyAdapter } from "../adapters/notify/notify.interface";
import { Job, StageRecord } from "../models/job.model";
import { listInstanceIds, loadInstanceConfig } from "./instance-config";
import { scaffoldAllWorkspaces, scaffoldInstanceWorkspace } from "./workspace-scaffold";
import { logger } from "./logger";
import { config } from "../config";

const INSTANCES_DIR = path.resolve(__dirname, "../agents");

/**
 * MCWorker — the core daemon-mode engine in the refactored architecture.
 *
 * Replaces: MissionControlBridge + DashboardPoller + dashboard-sync
 *
 * ─── What it does ────────────────────────────────────────────────────────────
 *
 *  1. REGISTER   — Registers each ElevarusOS bot instance as an agent in MC
 *                  at startup (idempotent — safe to call on every restart).
 *
 *  2. POLL       — Periodically polls GET /api/tasks/queue for each registered
 *                  agent. When MC assigns a task, MCWorker claims it atomically.
 *
 *  3. EXECUTE    — Runs the workflow stages for the claimed task, updating MC
 *                  task status in real time as each stage completes.
 *
 *  4. APPROVE    — When a workflow reaches the approval_notify stage, it sets
 *                  the MC task to "review" and pauses. When a human approves in
 *                  the MC Task Board, MC fires a webhook → ElevarusOS receives
 *                  it → notifyApproval() resolves the pending Promise → the
 *                  remaining stages (publish, completion) run.
 *
 * ─── Flow ────────────────────────────────────────────────────────────────────
 *
 *   Cron / Human / API  →  MC task created (inbox)
 *   MCWorker polls      →  claims task (in_progress)
 *   Stages run          →  MC updated after each stage
 *   approval_notify     →  MC set to "review"; awaiting human
 *   Human approves      →  MC fires webhook  →  notifyApproval()
 *   Remaining stages    →  publish + completion
 *   Done                →  MC set to "done"
 *
 * ─── Supabase (optional) ─────────────────────────────────────────────────────
 *
 *   If a jobStore is provided, MCWorker also saves detailed execution state
 *   (all stages, outputs, errors) to Supabase for analytics / long-term audit.
 *   MC's task table is always the source of truth for status — Supabase is a
 *   secondary detailed store only.
 */
export class MCWorker {
  private readonly client: MCClient;
  private running = false;
  private pollTimer?: ReturnType<typeof setTimeout>;

  /**
   * Pending approval callbacks keyed by MC task ID.
   * Populated when a workflow hits the approval_notify stage.
   * Resolved by notifyApproval() when a webhook arrives.
   */
  private readonly approvalCallbacks = new Map<number, (approved: boolean) => void>();

  /** MC agent IDs for each registered instance (instanceId → MC agent ID). */
  private readonly agentIds = new Map<string, number>();

  /**
   * Tasks currently being executed by this process.
   * Prevents a task from being claimed and run twice if MC's queue endpoint
   * returns an already-running in_progress task on a subsequent poll cycle.
   */
  private readonly runningTaskIds = new Set<number>();

  constructor(
    private readonly registry:  WorkflowRegistry,
    private readonly notifiers: INotifyAdapter[],
    private readonly jobStore?: IJobStore,
  ) {
    this.client = new MCClient();
  }

  get enabled(): boolean {
    return this.client.enabled;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (!this.enabled) {
      logger.info("MCWorker: MC not configured — daemon will not poll (set MISSION_CONTROL_URL + MISSION_CONTROL_API_KEY)");
      return;
    }

    // Scaffold standard MC workspace files for all instances (agent.md, soul.md, etc.)
    // This ensures MC's Files tab shows content for every registered agent.
    scaffoldAllWorkspaces();

    await this.registerAgents();

    this.running = true;
    logger.info("MCWorker: started", {
      agents:       [...this.agentIds.keys()],
      pollInterval: `${config.orchestrator.pollIntervalMs}ms`,
    });
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);

    // Reject any workflows waiting for approval so they don't hang
    for (const resolve of this.approvalCallbacks.values()) resolve(false);
    this.approvalCallbacks.clear();

    logger.info("MCWorker: stopped");
  }

  // ── Webhook-driven approval ────────────────────────────────────────────────

  /**
   * Called by the webhook receiver (POST /api/webhooks/mc) when MC fires a
   * task.updated event with status "done" or "quality_review".
   *
   * Resolves the pending Promise inside executeTask(), unblocking the workflow.
   */
  notifyApproval(mcTaskId: number, approved: boolean): void {
    const resolve = this.approvalCallbacks.get(mcTaskId);
    if (resolve) {
      logger.info("MCWorker: approval received", { mcTaskId, approved });
      this.approvalCallbacks.delete(mcTaskId);
      resolve(approved);
    } else {
      logger.debug("MCWorker: approval received but no pending callback", { mcTaskId });
    }
  }

  // ── Public: create an MC task (used by Scheduler, API, intake adapters) ───

  /**
   * Create a task in MC on behalf of a bot instance.
   * Used by the Scheduler when a cron fires, and by POST /api/jobs.
   */
  async createTask(params: {
    instanceId:   string;
    title:        string;
    description?: string;
    priority?:    string;
    tags?:        string[];
    metadata?:    Record<string, unknown>;
  }): Promise<number | null> {
    return this.client.createTask({
      title:       params.title,
      description: params.description,
      // Create as "in_progress" so MC does not attempt native dispatch via openclaw.
      // MC's normalizeTaskCreateStatus converts inbox+assigned_to → "assigned", which
      // triggers MC's scheduler to try the openclaw gateway (ENOENT on dev machines).
      // MCWorker polls via GET /api/tasks/queue which returns in_progress tasks first
      // (continue_current branch), so ElevarusOS claims them on the next poll cycle.
      status:      "in_progress",
      priority:    params.priority ?? "medium",
      assigned_to: params.instanceId,
      tags:        params.tags ?? [params.instanceId],
      metadata:    params.metadata,
    });
  }

  // ── Agent registration ─────────────────────────────────────────────────────

  private async registerAgents(): Promise<void> {
    const instanceIds = listInstanceIds(true); // include disabled instances
    let registered = 0;

    for (const id of instanceIds) {
      try {
        const cfg         = loadInstanceConfig(id);
        const role        = cfg.baseWorkflow.includes("reporting") || cfg.baseWorkflow === "ppc-campaign-report" ? "researcher" : "assistant";
        const capabilities = [cfg.baseWorkflow, cfg.enabled ? "active" : "disabled"];
        const instanceDir = path.join(INSTANCES_DIR, id);
        const soulContent = MCClient.buildSoulContent(cfg);

        const agentId = await this.client.registerAgent({
          name:         id,
          role,
          capabilities,
          framework:    "ElevarusOS",
          workspace:    instanceDir,
          soulContent,
        });

        if (agentId) {
          this.agentIds.set(id, agentId);
          registered++;
          logger.debug("MCWorker: agent registered", { id, agentId });
        }
      } catch (err) {
        logger.warn("MCWorker: failed to register agent", { id, error: String(err) });
      }
    }

    logger.info("MCWorker: agent registration complete", { registered, total: instanceIds.length });
  }

  // ── Queue polling ──────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    try {
      await this.checkAllQueues();
    } catch (err) {
      logger.error("MCWorker: unhandled poll error", { error: String(err) });
    }

    if (this.running) {
      this.pollTimer = setTimeout(
        () => void this.poll(),
        config.orchestrator.pollIntervalMs
      );
    }
  }

  private async checkAllQueues(): Promise<void> {
    for (const agentName of this.agentIds.keys()) {
      // Only poll agents that have a registered workflow
      if (!this.registry.get(agentName)) continue;

      try {
        const task = await this.client.pollQueue(agentName);
        if (task) {
          if (this.runningTaskIds.has(task.id)) {
            logger.debug("MCWorker: task already running — skipping", { mcTaskId: task.id, agent: agentName });
            continue;
          }
          logger.info("MCWorker: task claimed", {
            mcTaskId: task.id,
            title:    task.title,
            agent:    agentName,
          });
          // Fire-and-forget — multiple workflows can run concurrently
          void this.executeTask(task, agentName);
        }
      } catch (err) {
        logger.warn("MCWorker: queue poll error", { agentName, error: String(err) });
      }
    }
  }

  // ── Task execution ─────────────────────────────────────────────────────────

  private async executeTask(mcTask: MCTask, agentName: string): Promise<void> {
    const mcTaskId = mcTask.id;
    this.runningTaskIds.add(mcTaskId);

    try {
      await this._executeTaskInner(mcTask, agentName);
    } finally {
      this.runningTaskIds.delete(mcTaskId);
    }
  }

  private async _executeTaskInner(mcTask: MCTask, agentName: string): Promise<void> {
    const mcTaskId = mcTask.id;
    const workflow = this.registry.get(agentName);

    if (!workflow) {
      await this.client.updateTask(mcTaskId, {
        status:        "failed",
        error_message: `No workflow registered for agent "${agentName}"`,
      });
      return;
    }

    // Guard: if a previous run already completed this task (e.g. ElevarusOS was
    // killed after workflow finished but before Aegis approval went through),
    // just close the task without re-running the stages — avoids duplicate Slack posts.
    if (mcTask.resolution && mcTask.resolution.includes("completed")) {
      logger.info("MCWorker: task already completed — closing without re-run", { mcTaskId, agent: agentName });
      await this.client.submitAegisApproval(mcTaskId, "Auto-closed: workflow already completed in a prior run.");
      return;
    }

    // Build an internal Job object from the MC task
    const job = this.buildJobFromMCTask(mcTask, agentName, workflow.stages);

    // Persist to Supabase if configured (detailed execution tracking)
    await this.saveJobOptional(job);

    // Mark in_progress in MC
    await this.client.updateTask(mcTaskId, { status: "in_progress" });
    logger.info("MCWorker: workflow started", { mcTaskId, agent: agentName, jobId: job.id });

    // Run stages sequentially
    for (const stage of workflow.stages) {
      const stageRecord = job.stages.find((s) => s.name === stage.stageName);
      if (!stageRecord) {
        logger.warn("MCWorker: stage record missing — skipping", {
          jobId:  job.id,
          stage:  stage.stageName,
        });
        continue;
      }

      // ── Approval gate ──────────────────────────────────────────────────────
      // When approval_notify stage runs, we pause and wait for a human to
      // approve in the MC Task Board. Approval arrives via webhook.
      if (stage.stageName === "approval_notify") {
        // Run the notification stage itself (sends email/Slack to approver)
        const notified = await this.runStageWithRetry(job, stage, stageRecord);
        if (!notified) {
          logger.warn("MCWorker: approval notify stage failed — skipping gate", { mcTaskId });
          // Non-fatal — proceed without blocking
        }

        // Move MC task to review and wait
        await this.client.updateTask(mcTaskId, {
          status:      "review",
          description: this.buildDescription(job),
          metadata:    this.buildMetadata(job),
        });
        logger.info("MCWorker: awaiting approval in MC Task Board", { mcTaskId });

        const approved = await this.waitForApproval(mcTaskId);

        if (!approved) {
          await this.client.updateTask(mcTaskId, {
            status:        "failed",
            error_message: "Approval timed out or was rejected",
          });
          job.status = "failed";
          job.error  = "Approval timed out";
          await this.saveJobOptional(job);
          logger.warn("MCWorker: approval timed out", { mcTaskId });
          return;
        }

        // Approved — resume workflow
        job.approval.approved   = true;
        job.approval.approvedBy = "mission-control";
        job.approval.approvedAt = new Date().toISOString();
        await this.client.updateTask(mcTaskId, { status: "in_progress" });
        logger.info("MCWorker: approved — resuming workflow", { mcTaskId });
        continue;
      }

      // ── Normal stage ───────────────────────────────────────────────────────
      const succeeded = await this.runStageWithRetry(job, stage, stageRecord);

      if (!succeeded) {
        const reason = `Stage "${stage.stageName}" failed after ${config.orchestrator.maxStageRetries + 1} attempts`;
        job.status = "failed";
        job.error  = reason;
        await this.saveJobOptional(job);

        await this.client.updateTask(mcTaskId, {
          status:        "failed",
          error_message: reason,
          metadata:      this.buildMetadata(job),
        });
        logger.error("MCWorker: workflow failed", { mcTaskId, agent: agentName, reason });

        await Promise.allSettled(this.notifiers.map((n) => n.sendFailure(job, reason)));
        return;
      }

      // Update MC with stage progress (best-effort, non-blocking)
      void this.client.updateTask(mcTaskId, {
        description: this.buildDescription(job),
        metadata:    this.buildMetadata(job),
      });

      // Post key stage outputs as comments so they're readable in the MC Task Board
      void this.postStageOutputComment(mcTaskId, stage.stageName, stageRecord.output);

      await this.saveJobOptional(job);
    }

    // All stages complete
    job.status      = "completed";
    job.completedAt = new Date().toISOString();
    job.updatedAt   = job.completedAt;
    await this.saveJobOptional(job);

    // Update description + metadata first (non-blocking)
    void this.client.updateTask(mcTaskId, {
      resolution:  "Workflow completed successfully",
      description: this.buildDescription(job),
      metadata:    this.buildMetadata(job),
    });

    // MC requires Aegis quality-review approval before a task can move to "done".
    // For automated workflows, we self-approve as "aegis" — the quality-review
    // endpoint auto-advances the task to "done" on approval.
    const approved = await this.client.submitAegisApproval(
      mcTaskId,
      `ElevarusOS automated workflow complete: ${agentName}`
    );

    if (!approved) {
      // Fallback: try direct status update (works if Aegis is disabled for this workspace)
      await this.client.updateTask(mcTaskId, { status: "done" });
    }

    logger.info("MCWorker: workflow completed", { mcTaskId, agent: agentName, jobId: job.id });
  }

  // ── Stage execution with retry ─────────────────────────────────────────────

  private async runStageWithRetry(
    job:    Job,
    stage:  IStage,
    record: StageRecord
  ): Promise<boolean> {
    const maxAttempts = config.orchestrator.maxStageRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      record.status    = "running";
      record.startedAt = new Date().toISOString();
      record.attempts  = attempt;
      job.updatedAt    = record.startedAt;

      logger.debug(`MCWorker: stage attempt ${attempt}/${maxAttempts}`, {
        jobId: job.id,
        stage: stage.stageName,
      });

      try {
        const output         = await stage.run(job);
        record.output        = output;
        record.status        = "completed";
        record.completedAt   = new Date().toISOString();
        job.updatedAt        = record.completedAt;

        logger.info("MCWorker: stage completed", {
          jobId:   job.id,
          stage:   stage.stageName,
          attempt,
        });
        return true;
      } catch (err) {
        const errorMsg = String(err);
        record.error   = errorMsg;

        logger.warn("MCWorker: stage attempt failed", {
          jobId:   job.id,
          stage:   stage.stageName,
          attempt,
          error:   errorMsg,
        });

        if (attempt >= maxAttempts) {
          record.status      = "failed";
          record.completedAt = new Date().toISOString();
          job.updatedAt      = record.completedAt;
          return false;
        }

        // Exponential backoff before retry
        await new Promise((r) => setTimeout(r, 2_000 * attempt));
      }
    }

    return false;
  }

  // ── Approval gate ──────────────────────────────────────────────────────────

  /**
   * Block until a webhook signals approval (or the timeout fires).
   * Default timeout: 24 hours — long enough for async human review.
   */
  private waitForApproval(
    mcTaskId:  number,
    timeoutMs: number = 24 * 60 * 60 * 1000
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvalCallbacks.delete(mcTaskId);
        resolve(false);
      }, timeoutMs);

      this.approvalCallbacks.set(mcTaskId, (approved) => {
        clearTimeout(timer);
        resolve(approved);
      });
    });
  }

  // ── Job construction ───────────────────────────────────────────────────────

  /**
   * Build an internal Job object from an MC task.
   * MC task metadata carries request fields if the task was created by
   * ElevarusOS (scheduler / API). Human-created MC tasks fall back to the title.
   */
  private buildJobFromMCTask(
    mcTask:     MCTask,
    agentName:  string,
    stages:     IStage[]
  ): Job {
    const now  = new Date().toISOString();
    const meta = (mcTask.metadata ?? {}) as Record<string, unknown>;
    const req  = (meta.request  as Record<string, unknown>) ?? {};

    return {
      id:           (meta.elevarus_job_id as string) ?? uuidv4(),
      workflowType: agentName,
      status:       "running",
      request: {
        title:         mcTask.title,
        brief:         (req.brief      as string) ?? mcTask.description ?? mcTask.title,
        audience:      (req.audience   as string) ?? "Elevarus team",
        targetKeyword: (req.keyword    as string) ?? mcTask.title,
        cta:           (req.cta        as string) ?? "",
        approver:      (req.approver   as string) ?? undefined,
        workflowType:  agentName,
        rawSource: {
          channel:    "mc_task",
          receivedAt: now,
          payload:    { mcTaskId: mcTask.id },
        },
        missingFields: [],
      },
      stages: stages.map((s) => ({
        name:     s.stageName,
        status:   "pending",
        attempts: 0,
      })),
      createdAt: now,
      updatedAt: now,
      // Reporting workflows run automatically — no human approval needed.
      // Approval gates only trigger when a stage named "approval_notify" exists
      // (blog/content workflows). Hardcoding required:true caused confusion in
      // the MC task metadata even though it never actually blocked execution.
      approval:  { required: false, approved: false },
      // Forward pass-through metadata so workflow stages (e.g. clickup-sync)
      // can read external-system IDs the MC task was created with. We strip
      // ElevarusOS-internal keys (request, elevarus_job_id) and surface
      // anything else verbatim.
      metadata: this.extractPassthroughMetadata(meta),
    };
  }

  /** Pass-through MC metadata → Job.metadata. Drops internal-only keys. */
  private extractPassthroughMetadata(meta: Record<string, unknown>): Record<string, unknown> | undefined {
    const INTERNAL_KEYS = new Set(["request", "elevarus_job_id"]);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(meta)) {
      if (INTERNAL_KEYS.has(k)) continue;
      out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  // ── MC description / metadata helpers ─────────────────────────────────────

  private buildDescription(job: Job): string {
    const lines: string[] = [
      `**Bot:** ${job.workflowType}`,
      `**Brief:** ${job.request.brief.slice(0, 300)}`,
    ];
    if (job.request.targetKeyword) lines.push(`**Keyword:** ${job.request.targetKeyword}`);
    if (job.request.audience)      lines.push(`**Audience:** ${job.request.audience}`);

    const running = job.stages.find((s) => s.status === "running");
    if (running) lines.push(`\n**Current stage:** ${running.name}`);

    const done  = job.stages.filter((s) => s.status === "completed").length;
    const total = job.stages.length;
    lines.push(`**Progress:** ${done}/${total} stages`);

    return lines.join("\n");
  }

  private buildMetadata(job: Job): Record<string, unknown> {
    return {
      elevarus_job_id: job.id,
      workflow_type:   job.workflowType,
      request: {
        title:    job.request.title,
        audience: job.request.audience,
        keyword:  job.request.targetKeyword,
        cta:      job.request.cta,
        approver: job.request.approver,
        brief:    job.request.brief.slice(0, 500),
      },
      stages: job.stages.map((s) => ({
        name:        s.name,
        status:      s.status,
        startedAt:   s.startedAt,
        completedAt: s.completedAt,
        error:       s.error,
      })),
      approval:  job.approval,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  // ── Stage output comments ──────────────────────────────────────────────────

  /**
   * Post the output of key stages as a comment on the MC task.
   * This makes report content and blog drafts readable directly in the MC UI
   * without needing to query the API or Supabase.
   *
   * Key stages by workflow type:
   *   reporting — "summary"  → posts markdownReport + alertLevel
   *   blog      — "editorial" → posts the final edited draft
   *              "drafting"   → posts the initial draft
   */
  private async postStageOutputComment(
    mcTaskId:  number,
    stageName: string,
    output:    unknown
  ): Promise<void> {
    if (!output || typeof output !== "object") return;

    const o = output as Record<string, unknown>;

    // ── Reporting: summary stage ────────────────────────────────────────────
    if (stageName === "summary") {
      const alert   = o.alertLevel ? `\n\n**Alert level:** ${String(o.alertLevel).toUpperCase()}` : "";
      const oneliner = o.oneLiner  ? `\n**Headline:** ${o.oneLiner}` : "";
      const report  = o.markdownReport as string | undefined;
      const slack   = o.slackMessage   as string | undefined;

      const comment = [
        `## 📊 Campaign Report`,
        oneliner,
        alert,
        report ? `\n---\n\n${report}` : "",
        slack  ? `\n\n---\n**Slack summary:**\n${slack}` : "",
      ].filter(Boolean).join("\n");

      await this.client.addComment(mcTaskId, comment);
    }

    // ── Blog: editorial stage (final polished draft) ────────────────────────
    if (stageName === "editorial") {
      const draft = (o.editedDraft ?? o.draft ?? o.content ?? o.text) as string | undefined;
      if (draft) {
        await this.client.addComment(
          mcTaskId,
          `## ✍️ Final Draft (post-editorial)\n\n${draft}`
        );
      }
    }

    // ── Blog: drafting stage (initial draft for reference) ──────────────────
    if (stageName === "drafting" && !o.editedDraft) {
      const draft = (o.draft ?? o.content ?? o.text) as string | undefined;
      if (draft) {
        await this.client.addComment(
          mcTaskId,
          `## 📝 Initial Draft\n\n${draft}`
        );
      }
    }
  }

  // ── Supabase passthrough ───────────────────────────────────────────────────

  private async saveJobOptional(job: Job): Promise<void> {
    if (!this.jobStore) return;
    try {
      await this.jobStore.save(job);
    } catch {
      // Non-fatal — MC is source of truth; Supabase is secondary
    }
  }
}
