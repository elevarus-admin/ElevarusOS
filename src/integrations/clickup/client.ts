import { logger } from "../../core/logger";
import type {
  ClickUpTask,
  ClickUpComment,
} from "./types";

/**
 * Low-level ClickUp REST API v2 client.
 *
 * Auth:   Authorization: {token}      (raw — no "Bearer" prefix; ClickUp personal tokens)
 * Base:   https://api.clickup.com/api/v2
 *
 * Mirrors the RingbaHttpClient shape: `enabled` set from env at construction
 * time, `null` returned (not thrown) on failure, retry+backoff on 429/5xx.
 *
 * Read-only surface in Phase 1. Write methods (createTask, updateTask, addComment)
 * land in Phase 2 alongside Slack write tools.
 *
 * Env vars:
 *   CLICKUP_API_TOKEN    — Personal API token. Settings → Apps in ClickUp.
 *   CLICKUP_TEAM_ID      — Workspace team ID. Required for /team/{teamId}/* endpoints.
 */

const BASE_URL = "https://api.clickup.com/api/v2";

export interface ClickUpListTasksOptions {
  /** Status names — e.g. ["Open", "In Progress"]. */
  statuses?:      string[];
  /** ClickUp user IDs (string form). */
  assignees?:     string[];
  /** Include closed tasks. Defaults to false. */
  includeClosed?: boolean;
  /** Filter by due_date — ms epoch. */
  dueDateGt?:     number;
  dueDateLt?:     number;
  /** Page index (0-based). ClickUp pages at 100 per request. */
  page?:          number;
  /** Order: "created" | "updated" | "due_date". */
  orderBy?:       "created" | "updated" | "due_date";
  /** Reverse the ordering. */
  reverse?:       boolean;
}

export interface ClickUpFindTasksOptions {
  /** ClickUp user IDs (string form). */
  assignees?:     string[];
  statuses?:      string[];
  /** Restrict to specific list IDs. Empty = whole team. */
  listIds?:       string[];
  spaceIds?:      string[];
  includeClosed?: boolean;
  /** Filter by due_date — ms epoch. */
  dueDateGt?:     number;
  dueDateLt?:     number;
  /** Optional tag-name filter. */
  tags?:          string[];
  /** Page index (0-based). */
  page?:          number;
  orderBy?:       "created" | "updated" | "due_date";
  reverse?:       boolean;
}

// ─── Write payloads ───────────────────────────────────────────────────────────

export interface ClickUpTaskCreate {
  name:          string;
  description?:  string;
  /** ClickUp user IDs (numeric, but accepted as numbers in the payload). */
  assignees?:    number[];
  status?:       string;
  /** Unix ms epoch. */
  dueDate?:      number;
  dueDateTime?:  boolean;
  /** Unix ms epoch. */
  startDate?:    number;
  startDateTime?: boolean;
  priority?:     1 | 2 | 3 | 4 | null;   // 1=urgent, 2=high, 3=normal, 4=low
  tags?:         string[];
  parent?:       string;
  /** Free-form custom fields — ClickUp validates server-side. */
  customFields?: Array<{ id: string; value: unknown }>;
}

export interface ClickUpTaskUpdate {
  name?:        string;
  description?: string;
  status?:      string;
  dueDate?:     number | null;
  dueDateTime?: boolean;
  priority?:    1 | 2 | 3 | 4 | null;
  /**
   * Assignees use ClickUp's add/rem semantics on update — not a replacement set.
   * Pass user IDs to add and/or remove independently.
   */
  assignees?: {
    add?: number[];
    rem?: number[];
  };
}

export interface ClickUpCommentCreate {
  commentText: string;
  /** ClickUp user ID to attach the comment to (optional). */
  assignee?:   number;
  notifyAll?:  boolean;
}

export class ClickUpHttpClient {
  readonly enabled: boolean;
  readonly teamId:  string;
  private readonly token: string;

