import { Job, JobStatus } from "../../models/job.model";
import { IJobStore } from "../../core/job-store";
import { logger } from "../../core/logger";

/**
 * Mission Control Bridge
 *
 * Syncs ElevarusOS job lifecycle events to the Mission Control dashboard.
 * Mission Control provides the visual UI — this bridge keeps it in sync.
 *
 * ─── Setup ───────────────────────────────────────────────────────────────────
 *
 * 1. Start Mission Control:
 *      cd dashboard && pnpm dev
 *
 * 2. Get an API key:
 *      Open http://localhost:3000 → Settings → API Keys → Create Key
 *
 * 3. Set env vars in ElevarusOS .env:
 *      MISSION_CONTROL_URL=http://localhost:3000
 *      MISSION_CONTROL_API_KEY=your-api-key-here
 *
 * 4. Enable the bridge in index.ts:
 *      const bridge = new MissionControlBridge(jobStore);
 *      orchestrator.setBridge(bridge);
 *
 * ─── Status mapping ──────────────────────────────────────────────────────────
 *
 *   ElevarusOS             →  Mission Control
 *   queued                 →  inbox
 *   running                →  in_progress
 *   awaiting_approval      →  review
 *   approved               →  quality_review
 *   completed              →  done
 *   failed                 →  failed
 *
 * ─── Persistence ─────────────────────────────────────────────────────────────
 *
 * mc_task_id is saved back to the job store (Supabase) after task creation.
 * On startup, call restoreTaskIdMap() to rebuild the in-memory map from the
 * store so updates work correctly after a restart.
 */
export class MissionControlBridge {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  readonly enabled: boolean;

  /** Map from ElevarusOS job.id → Mission Control task id (numeric) */
  private readonly taskIdMap = new Map<string, number>();

  private readonly jobStore: IJobStore | null;

  constructor(jobStore?: IJobStore) {
    this.baseUrl = (process.env.MISSION_CONTROL_URL ?? "http://localhost:3000").replace(/\/$/, "");
    this.apiKey = process.env.MISSION_CONTROL_API_KEY ?? "";
    this.enabled = Boolean(this.baseUrl && this.apiKey);
    this.jobStore = jobStore ?? null;

    if (!this.enabled) {
      logger.info("Mission Control bridge: not configured (set MISSION_CONTROL_URL + MISSION_CONTROL_API_KEY to enable)");
    } else {
      logger.info("Mission Control bridge: enabled", { baseUrl: this.baseUrl });
    }
  }

  // ─── Startup ──────────────────────────────────────────────────────────────

  /**
   * Rebuild the in-memory taskIdMap from the job store.
   * Call once at startup so existing jobs keep their MC task IDs across restarts.
   */
  async restoreTaskIdMap(): Promise<void> {
    if (!this.enabled || !this.jobStore) return;
    try {
      const jobs = await this.jobStore.list();
      let restored = 0;
      for (const job of jobs) {
        if (job.mcTaskId) {
          this.taskIdMap.set(job.id, job.mcTaskId);
          restored++;
        }
      }
      if (restored > 0) {
        logger.info("Mission Control bridge: restored task ID map", { count: restored });
      }
    } catch (err) {
      logger.warn("Mission Control bridge: could not restore task ID map", { error: String(err) });
    }
  }

  // ─── Lifecycle hooks (call from orchestrator) ─────────────────────────────

  async onJobCreated(job: Job): Promise<void> {
    if (!this.enabled) return;
    try {
      const taskId = await this.createTask(job);
      if (taskId) {
        this.taskIdMap.set(job.id, taskId);
        // Persist mc_task_id so the map survives restarts
        await this.persistMcTaskId(job, taskId);
      }
    } catch (err) {
      logger.warn("Mission Control: failed to create task", { jobId: job.id, error: String(err) });
    }
  }

  async onJobUpdated(job: Job): Promise<void> {
    if (!this.enabled) return;
    const taskId = this.taskIdMap.get(job.id);
    if (!taskId) {
      logger.warn("Mission Control: onJobUpdated called but no taskId mapped — update skipped", {
        jobId: job.id,
        status: job.status,
      });
      return;
    }
    try {
      await this.updateTask(taskId, job);
    } catch (err) {
      logger.warn("Mission Control: failed to update task", { jobId: job.id, taskId, error: String(err) });
    }
  }

