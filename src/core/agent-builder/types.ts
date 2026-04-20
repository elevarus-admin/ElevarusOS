// ─── Agent Builder Types ──────────────────────────────────────────────────────
//
// Domain types for the Agent Builder feature. See docs/prd-agent-builder.md
// for the full design.

export type AgentBuilderSource = "slack" | "dashboard";
export type AgentBuilderStatus = "open" | "submitted" | "abandoned";

/** Role in the transcript. `system` is rare (used only for initialization). */
export type TranscriptRole = "assistant" | "user" | "system";

/** One entry in the transcript JSONB. */
export interface TranscriptTurn {
  role:            TranscriptRole;
  content:         string;
  /** Which canonical question (1–6) or adaptive follow-up index (7–9) this turn corresponds to. Null for the intro or system messages. */
  question_index:  number | null;
  /** ISO timestamp */
  ts:              string;
  /** Optional attachment URLs referenced in this turn (subset of session.attachments). */
  attachment_urls?: string[];
}

/** Attachment record (subset of Supabase Storage object). */
export interface Attachment {
  url:         string;
  mime_type:   string;
  filename:    string;
  size_bytes:  number;
  uploaded_at: string;
}

/** Snapshot of a session row. */
export interface AgentBuilderSession {
  id:                      string;
  source:                  AgentBuilderSource;
  created_by:              string | null;
  slack_channel_id:        string | null;
  slack_thread_ts:         string | null;
  created_at:              string;
  updated_at:              string;
  status:                  AgentBuilderStatus;
  current_question_index:  number;
  adaptive_followup_count: number;
  transcript:              TranscriptTurn[];
  attachments:             Attachment[];
  proposed_name:           string | null;
  proposed_slug:           string | null;
  vertical_tag:            string | null;
  capability_tag:          string | null;
  clickup_task_id:         string | null;
  clickup_task_url:        string | null;
}

/** Result of advancing a session one turn. */
export interface AdvanceResult {
  session:       AgentBuilderSession;
  /** Next canonical-or-adaptive question to ask, or null if ready to finalize. */
  nextQuestion:  string | null;
  nextIndex:     number | null;
  readyToFinalize: boolean;
}

export interface StartSessionOpts {
  source:           AgentBuilderSource;
  createdBy?:       string;
  slackChannelId?:  string;
  slackThreadTs?:   string;
}

export interface SubmitAnswerOpts {
  sessionId:         string;
  answer:            string;
  questionIndex:     number;          // client asserts which question it thinks it's answering
  attachmentUrls?:   string[];
}

export interface FinalizeOpts {
  sessionId:       string;
  /** Optional — the Claude-authored proposed_name override. If absent, server extracts from Q1. */
  proposedName?:   string;
  proposedSlug?:   string;
  verticalTag?:    string;
  capabilityTag?:  string;
}

export interface FinalizeResult {
  session:       AgentBuilderSession;
  clickupTaskId: string;
  clickupTaskUrl: string;
}

/** Specific error codes the state machine emits. */
export type AgentBuilderErrorCode =
  | "session_not_found"
  | "session_not_open"
  | "out_of_order"
  | "already_finalized"
  | "not_ready_to_finalize"
  | "clickup_not_configured"
  | "clickup_create_failed";

export class AgentBuilderError extends Error {
  code:     AgentBuilderErrorCode;
  details?: Record<string, unknown>;

  constructor(code: AgentBuilderErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name    = "AgentBuilderError";
    this.code    = code;
    this.details = details;
  }
}
