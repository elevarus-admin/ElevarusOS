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

export const BLOG_STAGES = [
  "intake",
  "normalization",
  "research",
  "outline",
  "drafting",
  "editorial",
  "approval_notify",
  "publish_placeholder",
  "completion",
] as const;

export type BlogStageName = (typeof BLOG_STAGES)[number];

export interface StageRecord {
  name: BlogStageName;
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
  attempts: number;
  error?: string;
  /** Stage-specific structured output, stored for use by downstream stages */
  output?: unknown;
}

// ─── Job ──────────────────────────────────────────────────────────────────────

export interface Job {
  id: string;
  workflowType: "blog";
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