  // ─── Approval polling ─────────────────────────────────────────────────────

  /**
   * Returns jobs that MC has marked done/quality_review for a given set of
   * ElevarusOS job IDs. Used by the approval poller.
   * Returns { jobId, mcStatus } for any job whose MC task has moved past "review".
   */
  async pollForApprovals(jobIds: string[]): Promise<Array<{ jobId: string; mcStatus: string }>> {
    if (!this.enabled || jobIds.length === 0) return [];
    const results: Array<{ jobId: string; mcStatus: string }> = [];

    for (const jobId of jobIds) {
      const taskId = this.taskIdMap.get(jobId);
      if (!taskId) continue;
      try {
        const task = await this.getTask(taskId);
        if (task && (task.status === "done" || task.status === "quality_review")) {
          results.push({ jobId, mcStatus: task.status });
        }
      } catch {
        // skip — transient error
      }
    }

    return results;
  }

  // ─── API calls ────────────────────────────────────────────────────────────

  private async createTask(job: Job): Promise<number | null> {
    const body = {
      title: job.request.title,
      description: this.buildDescription(job),
      status: this.mapStatus(job.status),
      priority: "medium",
      assigned_to: job.workflowType,
      tags: [job.workflowType, ...(job.workflowType.includes("blog") ? ["blog"] : ["reporting"])],
      metadata: this.buildMetadata(job),
    };

    const res = await this.post("/api/tasks", body);
    if (!res) return null;

    const taskId = res.task?.id ?? res.id;
    if (!taskId) {
      logger.warn("Mission Control: POST succeeded but no task ID in response", { jobId: job.id, res });
      return null;
    }

    logger.debug("Mission Control: task created", { jobId: job.id, taskId });
    return taskId as number;
  }

  private async updateTask(taskId: number, job: Job): Promise<void> {
    const body = {
      status: this.mapStatus(job.status),
      description: this.buildDescription(job),
      metadata: this.buildMetadata(job),
      ...(job.status === "failed" ? { error_message: job.error ?? "Unknown error" } : {}),
    };

    await this.put(`/api/tasks/${taskId}`, body);
    logger.debug("Mission Control: task updated", { jobId: job.id, taskId, status: job.status });
  }

  private async getTask(taskId: number): Promise<{ status: string } | null> {
    const res = await this.get(`/api/tasks/${taskId}`);
    return res?.task ?? res ?? null;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private async persistMcTaskId(job: Job, mcTaskId: number): Promise<void> {
    if (!this.jobStore) return;
    try {
      const updated = { ...job, mcTaskId };
      await this.jobStore.save(updated);
    } catch (err) {
      logger.warn("Mission Control: failed to persist mc_task_id", { jobId: job.id, mcTaskId, error: String(err) });
    }
  }

  private mapStatus(status: JobStatus): string {
    const map: Record<JobStatus, string> = {
      queued:            "inbox",
      running:           "in_progress",
      awaiting_approval: "review",
      approved:          "quality_review",
      completed:         "done",
      failed:            "failed",
    };
    return map[status] ?? "inbox";
  }

  private buildDescription(job: Job): string {
    const lines = [
      `**Bot:** ${job.workflowType}`,
      `**Brief:** ${job.request.brief.slice(0, 300)}`,
      `**Keyword:** ${job.request.targetKeyword}`,
      `**Audience:** ${job.request.audience}`,
    ];

    const currentStage = job.stages.find((s) => s.status === "running");
    if (currentStage) lines.push(`\n**Current stage:** ${currentStage.name}`);

    const completedCount = job.stages.filter((s) => s.status === "completed").length;
    lines.push(`**Progress:** ${completedCount}/${job.stages.length} stages`);

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

  private async post(path: string, body: unknown): Promise<any | null> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn("Mission Control POST failed", { path, status: res.status, body: text.slice(0, 200) });
      return null;
    }
    return res.json();
  }

  private async put(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn("Mission Control PUT failed", { path, status: res.status, body: text.slice(0, 200) });
    }
  }

  private async get(path: string): Promise<any | null> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { "x-api-key": this.apiKey },
    });
    if (!res.ok) return null;
    return res.json();
  }
}
