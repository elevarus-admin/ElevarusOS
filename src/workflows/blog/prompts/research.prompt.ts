import * as path from "path";
import { BlogRequest } from "../../../models/blog-request.model";
import { loadPrompt, PromptResult } from "../../../core/prompt-loader";

const TEMPLATE = path.join(__dirname, "research.md");

/**
 * Builds the research stage prompt from research.md.
 *
 * ✏️  To tune the base prompt:    src/workflows/blog/prompts/research.md
 * ✏️  Per-client override:        src/clients/{clientId}/blog/research.md
 *
 * Client brand vars (BRAND_VOICE, BRAND_AUDIENCE, etc.) are automatically
 * injected when the request has a clientId set.
 */
export function buildResearchPrompt(request: BlogRequest): PromptResult {
  return loadPrompt(
    TEMPLATE,
    {
      TITLE: request.title,
      BRIEF: request.brief,
      AUDIENCE: request.audience || "{{BRAND_AUDIENCE}}",
      KEYWORD: request.targetKeyword,
      CTA: request.cta,
    },
    { instanceId: request.workflowType }
  );
}
