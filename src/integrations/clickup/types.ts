// ─── ClickUp Integration Types ────────────────────────────────────────────────
//
// Shapes for the ClickUp v2 REST API (https://clickup.com/api).
// Exhaustive enough to cover the read tools and the eventual write tools.
// Custom-field values arrive as `unknown` because their shape varies by field type.

// ─── Catalog file (`data/clickup-spaces.json`) ────────────────────────────────

export interface ClickUpCatalog {
  teamId:  string;
  spaces:  ClickUpCatalogSpace[];
  lists:   ClickUpCatalogList[];
  members: ClickUpCatalogMember[];
}

export interface ClickUpCatalogSpace {
  id:   string;
  name: string;
}

export interface ClickUpCatalogList {
  id:      string;
  name:    string;
  spaceId: string;
}

export interface ClickUpCatalogMember {
  id:           string;   // ClickUp user ID (numeric, stored as string)
  username:     string;
  email:        string;
  /** Optional Slack user ID for direct mention → ClickUp user resolution. */
  slackUserId?: string;
}

// ─── ClickUp API shapes ───────────────────────────────────────────────────────

export interface ClickUpUser {
  id:       number;
  username: string;
  email:    string;
  color?:   string;
  initials?: string;
  profilePicture?: string | null;
}

export interface ClickUpStatus {
  status:     string;
  color?:     string;
  /** "open" | "custom" | "closed" | "done" — terminal types are "closed" and "done". */
  type:       string;
  orderindex?: number;
}

export interface ClickUpTag {
  name:     string;
  tag_fg?:  string;
  tag_bg?:  string;
  creator?: number;
}

export interface ClickUpCustomField {
  id:    string;
  name:  string;
  type:  string;
  value?: unknown;
}

export interface ClickUpTask {
  id:           string;
  custom_id?:   string | null;
  name:         string;
  text_content?: string;
  description?: string;
  status:       ClickUpStatus;
  date_created: string;     // ms timestamp as string
  date_updated: string;
  date_closed?: string | null;
  date_done?:   string | null;
  due_date?:    string | null;   // ms timestamp as string
  start_date?:  string | null;
  url?:         string;
  list?:        { id: string; name?: string };
  folder?:      { id: string; name?: string };
  space?:       { id: string };
  assignees:    ClickUpUser[];
  watchers?:    ClickUpUser[];
  creator?:     ClickUpUser;
  tags?:        ClickUpTag[];
  priority?:    { id: string; priority: string; color: string } | null;
  custom_fields?: ClickUpCustomField[];
  parent?:      string | null;
  team_id?:     string;
}

export interface ClickUpComment {
  id:            string;
  comment_text:  string;
  user?:         ClickUpUser;
  resolved?:     boolean;
  assignee?:     ClickUpUser | null;
  date:          string;
}

// ─── Webhook payloads (Phase 4) ───────────────────────────────────────────────

export type ClickUpWebhookEventType =
  | "taskCreated"
  | "taskUpdated"
  | "taskAssigned"
  | "taskStatusUpdated"
  | "taskCommentPosted"
  | string;   // unknowns logged + dropped

export interface ClickUpWebhookEvent {
  event:        ClickUpWebhookEventType;
  webhook_id?:  string;
  task_id?:     string;
  history_items?: Array<{
    id?:        string;
    type?:      number;
    field?:     string;
    before?:    unknown;
    after?:     unknown;
  }>;
  /**
   * For `taskCreated` events ClickUp delivers the task body inline.
   * For other events the handler typically re-fetches via GET /task/{id}.
   */
  task?:        ClickUpTask;
}
