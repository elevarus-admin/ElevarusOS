/**
 * Agent Builder REST routes.
 *
 * These back the dashboard `/agents/new` wizard. Slack doesn't call these
 * (it uses the tool surface in src/core/agent-builder/slack-tools.ts).
 *
 * All routes operate on the same state machine as the Slack tools, so
 * server-side question-order enforcement applies equally.
 *
 *   POST /api/agent-builder/session              → create session, return Q1
 *   GET  /api/agent-builder/session/:id          → fetch session state
 *   POST /api/agent-builder/session/:id/turn     → submit answer, return next Q or readyToFinalize
 *   POST /api/agent-builder/session/:id/ticket   → finalize → ClickUp task
 *   POST /api/agent-builder/session/:id/abandon  → mark abandoned
 */

import { Router, Request, Response, NextFunction } from "express";
import {
  startOrResumeSession,
  getSession,
  submitAnswer,
  markSubmitted,
  abandonSession,
  renderPRD,
  AgentBuilderError,
  CANONICAL_QUESTIONS,
  READY_TO_FINALIZE_INDEX,
  getCanonicalQuestion,
} from "../core/agent-builder";
import { ClickUpHttpClient } from "../integrations/clickup/client";
import { logger }            from "../core/logger";

export function buildAgentBuilderRouter(): Router {
  const r = Router();

  // POST /api/agent-builder/session — create a new session (dashboard always gets fresh)
  r.post("/", handleAsync(async (req: Request, res: Response) => {
    const { createdBy } = (req.body ?? {}) as { createdBy?: string };

    const session = await startOrResumeSession({
      source:    "dashboard",
      createdBy: createdBy,
    });

    const q1 = getCanonicalQuestion(1);
    res.json({
      sessionId:      session.id,
      questionIndex:  1,
      nextQuestion:   q1?.canonical,
      totalQuestions: CANONICAL_QUESTIONS.length,
      intro:          session.transcript[0]?.content ?? null,
    });
  }));

  // GET /api/agent-builder/session/:id
  r.get("/:id", handleAsync(async (req: Request, res: Response) => {
    const session = await getSession(String(req.params.id));
    res.json({
      session,
      currentQuestion: getCanonicalQuestion(session.current_question_index)?.canonical ?? null,
      readyToFinalize: session.current_question_index === READY_TO_FINALIZE_INDEX,
    });
  }));

  // POST /api/agent-builder/session/:id/turn
  r.post("/:id/turn", handleAsync(async (req: Request, res: Response) => {
    const { answer, questionIndex, attachmentUrls } = (req.body ?? {}) as {
      answer?:         string;
      questionIndex?:  number;
      attachmentUrls?: string[];
    };

    if (typeof answer !== "string" || !answer.trim()) {
      res.status(400).json({ error: "answer is required" });
      return;
    }
    if (typeof questionIndex !== "number") {
      res.status(400).json({ error: "questionIndex is required" });
      return;
    }

    const result = await submitAnswer({
      sessionId:       String(req.params.id),
      questionIndex,
      answer,
      attachmentUrls,
    });

    res.json({
      sessionId:       result.session.id,
      nextQuestion:    result.nextQuestion,
      nextIndex:       result.nextIndex,
      readyToFinalize: result.readyToFinalize,
    });
  }));

  // POST /api/agent-builder/session/:id/ticket — finalize → ClickUp
  r.post("/:id/ticket", handleAsync(async (req: Request, res: Response) => {
    const { proposedName, proposedSlug, verticalTag, capabilityTag } = (req.body ?? {}) as {
      proposedName?:  string;
      proposedSlug?:  string;
      verticalTag?:   string;
      capabilityTag?: string;
    };

    const session = await getSession(String(req.params.id));
    if (session.current_question_index !== READY_TO_FINALIZE_INDEX) {
      res.status(409).json({
        error: "not_ready_to_finalize",
        current_question_index: session.current_question_index,
      });
      return;
    }

    const listId =
      process.env.AGENT_BUILDER_CLICKUP_LIST_ID ??
      process.env.CLICKUP_DEFAULT_LIST_ID ??
      "";
    if (!listId) {
      res.status(500).json({
        error: "clickup_not_configured",
        message: "Set AGENT_BUILDER_CLICKUP_LIST_ID or CLICKUP_DEFAULT_LIST_ID.",
      });
      return;
    }

    const client = new ClickUpHttpClient();
    if (!client.enabled) {
      res.status(500).json({ error: "clickup_not_configured" });
      return;
    }

    const rendered = renderPRD(session, {
      proposedName, proposedSlug, verticalTag, capabilityTag,
    });

    const task = await client.createTask(listId, {
      name:        rendered.title,
      description: rendered.body,
      tags:        rendered.tags,
    });
    if (!task?.id) {
      res.status(502).json({ error: "clickup_create_failed" });
      return;
    }
    const taskUrl = task.url ?? `https://app.clickup.com/t/${task.id}`;
    const updated = await markSubmitted(session.id, task.id, taskUrl, {
      proposedName, proposedSlug, verticalTag, capabilityTag,
    });

    res.json({
      sessionId:      updated.id,
      clickupTaskId:  task.id,
      clickupTaskUrl: taskUrl,
      title:          rendered.title,
      tags:           rendered.tags,
    });
  }));

  // POST /api/agent-builder/session/:id/abandon
  r.post("/:id/abandon", handleAsync(async (req: Request, res: Response) => {
    await abandonSession(String(req.params.id));
    res.json({ ok: true });
  }));

  return r;
}

// ── error-aware async wrapper ───────────────────────────────────────────────

function handleAsync(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch((err) => {
      if (err instanceof AgentBuilderError) {
        const statusCode =
          err.code === "session_not_found"    ? 404 :
          err.code === "session_not_open"     ? 409 :
          err.code === "out_of_order"         ? 409 :
          err.code === "not_ready_to_finalize" ? 409 :
          err.code === "already_finalized"    ? 409 :
          err.code === "clickup_not_configured" ? 500 :
          err.code === "clickup_create_failed" ? 502 :
          400;
        res.status(statusCode).json({ error: err.code, message: err.message, ...(err.details ?? {}) });
        return;
      }
      logger.warn("agent-builder route error", { path: req.path, error: String(err) });
      res.status(500).json({ error: "internal", message: String(err) });
      next();
    });
  };
}