  constructor() {
    this.token  = process.env.CLICKUP_API_TOKEN ?? "";
    this.teamId = process.env.CLICKUP_TEAM_ID   ?? "";
    this.enabled = Boolean(this.token && this.teamId);

    if (!this.enabled) {
      logger.info("ClickUpHttpClient: not configured (set CLICKUP_API_TOKEN + CLICKUP_TEAM_ID)");
    }
  }

  // ─── Read methods (Phase 1) ─────────────────────────────────────────────────

  /**
   * Tasks in a single list.
   *
   * GET /list/{listId}/task
   * https://clickup.com/api/clickupreference/operation/GetTasks/
   *
   * Pagination: 100 tasks per page. Caller handles paging via `page`.
   */
  async listTasks(listId: string, opts: ClickUpListTasksOptions = {}): Promise<ClickUpTask[]> {
    const qs = new URLSearchParams();
    qs.set("include_closed", String(opts.includeClosed ?? false));
    qs.set("subtasks", "true");
    if (opts.page !== undefined)        qs.set("page",      String(opts.page));
    if (opts.orderBy)                   qs.set("order_by",  opts.orderBy);
    if (opts.reverse)                   qs.set("reverse",   "true");
    if (opts.dueDateGt !== undefined)   qs.set("due_date_gt", String(opts.dueDateGt));
    if (opts.dueDateLt !== undefined)   qs.set("due_date_lt", String(opts.dueDateLt));
    for (const s of opts.statuses ?? []) qs.append("statuses[]",  s);
    for (const a of opts.assignees ?? []) qs.append("assignees[]", a);

    const res = await this.get(`/list/${listId}/task?${qs.toString()}`);
    if (!res) return [];
    return (res.tasks as ClickUpTask[]) ?? [];
  }

  /**
   * Cross-list filtered query — the workhorse for "who has overdue tasks",
   * "what's due today on Shane's plate", etc.
   *
   * GET /team/{teamId}/task
   * https://clickup.com/api/clickupreference/operation/GetFilteredTeamTasks/
   *
   * Returns up to 100 results per page.
   */
  async findTasks(opts: ClickUpFindTasksOptions = {}): Promise<ClickUpTask[]> {
    if (!this.teamId) return [];
    const qs = new URLSearchParams();
    qs.set("include_closed", String(opts.includeClosed ?? false));
    qs.set("subtasks", "true");
    if (opts.page !== undefined)        qs.set("page",      String(opts.page));
    if (opts.orderBy)                   qs.set("order_by",  opts.orderBy);
    if (opts.reverse)                   qs.set("reverse",   "true");
    if (opts.dueDateGt !== undefined)   qs.set("due_date_gt", String(opts.dueDateGt));
    if (opts.dueDateLt !== undefined)   qs.set("due_date_lt", String(opts.dueDateLt));
    for (const s of opts.statuses  ?? []) qs.append("statuses[]",  s);
    for (const a of opts.assignees ?? []) qs.append("assignees[]", a);
    for (const l of opts.listIds   ?? []) qs.append("list_ids[]",  l);
    for (const s of opts.spaceIds  ?? []) qs.append("space_ids[]", s);
    for (const t of opts.tags      ?? []) qs.append("tags[]",      t);

    const res = await this.get(`/team/${this.teamId}/task?${qs.toString()}`);
    if (!res) return [];
    return (res.tasks as ClickUpTask[]) ?? [];
  }

  /** GET /task/{taskId} */
  async getTask(taskId: string): Promise<ClickUpTask | null> {
    const res = await this.get(`/task/${taskId}`);
    if (!res) return null;
    return res as ClickUpTask;
  }

  /** GET /task/{taskId}/comment — most-recent first per ClickUp's default. */
  async getTaskComments(taskId: string): Promise<ClickUpComment[]> {
    const res = await this.get(`/task/${taskId}/comment`);
    if (!res) return [];
    return (res.comments as ClickUpComment[]) ?? [];
  }

