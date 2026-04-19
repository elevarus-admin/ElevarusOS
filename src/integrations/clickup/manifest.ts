/**
 * ClickUp integration manifest.
 *
 * Registered via src/core/integration-registry.ts. Ask Elevarus picks up the
 * liveTools[] at boot and routes Slack-driven tool calls through them.
 *
 * Phase 1: read tools (list/find/get/comments + catalog).
 * Phase 2: write tools (update/comment/create/trigger-agent).
 * Phase 3 (pending): clickup-sync workflow stage.
 * Phase 4 (pending): inbound webhook handler.
 */

import type { IntegrationManifest } from "../../core/integration-registry";
import {
  // Read tools (Phase 1)
  clickupListListsTool,
  clickupListMembersTool,
  clickupListTasksTool,
  clickupFindTasksTool,
  clickupGetTaskTool,
  clickupGetTaskCommentsTool,
  // Write tools (Phase 2)
  clickupUpdateTaskTool,
  clickupAddCommentTool,
  clickupCreateTaskTool,
  clickupTriggerAgentTool,
} from "./live-tools";

export const manifest: IntegrationManifest = {
  id:          "clickup",
  name:        "ClickUp",
  description: "Team task tracker. Slack bot can list, search, and read tasks across the workspace, plus update/comment/create tasks and hand a task to an ElevarusOS agent. All writes use the shared ElevarusOS token; Slack user attribution is preserved in the audit log. No Supabase mirror — all queries hit the live ClickUp API. Catalog (spaces, lists, members) is cached in data/clickup-spaces.json.",

  status: () =>
    (process.env.CLICKUP_API_TOKEN && process.env.CLICKUP_TEAM_ID)
      ? "configured"
      : "unconfigured",

  // No Supabase tables — `clickupTaskId` lives on `job.metadata` for traceability.
  supabaseTables: [],

  liveTools: [
    // Read
    clickupListListsTool,
    clickupListMembersTool,
    clickupListTasksTool,
    clickupFindTasksTool,
    clickupGetTaskTool,
    clickupGetTaskCommentsTool,
    // Write
    clickupUpdateTaskTool,
    clickupAddCommentTool,
    clickupCreateTaskTool,
    clickupTriggerAgentTool,
  ],

  features: [
    "List, search, and read tasks across the workspace",
    "Update task status, assignees, due dates, and priority",
    "Add comments to tasks",
    "Create new tasks in any list",
    "Hand tasks to ElevarusOS agents via trigger",
    "Live ClickUp API (no Supabase mirror)",
  ],

  systemPromptBlurb:
    "ClickUp is the team's task tracker. " +
    "**Read (preferred path for triage):** for 'who has overdue tasks', 'what's due today', 'what's on Shane's plate this week' — call `clickup_find_tasks` with `dueDate: { preset: 'overdue' | 'today' | 'this_week' }` and an optional `groupBy: 'assignee' | 'status' | 'list'`. The tool spans the workspace and auto-paginates up to 500 rows. For single-list questions ('what's open in Marketing?') use `clickup_list_tasks` after resolving the list ID via `clickup_list_lists`. Always resolve names → ClickUp user IDs via `clickup_list_members` before passing `assignees[]` (the catalog also carries optional `slackUserId` mappings so a `<@U...>` mention maps to a ClickUp user). Default behavior excludes closed/done tasks; pass `includeClosed: true` only when explicitly asked. " +
    "**Write (use when the user asks for an action):** `clickup_update_task` patches name/status/due/priority/assignees on an existing task; `clickup_add_comment` posts to a task; `clickup_create_task` creates a new task in a list (lower-volume use case); `clickup_trigger_agent` hands an existing ClickUp task to an ElevarusOS agent (creates an MC task tagged with `clickupTaskId`, dedupes against the local job store). All writes appear in ClickUp under the shared ElevarusOS token-owner. Date strings on writes are YYYY-MM-DD in PT — resolve natural language ('Friday', 'next Tuesday') to ISO yourself using the PT date in this prompt before calling. " +
    "**Confirmation:** if the user is ambiguous about which list, who to assign, what date, or which task — confirm in chat before calling a write tool. Don't guess.",

  exampleQuestions: [
    "Who has overdue tasks today?",
    "What's due today on Shane's plate?",
    "What's on the team's plate this week, grouped by assignee?",
    "What's open in the Marketing list?",
    "What's the status of the Q3 deck task?",
    "Show me everything in `In Progress` across the workspace.",
    "Summarize the latest comments on task <id>.",
    "Move task <id> to `Review`.",
    "Comment on task <id> that the data is stale and needs a re-pull.",
    "Have the U65 reporting bot pick up task <id>.",
    "Create a task for Shane in Marketing — 'Update Q3 deck' — due Friday.",
  ],
};
