import { IIntakeAdapter } from "./intake.interface";
import { BlogRequest, RawSource } from "../../models/blog-request.model";
import { config } from "../../config";
import { logger } from "../../core/logger";

/**
 * Reads new blog content requests from a designated ClickUp list.
 *
 * Integration points:
 * - Uses the ClickUp REST API v2 (https://clickup.com/api)
 * - Requires CLICKUP_API_TOKEN and CLICKUP_LIST_ID in env
 *
 * TODO: Implement deduplication — track processed task IDs (e.g. via a local
 *       set or persisted store) so a task is not enqueued twice on re-poll.
 * TODO: Add webhook support as an alternative to polling when the ClickUp
 *       list grows and latency becomes important.
 */
export class ClickUpIntakeAdapter implements IIntakeAdapter {
  readonly name = "clickup";

  async fetchPending(): Promise<BlogRequest[]> {
    if (!config.clickup.apiToken || !config.clickup.listId) {
      logger.warn("ClickUp adapter is not configured — skipping", {
        adapter: this.name,
      });
      return [];
    }

    logger.info("Polling ClickUp for pending blog requests", {
      listId: config.clickup.listId,
    });

    const tasks = await this.fetchTasksFromClickUp();
    return tasks.map((task) => this.normalizeTask(task));
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async fetchTasksFromClickUp(): Promise<ClickUpTask[]> {
    // TODO: Implement real HTTP call to ClickUp API
    // Example endpoint:
    //   GET https://api.clickup.com/api/v2/list/{listId}/task
    //   Headers: { Authorization: config.clickup.apiToken }
    //   Query params: { statuses: ["Open"], custom_fields: true }
    //
    // Replace the stub below with actual fetch/axios call once credentials
    // and list structure are confirmed.
    logger.debug("ClickUp API call stubbed — returning empty task list", {
      adapter: this.name,
    });
    return [];
  }

  private normalizeTask(task: ClickUpTask): BlogRequest {
    const cf = task.custom_fields ?? {};

    const raw: RawSource = {
      channel: "clickup",
      sourceId: task.id,
      receivedAt: new Date().toISOString(),
      payload: task,
    };

    const title = task.name ?? "";
    const brief = cf["brief"] ?? task.description ?? "";
    const audience = cf["audience"] ?? "";
    const targetKeyword = cf["target_keyword"] ?? "";
    const cta = cf["cta"] ?? "";
    const dueDate = task.due_date
      ? new Date(parseInt(task.due_date)).toISOString()
      : undefined;
    const approver = cf["approver"] ?? task.assignees?.[0]?.email ?? undefined;

    const missingFields = this.detectMissing({
      title,
      brief,
      audience,
      targetKeyword,
      cta,
    });

    return {
      title,
      brief,
      audience,
      targetKeyword,
      cta,
      dueDate,
      approver,
      rawSource: raw,
      missingFields,
    };
  }

  private detectMissing(
    fields: Record<string, string>
  ): Array<keyof Omit<BlogRequest, "rawSource" | "missingFields">> {
    return Object.entries(fields)
      .filter(([, v]) => !v)
      .map(([k]) => k as keyof Omit<BlogRequest, "rawSource" | "missingFields">);
  }
}

// ─── ClickUp API shape (minimal) ─────────────────────────────────────────────

interface ClickUpTask {
  id: string;
  name: string;
  description?: string;
  status?: { status: string };
  due_date?: string;
  assignees?: Array<{ email?: string }>;
  custom_fields?: Record<string, string>;
}
