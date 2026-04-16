import { Job, JobStatus } from "../../models/job.model";
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
 *      npm run dashboard:dev          (from repo root)
 *      — or —
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
 *      const bridge = new MissionControlBridge();
 *      orchestrator.setBridge(bridge);     ← see orchestrator.ts
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
 * ─── Data stored in Mission Control ─────────────────────────────────────────
 *
 * - title: job.request.title
 * - description: job.request.brief
 * - status: mapped from JobStatus
 * - tags: [workflowType, instanceId]
 * - metadata: { jobId, workflowType, stages, approvalState, request fields }
 *
 * The metadata field holds the full stage progression so Mission Control can
 * show which stages have completed and what each one produced.
 */
export class MissionControlBridge {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly enabled: boolean;

  /** Map from ElevarusOS job.id → Mission Control task id (numeric) */
  private readonly taskIdMap = new Map<string, number>();

  constructor() {
    this.baseUrl = (process.env.MISSION_CONTROL_URL ?? "http://localhost:3000").replace(/\/$/, "");
    this.apiKey = process.env.MISSION_CONTROL_API_KEY ?? "";
    this.enabled = Boolean(this.baseUrl && this.apiKey);

    if (!this.enabled) {
      logger.info("Mission Control bridge: not configured (set MISSION_CONTROL_URL + MISSION_CONTROL_API_KEY to enable)");
    } else {
      logger.info("Mission Control bridge: enabled", { baseUrl: this.baseUrl });
    }
  }

  // ─── Lifecycle hooks (call from orchestrator) ─────────────────────────────

  async onJobCreated(job: Job): Promise<void> {
    if (!this.enabled) return;
    try {
      const taskId = await this.createTask(job);
      if (taskId) this.taskIdMap.set(job.id, taskId);
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

  // ─── API calls ────────────────────────────────────────────────────────────

  private async createTask(job: Job): Promise<number | null> {
    const body = {
      title: job.request.title,
      description: this.buildDescription(job),
      status: this.mapStatus(job.status),
      priority: "medium",
      tags: [job.workflowType, ...(job.workflowType.includes("blog") ? ["blog"] : ["reporting"])],
      metadata: this.buildMetadata(job),
    };

    const res = await this.post("/api/tasks", body);
    if (!res) return null;

    // MC returns { task: { id, ... } }
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

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private mapStatus(status: JobStatus): string {
    // Mission Control status values: inbox | in_progress | review | quality_review | done | failed
    // Note: "done" requires Aegis approval in Mission Control's workflow.
    // ElevarusOS "completed" maps to "quality_review" — visible as a completed, pending final sign-off.
    const map: Record<JobStatus, string> = {
      queued: "inbox",
      running: "in_progress",
      awaiting_approval: "review",
      approved: "quality_review",
      completed: "quality_review",
      failed: "failed",
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
      workflow_type: job.workflowType,
      request: {
        title: job.request.title,
        audience: job.request.audience,
        keyword: job.request.targetKeyword,
        cta: job.request.cta,
        approver: job.request.approver,
      },
      stages: job.stages.map((s) => ({
        name: s.name,
        status: s.status,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        error: s.error,
      })),
      approval: job.approval,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private async post(path: string, body: unknown): Promise<any | null> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
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
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logger.warn("Mission Control PUT failed", { path, status: res.status, body: text.slice(0, 200) });
    }
  }
}
