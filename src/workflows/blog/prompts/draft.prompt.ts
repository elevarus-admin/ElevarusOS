import { BlogRequest } from "../../../models/blog-request.model";
import { ResearchOutput, OutlineOutput } from "../../../models/output.model";

export function buildDraftPrompt(
  request: BlogRequest,
  research: ResearchOutput,
  outline: OutlineOutput
): string {
  const outlineText = outline.sections
    .map((s) => {
      const subs = s.subheadings?.length
        ? `\n  Subheadings: ${s.subheadings.join(", ")}`
        : "";
      return `## ${s.heading}\n  Notes: ${s.notes}${subs}`;
    })
    .join("\n\n");

  return `You are a professional blog writer for a digital marketing agency.

Write a complete, publication-ready first-draft blog post using the outline and research below.

<request>
Title: ${request.title}
Target audience: ${request.audience}
Primary keyword: ${request.targetKeyword}
CTA: ${request.cta}
</request>

<research>
Topic framing: ${research.topicFraming}
Key questions to answer: ${research.questionsToAnswer.join(" | ")}
Keyword notes: ${research.keywordNotes}
</research>

<outline>
${outlineText}
</outline>

Writing guidelines:
- Write for the specified audience — match their vocabulary, knowledge level, and concerns
- Use the primary keyword naturally throughout; avoid keyword stuffing
- Use short paragraphs (2-4 sentences), conversational but professional tone
- Open with a strong hook in the introduction
- Close with a clear, compelling CTA: "${request.cta}"
- Do not include placeholder text or "[CITATION NEEDED]" markers — write the best draft you can
- Target approximately ${outline.estimatedWordCount} words

Return ONLY valid JSON — no markdown fences or explanation:

{
  "title": "<final blog post title>",
  "body": "<full markdown body of the blog post>",
  "wordCount": <integer>
}`;
}
