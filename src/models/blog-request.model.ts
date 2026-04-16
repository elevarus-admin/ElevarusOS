/**
 * Normalized blog content request — the standard internal format produced
 * by every intake adapter regardless of the source system.
 */
export interface BlogRequest {
  /** Human-readable title / working headline */
  title: string;

  /** Short description of the content goal and angle */
  brief: string;

  /** Target audience description */
  audience: string;

  /** Primary SEO keyword or phrase to optimize for */
  targetKeyword: string;

  /** Desired call-to-action */
  cta: string;

  /** ISO 8601 date string of the publication or delivery deadline, if known */
  dueDate?: string;

  /** Name or email of the person responsible for approving the draft */
  approver?: string;

  /** Raw source payload preserved for debugging and traceability */
  rawSource: RawSource;

  /** Fields that were missing from the source and need follow-up */
  missingFields: Array<keyof Omit<BlogRequest, "rawSource" | "missingFields" | "workflowType">>;

  /**
   * Which registered bot instance should handle this request.
   * Set by the intake adapter at construction time (e.g. "elevarus-blog", "nes-blog").
   * Defaults to "blog" in the orchestrator if not supplied.
   */
  workflowType?: string;
}

export type SourceChannel = "clickup" | "email" | "manual";

export interface RawSource {
  channel: SourceChannel;
  /** Original system identifier (ClickUp task ID, email message ID, etc.) */
  sourceId?: string;
  /** ISO 8601 received timestamp */
  receivedAt: string;
  /** Raw payload for traceability */
  payload: unknown;
}
