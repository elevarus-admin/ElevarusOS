import { v4 as uuidv4 } from "uuid";
import { Job, JobStatus, StageRecord } from "../models/job.model";
import { BlogRequest } from "../models/blog-request.model";
import { IIntakeAdapter } from "../adapters/intake/intake.interface";
import { INotifyAdapter } from "../adapters/notify/notify.interface";
import { IStage } from "./stage.interface";
import { WorkflowRegistry } from "./workflow-registry";
import { IJobStore } from "./job-store";
import { logger } from "./logger";
import { config } from "../config";
import { approvalStore } from "./approval-store";
import { getAndResetUsage } from "./claude-client";
import { addUsage } from "./model-pricing";

/** Minimal interface so orchestrator doesn't depend on MissionControlBridge directly */
interface IDashboardBridge {
  onJobCreated(job: Job): Promise<void>;
  onJobUpdated(job: Job): Promise<void>;
}

/**
 * Central orchestrator for ElevarusOS.
 *
 * The orchestrator is fully workflow-agnostic — it does not know about blogs,
 * social posts, or any other content type. All workflow specifics live inside
 * the WorkflowRegistry and the IStage implementations registered with it.
 *
 * To add a new bot:
 *   1. Implement IStage for each step of the new workflow
 *   2. Create a WorkflowDefinition and register it in the registry (index.ts)
 *   3. Ensure intake adapters produce requests for that workflowType
 */
export class Orchestrator {
  private running = false;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private bridge?: IDashboardBridge;

  constructor(
    private readonly jobStore: IJobStore,
    private readonly intakeAdapters: IIntakeAdapter[],
    private readonly notifiers: INotifyAdapter[],
    private readonly registry: WorkflowRegistry
  ) {}

  /**
   * Attach a dashboard bridge (e.g. MissionControlBridge).
   * When set, the orchestrator fires onJobCreated/onJobUpdated on every job event.
   */
  setBridge(bridge: IDashboardBridge): void {
    this.bridge = bridge;
    logger.info("Dashboard bridge attached", { bridge: bridge.constructor.name });
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Start polling all intake adapters on the configured interval. */
  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info("Orchestrator started", {
      pollIntervalMs: config.orchestrator.pollIntervalMs,
      intakeAdapters: this.intakeAdapters.map((a) => a.name),
      notifiers: this.notifiers.map((n) => n.name),
      workflows: this.registry.registeredTypes,
    });
    void this.poll();
  }

  /** Stop the polling loop after the current poll completes. */
  stop(): void {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    logger.info("Orchestrator stopped");
  }

