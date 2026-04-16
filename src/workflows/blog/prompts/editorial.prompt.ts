import * as path from "path";
import { BlogRequest } from "../../../models/blog-request.model";
import { DraftOutput } from "../../../models/output.model";
import { loadPrompt, PromptResult } from "../../../core/prompt-loader";

const TEMPLATE = path.join(__dirname, "editorial.md");

/**
 * Builds the editorial stage prompt from editorial.md.
 *
 * ✏️  To tune editorial rules, quality standards, or the JSON output schema:
 *     edit  src/workflows/blog/prompts/editorial.md
 */
export function buildEditorialPrompt(
  request: BlogRequest,
  draft: DraftOutput
): PromptResult {
  return loadPrompt(TEMPLATE, {
    KEYWORD: request.targetKeyword,
    DRAFT_TITLE: draft.title,
    DRAFT_BODY: draft.body,
  });
}
