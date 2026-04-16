import { IBlogStage, requireStageOutput } from "./stage.interface";
import { Job } from "../../../models/job.model";
import { DraftOutput, EditorialOutput } from "../../../models/output.model";
import { claudeJSON } from "../../../core/claude-client";
import { buildEditorialPrompt } from "../prompts/editorial.prompt";
import { logger } from "../../../core/logger";

/**
 * Stage 6 — Editorial Pass
 *
 * Uses Claude to review and refine the first draft for clarity, flow,
 * SEO keyword placement, and CTA strength.
 *
 * ✏️  Tune this stage:  src/workflows/blog/prompts/editorial.md
 */
export class EditorialStage implements IBlogStage {
  readonly stageName = "editorial";

  async run(job: Job): Promise<EditorialOutput> {
    logger.info("Running editorial stage", { jobId: job.id });

    const draft = requireStageOutput<DraftOutput>(job, "drafting");
    const { systemPrompt, userPrompt } = buildEditorialPrompt(job.request, draft);

    const result = await claudeJSON<EditorialOutput>(systemPrompt, userPrompt, job.id);

    logger.info("Editorial stage complete", {
      jobId: job.id,
      wordCount: result.wordCount,
      editSummary: result.editSummary?.slice(0, 100),
    });

    return result;
  }
}
