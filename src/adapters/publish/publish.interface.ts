import { Job } from "../../models/job.model";

/**
 * Publishing adapter interface — not implemented in v1.
 *
 * Future adapters (WordPress, Webflow, HubSpot, etc.) will implement this
 * interface so the orchestrator can hand off an approved draft without
 * changes to the workflow or orchestrator layers.
 */
export interface IPublishAdapter {
  readonly name: string;
  readonly platform: string;

  /**
   * Publish the approved draft from the given job.
   * Must only be called after job.approval.approved === true.
   *
   * @returns The canonical URL of the published content.
   */
  publish(job: Job): Promise<PublishResult>;
}

export interface PublishResult {
  platform: string;
  url?: string;
  externalId?: string;
  publishedAt: string;
}
