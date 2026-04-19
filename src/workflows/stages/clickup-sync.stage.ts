import { IStage, getStageOutput } from "../../core/stage.interface";
import { Job } from "../../models/job.model";
import { loadInstanceConfig } from "../../core/instance-config";
import { ClickUpHttpClient } from "../../integrations/clickup";
import { logger } from "../../core/logger";

/**
 * Stage: `clickup-sync`
 *
 * Opt-in terminal stage. Posts a wrap-up comment + status update to the
 * ClickUp task that originated this job. Self-guarding — no-ops cleanly when:
 *
 *   - `job.metadata.clickupTaskId` is missing (the job didn't come from ClickUp)
 *   - The instance has no `clickup` config block (instance hasn't opted in)
 *   - `instance.clickup.syncEnabled` is false (per-instance kill switch)
 *   - ClickUp env vars aren't configured
 *
 * Workflows include this stage unconditionally; the cost of running it on a
 * non-ClickUp job is one config read.
 *
 * Comment body (per docs/prd-clickup-integration.md OQ-06):
 *   - summary.oneLiner   (if available)
 *   - first ~1.5k chars of summary.markdownReport (truncated)
 *   - link back to the source so users can see the full output
 *
 * Failure handling: this stage only runs on the success path. If an upstream
 * stage threw, the orchestrator marks the job failed and skips remaining
 * stages — including this one. A future failure-comment hook would live in
 * the orchestrator, not here.
 */

const COMMENT_BODY_CAP = 1500;

interface ClickUpSyncOutput {
  /** True when something was posted to ClickUp. False = self-guarded no-op. */
  posted:        boolean;
  /** Human-readable reason if `posted: false`. */
  reason?:       string;
  clickupTaskId?: string;
  commentId?:    string | null;
  statusSet?:    string | null;
}

interface SummaryShape {
  oneLiner?:       string;
  slackMessage?:   string;
  markdownReport?: string;
  alertLevel?:     "green" | "yellow" | "red";
}

interface EditorialShape {
  editedDraft?: string;
  draft?:       string;
  content?:     string;
}

export class ClickUpSyncStage implements IStage {
  readonly stageName = "clickup-sync";

  async run(job: Job): Promise<ClickUpSyncOutput> {
    // ── Guard 1: job has a ClickUp source task ────────────────────────────────
    const clickupTaskId = (job.metadata?.clickupTaskId as string | undefined) ?? undefined;
    if (!clickupTaskId) {
      return { posted: false, reason: "job has no metadata.clickupTaskId" };
    }

    // ── Guard 2: instance has opted in ─────────────────────────────────────────
    let cfg;
    try {
      cfg = loadInstanceConfig(job.workflowType);
    } catch (err) {
      logger.warn("clickup-sync: instance config unreadable — skipping", { jobId: job.id, error: String(err) });
      return { posted: false, reason: "instance config unreadable" };
    }
    if (!cfg.clickup) {
      return { posted: false, reason: "instance has no clickup config" };
    }
    if (!cfg.clickup.syncEnabled) {
      return { posted: false, reason: "instance.clickup.syncEnabled is false" };
    }

    // ── Guard 3: client is configured ──────────────────────────────────────────
    const client = new ClickUpHttpClient();
    if (!client.enabled) {
      logger.warn("clickup-sync: ClickUp client not configured — skipping", { jobId: job.id });
      return { posted: false, reason: "ClickUp not configured (CLICKUP_API_TOKEN/CLICKUP_TEAM_ID)" };
    }

    // ── Build the comment body ─────────────────────────────────────────────────
    const body = buildCommentBody(job);

    // ── Post comment + update status (best-effort, both logged on failure) ─────
    const comment = await client.addComment(clickupTaskId, {
      commentText: body,
      notifyAll:   false,
    });
    if (!comment) {
      logger.warn("clickup-sync: addComment returned null", { jobId: job.id, clickupTaskId });
    }

    const targetStatus = cfg.clickup.statusMap.completed;
    const updated = await client.updateTaskStatus(clickupTaskId, targetStatus);
    if (!updated) {
      logger.warn("clickup-sync: updateTaskStatus returned null", {
        jobId: job.id, clickupTaskId, targetStatus,
        hint:  "Most common cause: status string doesn't match the list's workflow exactly (case-sensitive).",
      });
    }

    logger.info("clickup-sync: posted", {
      jobId:         job.id,
      clickupTaskId,
      commentPosted: Boolean(comment),
      statusUpdated: Boolean(updated),
      targetStatus,
    });

    return {
      posted:        Boolean(comment) || Boolean(updated),
      clickupTaskId,
      commentId:     comment?.id ?? null,
      statusSet:     updated ? targetStatus : null,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the wrap-up comment body. Prefers reporting workflows' `summary`
 * stage shape, falls back to blog workflows' `editorial` stage shape, falls
 * back to a generic "job complete" stub.
 */
function buildCommentBody(job: Job): string {
  const summary   = getStageOutput<SummaryShape>(job, "summary");
  const editorial = getStageOutput<EditorialShape>(job, "editorial");

  const lines: string[] = ["**ElevarusOS — Job complete**", ""];

  if (summary?.oneLiner) {
    lines.push(`> ${summary.oneLiner}`, "");
  }

  if (summary?.alertLevel) {
    const emoji = summary.alertLevel === "green"  ? "✅"
                : summary.alertLevel === "yellow" ? "⚠️"
                                                  : "🚨";
    lines.push(`${emoji} Alert level: **${summary.alertLevel}**`, "");
  }

  let body: string | undefined;
  if (summary?.markdownReport) body = summary.markdownReport;
  else if (summary?.slackMessage) body = summary.slackMessage;
  else if (editorial?.editedDraft) body = editorial.editedDraft;
  else if (editorial?.draft) body = editorial.draft;
  else if (editorial?.content) body = editorial.content;

  if (body) {
    const truncated = body.length > COMMENT_BODY_CAP;
    lines.push(truncated ? body.slice(0, COMMENT_BODY_CAP) + "…" : body);
    if (truncated) {
      lines.push("", `_(Truncated at ${COMMENT_BODY_CAP} chars — see ElevarusOS job \`${job.id}\` for the full output.)_`);
    }
  } else {
    lines.push(`Job \`${job.id}\` (${job.workflowType}) finished without a summary stage to render.`);
  }

  lines.push("", `_Job: \`${job.id}\` · Workflow: \`${job.workflowType}\`_`);
  return lines.join("\n");
}
