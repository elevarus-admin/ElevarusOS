import { IJobStore } from "./job-store";
import { MissionControlBridge } from "../adapters/bridge/mission-control.bridge";
import { logger } from "./logger";

/**
 * DashboardPoller
 *
 * Periodically checks Mission Control for jobs that have been approved in the
 * dashboard (status moved to "done" or "quality_review") and updates the
 * corresponding ElevarusOS job's approval state.
 *
 * This closes the approval loop:
 *   ElevarusOS awaiting_approval → MC task review
 *   Human approves in MC → task moves to done/quality_review
 *   Poller detects → sets job.approval.approved = true in Supabase
 *   Orchestrator unblocks → job continues to completed
 *
 * Poll interval defaults to 30s — light-weight HEAD-style checks.
 */
export class DashboardPoller {
  private readonly jobStore: IJobStore;
  private readonly bridge: MissionControlBridge;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(jobStore: IJobStore, bridge: MissionControlBridge, intervalMs = 30_000) {
    this.jobStore   = jobStore;
    this.bridge     = bridge;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (!this.bridge.enabled) return;
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    logger.info("DashboardPoller: started", { intervalMs: this.intervalMs });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      // Find all jobs currently awaiting approval
      const allJobs = await this.jobStore.list();
      const pending = allJobs.filter(
        (j) => j.status === "awaiting_approval" && !j.approval.approved,
      );

      if (pending.length === 0) return;

      const approvals = await this.bridge.pollForApprovals(pending.map((j) => j.id));

      for (const { jobId, mcStatus } of approvals) {
        const job = pending.find((j) => j.id === jobId);
        if (!job) continue;

        logger.info("DashboardPoller: approval detected in MC", { jobId, mcStatus });

        // Mark the job as approved in the store
        const updatedJob = {
          ...job,
          approval: {
            ...job.approval,
            approved:   true,
            approvedBy: "mission-control",
            approvedAt: new Date().toISOString(),
            notes:      `Approved via Mission Control dashboard (MC status: ${mcStatus})`,
          },
        };

        await this.jobStore.save(updatedJob);
        logger.info("DashboardPoller: job approval persisted", { jobId });
      }
    } catch (err) {
      logger.warn("DashboardPoller: poll error", { error: String(err) });
    }
  }
}
