import { v4 as uuidv4 } from "uuid";
import {
  Job,
  JobStatus,
  StageRecord,
  BLOG_STAGES,
  BlogStageName,
} from "../models/job.model";
import { BlogRequest } from "../models/blog-request.model";
import { IIntakeAdapter } from "../adapters/intake/intake.interface";
import { INotifyAdapter } from "../adapters/notify/notify.interface";
import { IBlogStage } from "../workflows/blog/stages/stage.interface";
import { IJobStore } from "./job-store";
import { logger } from "./logger";
import { config } from "../config";

/**
 * Central orchestrator for ElevarusOS.
 *
 * Responsibilities:
 * - Poll intake adapters for new blog requests
 * - Create and persist jobs
 * - Execute workflow stages in order with retry logic
 * - Track stage-level status transitions
 * - Route failure notifications
 *
 * Designed to support multiple workflow types in the future — the blog
 * workflow is wired in at the call site (index.ts) rather than hard-coded
 * here, keeping this class workflow-agnostic.
 */
export class Orchestrator {
  private running = false;
  private pollTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly jobStore: IJobStore,
    private readonly intakeAdapters: IIntakeAdapter[],
    private readonly notifiers: INotifyAdapter[],
    private readonly stages: IBlogStage[]
  ) {}

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /** Start polling all intake adapters on the configured interval. */
  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info("Orchestrator started", {
      pollIntervalMs: config.orchestrator.pollIntervalMs,
      intakeAdapters: this.intakeAdapters.map((a) => a.name),
      notifiers: this.notifiers.map((n) => n.name),
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
        const job = this.createJob(request);
        await this.jobStore.save(job);
        logger.info("New job enqueued", {
          jobId: job.id,
          source: adapter.name,
          title: request.title,
        });
        void this.runJob(job);
      }
    }
  }

  // ─── Manual job submission (for testing / direct invocation) ─────────────

  async submitJob(request: BlogRequest): Promise<Job> {
    const job = this.createJob(request);
    await this.jobStore.save(job);
    logger.info("Job submitted manually", { jobId: job.id, title: request.title });
    await this.runJob(job);
    return (await this.jobStore.get(job.id))!;
  }

  // ─── Job creation ─────────────────────────────────────────────────────────

  private createJob(request: BlogRequest): Job {
    const now = new Date().toISOString();
    const stages: StageRecord[] = BLOG_STAGES.map((name) => ({
      name,
      status: "pending",
      attempts: 0,
    }));

    return {
      id: uuidv4(),
      workflowType: "blog",
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
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    await this.jobStore.save(job);

    logger.info("Job started", { jobId: job.id, title: job.request.title });

    await Promise.allSettled(this.notifiers.map((n) => n.sendJobStarted(job)));

    for (const stage of this.stages) {
      const stageRecord = job.stages.find(
        (s) => s.name === (stage.stageName as BlogStageName)
      );

      if (!stageRecord) {
        logger.warn("Stage record not found — skipping", {
          jobId: job.id,
          stage: stage.stageName,
        });
        continue;
      }

      const succeeded = await this.runStageWithRetry(job, stage, stageRecord);

      if (!succeeded) {
        await this.failJob(job, `Stage "${stage.stageName}" failed after retries`);
        return;
      }

      // After approval_notify, flip the job status so callers know we're waiting
      if (stage.stageName === "approval_notify") {
        job.status = "awaiting_approval";
        job.updatedAt = new Date().toISOString();
        await this.jobStore.save(job);
      }
    }

    job.status = "completed";
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    await this.jobStore.save(job);

    logger.info("Job completed", { jobId: job.id });
  }

  private async runStageWithRetry(
    job: Job,
    stage: IBlogStage,
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

    logger.error("Job failed", { jobId: job.id, reason });

    await Promise.allSettled(
      this.notifiers.map((n) => n.sendFailure(job, reason))
    );
  }

  // ─── Job access ───────────────────────────────────────────────────────────

  async getJob(id: string): Promise<Job | undefined> {
    return this.jobStore.get(id);
  }

  async listJobs(): Promise<Job[]> {
    return this.jobStore.list();
  }
}
