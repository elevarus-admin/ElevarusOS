import { IBlogStage, getStageOutput } from "./stage.interface";
import { Job } from "../../../models/job.model";
import { CompletionOutput, EditorialOutput } from "../../../models/output.model";
import { INotifyAdapter } from "../../../adapters/notify/notify.interface";
import { logger } from "../../../core/logger";

/**
 * Stage 9 — Completion
 *
 * Marks the workflow as done, generates a human-readable summary, and
 * sends final completion notifications.
 */
export class CompletionStage implements IBlogStage {
  readonly stageName = "completion";

  constructor(private readonly notifiers: INotifyAdapter[]) {}

  async run(job: Job): Promise<CompletionOutput> {
    logger.info("Running completion stage", { jobId: job.id });

    const editorial = getStageOutput<EditorialOutput>(job, "editorial");

    const summary = [
      `Blog workflow completed for job ${job.id}.`,
      `Title: ${editorial?.title ?? job.request.title}`,
      `Word count: ${editorial?.wordCount ?? "—"}`,
      `Keyword: ${job.request.targetKeyword}`,
      `Approval status: ${job.approval.approved ? "Approved" : "Pending"}`,
    ].join("\n");

    const completedAt = new Date().toISOString();

    await Promise.allSettled(
      this.notifiers.map((n) => n.sendCompletion(job))
    );

    logger.info("Workflow completion notifications dispatched", {
      jobId: job.id,
      completedAt,
    });

    return { summary, completedAt };
  }
}
