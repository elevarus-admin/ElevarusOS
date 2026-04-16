import { BlogRequest } from "../../../models/blog-request.model";
import { DraftOutput } from "../../../models/output.model";

export function buildEditorialPrompt(
  request: BlogRequest,
  draft: DraftOutput
): string {
  return `You are a senior content editor at a digital marketing agency.

Review and improve the draft blog post below. Your goals:
- Improve clarity, flow, and sentence variety
- Strengthen the hook and the CTA closing
- Ensure the primary keyword ("${request.targetKeyword}") is used naturally and effectively
- Fix any awkward phrasing, repetition, or structural issues
- Do NOT change the topic, the core argument, or add fabricated statistics
- Keep the word count within 10% of the original

<draft_title>${draft.title}</draft_title>

<draft_body>
${draft.body}
</draft_body>

Return ONLY valid JSON — no markdown fences or explanation:

{
  "title": "<final edited title>",
  "body": "<full edited markdown body>",
  "wordCount": <integer>,
  "editSummary": "<2-3 sentences summarising what was changed and why>"
}`;
}
