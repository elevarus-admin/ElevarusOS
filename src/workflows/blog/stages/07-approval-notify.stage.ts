import { IBlogStage } from "./stage.interface";
import { Job } from "../../../models/job.model";
import { ApprovalNotifyOutput } from "../../../models/output.model";
import { INotifyAdapter } from "../../../adapters/notify/notify.interface";
import { approvalStore } from "../../../core/approval-store";
import { logger } from "../../../core/logger";

/**
 * Stage 7 — Approval Notification
 *
 * Sends the draft summary to Slack (with interactive Approve/Reject buttons)
 * and email, then BLOCKS until the approver acts or the 24-hour timeout fires.
 *
 * The blocking happens via ApprovalStore.waitForApproval(job.id). The API
 * endpoints POST /api/jobs/:jobId/approve and POST /api/jobs/:jobId/reject
 * (also reached via the Slack interactive webhook) call
 * approvalStore.notifyApproval() to unblock the stage.
 *
 * The orchestrator sets job.status = "awaiting_approval" BEFORE entering this
 * stage so the dashboard reflects the correct state during the wait.
 *
 * After this stage returns:
 *   output.approved = true  → orchestrator continues to remaining stages
 *   output.approved = false → orchestrator marks job as "rejected" and stops
 */
export class ApprovalNotifyStage implements IBlogStage {
  readonly stageName = "approval_notify";

  constructor(private readonly notifiers: INotifyAdapter[]) {}

  async run(job: Job): Promise<ApprovalNotifyOutput> {
    logger.info("Running approval notification stage", {
      jobId:         job.id,
      approver:      job.request.approver,
      notifierCount: this.notifiers.length,
    });

    // Fire all notifiers (Slack + email) in parallel — failures are logged but
    // don't prevent the approval gate from opening
    const results = await Promise.allSettled(
      this.notifiers.map((n) => n.sendApprovalRequest(job))
    );

    results.forEach((r, i) => {
      if (r.status === "rejected") {
        logger.error("Notifier failed during approval notify", {
          jobId:    job.id,
          notifier: this.notifiers[i].name,
          error:    String(r.reason),
        });
      }
    });

    const notifiedAt = new Date().toISOString();

    logger.info("Approval notifications dispatched — waiting for human decision", {
      jobId:     job.id,
      notifiedAt,
    });

    // ── Block here until approved, rejected, or 24h timeout ──────────────────
    const approved  = await approvalStore.waitForApproval(job.id);
    const decidedAt = new Date().toISOString();

    logger.info("Approval decision received", { jobId: job.id, approved, decidedAt });

    return {
      notifiedAt,
      approved,
      decidedAt,
    };
  }
}
