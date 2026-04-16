import { IBlogStage, requireStageOutput } from "./stage.interface";
import { Job } from "../../../models/job.model";
import { ResearchOutput, OutlineOutput, DraftOutput } from "../../../models/output.model";
import { claudeJSON } from "../../../core/claude-client";
import { buildDraftPrompt } from "../prompts/draft.prompt";
import { logger } from "../../../core/logger";

/**
 * Stage 5 — Drafting
 *
 * Uses Claude to write a complete first-draft blog post from the outline
 * and research produced in previous stages.
 */
export class DraftingStage implements IBlogStage {
  readonly stageName = "drafting";

  async run(job: Job): Promise<DraftOutput> {
    logger.info("Running drafting stage", { jobId: job.id });

    const research = requireStageOutput<ResearchOutput>(job, "research");
    const outline = requireStageOutput<OutlineOutput>(job, "outline");

    const userPrompt = buildDraftPrompt(job.request, research, outline);

    const result = await claudeJSON<DraftOutput>(
      "You are a professional blog writer. Return only valid JSON.",
      userPrompt,
      job.id
    );

    logger.info("Drafting stage complete", {
      jobId: job.id,
      wordCount: result.wordCount,
      titlePreview: result.title?.slice(0, 60),
    });

    return result;
  }
}
