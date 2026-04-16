import { IPublishAdapter, PublishResult } from "./publish.interface";
import { Job } from "../../models/job.model";
import { logger } from "../../core/logger";

/**
 * Placeholder publisher — records the intent to publish without performing
 * any real CMS or platform operation.
 *
 * This adapter is intentionally minimal. Replace or extend it in v2+ once
 * publishing platforms and approval workflows are fully defined.
 *
 * The adapter enforces the approval gate: it will refuse to run if the job
 * has not been explicitly approved.
 */
export class PlaceholderPublishAdapter implements IPublishAdapter {
  readonly name = "placeholder";
  readonly platform = "none";

  async publish(job: Job): Promise<PublishResult> {
    if (!job.approval.approved) {
      throw new Error(
        `Publish blocked: job ${job.id} has not been approved. ` +
          `Set job.approval.approved = true before calling publish.`
      );
    }

    logger.info("Publish placeholder — no real publish performed", {
      jobId: job.id,
      title: job.request.title,
    });

    return {
      platform: this.platform,
      publishedAt: new Date().toISOString(),
    };
  }
}
