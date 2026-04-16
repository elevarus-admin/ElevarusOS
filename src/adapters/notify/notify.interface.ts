import { Job } from "../../models/job.model";

/**
 * Every notification channel implements this interface so the orchestrator
 * can fan-out messages without knowing the underlying platform.
 */
export interface INotifyAdapter {
  readonly name: string;

  /** Notify that a new blog workflow job has started */
  sendJobStarted(job: Job): Promise<void>;

  /** Notify that a draft is ready and approval is requested */
  sendApprovalRequest(job: Job): Promise<void>;

  /** Notify that a workflow stage or overall job has failed */
  sendFailure(job: Job, error: string): Promise<void>;

  /** Notify that the job completed successfully */
  sendCompletion(job: Job): Promise<void>;
}
