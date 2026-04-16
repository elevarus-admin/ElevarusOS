import { IBlogStage, requireStageOutput } from "./stage.interface";
import { Job } from "../../../models/job.model";
import { ResearchOutput, OutlineOutput } from "../../../models/output.model";
import { claudeJSON } from "../../../core/claude-client";
import { buildOutlinePrompt } from "../prompts/outline.prompt";
import { logger } from "../../../core/logger";

/**
 * Stage 4 — Outline
 *
 * Uses Claude to generate a structured content outline based on the
 * research package produced in stage 3.
 */
export class OutlineStage implements IBlogStage {
  readonly stageName = "outline";

  async run(job: Job): Promise<OutlineOutput> {
    logger.info("Running outline stage", { jobId: job.id });

    const research = requireStageOutput<ResearchOutput>(job, "research");
    const userPrompt = buildOutlinePrompt(job.request, research);

    const result = await claudeJSON<OutlineOutput>(
      "You are an expert content strategist. Return only valid JSON.",
      userPrompt,
      job.id
    );

    logger.info("Outline stage complete", {
      jobId: job.id,
      sectionCount: result.sections?.length ?? 0,
      estimatedWordCount: result.estimatedWordCount,
    });

    return result;
  }
}
