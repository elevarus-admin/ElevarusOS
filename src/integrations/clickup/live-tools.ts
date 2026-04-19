/**
 * ClickUp live-API tools contributed to the Ask Elevarus bot via the manifest.
 *
 * Phase 1: read-only surface.
 *   - clickup_list_lists       — catalog from data/clickup-spaces.json
 *   - clickup_list_members     — catalog from data/clickup-spaces.json
 *   - clickup_list_tasks       — single-list query
 *   - clickup_find_tasks       — cross-list query (workhorse for triage)
 *   - clickup_get_task         — single task by ID
 *   - clickup_get_task_comments — comment thread on a task
 *
 * Date filters resolve in PT (matches the existing system-prompt convention
 * in src/adapters/slack/events.ts).
 *
 * Audit: every tool calls auditQueryTool — slack user/channel/trace IDs are
 * captured automatically from QAToolContext.
 */

import * as fs from "fs";
import * as path from "path";
import { ClickUpHttpClient } from "./client";
import { auditQueryTool }    from "../../core/audit-log";
import { logger }            from "../../core/logger";
import { todayPst }          from "../../core/date-time";
import { listInstanceIds }   from "../../core/instance-config";
import { MCClient }          from "../../core/mc-client";
import type { QATool }       from "../../core/qa-tools";
import type {
  ClickUpCatalog,
  ClickUpTask,
  ClickUpComment,
  ClickUpStatus,
} from "./types";

// ─── Catalog file loader (cached per-process) ─────────────────────────────────

const CATALOG_PATH = path.resolve(__dirname, "../../../data/clickup-spaces.json");

let catalogCache: { at: number; data: ClickUpCatalog } | null = null;
const CATALOG_TTL_MS = 5 * 60 * 1000;   // re-read every 5 min in case the file is updated

function loadCatalog(): ClickUpCatalog | null {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.data;
  }
  try {
    const raw = fs.readFileSync(CATALOG_PATH, "utf8");
    const data = JSON.parse(raw) as ClickUpCatalog;
    catalogCache = { at: Date.now(), data };
    return data;
  } catch (err) {
    logger.warn("clickup: catalog file missing or unreadable", {
      path:  CATALOG_PATH,
      error: String(err),
    });
    return null;
  }
}

// ─── PT date helpers for due-date filters ─────────────────────────────────────

/**
 * Convert a PT YYYY-MM-DD to start-of-day UTC ms. ClickUp due_date filters
 * are millisecond epochs.
 */
function ptDayStartMs(ymd: string): number {
  // toPstIso would be nicer here but we want plain ms — build a Date from the
  // PT-anchored ISO string and let JS resolve it.
  const isoUtcMidnight = new Date(`${ymd}T00:00:00`).getTime();
  // Compute the PT offset for that day (DST-safe via Intl).
  const pt = new Intl.DateTimeFormat("en-US", {
    timeZone:     "America/Los_Angeles",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(isoUtcMidnight));
  const offsetLabel = pt.find((p) => p.type === "timeZoneName")?.value ?? "GMT-08:00";
  const m = offsetLabel.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return isoUtcMidnight;
  const sign = m[1] === "-" ? -1 : 1;
  const hrs  = Number(m[2]);
  const mins = Number(m[3] ?? 0);
  const offsetMin = sign * (hrs * 60 + mins);
  // PT midnight = UTC midnight - offsetMin minutes
  return isoUtcMidnight - offsetMin * 60_000;
}

function ptDayEndMs(ymd: string): number {
  return ptDayStartMs(ymd) + 24 * 60 * 60 * 1000 - 1;
}

/** Monday-anchored week containing the given PT date. */
function weekRangePt(ymd: string): { startMs: number; endMs: number } {
  // Compute weekday of the PT date by parsing in PT
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday:  "short",
  }).format(new Date(`${ymd}T12:00:00Z`));
  const wdMap: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const offset = wdMap[wd] ?? 0;

  const todayStart = ptDayStartMs(ymd);
  const monStart   = todayStart - offset * 24 * 60 * 60 * 1000;
  const sunEnd     = monStart   + 7 * 24 * 60 * 60 * 1000 - 1;
  return { startMs: monStart, endMs: sunEnd };
}

interface DueDateFilter {
  /** Convenience keywords. */
  preset?:   "overdue" | "today" | "this_week";
  /** Custom PT date range (YYYY-MM-DD). Used when preset is omitted. */
  from?:     string;
  to?:       string;
}

