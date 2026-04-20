/**
 * Agent Builder — session state machine.
 *
 * All state lives in Supabase; this module is the ONLY writer. Server-side
 * enforcement of question order is load-bearing (see PRD Decision 8) —
 * Claude cannot skip ahead by handing in an answer for Q5 when we're on Q3.
 *
 * Indexes:
 *   current_question_index = 0   → session just created, first call to advance asks Q1
 *   current_question_index = 1..6 → on canonical question N
 *   current_question_index = 7..9 → on adaptive follow-up N (counted by adaptive_followup_count)
 *   current_question_index = 99  → ready to finalize
 */

import { getSupabaseClient } from "../supabase-client";
import { logger }            from "../logger";
import {
  CANONICAL_COUNT,
  MAX_TOTAL_QUESTIONS,
  READY_TO_FINALIZE_INDEX,
  getCanonicalQuestion,
  INTRO_MESSAGE,
} from "./prompts";
import {
  AgentBuilderError,
  type AgentBuilderSession,
  type AdvanceResult,
  type StartSessionOpts,
  type SubmitAnswerOpts,
  type TranscriptTurn,
} from "./types";

const TABLE = "agent_builder_sessions";

// ─── Create / resume ────────────────────────────────────────────────────────

/**
 * Start a new session, or resume an existing open one for the same Slack
 * (user, channel, thread) triple. Dashboard callers always get a fresh session.
 */
export async function startOrResumeSession(opts: StartSessionOpts): Promise<AgentBuilderSession> {
  const supabase = getSupabaseClient();

  // Resume path — Slack only.
  // Tries (user, channel, thread) when threadTs is present, otherwise
  // (user, channel, NULL thread). Without this, every @-mention starts
  // a fresh session and the user's prior progress is orphaned.
  if (opts.source === "slack" && opts.createdBy && opts.slackChannelId) {
    let q = supabase
      .from(TABLE)
      .select("*")
      .eq("source",           "slack")
      .eq("status",           "open")
      .eq("created_by",       opts.createdBy)
      .eq("slack_channel_id", opts.slackChannelId);

    // Critical: PostgREST `.eq(col, undefined)` produces invalid syntax and
    // matches nothing. Use `.is(col, null)` for the null-thread case.
    q = opts.slackThreadTs
      ? q.eq("slack_thread_ts", opts.slackThreadTs)
      : q.is("slack_thread_ts", null);

    const { data: existing, error: selErr } = await q.maybeSingle();
    if (selErr) logger.warn("agent-builder: resume lookup failed", { error: selErr.message });
    if (existing) {
      logger.info("agent-builder: resuming open session", {
        sessionId:     existing.id,
        currentIndex:  existing.current_question_index,
      });
      return rowToSession(existing);
    }
  }

  // Create new
  const intro: TranscriptTurn = {
    role:           "assistant",
    content:        INTRO_MESSAGE,
    question_index: null,
    ts:             new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      source:           opts.source,
      created_by:       opts.createdBy       ?? null,
      slack_channel_id: opts.slackChannelId  ?? null,
      slack_thread_ts:  opts.slackThreadTs   ?? null,
      transcript:       [intro],
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new Error(`agent-builder: could not create session: ${error?.message}`);
  }
  return rowToSession(data);
}

export async function getSession(id: string): Promise<AgentBuilderSession> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from(TABLE).select("*").eq("id", id).single();
  if (error || !data) throw new AgentBuilderError("session_not_found", `no session ${id}`);
  return rowToSession(data);
}

// ─── Advance (answer a question) ────────────────────────────────────────────

/**
 * Accept an answer for the current question, append to transcript, and advance
 * the state machine. This is the enforcement point: `questionIndex` on the
 * input MUST match `current_question_index` on the row, otherwise we return
 * `out_of_order`.
 *
 * The first call to `submitAnswer` (when current_question_index = 0) is
 * special-cased: it treats Q1 as the current question.
 */
