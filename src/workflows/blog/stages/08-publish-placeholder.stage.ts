import { IBlogStage } from "./stage.interface";
import { Job } from "../../../models/job.model";
import { PublishPlaceholderOutput } from "../../../models/output.model";
import { logger } from "../../../core/logger";

/**
 * Stage 8 — Publish Placeholder
 *
 * Records the publish handoff intent without performing any real CMS or
 * platform operation. This stage enforces the approval gate — it will not
 * proceed if the job has not been explicitly approved.
 *
 * In v2+, swap or extend this stage to call a real IPublishAdapter
 * (WordPress, Webflow, HubSpot, etc.) after approval is confirmed.
 */
export class PublishPlaceholderStage implements IBlogStage {
  readonly stageName = "publish_placeholder";

  async run(job: Job): Promise<PublishPlaceholderOutput> {
    logger.info("Running publish placeholder stage", {
      jobId: job.id,
      approved: job.approval.approved,
    });

    if (!job.approval.approved) {
      logger.info(
        "Job is not yet approved — recording publish intent as pending",
        { jobId: job.id }
      );
    }

    const output: PublishPlaceholderOutput = {
      handoffStatus: "pending",
      note: job.approval.approved
        ? "Approved — ready for publish adapter integration in a future version."
        : "Awaiting approval — publish is blocked until job.approval.approved is set to true.",
      createdAt: new Date().toISOString(),
    };

    // Attach a publish record to the job for visibility
    job.publishRecord = {
      status: "pending",
      createdAt: output.createdAt,
    };

    return output;
  }
}
