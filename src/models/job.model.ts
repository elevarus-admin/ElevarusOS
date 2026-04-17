import { BlogRequest } from "./blog-request.model";

// ─── Job status ───────────────────────────────────────────────────────────────

export type JobStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "approved"
  | "failed"
  | "completed";

// ─── Stage status ─────────────────────────────────────────────────────────────

export type StageStatus = "pending" | "running" | "completed" | "failed" | "skipped";

/**
 * One record per stage in a job. `name` is a plain string matching the
 * stageName declared on the corresponding IStage implementation — it is
 * workflow-agnostic and not restricted to blog stage names.
 */
export interface StageRecord {
  name: string;
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
  attempts: number;
  error?: string;
  /** Stage-specific structured output, stored for use by downstream stages */
  output?: unknown;
}

// ─── Job ──────────────────────────────────────────────────────────────────────

/**
 * A Job represents one unit of orchestrated work — e.g. a single blog post
 * through the full blog workflow, or a social post through a different workflow.
 *
 * `workflowType` is a plain string that matches a WorkflowDefinition.type in
 * the WorkflowRegistry — this is what makes the orchestrator multi-bot capable.
 *
 * NOTE: `request` is typed as BlogRequest today because it is the only
 * workflow currently implemented. When additional workflow types are added,
 * this should become a discriminated union or a generic `WorkflowRequest`
 * base type.
 */
export interface Job {
  id: string;
  /** Matches WorkflowDefinition.type in the WorkflowRegistry */
  workflowType: string;
  status: JobStatus;
  request: BlogRequest;
  stages: StageRecord[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;

  /** Approval state — blocked until explicitly set */
  approval: ApprovalState;

  /** Publish handoff record (populated by the publish_placeholder stage) */
  publishRecord?: PublishRecord;

  /** Mission Control task ID — set by the bridge after task creation */
  mcTaskId?: number;
}

export interface ApprovalState {
  required: true;
  approved: boolean;
  approvedBy?: string;
  approvedAt?: string;
  notes?: string;
}

export interface PublishRecord {
  /** Placeholder — real publish adapters will extend this */
  status: "pending" | "published";
  targetPlatform?: string;
  handoffData?: unknown;
  createdAt: string;
}
