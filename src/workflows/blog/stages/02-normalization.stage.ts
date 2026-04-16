import { IBlogStage, requireStageOutput } from "./stage.interface";
import { Job } from "../../../models/job.model";
import { IntakeOutput, NormalizationOutput } from "../../../models/output.model";
import { logger } from "../../../core/logger";

const REQUIRED_FIELDS: Array<keyof IntakeOutput> = [];

const ALL_REQUEST_FIELDS = [
  "title",
  "brief",
  "audience",
  "targetKeyword",
  "cta",
] as const;

/**
 * Stage 2 — Normalization
 *
 * Confirms which required fields are present and records the state for
 * downstream stages. In future iterations, this stage could use Claude to
 * infer missing values from the raw text before flagging them.
 *
 * TODO: Use Claude to attempt field inference when values are missing
 *       (e.g., derive "audience" from the brief, or "cta" from context).
 */
export class NormalizationStage implements IBlogStage {
  readonly stageName = "normalization";

  async run(job: Job): Promise<NormalizationOutput> {
    requireStageOutput<IntakeOutput>(job, "intake");

    const { request } = job;

    const fieldValues: Record<string, string> = {
      title: request.title,
      brief: request.brief,
      audience: request.audience,
      targetKeyword: request.targetKeyword,
      cta: request.cta,
    };

    const filledFields = ALL_REQUEST_FIELDS.filter(
      (f) => !!fieldValues[f]
    ) as string[];

    const missingFields = ALL_REQUEST_FIELDS.filter(
      (f) => !fieldValues[f]
    ) as string[];

    const isComplete = missingFields.length === 0;

    logger.info("Normalization complete", {
      jobId: job.id,
      isComplete,
      filledFields,
      missingFields,
    });

    if (!isComplete) {
      logger.warn(
        "Proceeding with incomplete request — downstream stages will use available fields",
        { jobId: job.id, missingFields }
      );
    }

    return { isComplete, filledFields, missingFields };
  }
}