export async function submitAnswer(opts: SubmitAnswerOpts): Promise<AdvanceResult> {
  const supabase = getSupabaseClient();

  // Fetch + lock semantics: Supabase doesn't do SELECT FOR UPDATE over REST, but
  // we rely on optimistic checks on current_question_index to catch concurrent
  // writes. In practice there's one writer per session (Slack user or
  // dashboard user), so contention is near-zero.
  const session = await getSession(opts.sessionId);

  if (session.status !== "open") {
    throw new AgentBuilderError("session_not_open", `session ${opts.sessionId} is ${session.status}`);
  }

  // What question are we currently expecting an answer for?
  // At index 0, the implicit current question is Q1.
  const expectedIndex =
    session.current_question_index === 0
      ? 1
      : session.current_question_index;

  if (opts.questionIndex !== expectedIndex) {
    throw new AgentBuilderError(
      "out_of_order",
      `out_of_order: expected answer for question ${expectedIndex}, got ${opts.questionIndex}`,
      { expected: expectedIndex, got: opts.questionIndex },
    );
  }

  // Determine the next index.
  // Rule: after canonical Q6, we go straight to ready-to-finalize (99).
  //       Adaptive follow-ups are added by Claude *before* Q6 by calling
  //       submitAnswer with the same questionIndex + an extra flag — for v1
  //       we keep it simple: Claude asks follow-ups inline and the user's
  //       combined answer is submitted as a single answer to the canonical
  //       question. The adaptive_followup_count is incremented when Claude
  //       explicitly asks a follow-up via the tool. (See Phase 2 refinement.)
  let nextIndex: number;
  if (expectedIndex < CANONICAL_COUNT) {
    nextIndex = expectedIndex + 1;
  } else {
    // Just answered Q6 → ready to finalize.
    nextIndex = READY_TO_FINALIZE_INDEX;
  }

  // Append answer to transcript
  const userTurn: TranscriptTurn = {
    role:           "user",
    content:        opts.answer,
    question_index: expectedIndex,
    ts:             new Date().toISOString(),
    attachment_urls: opts.attachmentUrls ?? [],
  };

  const newTranscript = [...session.transcript, userTurn];

  // If we're NOT done, also append the next question as an assistant turn for
  // transcript completeness (Dashboard uses this directly; Slack uses Claude's
  // phrasing but still gets the canonical text recorded here).
  let nextQuestionText: string | null = null;
  if (nextIndex !== READY_TO_FINALIZE_INDEX) {
    const q = getCanonicalQuestion(nextIndex);
    if (!q) throw new Error(`internal: no canonical question for index ${nextIndex}`);
    nextQuestionText = q.canonical;
    newTranscript.push({
      role:           "assistant",
      content:        nextQuestionText,
      question_index: nextIndex,
      ts:             new Date().toISOString(),
    });
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      current_question_index: nextIndex,
      transcript:             newTranscript,
      attachments:
        opts.attachmentUrls && opts.attachmentUrls.length > 0
          ? addAttachmentUrls(session, opts.attachmentUrls)
          : undefined,
    })
    .eq("id", opts.sessionId)
    .eq("current_question_index", session.current_question_index) // optimistic check
    .select("*")
    .single();

  if (error || !data) {
    throw new AgentBuilderError(
      "out_of_order",
      `optimistic update failed — likely concurrent submit. Re-fetch session.`,
      { supabaseError: error?.message },
    );
  }

  const updated = rowToSession(data);
  return {
    session:         updated,
    nextQuestion:    nextQuestionText,
    nextIndex:       nextIndex === READY_TO_FINALIZE_INDEX ? null : nextIndex,
    readyToFinalize: nextIndex === READY_TO_FINALIZE_INDEX,
  };
}

/**
 * Mark an adaptive follow-up as asked. Increments adaptive_followup_count and
 * appends the Claude-authored follow-up to the transcript as an assistant
 * turn, WITHOUT advancing current_question_index. Capped at MAX_TOTAL - CANONICAL = 3.
 */
export async function addAdaptiveFollowup(
  sessionId: string,
  followupText: string,
): Promise<AgentBuilderSession> {
  const session = await getSession(sessionId);
  if (session.status !== "open") {
    throw new AgentBuilderError("session_not_open", `session ${sessionId} is ${session.status}`);
  }
  if (session.adaptive_followup_count >= MAX_TOTAL_QUESTIONS - CANONICAL_COUNT) {
    throw new AgentBuilderError(
      "out_of_order",
      `adaptive follow-up cap reached (${MAX_TOTAL_QUESTIONS - CANONICAL_COUNT}). Finalize instead.`,
    );
  }

  const supabase = getSupabaseClient();
  const turn: TranscriptTurn = {
    role:           "assistant",
    content:        followupText,
    question_index: session.current_question_index, // follow-up is scoped to current canonical question
    ts:             new Date().toISOString(),
  };
  const newTranscript = [...session.transcript, turn];

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      transcript:              newTranscript,
      adaptive_followup_count: session.adaptive_followup_count + 1,
    })
    .eq("id", sessionId)
    .select("*")
    .single();

  if (error || !data) throw new Error(`agent-builder: follow-up update failed: ${error?.message}`);
  return rowToSession(data);
}

