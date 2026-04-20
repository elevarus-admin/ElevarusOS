/**
 * Agent Builder — Slack Q&A tools contributed via the manifest.
 *
 * Three tools, called in order by Claude inside the Slack bot's tool loop:
 *   1. propose_agent           — start or resume a session, return Q1 (or the next question if resuming)
 *   2. refine_agent_spec       — submit the user's answer, return nextQuestion or readyToFinalize
 *   3. create_agent_prd_ticket — finalize the session → ClickUp task
 *
 * State is persisted in Supabase via session.ts. These tools only marshal
 * tool input/output and write an audit row.
 */

import { auditQueryTool }    from "../audit-log";
import { logger }            from "../logger";
import type { QATool }       from "../qa-tools";
import { ClickUpHttpClient } from "../../integrations/clickup/client";
import {
  startOrResumeSession,
  getSession,
  submitAnswer,
  markSubmitted,
} from "./session";
import { renderPRD } from "./prd-renderer";
import {
  CANONICAL_QUESTIONS,
  getCanonicalQuestion,
  READY_TO_FINALIZE_INDEX,
} from "./prompts";
import { AgentBuilderError } from "./types";

// ─── propose_agent ───────────────────────────────────────────────────────────

export const proposeAgentTool: QATool = {
  spec: {
    name: "propose_agent",
    description:
      "Start (or resume) an Agent Builder session to scope a new ElevarusOS agent via a structured 6-question conversation that produces a ClickUp PRD ticket. " +
      "Call this when the user asks to build / propose / create a new agent, OR proactively when the user's ask doesn't map to existing agents/tools and you've confirmed they want to scope a new one. " +
      "If you're already mid-session in this Slack thread, calling this tool RESUMES — it won't create a duplicate.",
    input_schema: {
      type: "object",
      properties: {
        initial_hint: {
          type: "string",
          description: "Optional: the user's opening sentence about what they want (used for session resume disambiguation, not question advancement).",
        },
      },
    },
  },
  async execute(_input, ctx) {
    const startedAt = Date.now();
    try {
      const session = await startOrResumeSession({
        source:          "slack",
        createdBy:       ctx.slack?.userId,
        slackChannelId:  ctx.slack?.channelId,
        slackThreadTs:   ctx.slack?.threadTs,
      });

      const currentIndex =
        session.current_question_index === 0 ? 1 :
        session.current_question_index === READY_TO_FINALIZE_INDEX ? null :
        session.current_question_index;

      const currentQuestion = currentIndex ? getCanonicalQuestion(currentIndex)?.canonical ?? null : null;

      await auditQueryTool(ctx, {
        tool_name: "propose_agent",
        params:    { resumed: session.transcript.length > 1 },
        status:    "ok",
        elapsed_ms: Date.now() - startedAt,
      });

      return {
        sessionId:        session.id,
        resumed:          session.transcript.length > 1,
        questionIndex:    currentIndex,
        nextQuestion:     currentQuestion,
        totalQuestions:   CANONICAL_QUESTIONS.length,
        readyToFinalize:  session.current_question_index === READY_TO_FINALIZE_INDEX,
      };
    } catch (err) {
      logger.warn("propose_agent failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name:     "propose_agent",
        params:        {},
        status:        "error",
        elapsed_ms:    Date.now() - startedAt,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

// ─── refine_agent_spec ───────────────────────────────────────────────────────

export const refineAgentSpecTool: QATool = {
  spec: {
    name: "refine_agent_spec",
    description:
      "Submit the user's answer to the CURRENT Agent Builder question. Server-side state enforces order — if you pass the wrong questionIndex, the call fails with out_of_order and tells you the expected index. " +
      "Returns the next question OR readyToFinalize=true after Q6. Echo a one-line summary of the user's answer before calling, then call this with exactly what they said.",
    input_schema: {
      type: "object",
      required: ["sessionId", "questionIndex", "answer"],
      properties: {
        sessionId:     { type: "string", description: "From propose_agent's response." },
        questionIndex: { type: "integer", description: "Which canonical question you're answering (1..6). Must match server state." },
        answer:        { type: "string", description: "The user's answer, verbatim or lightly normalized. Preserve concrete details (dates, IDs, names)." },
      },
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params = (input ?? {}) as { sessionId?: string; questionIndex?: number; answer?: string };

    try {
      if (!params.sessionId || !params.questionIndex || !params.answer) {
        throw new Error("sessionId, questionIndex, and answer are required");
      }

      const result = await submitAnswer({
        sessionId:     params.sessionId,
        questionIndex: params.questionIndex,
        answer:        params.answer,
      });

      await auditQueryTool(ctx, {
        tool_name:  "refine_agent_spec",
        params:     { sessionId: params.sessionId, questionIndex: params.questionIndex },
        status:     "ok",
        elapsed_ms: Date.now() - startedAt,
      });

      return {
        sessionId:       result.session.id,
        nextQuestion:    result.nextQuestion,
        nextIndex:       result.nextIndex,
        readyToFinalize: result.readyToFinalize,
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      if (err instanceof AgentBuilderError) {
        logger.info("refine_agent_spec enforcement block", {
          code:    err.code,
          details: err.details,
        });
        await auditQueryTool(ctx, {
          tool_name:     "refine_agent_spec",
          params,
          status:        "error",
          elapsed_ms,
          error_message: `${err.code}: ${err.message}`,
        });
        return { error: err.code, message: err.message, ...(err.details ?? {}) };
      }
      logger.warn("refine_agent_spec failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name:     "refine_agent_spec",
        params,
        status:        "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

// ─── create_agent_prd_ticket ─────────────────────────────────────────────────

export const createAgentPrdTicketTool: QATool = {
  spec: {
    name: "create_agent_prd_ticket",
    description:
      "Finalize an Agent Builder session and create the ClickUp PRD ticket. Call ONLY after refine_agent_spec returned readyToFinalize=true. " +
      "Optionally pass proposedName, proposedSlug, verticalTag (e.g. 'vertical:hvac'), and capabilityTag (e.g. 'capability:reporting') — these populate the ticket title and tags. If omitted, reasonable defaults are derived from the transcript.",
    input_schema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId:     { type: "string" },
        proposedName:  { type: "string", description: "Display name for the agent (e.g. 'LinkedIn Ads Reporting')" },
        proposedSlug:  { type: "string", description: "Instance ID slug (e.g. 'linkedin-ads-reporting'). Auto-derived from name if omitted." },
        verticalTag:   { type: "string", description: "ClickUp tag like 'vertical:hvac'. Optional." },
        capabilityTag: { type: "string", description: "ClickUp tag like 'capability:reporting'. Optional." },
      },
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params = (input ?? {}) as {
      sessionId?:     string;
      proposedName?:  string;
      proposedSlug?:  string;
      verticalTag?:   string;
      capabilityTag?: string;
    };

    try {
      if (!params.sessionId) throw new Error("sessionId is required");

      const session = await getSession(params.sessionId);
      if (session.current_question_index !== READY_TO_FINALIZE_INDEX) {
        throw new AgentBuilderError(
          "not_ready_to_finalize",
          `session is on question ${session.current_question_index}, not ready to finalize`,
          { current_question_index: session.current_question_index },
        );
      }

      const listId =
        process.env.AGENT_BUILDER_CLICKUP_LIST_ID ??
        process.env.CLICKUP_DEFAULT_LIST_ID ??
        "";
      if (!listId) {
        throw new AgentBuilderError(
          "clickup_not_configured",
          "Set AGENT_BUILDER_CLICKUP_LIST_ID (or CLICKUP_DEFAULT_LIST_ID as fallback) to the ClickUp list that should receive agent PRDs.",
        );
      }

      const client = new ClickUpHttpClient();
      if (!client.enabled) {
        throw new AgentBuilderError("clickup_not_configured", "ClickUp integration is not configured (CLICKUP_API_TOKEN missing).");
      }

      const rendered = renderPRD(session, {
        proposedName:  params.proposedName,
        proposedSlug:  params.proposedSlug,
        verticalTag:   params.verticalTag,
        capabilityTag: params.capabilityTag,
      });

      const task = await client.createTask(listId, {
        name:        rendered.title,
        description: rendered.body,
        tags:        rendered.tags,
      });

      if (!task?.id) {
        throw new AgentBuilderError("clickup_create_failed", "ClickUp createTask returned null");
      }

      const taskUrl = task.url ?? `https://app.clickup.com/t/${task.id}`;

      const updated = await markSubmitted(session.id, task.id, taskUrl, {
        proposedName:  params.proposedName,
        proposedSlug:  params.proposedSlug,
        verticalTag:   params.verticalTag,
        capabilityTag: params.capabilityTag,
      });

      await auditQueryTool(ctx, {
        tool_name:  "create_agent_prd_ticket",
        params:     { sessionId: session.id, listId, proposedName: params.proposedName },
        status:     "ok",
        elapsed_ms: Date.now() - startedAt,
      });

      return {
        sessionId:     updated.id,
        clickupTaskId: task.id,
        clickupTaskUrl: taskUrl,
        title:         rendered.title,
        tags:          rendered.tags,
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      if (err instanceof AgentBuilderError) {
        logger.info("create_agent_prd_ticket error", { code: err.code, details: err.details });
        await auditQueryTool(ctx, {
          tool_name:     "create_agent_prd_ticket",
          params,
          status:        "error",
          elapsed_ms,
          error_message: `${err.code}: ${err.message}`,
        });
        return { error: err.code, message: err.message, ...(err.details ?? {}) };
      }
      logger.warn("create_agent_prd_ticket failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name:     "create_agent_prd_ticket",
        params,
        status:        "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

// ─── agent_builder_step (the fast path) ─────────────────────────────────────

/**
 * Single-tool Agent Builder step. Replaces propose_agent + refine_agent_spec
 * for the Slack flow — one Claude inference roundtrip per Slack message
 * instead of two.
 *
 * Behavior:
 *   - Auto-resumes the open session for (slack_user, channel, thread)
 *   - If `answer` is provided → submits it as the response to the current
 *     question, advances state, returns the next question
 *   - If `answer` is omitted → returns the current question (turn 1, or
 *     resume case where Claude just wants to know where we are)
 *   - On readyToFinalize, the bot should switch to create_agent_prd_ticket
 *
 * Backwards compat: propose_agent + refine_agent_spec still exist (used
 * by smoke tests and any external callers) — only the Slack surface
 * changes.
 */
export const agentBuilderStepTool: QATool = {
  spec: {
    name: "agent_builder_step",
    description:
      "Use this for EVERY Agent Builder turn in Slack. ONE call per Slack message. " +
      "Auto-resumes any open session for this Slack thread (no sessionId needed). " +
      "When the user just answered the current question, pass their answer in `answer` — " +
      "the tool submits it and returns the NEXT question. When starting a fresh session, " +
      "OMIT `answer` — tool returns Q1. After readyToFinalize=true, switch to create_agent_prd_ticket.",
    input_schema: {
      type: "object",
      properties: {
        answer: {
          type: "string",
          description: "The user's answer to the CURRENT question, verbatim or lightly normalized. OMIT on the very first call (no answer to submit yet) — the tool will return Q1.",
        },
      },
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params = (input ?? {}) as { answer?: string };

    try {
      const session = await startOrResumeSession({
        source:          "slack",
        createdBy:       ctx.slack?.userId,
        slackChannelId:  ctx.slack?.channelId,
        slackThreadTs:   ctx.slack?.threadTs,
      });

      // What index are we expecting an answer for? 0 → Q1.
      const expectedIndex =
        session.current_question_index === 0 ? 1 :
        session.current_question_index === READY_TO_FINALIZE_INDEX ? null :
        session.current_question_index;

      // Path A: answer submitted, advance state.
      if (params.answer && expectedIndex !== null) {
        const result = await submitAnswer({
          sessionId:     session.id,
          questionIndex: expectedIndex,
          answer:        params.answer,
        });
        await auditQueryTool(ctx, {
          tool_name:  "agent_builder_step",
          params:     { hasAnswer: true, expectedIndex },
          status:     "ok",
          elapsed_ms: Date.now() - startedAt,
        });
        return {
          sessionId:        result.session.id,
          questionIndex:    result.nextIndex,
          currentQuestion: result.nextQuestion,
          totalQuestions:  CANONICAL_QUESTIONS.length,
          readyToFinalize: result.readyToFinalize,
          justResumed:     false,
        };
      }

      // Path B: no answer — just return current question (turn 1 or pure resume).
      const currentQuestion = expectedIndex
        ? getCanonicalQuestion(expectedIndex)?.canonical ?? null
        : null;

      await auditQueryTool(ctx, {
        tool_name:  "agent_builder_step",
        params:     { hasAnswer: false, expectedIndex },
        status:     "ok",
        elapsed_ms: Date.now() - startedAt,
      });
      return {
        sessionId:        session.id,
        questionIndex:    expectedIndex,
        currentQuestion,
        totalQuestions:  CANONICAL_QUESTIONS.length,
        readyToFinalize: session.current_question_index === READY_TO_FINALIZE_INDEX,
        justResumed:     session.transcript.length > 1,
      };
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      if (err instanceof AgentBuilderError) {
        logger.info("agent_builder_step enforcement block", { code: err.code, details: err.details });
        await auditQueryTool(ctx, {
          tool_name:     "agent_builder_step",
          params,
          status:        "error",
          elapsed_ms,
          error_message: `${err.code}: ${err.message}`,
        });
        return { error: err.code, message: err.message, ...(err.details ?? {}) };
      }
      logger.warn("agent_builder_step failed", { error: String(err) });
      await auditQueryTool(ctx, {
        tool_name:     "agent_builder_step",
        params,
        status:        "error",
        elapsed_ms,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

export const agentBuilderLiveTools = [
  agentBuilderStepTool,
  createAgentPrdTicketTool,
  // Legacy — kept exported for the smoke-test script + any external callers,
  // but Slack uses agent_builder_step now (one inference round instead of two).
  proposeAgentTool,
  refineAgentSpecTool,
];
