import * as path from "path";
import { BlogRequest } from "../../../models/blog-request.model";
import { ResearchOutput, OutlineOutput } from "../../../models/output.model";
import { loadPrompt, PromptResult } from "../../../core/prompt-loader";

const TEMPLATE = path.join(__dirname, "draft.md");

/**
 * Builds the drafting stage prompt from draft.md.
 *
 * ✏️  To tune the writing style, tone, structure requirements, or JSON schema:
 *     edit  src/workflows/blog/prompts/draft.md
 */
export function buildDraftPrompt(
  request: BlogRequest,
  research: ResearchOutput,
  outline: OutlineOutput
): PromptResult {
  // Render the structured outline into a readable text block
  const outlineSections = outline.sections
    .map((s) => {
      const subs = s.subheadings?.length
        ? `\n  Subheadings: ${s.subheadings.join(", ")}`
        : "";
      return `## ${s.heading}\n  Notes: ${s.notes}${subs}`;
    })
    .join("\n\n");

  return loadPrompt(TEMPLATE, {
    TITLE: request.title,
    AUDIENCE: request.audience,
    KEYWORD: request.targetKeyword,
    CTA: request.cta,
    TOPIC_FRAMING: research.topicFraming,
    QUESTIONS: research.questionsToAnswer.join(" | "),
    KEYWORD_NOTES: research.keywordNotes,
    OUTLINE_SECTIONS: outlineSections,
    ESTIMATED_WORD_COUNT: String(outline.estimatedWordCount),
  });
}
