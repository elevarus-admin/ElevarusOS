/**
 * Agent Builder — barrel export.
 *
 * Public API:
 *   - startOrResumeSession / submitAnswer / getSession / markSubmitted / abandonSession
 *   - renderPRD
 *   - CANONICAL_QUESTIONS / MAX_TOTAL_QUESTIONS / READY_TO_FINALIZE_INDEX
 *   - The 3 Slack tools (exposed via manifest.ts, not imported directly)
 *
 * See docs/prd-agent-builder.md.
 */

export {
  startOrResumeSession,
  getSession,
  submitAnswer,
  addAdaptiveFollowup,
  abandonSession,
  markSubmitted,
} from "./session";

export { renderPRD } from "./prd-renderer";

export {
  CANONICAL_QUESTIONS,
  CANONICAL_COUNT,
  MAX_TOTAL_QUESTIONS,
  READY_TO_FINALIZE_INDEX,
  getCanonicalQuestion,
  INTRO_MESSAGE,
  SYSTEM_PROMPT_BLURB,
} from "./prompts";

export type {
  AgentBuilderSession,
  AgentBuilderSource,
  AgentBuilderStatus,
  AdvanceResult,
  Attachment,
  StartSessionOpts,
  SubmitAnswerOpts,
  TranscriptTurn,
  TranscriptRole,
} from "./types";

export { AgentBuilderError } from "./types";