function resolveDueDateFilter(f?: DueDateFilter): { gt?: number; lt?: number; preset?: string } {
  if (!f) return {};
  if (f.preset) {
    const today = todayPst();
    if (f.preset === "overdue")   return { lt: ptDayStartMs(today),       preset: "overdue" };
    if (f.preset === "today")     return { gt: ptDayStartMs(today) - 1,
                                           lt: ptDayEndMs(today)   + 1,   preset: "today" };
    if (f.preset === "this_week") {
      const { startMs, endMs } = weekRangePt(today);
      return { gt: startMs - 1, lt: endMs + 1, preset: "this_week" };
    }
  }
  if (f.from || f.to) {
    return {
      gt: f.from ? ptDayStartMs(f.from) - 1 : undefined,
      lt: f.to   ? ptDayEndMs(f.to)     + 1 : undefined,
    };
  }
  return {};
}

/** Trim a ClickUpTask to the fields most useful in chat. Keeps tool output compact. */
function compactTask(t: ClickUpTask) {
  return {
    id:          t.id,
    name:        t.name,
    url:         t.url,
    status:      t.status?.status,
    statusType:  t.status?.type,
    listId:      t.list?.id,
    listName:    t.list?.name,
    assignees:   (t.assignees ?? []).map((a) => ({ id: String(a.id), username: a.username })),
    dueDate:     t.due_date ? new Date(Number(t.due_date)).toISOString() : null,
    dueDateMs:   t.due_date ? Number(t.due_date)                          : null,
    dateUpdated: t.date_updated ? new Date(Number(t.date_updated)).toISOString() : null,
    priority:    t.priority?.priority ?? null,
    tags:        (t.tags ?? []).map((tag) => tag.name),
  };
}

function isClosedStatus(s: ClickUpStatus | undefined): boolean {
  if (!s) return false;
  return s.type === "closed" || s.type === "done";
}

// ─── clickup_list_lists ───────────────────────────────────────────────────────

export const clickupListListsTool: QATool = {
  spec: {
    name: "clickup_list_lists",
    description:
      "Return the static catalog of ClickUp spaces and lists from data/clickup-spaces.json. Use this first when the user names a list ('the marketing list', 'agent jobs') so you can resolve it to a real list ID for clickup_list_tasks / clickup_find_tasks. No API call — instant.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  async execute(_input, ctx) {
    const startedAt = Date.now();
    const cat = loadCatalog();
    const elapsed_ms = Date.now() - startedAt;

    if (!cat) {
      await auditQueryTool(ctx, {
        tool_name: "clickup_list_lists",
        params:    {},
        status:    "error",
        elapsed_ms,
        error_message: "catalog file missing — run scripts/sync-clickup-catalog.ts",
      });
      return { error: "ClickUp catalog file is missing. Run scripts/sync-clickup-catalog.ts to populate data/clickup-spaces.json." };
    }

    await auditQueryTool(ctx, {
      tool_name: "clickup_list_lists",
      params:    {},
      status:    "ok",
      row_count: cat.lists.length,
      elapsed_ms,
    });

    return {
      teamId: cat.teamId,
      spaces: cat.spaces,
      lists:  cat.lists,
    };
  },
};

// ─── clickup_list_members ─────────────────────────────────────────────────────

