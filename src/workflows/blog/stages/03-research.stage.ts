import { IBlogStage } from "./stage.interface";
import { Job } from "../../../models/job.model";
import { ResearchOutput } from "../../../models/output.model";
import { claudeJSON } from "../../../core/claude-client";
import { buildResearchPrompt } from "../prompts/research.prompt";
import { logger } from "../../../core/logger";

/**
 * Stage 3 — Research
 *
 * Uses Claude to generate a first-pass research package:
 * topic framing, subtopics, questions to answer, source suggestions,
 * and keyword notes.
 */
export class ResearchStage implements IBlogStage {
  readonly stageName = "research";

  async run(job: Job): Promise<ResearchOutput> {
    logger.info("Running research stage", { jobId: job.id });

    const userPrompt = buildResearchPrompt(job.request);

    const result = await claudeJSON<ResearchOutput>(
      "You are an expert content strategist. Return only valid JSON.",
      userPrompt,
      job.id
    );

    logger.info("Research stage complete", {
      jobId: job.id,
      subtopicCount: result.subtopics?.length ?? 0,
      questionCount: result.questionsToAnswer?.length ?? 0,
    });

    return result;
  }
}
