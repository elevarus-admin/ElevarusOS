import { IBlogStage } from "./stage.interface";
import { Job } from "../../../models/job.model";
import { IntakeOutput } from "../../../models/output.model";
import { logger } from "../../../core/logger";

/**
 * Stage 1 — Intake
 *
 * Validates that the job carries a usable request and records the raw source
 * summary. This is intentionally lightweight; real parsing happened in the
 * intake adapter before the job was created.
 */
export class IntakeStage implements IBlogStage {
  readonly stageName = "intake";

  async run(job: Job): Promise<IntakeOutput> {
    const { request } = job;

    logger.info("Running intake stage", {
      jobId: job.id,
      source: request.rawSource.channel,
      sourceId: request.rawSource.sourceId,
      missingFields: request.missingFields,
    });

    if (request.missingFields.length > 0) {
      logger.warn("Blog request has missing fields — proceeding with defaults", {
        jobId: job.id,
        missingFields: request.missingFields,
      });
    }

    const rawText = [
      `Title: ${request.title || "(no title)"}`,
      `Brief: ${request.brief || "(no brief)"}`,
      `Audience: ${request.audience || "(no audience)"}`,
      `Keyword: ${request.targetKeyword || "(no keyword)"}`,
      `CTA: ${request.cta || "(no CTA)"}`,
      request.dueDate ? `Due: ${request.dueDate}` : null,
      request.approver ? `Approver: ${request.approver}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      sourceId: request.rawSource.sourceId,
      rawText,
    };
  }
}