export const clickupListMembersTool: QATool = {
  spec: {
    name: "clickup_list_members",
    description:
      "Return the ClickUp team-member directory from data/clickup-spaces.json — { id, username, email, slackUserId? }. Use this to resolve a name ('Shane') or a Slack mention (<@U01ABCDEF>) to a ClickUp user ID before passing it to clickup_list_tasks / clickup_find_tasks (assignees[]) or clickup_create_task. No API call — instant.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
  async execute(_input, ctx) {
    const startedAt = Date.now();
    const cat = loadCatalog();
    const elapsed_ms = Date.now() - startedAt;

    if (!cat) {
      await auditQueryTool(ctx, {
        tool_name: "clickup_list_members",
        params:    {},
        status:    "error",
        elapsed_ms,
        error_message: "catalog file missing — run scripts/sync-clickup-catalog.ts",
      });
      return { error: "ClickUp catalog file is missing. Run scripts/sync-clickup-catalog.ts to populate data/clickup-spaces.json." };
    }

    await auditQueryTool(ctx, {
      tool_name: "clickup_list_members",
      params:    {},
      status:    "ok",
      row_count: cat.members.length,
      elapsed_ms,
    });

    return { members: cat.members };
  },
};

// ─── clickup_list_tasks ───────────────────────────────────────────────────────

interface ListTasksInput {
  listId:        string;
  statuses?:     string[];
  assignees?:    string[];
  dueDate?:      DueDateFilter;
  includeClosed?: boolean;
  limit?:        number;
}

export const clickupListTasksTool: QATool = {
  spec: {
    name: "clickup_list_tasks",
    description:
      "Return tasks from a single ClickUp list (GET /list/{listId}/task). Use this when the user has named or implied a specific list. For cross-list questions ('who has overdue tasks', 'what's due today across the workspace') prefer clickup_find_tasks. Resolve listId via clickup_list_lists first if you don't have it. assignees[] takes ClickUp user IDs — resolve names via clickup_list_members.",
    input_schema: {
      type: "object",
      properties: {
        listId:    { type: "string", description: "ClickUp list ID (string)." },
        statuses:  { type: "array",  items: { type: "string" }, description: "Status name filter (e.g. ['Open','In Progress']). Case-sensitive — must match the workspace's status strings." },
        assignees: { type: "array",  items: { type: "string" }, description: "ClickUp user IDs (string form). Use clickup_list_members to resolve names." },
        dueDate: {
          type: "object",
          description: "Due-date filter. Use preset for common buckets, or { from, to } for an arbitrary PT date range.",
          properties: {
            preset: { type: "string", enum: ["overdue", "today", "this_week"] },
            from:   { type: "string", description: "YYYY-MM-DD (PT, inclusive)." },
            to:     { type: "string", description: "YYYY-MM-DD (PT, inclusive)." },
          },
        },
        includeClosed: { type: "boolean", description: "Include tasks in closed/done statuses. Default false." },
        limit:         { type: "integer", description: "Cap returned rows. Default 100, max 200." },
      },
      required: ["listId"],
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params    = (input ?? {}) as ListTasksInput;

    try {
      if (!params.listId) throw new Error("listId is required.");

      const client = new ClickUpHttpClient();
      if (!client.enabled) throw new Error("ClickUp not configured — CLICKUP_API_TOKEN + CLICKUP_TEAM_ID required.");

      const dd = resolveDueDateFilter(params.dueDate);
      let tasks = await client.listTasks(params.listId, {
        statuses:      params.statuses,
        assignees:     params.assignees,
        includeClosed: params.includeClosed ?? false,
        dueDateGt:     dd.gt,
        dueDateLt:     dd.lt,
      });

      // Belt-and-suspenders: drop closed/done tasks if the API returned them
      // despite include_closed=false (happens occasionally for "done"-type statuses).
      if (!params.includeClosed) tasks = tasks.filter((t) => !isClosedStatus(t.status));

      // For "overdue", also drop tasks without a due date (otherwise null sorts first).
      if (params.dueDate?.preset === "overdue") {
        tasks = tasks.filter((t) => t.due_date && Number(t.due_date) > 0);
      }

      const cap = Math.min(params.limit ?? 100, 200);
      const truncated = tasks.length > cap;
      const rows = (truncated ? tasks.slice(0, cap) : tasks).map(compactTask);
      const elapsed_ms = Date.now() - startedAt;

      await auditQueryTool(ctx, {
        tool_name:       "clickup_list_tasks",
        params,
        status:          truncated ? "capped" : "ok",
        row_count:       rows.length,
        total_available: tasks.length,
        elapsed_ms,
      });

      return {
        tasks:           rows,
        row_count:       rows.length,
        total_available: tasks.length,
        truncated,
        ...(dd.preset ? { resolved_filter: dd.preset } : {}),
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("clickup_list_tasks failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name: "clickup_list_tasks",
        params,
        status:    "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

// ─── clickup_find_tasks (cross-list workhorse) ────────────────────────────────

interface FindTasksInput {
  assignees?:    string[];
  statuses?:     string[];
  listIds?:      string[];
  spaceIds?:     string[];
  tags?:         string[];
  dueDate?:      DueDateFilter;
  includeClosed?: boolean;
  limit?:        number;
  /** Convenience: group the result by assignee or status. */
  groupBy?:      "assignee" | "status" | "list";
}

export const clickupFindTasksTool: QATool = {
  spec: {
    name: "clickup_find_tasks",
    description:
      "Cross-workspace task search via ClickUp's Filtered Team Tasks endpoint (GET /team/{teamId}/task). This is the right tool for triage questions: 'who has overdue tasks today', 'what's due today on Shane's plate', 'show me everything in In Progress across the workspace'. Filters: assignees (ClickUp user IDs), statuses, listIds, dueDate (preset 'overdue'|'today'|'this_week' or { from, to } PT range). Always resolve usernames → user IDs via clickup_list_members first. Defaults to includeClosed=false because triage rarely wants done tasks.",
    input_schema: {
      type: "object",
      properties: {
        assignees: { type: "array", items: { type: "string" }, description: "ClickUp user IDs. Resolve names via clickup_list_members." },
        statuses:  { type: "array", items: { type: "string" }, description: "Status names (case-sensitive)." },
        listIds:   { type: "array", items: { type: "string" }, description: "Restrict to specific lists. Empty = whole workspace." },
        spaceIds:  { type: "array", items: { type: "string" }, description: "Restrict to specific spaces." },
        tags:      { type: "array", items: { type: "string" }, description: "Tag-name filter." },
        dueDate: {
          type: "object",
          description: "Due-date filter. Use preset 'overdue' | 'today' | 'this_week', or { from, to } in PT YYYY-MM-DD.",
          properties: {
            preset: { type: "string", enum: ["overdue", "today", "this_week"] },
            from:   { type: "string", description: "YYYY-MM-DD (PT, inclusive)." },
            to:     { type: "string", description: "YYYY-MM-DD (PT, inclusive)." },
          },
        },
        includeClosed: { type: "boolean", description: "Include tasks in closed/done statuses. Default false." },
        limit:         { type: "integer", description: "Cap returned rows. Default 100, max 200." },
        groupBy:       { type: "string", enum: ["assignee", "status", "list"], description: "If set, additionally return a grouped summary alongside the raw rows. Useful for 'who has overdue' (groupBy: 'assignee')." },
      },
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params    = (input ?? {}) as FindTasksInput;

    try {
      const client = new ClickUpHttpClient();
      if (!client.enabled) throw new Error("ClickUp not configured — CLICKUP_API_TOKEN + CLICKUP_TEAM_ID required.");

      const dd = resolveDueDateFilter(params.dueDate);
      const requestedLimit = params.limit ?? 100;
      // Auto-paginate when the user wants > 100 rows. ClickUp pages at 100;
      // walk up to 5 pages (500 tasks) by default to keep responses bounded.
      const maxPages = Math.min(5, Math.ceil(requestedLimit / 100));
      let tasks = await client.findTasksAll({
        assignees:     params.assignees,
        statuses:      params.statuses,
        listIds:       params.listIds,
        spaceIds:      params.spaceIds,
        tags:          params.tags,
        includeClosed: params.includeClosed ?? false,
        dueDateGt:     dd.gt,
        dueDateLt:     dd.lt,
      }, maxPages);

      if (!params.includeClosed) tasks = tasks.filter((t) => !isClosedStatus(t.status));
      if (params.dueDate?.preset === "overdue") {
        tasks = tasks.filter((t) => t.due_date && Number(t.due_date) > 0);
      }

      const cap = Math.min(requestedLimit, 500);
      const truncated = tasks.length > cap;
      const windowed  = truncated ? tasks.slice(0, cap) : tasks;
      const rows      = windowed.map(compactTask);
      const elapsed_ms = Date.now() - startedAt;

      // Optional grouping
      let grouped: Record<string, { count: number; tasks: ReturnType<typeof compactTask>[] }> | undefined;
      if (params.groupBy) {
        grouped = {};
        for (const r of rows) {
          let key: string;
          if (params.groupBy === "assignee") {
            const names = r.assignees.map((a) => a.username);
            key = names.length === 0 ? "(unassigned)" : names.join(", ");
          } else if (params.groupBy === "status") {
            key = r.status ?? "(none)";
          } else {
            key = r.listName ?? r.listId ?? "(none)";
          }
          if (!grouped[key]) grouped[key] = { count: 0, tasks: [] };
          grouped[key].count += 1;
          grouped[key].tasks.push(r);
        }
      }

      await auditQueryTool(ctx, {
        tool_name:       "clickup_find_tasks",
        params,
        status:          truncated ? "capped" : "ok",
        row_count:       rows.length,
        total_available: tasks.length,
        elapsed_ms,
      });

      return {
        tasks:           rows,
        row_count:       rows.length,
        total_available: tasks.length,
        truncated,
        ...(grouped ? { grouped } : {}),
        ...(dd.preset ? { resolved_filter: dd.preset } : {}),
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("clickup_find_tasks failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name: "clickup_find_tasks",
        params,
        status:    "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

// ─── clickup_get_task ─────────────────────────────────────────────────────────

export const clickupGetTaskTool: QATool = {
  spec: {
    name: "clickup_get_task",
    description:
      "Fetch a single ClickUp task by ID (GET /task/{taskId}). Returns full task: status, assignees, dueDate, custom fields, priority, tags, URL. Use this when you have a task ID from a prior list/find call or the user pasted one in.",
    input_schema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "ClickUp task ID (e.g. '8693xyz12'). Also accepts custom IDs if your workspace uses them." },
      },
      required: ["taskId"],
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params    = (input ?? {}) as { taskId: string };

    try {
      if (!params.taskId) throw new Error("taskId is required.");

      const client = new ClickUpHttpClient();
      if (!client.enabled) throw new Error("ClickUp not configured.");

      const task = await client.getTask(params.taskId);
      const elapsed_ms = Date.now() - startedAt;

      if (!task) {
        await auditQueryTool(ctx, {
          tool_name: "clickup_get_task",
          params,
          status:    "error",
          elapsed_ms,
          error_message: "task not found or unauthorized",
        });
        return { error: `Task '${params.taskId}' not found or inaccessible.` };
      }

      await auditQueryTool(ctx, {
        tool_name: "clickup_get_task",
        params,
        status:    "ok",
        row_count: 1,
        elapsed_ms,
      });

      return {
        task: {
          ...compactTask(task),
          description: task.description ?? task.text_content ?? null,
          customFields: (task.custom_fields ?? []).map((cf) => ({
            id:    cf.id,
            name:  cf.name,
            type:  cf.type,
            value: cf.value ?? null,
          })),
        },
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("clickup_get_task failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name: "clickup_get_task",
        params,
        status:    "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

// ─── clickup_get_task_comments ────────────────────────────────────────────────

export const clickupGetTaskCommentsTool: QATool = {
  spec: {
    name: "clickup_get_task_comments",
    description:
      "Fetch comments on a ClickUp task (GET /task/{taskId}/comment). Returns the most recent comments first. Use this when answering 'what was the latest discussion on <task>' or summarizing context before suggesting an action.",
    input_schema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "ClickUp task ID." },
        limit:  { type: "integer", description: "Cap returned comments. Default 25, max 100." },
      },
      required: ["taskId"],
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params    = (input ?? {}) as { taskId: string; limit?: number };

    try {
      if (!params.taskId) throw new Error("taskId is required.");

      const client = new ClickUpHttpClient();
      if (!client.enabled) throw new Error("ClickUp not configured.");

      const comments = await client.getTaskComments(params.taskId);
      const cap = Math.min(params.limit ?? 25, 100);
      const truncated = comments.length > cap;
      const rows = (truncated ? comments.slice(0, cap) : comments).map((c: ClickUpComment) => ({
        id:        c.id,
        text:      c.comment_text,
        author:    c.user?.username ?? null,
        date:      c.date ? new Date(Number(c.date)).toISOString() : null,
        resolved:  c.resolved ?? false,
      }));
      const elapsed_ms = Date.now() - startedAt;

      await auditQueryTool(ctx, {
        tool_name:       "clickup_get_task_comments",
        params,
        status:          truncated ? "capped" : "ok",
        row_count:       rows.length,
        total_available: comments.length,
        elapsed_ms,
      });

      return {
        comments:        rows,
        row_count:       rows.length,
        total_available: comments.length,
        truncated,
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("clickup_get_task_comments failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name: "clickup_get_task_comments",
        params,
        status:    "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// WRITE TOOLS (Phase 2)
// ──────────────────────────────────────────────────────────────────────────────
//
// All writes use the shared CLICKUP_API_TOKEN, so ClickUp shows the token
// owner as the actor. Slack user/channel/trace IDs are captured in the audit
// log so we still know who triggered each write.
//
// Pattern: validate → call client → return success or { ok: false, error, hint? }.
// Tools never throw; Claude relays the error to the user verbatim.

// ─── clickup_update_task ──────────────────────────────────────────────────────

interface UpdateTaskInput {
  taskId:       string;
  name?:        string;
  description?: string;
  status?:      string;
  /** YYYY-MM-DD (PT, midnight). Pass `null` to clear the due date. */
  dueDate?:     string | null;
  priority?:    1 | 2 | 3 | 4 | null;
  /** ClickUp user IDs to add to assignees. */
  addAssignees?: string[];
  /** ClickUp user IDs to remove from assignees. */
  removeAssignees?: string[];
}

export const clickupUpdateTaskTool: QATool = {
  spec: {
    name: "clickup_update_task",
    description:
      "WRITE: Patch fields on an existing ClickUp task (PUT /task/{taskId}). Pass only the fields you want to change. status must be a valid status string for the task's list (use clickup_get_task to see current status, or clickup_list_lists / clickup_get_task to discover allowed values). dueDate is YYYY-MM-DD in PT (resolve natural language like 'Friday' to ISO yourself before calling); pass null to clear it. assignees use add/remove arrays of ClickUp user IDs (resolve names via clickup_list_members). If the user is ambiguous about which task or what change, ask for confirmation before calling.",
    input_schema: {
      type: "object",
      properties: {
        taskId:       { type: "string", description: "ClickUp task ID." },
        name:         { type: "string", description: "Replace the task title." },
        description:  { type: "string", description: "Replace the task description." },
        status:       { type: "string", description: "New status string (case-sensitive, must exist in the list's workflow)." },
        dueDate:      { type: ["string", "null"], description: "YYYY-MM-DD (PT) or null to clear." },
        priority:     { type: ["integer", "null"], description: "1=urgent, 2=high, 3=normal, 4=low, null to clear." },
        addAssignees:    { type: "array", items: { type: "string" }, description: "ClickUp user IDs to add as assignees." },
        removeAssignees: { type: "array", items: { type: "string" }, description: "ClickUp user IDs to remove from assignees." },
      },
      required: ["taskId"],
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params    = (input ?? {}) as UpdateTaskInput;

    try {
      if (!params.taskId) throw new Error("taskId is required.");

      const client = new ClickUpHttpClient();
      if (!client.enabled) throw new Error("ClickUp not configured.");

      const dueDateMs =
        params.dueDate === null      ? null :
        params.dueDate === undefined ? undefined :
                                       ptDayStartMs(params.dueDate);

      const updated = await client.updateTask(params.taskId, {
        name:        params.name,
        description: params.description,
        status:      params.status,
        dueDate:     dueDateMs as number | null | undefined,
        dueDateTime: dueDateMs ? false : undefined,
        priority:    params.priority,
        assignees: (params.addAssignees || params.removeAssignees) ? {
          add: (params.addAssignees ?? []).map((id) => Number(id)),
          rem: (params.removeAssignees ?? []).map((id) => Number(id)),
        } : undefined,
      });
      const elapsed_ms = Date.now() - startedAt;

      if (!updated) {
        await auditQueryTool(ctx, {
          tool_name: "clickup_update_task",
          params,
          status:    "error",
          elapsed_ms,
          error_message: "update failed (see logs)",
        });
        return { ok: false, error: "Update failed. The most common causes: invalid status string, invalid task ID, or missing permissions on the list." };
      }

      await auditQueryTool(ctx, {
        tool_name: "clickup_update_task",
        params,
        status:    "ok",
        row_count: 1,
        elapsed_ms,
      });

      return {
        ok:   true,
        task: compactTask(updated),
        url:  updated.url ?? null,
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("clickup_update_task failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name: "clickup_update_task",
        params,
        status:    "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { ok: false, error: String(err) };
    }
  },
};

// ─── clickup_add_comment ──────────────────────────────────────────────────────

interface AddCommentInput {
  taskId:      string;
  text:        string;
  assigneeId?: string;
  notifyAll?:  boolean;
}

export const clickupAddCommentTool: QATool = {
  spec: {
    name: "clickup_add_comment",
    description:
      "WRITE: Post a comment to a ClickUp task (POST /task/{taskId}/comment). Use for status notes, hand-offs, or surfacing an issue. The comment will appear under the shared ElevarusOS token-owner. Optionally assign the comment to a ClickUp user (resolve via clickup_list_members).",
    input_schema: {
      type: "object",
      properties: {
        taskId:     { type: "string", description: "ClickUp task ID." },
        text:       { type: "string", description: "Comment body. Supports ClickUp's basic markdown." },
        assigneeId: { type: "string", description: "Optional ClickUp user ID to assign the comment to." },
        notifyAll:  { type: "boolean", description: "Notify everyone watching the task. Default false." },
      },
      required: ["taskId", "text"],
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params    = (input ?? {}) as AddCommentInput;

    try {
      if (!params.taskId) throw new Error("taskId is required.");
      if (!params.text)   throw new Error("text is required.");

      const client = new ClickUpHttpClient();
      if (!client.enabled) throw new Error("ClickUp not configured.");

      const comment = await client.addComment(params.taskId, {
        commentText: params.text,
        assignee:    params.assigneeId ? Number(params.assigneeId) : undefined,
        notifyAll:   params.notifyAll ?? false,
      });
      const elapsed_ms = Date.now() - startedAt;

      if (!comment) {
        await auditQueryTool(ctx, {
          tool_name: "clickup_add_comment",
          params:    { ...params, text: params.text.slice(0, 200) },
          status:    "error",
          elapsed_ms,
          error_message: "comment post failed",
        });
        return { ok: false, error: "Comment failed to post. Check the task ID and that the token has comment permissions on this list." };
      }

      await auditQueryTool(ctx, {
        tool_name: "clickup_add_comment",
        params:    { ...params, text: params.text.slice(0, 200) },   // truncate to keep audit row small
        status:    "ok",
        row_count: 1,
        elapsed_ms,
      });

      return {
        ok:        true,
        commentId: comment.id,
        taskUrl:   `https://app.clickup.com/t/${params.taskId}`,
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("clickup_add_comment failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name: "clickup_add_comment",
        params:    { ...params, text: params.text?.slice(0, 200) },
        status:    "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { ok: false, error: String(err) };
    }
  },
};

// ─── clickup_create_task (low-priority — keep for completeness) ──────────────

interface CreateTaskInput {
  listId:        string;
  name:          string;
  description?:  string;
  /** ClickUp user IDs to assign at create time. */
  assigneeIds?:  string[];
  status?:       string;
  /** YYYY-MM-DD in PT. */
  dueDate?:      string;
  priority?:     1 | 2 | 3 | 4;
  tags?:         string[];
  /** Optional free-form custom fields — ClickUp validates server-side. */
  customFields?: Array<{ id: string; value: unknown }>;
}

export const clickupCreateTaskTool: QATool = {
  spec: {
    name: "clickup_create_task",
    description:
      "WRITE: Create a new ClickUp task in a specific list (POST /list/{listId}/task). Lower-volume use case — usually triggered by an explicit 'create a task for X to do Y' request. Resolve listId via clickup_list_lists and assigneeIds via clickup_list_members BEFORE calling. dueDate is YYYY-MM-DD in PT — convert natural language ('Friday', 'next Tuesday') to ISO yourself using the PT date in your system prompt. If the user is ambiguous about list, assignee, or date, ask for confirmation first.",
    input_schema: {
      type: "object",
      properties: {
        listId:       { type: "string", description: "ClickUp list ID. Resolve via clickup_list_lists if unknown." },
        name:         { type: "string", description: "Task title." },
        description:  { type: "string", description: "Optional task description (markdown OK)." },
        assigneeIds:  { type: "array", items: { type: "string" }, description: "ClickUp user IDs. Resolve names via clickup_list_members." },
        status:       { type: "string", description: "Initial status (must exist in the list's workflow). Defaults to the list's first 'open' status if omitted." },
        dueDate:      { type: "string", description: "YYYY-MM-DD (PT)." },
        priority:     { type: "integer", description: "1=urgent, 2=high, 3=normal, 4=low." },
        tags:         { type: "array", items: { type: "string" }, description: "Tag names to attach." },
        customFields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id:    { type: "string" },
              value: {},
            },
            required: ["id", "value"],
          },
          description: "Free-form custom fields. ClickUp rejects unknown IDs server-side.",
        },
      },
      required: ["listId", "name"],
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params    = (input ?? {}) as CreateTaskInput;

    try {
      if (!params.listId) throw new Error("listId is required.");
      if (!params.name)   throw new Error("name is required.");

      const client = new ClickUpHttpClient();
      if (!client.enabled) throw new Error("ClickUp not configured.");

      const task = await client.createTask(params.listId, {
        name:         params.name,
        description:  params.description,
        assignees:    params.assigneeIds?.map((id) => Number(id)),
        status:       params.status,
        dueDate:      params.dueDate ? ptDayStartMs(params.dueDate) : undefined,
        dueDateTime:  params.dueDate ? false : undefined,
        priority:     params.priority,
        tags:         params.tags,
        customFields: params.customFields,
      });
      const elapsed_ms = Date.now() - startedAt;

      if (!task) {
        await auditQueryTool(ctx, {
          tool_name: "clickup_create_task",
          params,
          status:    "error",
          elapsed_ms,
          error_message: "create failed",
        });
        return { ok: false, error: "Create failed. The most common causes: invalid status string for the list, invalid assignee IDs, or invalid custom-field IDs." };
      }

      await auditQueryTool(ctx, {
        tool_name: "clickup_create_task",
        params,
        status:    "ok",
        row_count: 1,
        elapsed_ms,
      });

      return {
        ok:   true,
        task: compactTask(task),
        url:  task.url ?? null,
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("clickup_create_task failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name: "clickup_create_task",
        params,
        status:    "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { ok: false, error: String(err) };
    }
  },
};

// ─── clickup_trigger_agent ────────────────────────────────────────────────────
//
// Bridge tool: takes an EXISTING ClickUp task and gets an ElevarusOS agent
// to pick it up via MC. Validates the agent against listInstanceIds() and
// dedupes against the local job store so re-running doesn't double-queue.

interface TriggerAgentInput {
  taskId:           string;
  agentInstanceId:  string;
  /** Extra metadata passed through to the MC task. */
  metadata?:        Record<string, unknown>;
}

export const clickupTriggerAgentTool: QATool = {
  spec: {
    name: "clickup_trigger_agent",
    description:
      "WRITE: Hand an existing ClickUp task to an ElevarusOS agent. Validates agentInstanceId against the registered instance list and rejects unknown agents (returning the valid set as a hint). Creates an MC task with metadata.clickupTaskId so the agent can post results back. Dedupes: if a job already exists for this clickupTaskId in the local store, returns the existing jobId rather than creating a duplicate. Requires Mission Control to be configured.",
    input_schema: {
      type: "object",
      properties: {
        taskId:          { type: "string", description: "Existing ClickUp task ID to bind to the agent." },
        agentInstanceId: { type: "string", description: "ElevarusOS instance ID (e.g. 'final-expense-reporting'). Must match a registered instance." },
        metadata:        { type: "object", description: "Optional extra metadata to attach to the MC task." },
      },
      required: ["taskId", "agentInstanceId"],
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params    = (input ?? {}) as TriggerAgentInput;

    try {
      if (!params.taskId)          throw new Error("taskId is required.");
      if (!params.agentInstanceId) throw new Error("agentInstanceId is required.");

      // Validate agent against known instances
      const known = listInstanceIds(true);
      if (!known.includes(params.agentInstanceId)) {
        return {
          ok:    false,
          error: `Unknown agent '${params.agentInstanceId}'.`,
          hint:  `Known agents: ${known.join(", ")}.`,
        };
      }

      // Dedupe — best-effort: scan jobStore for any prior job with this clickupTaskId
      const existing = await ctx.jobStore.list();
      const dup = existing.find((j) => {
        const md = (j as unknown as { metadata?: Record<string, unknown> }).metadata;
        return md && md.clickupTaskId === params.taskId;
      });
      if (dup) {
        const elapsed_ms = Date.now() - startedAt;
        await auditQueryTool(ctx, {
          tool_name: "clickup_trigger_agent",
          params,
          status:    "ok",
          elapsed_ms,
        });
        return {
          ok:           true,
          deduped:      true,
          jobId:        dup.id,
          message:      `An ElevarusOS job already exists for ClickUp task ${params.taskId} — returning the existing jobId.`,
        };
      }

      // Fetch the ClickUp task to use its name as the MC task title
      const cu = new ClickUpHttpClient();
      if (!cu.enabled) throw new Error("ClickUp not configured.");
      const task = await cu.getTask(params.taskId);
      if (!task) throw new Error(`ClickUp task '${params.taskId}' not found.`);

      // Create the MC task
      const mc = new MCClient();
      if (!mc.enabled) throw new Error("Mission Control not configured (MISSION_CONTROL_URL + MISSION_CONTROL_API_KEY required).");

      const mcTaskId = await mc.createTask({
        title:       task.name,
        description: task.description ?? task.text_content ?? "",
        assigned_to: params.agentInstanceId,
        tags:        [params.agentInstanceId, "clickup"],
        metadata: {
          clickupTaskId:  params.taskId,
          clickupListId:  task.list?.id,
          clickupSpaceId: task.space?.id,
          clickupUrl:     task.url,
          ...params.metadata,
        },
      });
      const elapsed_ms = Date.now() - startedAt;

      if (!mcTaskId) {
        await auditQueryTool(ctx, {
          tool_name: "clickup_trigger_agent",
          params,
          status:    "error",
          elapsed_ms,
          error_message: "MC createTask returned null",
        });
        return { ok: false, error: "Failed to create MC task. Check MC logs." };
      }

      await auditQueryTool(ctx, {
        tool_name: "clickup_trigger_agent",
        params,
        status:    "ok",
        row_count: 1,
        elapsed_ms,
      });

      return {
        ok:        true,
        mcTaskId,
        agent:     params.agentInstanceId,
        clickupTaskId: params.taskId,
        clickupUrl: task.url ?? null,
        message:   `MC task ${mcTaskId} queued for ${params.agentInstanceId}; will pick up on the next poll cycle.`,
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      logger.warn("clickup_trigger_agent failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name: "clickup_trigger_agent",
        params,
        status:    "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { ok: false, error: String(err) };
    }
  },
};