  /**
   * Cross-list query with auto-pagination — pages through `findTasks` until
   * the API returns fewer than `pageSize` rows or `maxPages` is hit.
   *
   * ClickUp's Filtered Team Tasks endpoint pages at 100. Workspaces with
   * more than 100 matching tasks otherwise show only the first page.
   */
  async findTasksAll(opts: ClickUpFindTasksOptions = {}, maxPages = 5): Promise<ClickUpTask[]> {
    const PAGE_SIZE = 100;
    const all: ClickUpTask[] = [];
    for (let page = 0; page < maxPages; page++) {
      const batch = await this.findTasks({ ...opts, page });
      all.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return all;
  }

  // ─── Write methods (Phase 2) ────────────────────────────────────────────────

  /**
   * POST /list/{listId}/task
   * https://clickup.com/api/clickupreference/operation/CreateTask/
   *
   * Returns the created task on success, null on any failure (logged).
   */
  async createTask(listId: string, payload: ClickUpTaskCreate): Promise<ClickUpTask | null> {
    const body: Record<string, unknown> = {
      name:        payload.name,
      description: payload.description,
      assignees:   payload.assignees,
      status:      payload.status,
      due_date:    payload.dueDate,
      due_date_time: payload.dueDateTime,
      start_date:    payload.startDate,
      start_date_time: payload.startDateTime,
      priority:    payload.priority,
      tags:        payload.tags,
      parent:      payload.parent,
      custom_fields: payload.customFields,
    };
    // Strip undefined keys so we don't trigger ClickUp's "field cannot be null" errors
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];

    const res = await this.post(`/list/${listId}/task`, body);
    if (!res?.id) return null;
    return res as ClickUpTask;
  }

  /**
   * PUT /task/{taskId}
   * https://clickup.com/api/clickupreference/operation/UpdateTask/
   *
   * Patches only the fields you pass. Assignees use add/rem semantics.
   */
  async updateTask(taskId: string, patch: ClickUpTaskUpdate): Promise<ClickUpTask | null> {
    const body: Record<string, unknown> = {
      name:        patch.name,
      description: patch.description,
      status:      patch.status,
      due_date:    patch.dueDate,
      due_date_time: patch.dueDateTime,
      priority:    patch.priority,
      assignees:   patch.assignees ? {
        add: patch.assignees.add ?? [],
        rem: patch.assignees.rem ?? [],
      } : undefined,
    };
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];

