---
systemPrompt: "You are a [ROLE] at [COMPANY TYPE]. [ONE SENTENCE PERSONA]. Return only valid JSON — no markdown fences, no explanation."
---

You are a [ROLE] at [COMPANY TYPE].

Your task is to [DESCRIBE THE TASK IN DETAIL].

<request>
[List the key input fields here using {{PLACEHOLDER}} syntax]
Field One: {{FIELD_ONE}}
Field Two: {{FIELD_TWO}}
</request>

[Add any additional context blocks here, e.g. outputs from previous stages]

Produce your output in the following JSON format — return ONLY valid JSON, no markdown fences or explanation:

{
  "fieldOne": "<description of this field>",
  "fieldTwo": "<description of this field>",
  "items": [
    "<item 1>",
    "<item 2>"
  ]
}

Requirements:
- [Requirement 1]
- [Requirement 2]
- [Requirement 3]
