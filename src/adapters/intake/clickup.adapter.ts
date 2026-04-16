import * as fs from "fs";
import * as path from "path";
import { IIntakeAdapter } from "./intake.interface";
import { BlogRequest, RawSource } from "../../models/blog-request.model";
import { config } from "../../config";
import { logger } from "../../core/logger";

const CLICKUP_API_BASE = "https://api.clickup.com/api/v2";

/**
 * Reads new blog content requests from a designated ClickUp list.
 *
 * Auth:       Personal API token via Authorization header
 * Endpoint:   GET /list/{listId}/task
 * Dedup:      Processed task IDs are persisted to data/clickup-processed.json
 *             so re-polling never re-enqueues a task.
 */
export class ClickUpIntakeAdapter implements IIntakeAdapter {
  readonly name = "clickup";

  private readonly dedupFile = path.resolve(
    config.orchestrator.jobStorePath,
    "../clickup-processed.json"
  );

  async fetchPending(): Promise<BlogRequest[]> {
    if (!this.isConfigured()) {
      logger.warn("ClickUp adapter is not configured — skipping", {
        adapter: this.name,
      });
      return [];
    }

    logger.info("Polling ClickUp for pending blog requests", {
      listId: config.clickup.listId,
    });

    const processed = this.loadProcessed();
    const tasks = await this.fetchTasksFromClickUp();
    const newTasks = tasks.filter((t) => !processed.has(t.id));

    if (newTasks.length === 0) {
      logger.info("No new ClickUp tasks found", { adapter: this.name });
      return [];
    }

    logger.info(`Found ${newTasks.length} new ClickUp task(s)`, {
      adapter: this.name,
    });

    const requests = newTasks.map((t) => this.normalizeTask(t));

    // Mark as processed only after successful normalization
    newTasks.forEach((t) => processed.add(t.id));
    this.saveProcessed(processed);

    return requests;
  }

  // ─── API call ─────────────────────────────────────────────────────────────

  private async fetchTasksFromClickUp(): Promise<ClickUpTask[]> {
    const url = new URL(
      `${CLICKUP_API_BASE}/list/${config.clickup.listId}/task`
    );
    url.searchParams.set("statuses[]", "Open");
    url.searchParams.set("include_closed", "false");
    url.searchParams.set("custom_fields", "true");

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: config.clickup.apiToken,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `ClickUp API error (${res.status}): ${text.slice(0, 300)}`
      );
    }

    const data = (await res.json()) as { tasks: ClickUpTask[] };
    return data.tasks ?? [];
  }

  // ─── Normalization ────────────────────────────────────────────────────────

  private normalizeTask(task: ClickUpTask): BlogRequest {
    const cf = this.customFieldMap(task.custom_fields ?? []);

    const raw: RawSource = {
      channel: "clickup",
      sourceId: task.id,
      receivedAt: new Date().toISOString(),
      payload: task,
    };

    const title = task.name ?? "";
    const brief = cf["brief"] ?? cf["description"] ?? task.description ?? "";
    const audience = cf["audience"] ?? "";
    const targetKeyword = cf["target_keyword"] ?? cf["keyword"] ?? "";
    const cta = cf["cta"] ?? "";
    const dueDate = task.due_date
      ? new Date(parseInt(task.due_date, 10)).toISOString()
      : undefined;
    const approver =
      cf["approver"] ?? task.assignees?.[0]?.email ?? undefined;

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

  /** Build a name→value map from the ClickUp custom_fields array */
  private customFieldMap(
    fields: ClickUpCustomField[]
  ): Record<string, string> {
    const map: Record<string, string> = {};
    for (const f of fields) {
      if (f.value !== undefined && f.value !== null) {
        map[f.name.toLowerCase().replace(/\s+/g, "_")] = String(f.value);
      }
    }
    return map;
  }

  // ─── Deduplication ────────────────────────────────────────────────────────

  private loadProcessed(): Set<string> {
    try {
      const raw = fs.readFileSync(this.dedupFile, "utf8");
      return new Set(JSON.parse(raw) as string[]);
    } catch {
      return new Set();
    }
  }

  private saveProcessed(ids: Set<string>): void {
    try {
      fs.mkdirSync(path.dirname(this.dedupFile), { recursive: true });
      fs.writeFileSync(
        this.dedupFile,
        JSON.stringify([...ids], null, 2),
        "utf8"
      );
    } catch (err) {
      logger.warn("Could not persist ClickUp dedup file", { error: String(err) });
    }
  }

  // ─── Config check ─────────────────────────────────────────────────────────

  private isConfigured(): boolean {
    const { apiToken, listId } = config.clickup;
    // Reject obvious placeholder values
    if (!apiToken || apiToken === "pk_..." || !listId) return false;
    // ClickUp personal tokens follow pk_<digits>_<alphanum>
    return /^pk_\d+_.+/.test(apiToken);
  }

  private detectMissing(
    fields: Record<string, string>
  ): Array<keyof Omit<BlogRequest, "rawSource" | "missingFields" | "workflowType">> {
    return Object.entries(fields)
      .filter(([, v]) => !v)
      .map(([k]) => k as keyof Omit<BlogRequest, "rawSource" | "missingFields" | "workflowType">);
  }
}

// ─── ClickUp API shapes ───────────────────────────────────────────────────────

interface ClickUpCustomField {
  id: string;
  name: string;
  type: string;
  value?: string | number | null;
}

interface ClickUpTask {
  id: string;
  name: string;
  description?: string;
  status?: { status: string };
  due_date?: string;
  assignees?: Array<{ email?: string }>;
  custom_fields?: ClickUpCustomField[];
}
