import { IJobStore } from "./job-store";
import { Job, JobStatus, StageRecord, ApprovalState, PublishRecord } from "../models/job.model";
import { BlogRequest } from "../models/blog-request.model";
import { getSupabaseClient } from "./supabase-client";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// DB row shape (mirrors the jobs table columns)
// ---------------------------------------------------------------------------

interface JobRow {
  id: string;
  workflow_type: string;
  status: string;
  request: Record<string, unknown>;
  stages: Record<string, unknown>[];
  approval: Record<string, unknown>;
  publish_record: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  mc_task_id: number | null;
}

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export class SupabaseJobStore implements IJobStore {
  // ── IJobStore ─────────────────────────────────────────────────────────────

  async save(job: Job): Promise<void> {
    const { error } = await getSupabaseClient()
      .from("jobs")
      .upsert(toRow(job), { onConflict: "id" });

    if (error) {
      logger.error("Supabase: job save failed", { jobId: job.id, error: error.message });
      throw new Error(`Supabase save failed: ${error.message}`);
    }

    logger.debug("Supabase: job saved", { jobId: job.id, status: job.status });
  }

  async get(id: string): Promise<Job | undefined> {
    const { data, error } = await getSupabaseClient()
      .from("jobs")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      logger.error("Supabase: job fetch failed", { jobId: id, error: error.message });
      throw new Error(`Supabase get failed: ${error.message}`);
    }

    return data ? fromRow(data as JobRow) : undefined;
  }

  async list(): Promise<Job[]> {
    const { data, error } = await getSupabaseClient()
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      logger.error("Supabase: job list failed", { error: error.message });
      throw new Error(`Supabase list failed: ${error.message}`);
    }

    return (data as JobRow[] ?? []).map(fromRow);
  }
}

// ---------------------------------------------------------------------------
// Row ↔ Job mapping
// ---------------------------------------------------------------------------

function toRow(job: Job): Omit<JobRow, never> {
  return {
    id:             job.id,
    workflow_type:  job.workflowType,
    status:         job.status,
    request:        job.request as unknown as Record<string, unknown>,
    stages:         job.stages as unknown as Record<string, unknown>[],
    approval:       job.approval as unknown as Record<string, unknown>,
    publish_record: job.publishRecord as unknown as Record<string, unknown> | null ?? null,
    error:          job.error ?? null,
    created_at:     job.createdAt,
    updated_at:     job.updatedAt,
    completed_at:   job.completedAt ?? null,
    mc_task_id:     job.mcTaskId ?? null,
  };
}

function fromRow(row: JobRow): Job {
  return {
    id:            row.id,
    workflowType:  row.workflow_type,
    status:        row.status as JobStatus,
    request:       row.request as unknown as BlogRequest,
    stages:        row.stages as unknown as StageRecord[],
    approval:      row.approval as unknown as ApprovalState,
    publishRecord: row.publish_record as unknown as PublishRecord | undefined,
    error:         row.error ?? undefined,
    createdAt:     row.created_at,
    updatedAt:     row.updated_at,
    completedAt:   row.completed_at ?? undefined,
    mcTaskId:      row.mc_task_id ?? undefined,
  };
}
