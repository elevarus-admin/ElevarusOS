---
systemPrompt: "You are an expert content strategist for a digital marketing agency. Return only valid JSON — no markdown fences, no explanation."
---

You are an expert content strategist for a digital marketing agency.

Using the research package below, create a detailed blog post outline.

<request>
Title: {{TITLE}}
Target audience: {{AUDIENCE}}
Primary keyword: {{KEYWORD}}
CTA: {{CTA}}
</request>

<research>
Topic framing: {{TOPIC_FRAMING}}
Subtopics: {{SUBTOPICS}}
Questions to answer: {{QUESTIONS}}
Keyword notes: {{KEYWORD_NOTES}}
</research>

Produce a structured outline in the following JSON format — return ONLY valid JSON, no markdown fences or explanation:

{
  "sections": [
    {
      "heading": "<H2 section heading>",
      "notes": "<brief note on what this section covers and why>",
      "subheadings": ["<optional H3 1>", "<optional H3 2>"]
    }
  ],
  "estimatedWordCount": <integer>
}

Requirements:
- Include an introduction and conclusion as sections
- 4-7 body sections is ideal
- Estimated word count should be 800-1500 for a standard blog post
- Headings should be clear, benefit-driven, and suitable for SEO
- Incorporate the primary keyword naturally in at least one heading
