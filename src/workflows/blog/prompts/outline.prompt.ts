import * as path from "path";
import { BlogRequest } from "../../../models/blog-request.model";
import { ResearchOutput } from "../../../models/output.model";
import { loadPrompt, PromptResult } from "../../../core/prompt-loader";

const TEMPLATE = path.join(__dirname, "outline.md");

/**
 * Builds the outline stage prompt from outline.md.
 *
 * ✏️  To tune this bot's persona, instructions, or JSON output schema:
 *     edit  src/workflows/blog/prompts/outline.md
 */
export function buildOutlinePrompt(
  request: BlogRequest,
  research: ResearchOutput
): PromptResult {
  return loadPrompt(TEMPLATE, {
    TITLE: request.title,
    AUDIENCE: request.audience,
    KEYWORD: request.targetKeyword,
    CTA: request.cta,
    TOPIC_FRAMING: research.topicFraming,
    SUBTOPICS: research.subtopics.join(", "),
    QUESTIONS: research.questionsToAnswer.join(" | "),
    KEYWORD_NOTES: research.keywordNotes,
  });
}