    const res = await this.put(`/task/${taskId}`, body);
    if (!res?.id) return null;
    return res as ClickUpTask;
  }

  /** Convenience: status-only update. */
  async updateTaskStatus(taskId: string, status: string): Promise<ClickUpTask | null> {
    return this.updateTask(taskId, { status });
  }

  /**
   * POST /task/{taskId}/comment
   * https://clickup.com/api/clickupreference/operation/CreateTaskComment/
   */
  async addComment(taskId: string, payload: ClickUpCommentCreate): Promise<ClickUpComment | null> {
    const body: Record<string, unknown> = {
      comment_text: payload.commentText,
      assignee:     payload.assignee,
      notify_all:   payload.notifyAll ?? false,
    };
    for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];

    const res = await this.post(`/task/${taskId}/comment`, body);
    if (!res?.id && !res?.comment_text) return null;
    // ClickUp returns { id, hist_id, date } on create — re-fetch the full comment shape
    return {
      id:           String(res.id ?? ""),
      comment_text: payload.commentText,
      date:         String(res.date ?? Date.now()),
    } as ClickUpComment;
  }

  // ─── Catalog discovery (used by scripts/sync-clickup-catalog.ts) ────────────

  /** GET /team/{teamId}/space?archived=false → slimmed to { id, name }. */
  async listSpaces(): Promise<Array<{ id: string; name: string }>> {
    if (!this.teamId) return [];
    const res = await this.get(`/team/${this.teamId}/space?archived=false`);
    if (!res) return [];
    const raw = (res.spaces as Array<{ id: string; name: string }>) ?? [];
    return raw.map((s) => ({ id: String(s.id), name: s.name }));
  }

  /** GET /space/{spaceId}/list?archived=false — folderless lists only. */
  async listSpaceLists(spaceId: string): Promise<Array<{ id: string; name: string }>> {
    const res = await this.get(`/space/${spaceId}/list?archived=false`);
    if (!res) return [];
    const raw = (res.lists as Array<{ id: string; name: string }>) ?? [];
    return raw.map((l) => ({ id: String(l.id), name: l.name }));
  }

  /** GET /space/{spaceId}/folder?archived=false → slimmed; ClickUp nests lists inside folders. */
  async listSpaceFolders(spaceId: string): Promise<Array<{ id: string; name: string; lists: Array<{ id: string; name: string }> }>> {
    const res = await this.get(`/space/${spaceId}/folder?archived=false`);
    if (!res) return [];
    const raw = (res.folders as Array<{ id: string; name: string; lists?: Array<{ id: string; name: string }> }>) ?? [];
    return raw.map((f) => ({
      id:    String(f.id),
      name:  f.name,
      lists: (f.lists ?? []).map((l) => ({ id: String(l.id), name: l.name })),
    }));
  }

  /**
   * GET /team/{teamId}/member
   *
   * Note: ClickUp also exposes `/team/{teamId}` whose response includes a
   * `team.members` array — both return the same shape. We use `/member` for
   * symmetry with the rest of the catalog routes.
   */
  async listMembers(): Promise<Array<{ id: string; username: string; email: string }>> {
    if (!this.teamId) return [];
    const res = await this.get(`/team/${this.teamId}`);
    if (!res?.team) return [];
    const members = (res.team.members ?? []) as Array<{ user: { id: number | string; username: string; email: string } }>;
    return members.map((m) => ({
      id:       String(m.user.id),
      username: m.user.username,
      email:    m.user.email,
    }));
  }

  // ─── HTTP helpers ──────────────────────────────────────────────────────────

  private get headers(): Record<string, string> {
    return {
      "Content-Type":  "application/json",
      "Authorization": this.token,
    };
  }

  async get(path: string): Promise<any | null> {
    return this.request("GET", path);
  }

  async post(path: string, body: unknown): Promise<any | null> {
    return this.request("POST", path, body);
  }

  async put(path: string, body: unknown): Promise<any | null> {
    return this.request("PUT", path, body);
  }

  /**
   * Shared request helper with 429/5xx retry + exponential backoff.
   * Mirrors RingbaHttpClient.request — same pattern, same caps.
   */
  private async request(method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<any | null> {
    if (!this.enabled) return null;

    const MAX_ATTEMPTS = 6;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const init: RequestInit = { method, headers: this.headers };
        if (body !== undefined) init.body = JSON.stringify(body);

        const res = await fetch(`${BASE_URL}${path}`, init);
        if (res.ok) return res.json();

        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
          const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
          const backoff = Math.min(32000, 2000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
          const waitMs = Math.max(retryAfter, backoff);
          logger.warn("ClickUpHttpClient: retrying", {
            method, path, status: res.status, attempt, waitMs,
          });
          await sleep(waitMs);
          continue;
        }

        const text = await res.text().catch(() => "");
        logger.warn("ClickUpHttpClient: request failed", {
          method, path, status: res.status, attempt,
          body: text.slice(0, 300),
        });
        return null;
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) {
          const waitMs = Math.min(32000, 2000 * 2 ** (attempt - 1));
          logger.warn("ClickUpHttpClient: network error — retrying", {
            method, path, attempt, waitMs, error: String(err),
          });
          await sleep(waitMs);
          continue;
        }
        logger.warn("ClickUpHttpClient: request error (giving up)", { method, path, attempt, error: String(err) });
        return null;
      }
    }
    return null;
  }
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
