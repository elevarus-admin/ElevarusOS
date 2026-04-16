import { Job } from "../../../models/job.model";

/**
 * Each workflow stage implements this interface.
 * The orchestrator calls run() and stores the returned output on the job's
 * stage record so downstream stages can access it.
 */
export interface IBlogStage {
  /** Must match the BlogStageName enum value */
  readonly stageName: string;

  /**
   * Execute the stage.
   * @param job  The current job, including all prior stage outputs.
   * @returns    Structured output that is stored on the stage record.
   */
  run(job: Job): Promise<unknown>;
}

/**
 * Helper: retrieve the typed output of a previously completed stage.
 * Throws if the stage hasn't completed successfully.
 */
export function requireStageOutput<T>(job: Job, stageName: string): T {
  const stage = job.stages.find((s) => s.name === stageName);
  if (!stage || stage.status !== "completed") {
    throw new Error(
      `Stage "${stageName}" output is required but not yet available ` +
        `(current status: ${stage?.status ?? "not found"})`
    );
  }
  return stage.output as T;
}

/**
 * Helper: retrieve the typed output of a stage if it exists, or return
 * undefined — useful for optional upstream outputs.
 */
export function getStageOutput<T>(job: Job, stageName: string): T | undefined {
  const stage = job.stages.find((s) => s.name === stageName);
  if (stage?.status === "completed") return stage.output as T;
  return undefined;
}