  // ─── Polling ─────────────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    try {
      await this.fetchAndEnqueue();
    } catch (err) {
      logger.error("Unhandled error during intake poll", { error: String(err) });
    }

    if (this.running) {
      this.pollTimer = setTimeout(
        () => void this.poll(),
        config.orchestrator.pollIntervalMs
      );
    }
  }

  private async fetchAndEnqueue(): Promise<void> {
    for (const adapter of this.intakeAdapters) {
      let requests: BlogRequest[];
      try {
        requests = await adapter.fetchPending();
      } catch (err) {
        logger.error("Intake adapter error", {
          adapter: adapter.name,
          error: String(err),
        });
        continue;
      }

      for (const request of requests) {
        const workflowType = request.workflowType ?? "blog";
        const job = this.createJob(request, workflowType);
        if (!job) continue;

        await this.jobStore.save(job);
        // Await bridge create so taskIdMap is populated before runJob fires onJobUpdated
        await this.bridge?.onJobCreated(job);
        logger.info("New job enqueued", {
          jobId: job.id,
          workflowType,
          source: adapter.name,
          title: request.title,
        });
        void this.runJob(job);
      }
    }
  }

  // ─── Manual job submission (for testing / direct invocation) ─────────────

  async submitJob(
    request: BlogRequest,
    workflowType = "blog"
  ): Promise<Job> {
    const job = this.createJob(request, workflowType);
    if (!job) throw new Error(`Unknown workflowType: "${workflowType}"`);

    await this.jobStore.save(job);
    logger.info("Job submitted manually", { jobId: job.id, title: request.title });
    // Await bridge create so taskIdMap is populated before runJob fires onJobUpdated
    await this.bridge?.onJobCreated(job);
    await this.runJob(job);
    return (await this.jobStore.get(job.id))!;
  }

  // ─── Job creation ─────────────────────────────────────────────────────────

  private createJob(request: BlogRequest, workflowType: string): Job | null {
    const workflow = this.registry.get(workflowType);
    if (!workflow) {
      logger.error("No workflow registered for type — job dropped", { workflowType });
      return null;
    }

    const now = new Date().toISOString();
    // Derive stage names from the IStage instances — single source of truth
    const stages: StageRecord[] = workflow.stages.map((s) => ({
      name: s.stageName,
      status: "pending",
      attempts: 0,
    }));

    return {
      id: uuidv4(),
      workflowType,
      status: "queued",
      request,
      stages,
      createdAt: now,
      updatedAt: now,
      approval: { required: true, approved: false },
    };
  }

  // ─── Workflow execution ───────────────────────────────────────────────────

  private async runJob(job: Job): Promise<void> {
    const workflow = this.registry.get(job.workflowType);
    if (!workflow) {
      await this.failJob(job, `No workflow registered for type "${job.workflowType}"`);
      return;
    }

    job.status = "running";
    job.updatedAt = new Date().toISOString();
    await this.jobStore.save(job);
    await this.bridge?.onJobUpdated(job);

    logger.info("Job started", { jobId: job.id, title: job.request.title });

    await Promise.allSettled(this.notifiers.map((n) => n.sendJobStarted(job)));

    for (const stage of workflow.stages) {
      const stageRecord = job.stages.find((s) => s.name === stage.stageName);

      if (!stageRecord) {
        logger.warn("Stage record not found — skipping", {
          jobId: job.id,
          stage: stage.stageName,
        });
        continue;
      }

      // For the approval gate: set awaiting_approval BEFORE the stage runs
      // (the stage will block until the approver acts, so the status must
      // reflect "waiting" during that time, not "running")
      if (stage.stageName === "approval_notify") {
        job.status = "awaiting_approval";
        job.updatedAt = new Date().toISOString();
        await this.jobStore.save(job);
        await this.bridge?.onJobUpdated(job);
      }

      const succeeded = await this.runStageWithRetry(job, stage, stageRecord);

      if (!succeeded) {
        await this.failJob(job, `Stage "${stage.stageName}" failed after retries`);
        return;
      }

      // After approval_notify resolves, check the decision
      if (stage.stageName === "approval_notify") {
        const out = stageRecord.output as { approved?: boolean } | undefined;
        if (!out?.approved) {
          await this.rejectJob(job, "Rejected by approver or approval timed out");
          return;
        }
        // Approved — resume normal execution
        job.status = "running";
        job.updatedAt = new Date().toISOString();
        await this.jobStore.save(job);
        await this.bridge?.onJobUpdated(job);
        logger.info("Job approved — continuing workflow", { jobId: job.id });
      }
    }

    job.status = "completed";
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    await this.jobStore.save(job);
    await this.bridge?.onJobUpdated(job);

    logger.info("Job completed", { jobId: job.id });
  }

  private async runStageWithRetry(
    job: Job,
    stage: IStage,
    record: StageRecord
  ): Promise<boolean> {
    const maxAttempts = config.orchestrator.maxStageRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      record.status = "running";
      record.startedAt = new Date().toISOString();
      record.attempts = attempt;
      job.updatedAt = record.startedAt;
      await this.jobStore.save(job);

      logger.debug(`Running stage (attempt ${attempt}/${maxAttempts})`, {
        jobId: job.id,
        stage: stage.stageName,
      });

      try {
        const output = await stage.run(job);
        record.output = output;
        record.status = "completed";
        record.completedAt = new Date().toISOString();
        job.updatedAt = record.completedAt;

        // Capture token usage accumulated during this stage run
        const stageUsage = getAndResetUsage();
        if (stageUsage.totalTokens > 0) {
          record.usage = stageUsage;
          job.totalUsage = job.totalUsage
            ? addUsage(job.totalUsage, stageUsage)
            : stageUsage;
        }

        await this.jobStore.save(job);

        logger.info("Stage completed", {
          jobId: job.id,
          stage: stage.stageName,
          attempt,
        });
        return true;
      } catch (err) {
        const errorMsg = String(err);
        record.error = errorMsg;
        logger.warn(`Stage attempt failed`, {
          jobId: job.id,
          stage: stage.stageName,
          attempt,
          error: errorMsg,
        });

        if (attempt >= maxAttempts) {
          record.status = "failed";
          record.completedAt = new Date().toISOString();
          job.updatedAt = record.completedAt;
          await this.jobStore.save(job);
          return false;
        }

        // Brief backoff before retry
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }

    return false;
  }

  private async failJob(job: Job, reason: string): Promise<void> {
    job.status = "failed";
    job.error = reason;
    job.updatedAt = new Date().toISOString();
    await this.jobStore.save(job);
    await this.bridge?.onJobUpdated(job);

    logger.error("Job failed", { jobId: job.id, reason });

    await Promise.allSettled(
      this.notifiers.map((n) => n.sendFailure(job, reason))
    );
  }

  private async rejectJob(job: Job, reason: string): Promise<void> {
    job.status = "rejected";
    job.error = reason;
    job.updatedAt = new Date().toISOString();
    await this.jobStore.save(job);
    await this.bridge?.onJobUpdated(job);

    logger.info("Job rejected", { jobId: job.id, reason });

    // Reuse sendFailure for the notification (adapters can check job.status to
    // customise the message in future)
    await Promise.allSettled(
      this.notifiers.map((n) => n.sendFailure(job, reason))
    );
  }

  // ─── Job cancellation ─────────────────────────────────────────────────────

  async cancelJob(jobId: string): Promise<{ cancelled: boolean; error?: string }> {
    const job = await this.jobStore.get(jobId);
    if (!job) return { cancelled: false, error: "Job not found" };
    if (job.status === "completed" || job.status === "failed" || job.status === "rejected") {
      return { cancelled: false, error: `Job is already ${job.status}` };
    }
    // If awaiting approval, unblock the promise first
    if (job.status === "awaiting_approval") {
      approvalStore.notifyApproval(jobId, false);
    }
    job.status = "failed";
    job.error = "Cancelled by user";
    job.updatedAt = new Date().toISOString();
    await this.jobStore.save(job);
    await this.bridge?.onJobUpdated(job);
    logger.info("Job cancelled", { jobId });
    return { cancelled: true };
  }

  // ─── Job access ───────────────────────────────────────────────────────────

  async getJob(id: string): Promise<Job | undefined> {
    return this.jobStore.get(id);
  }

  async listJobs(): Promise<Job[]> {
    return this.jobStore.list();
  }
}
