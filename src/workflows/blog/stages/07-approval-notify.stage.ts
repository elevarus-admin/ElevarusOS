import { IBlogStage } from "./stage.interface";
import { Job } from "../../../models/job.model";
import { ApprovalNotifyOutput } from "../../../models/output.model";
import { INotifyAdapter } from "../../../adapters/notify/notify.interface";
import { logger } from "../../../core/logger";

/**
 * Stage 7 — Approval Notification
 *
 * Sends the draft summary to Slack and email so the approver can review and
 * respond. Sets the job status to "awaiting_approval" after notifying.
 *
 * The actual approval action (setting job.approval.approved = true) happens
 * outside the workflow — via a webhook, manual record update, or future
 * approval UI.
 */
export class ApprovalNotifyStage implements IBlogStage {
  readonly stageName = "approval_notify";

  constructor(private readonly notifiers: INotifyAdapter[]) {}

  async run(job: Job): Promise<ApprovalNotifyOutput> {
    logger.info("Running approval notification stage", {
      jobId: job.id,
      approver: job.request.approver,
      notifierCount: this.notifiers.length,
    });

    const results = await Promise.allSettled(
      this.notifiers.map((n) => n.sendApprovalRequest(job))
    );

    results.forEach((r, i) => {
      if (r.status === "rejected") {
        logger.error("Notifier failed during approval notify", {
          jobId: job.id,
          notifier: this.notifiers[i].name,
          error: String(r.reason),
        });
      }
    });

    const notifiedAt = new Date().toISOString();

    logger.info("Approval notifications dispatched", {
      jobId: job.id,
      notifiedAt,
    });

    return {
      notifiedAt,
    };
  }
}
