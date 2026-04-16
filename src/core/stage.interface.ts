import { Job } from "../models/job.model";

/**
 * Generic stage interface used by the orchestrator.
 *
 * Any workflow — blog, social, email, etc. — implements IStage for each of
 * its steps. The orchestrator is completely agnostic to what a stage does;
 * it only calls `run(job)` and stores the returned output on the stage record.
 */
export interface IStage {
  /** Must match the stage name string used in the WorkflowDefinition. */
  readonly stageName: string;

  /**
   * Execute the stage.
   * @param job  Current job, including all prior stage outputs.
   * @returns    Structured output stored on the stage record for downstream use.
   */
  run(job: Job): Promise<unknown>;
}

/**
 * Retrieve the typed output of a previously completed stage.
 * Throws if the stage has not yet completed successfully.
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
 * Retrieve the typed output of a stage if available, or return undefined.
 * Use this for optional upstream dependencies.
 */
export function getStageOutput<T>(job: Job, stageName: string): T | undefined {
  const stage = job.stages.find((s) => s.name === stageName);
  if (stage?.status === "completed") return stage.output as T;
  return undefined;
}