// ─── Abandon ────────────────────────────────────────────────────────────────

export async function abandonSession(sessionId: string): Promise<void> {
  const supabase = getSupabaseClient();
  await supabase.from(TABLE).update({ status: "abandoned" }).eq("id", sessionId);
}

/**
 * Mark every open session that hasn't been touched in `daysIdle` days as
 * abandoned. Returns the count of sessions affected. Called by the digest
 * worker before rendering, so the digest reflects fresh state.
 *
 * Per PRD OQ-01: 7-day inactivity threshold, no notification to the user.
 */
export async function markIdleSessionsAbandoned(daysIdle = 7): Promise<number> {
  const supabase = getSupabaseClient();
  const cutoff = new Date(Date.now() - daysIdle * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from(TABLE)
    .update({ status: "abandoned" })
    .eq("status", "open")
    .lt("updated_at", cutoff)
    .select("id");

  if (error) {
    logger.warn("agent-builder: idle sweep failed", { error: error.message });
    return 0;
  }
  const count = data?.length ?? 0;
  if (count > 0) {
    logger.info("agent-builder: marked idle sessions abandoned", {
      count,
      cutoff,
      daysIdle,
    });
  }
  return count;
}

// ─── Mark submitted (called by clickup ticket creator) ──────────────────────

export async function markSubmitted(
  sessionId: string,
  clickupTaskId: string,
  clickupTaskUrl: string,
  extracted: {
    proposedName?:   string | null;
    proposedSlug?:   string | null;
    verticalTag?:    string | null;
    capabilityTag?:  string | null;
  } = {},
): Promise<AgentBuilderSession> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status:           "submitted",
      clickup_task_id:  clickupTaskId,
      clickup_task_url: clickupTaskUrl,
      proposed_name:    extracted.proposedName    ?? null,
      proposed_slug:    extracted.proposedSlug    ?? null,
      vertical_tag:     extracted.verticalTag     ?? null,
      capability_tag:   extracted.capabilityTag   ?? null,
    })
    .eq("id", sessionId)
    .select("*")
    .single();

  if (error || !data) throw new Error(`agent-builder: markSubmitted failed: ${error?.message}`);
  return rowToSession(data);
}

// ─── helpers ────────────────────────────────────────────────────────────────

function addAttachmentUrls(session: AgentBuilderSession, urls: string[]) {
  // Dedupe — we don't re-attach the same URL twice.
  const existing = new Set(session.attachments.map((a) => a.url));
  const toAdd = urls.filter((u) => !existing.has(u));
  if (toAdd.length === 0) return undefined;
  // We only know URLs here; full metadata is populated by the /attachments
  // endpoint. Attach as stubs so transcript references stay valid.
  return [
    ...session.attachments,
    ...toAdd.map((url) => ({
      url,
      mime_type:   "application/octet-stream",
      filename:    url.split("/").pop() ?? "attachment",
      size_bytes:  0,
      uploaded_at: new Date().toISOString(),
    })),
  ];
}

function rowToSession(row: Record<string, unknown>): AgentBuilderSession {
  return {
    id:                      String(row.id),
    source:                  row.source as AgentBuilderSession["source"],
    created_by:              (row.created_by as string | null) ?? null,
    slack_channel_id:        (row.slack_channel_id as string | null) ?? null,
    slack_thread_ts:         (row.slack_thread_ts as string | null) ?? null,
    created_at:              String(row.created_at),
    updated_at:              String(row.updated_at),
    status:                  row.status as AgentBuilderSession["status"],
    current_question_index:  Number(row.current_question_index  ?? 0),
    adaptive_followup_count: Number(row.adaptive_followup_count ?? 0),
    transcript:              (row.transcript  as TranscriptTurn[]) ?? [],
    attachments:             (row.attachments as AgentBuilderSession["attachments"]) ?? [],
    proposed_name:           (row.proposed_name   as string | null) ?? null,
    proposed_slug:           (row.proposed_slug   as string | null) ?? null,
    vertical_tag:            (row.vertical_tag    as string | null) ?? null,
    capability_tag:          (row.capability_tag  as string | null) ?? null,
    clickup_task_id:         (row.clickup_task_id  as string | null) ?? null,
    clickup_task_url:        (row.clickup_task_url as string | null) ?? null,
  };
}
