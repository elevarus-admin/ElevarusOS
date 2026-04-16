---
type: blog
name: Blog Bot
version: 1.0.0
description: End-to-end blog post creation — research, outline, draft, editorial review, and approval workflow
author: Elevarus

stages:
  - name: intake
    label: Intake
    description: Validates and records the incoming blog request from any intake source
    aiPowered: false

  - name: normalization
    label: Normalization
    description: Detects missing fields and marks the request complete or flags it for follow-up
    aiPowered: false

  - name: research
    label: Research
    description: Claude generates topic framing, subtopics, key questions, source suggestions, and keyword strategy
    aiPowered: true
    promptFile: research.md

  - name: outline
    label: Outline
    description: Claude creates a structured H2/H3 outline from the research package
    aiPowered: true
    promptFile: outline.md

  - name: drafting
    label: Drafting
    description: Claude writes a complete first-draft blog post following the outline and research
    aiPowered: true
    promptFile: draft.md

  - name: editorial
    label: Editorial
    description: Claude edits the draft for clarity, flow, SEO keyword placement, and CTA strength
    aiPowered: true
    promptFile: editorial.md

  - name: approval_notify
    label: Approval Notification
    description: Dispatches the draft to the approver via all configured notifiers (Slack, email)
    aiPowered: false

  - name: publish_placeholder
    label: Publish Placeholder
    description: Records publish intent and hands off to a publish adapter when one is configured
    aiPowered: false

  - name: completion
    label: Completion
    description: Sends a workflow-complete notification to the approver
    aiPowered: false

config:
  requiresApproval: true
  approvalStage: approval_notify
  maxRetries: 2
---

# Blog Bot

The Blog Bot automates the full lifecycle of a blog post — from intake of a content brief through
research, outlining, drafting, editorial review, and approval — using Claude Opus as the AI engine.

## How it works

```
intake → normalization → research → outline → drafting → editorial → approval_notify → publish_placeholder → completion
```

1. A content brief is submitted via ClickUp task, email, or the `--once` CLI mode
2. Claude researches the topic and builds a structured knowledge package
3. Claude creates a detailed section-by-section outline
4. Claude writes a complete first draft following the outline
5. Claude performs an editorial pass (clarity, flow, SEO, CTA)
6. The edited draft is sent to the approver via Slack and/or email
7. On approval, the job moves to the publish stage (placeholder until a CMS is wired up)

## Tuning the AI stages

Each Claude-powered stage has its own Markdown prompt file. Edit these to change
how the bot writes, what persona it uses, or what JSON it returns:

| Stage      | Prompt File                     | Controls                                  |
|------------|---------------------------------|-------------------------------------------|
| research   | prompts/research.md             | Researcher persona, output JSON schema    |
| outline    | prompts/outline.md              | Strategist persona, outline structure     |
| drafting   | prompts/draft.md                | Writer persona, style guidelines, length  |
| editorial  | prompts/editorial.md            | Editor persona, editorial rules           |

### Prompt file format

```markdown
---
systemPrompt: "You are a ... Return only valid JSON."
---

Your task is to ...

{{TITLE}}
{{BRIEF}}
```

- The `systemPrompt` frontmatter field sets the Claude system message (persona + hard rules)
- The body is the user message template
- `{{PLACEHOLDER}}` markers are filled at runtime from the job's request data

## Input fields

| Field           | Required | Source                          |
|-----------------|----------|---------------------------------|
| title           | Yes      | Email subject / ClickUp name    |
| brief           | Yes      | Email body / ClickUp custom field |
| audience        | Yes      | Email body / ClickUp custom field |
| targetKeyword   | Yes      | Email body / ClickUp custom field |
| cta             | Yes      | Email body / ClickUp custom field |
| approver        | No       | Email From / ClickUp assignee   |
| dueDate         | No       | ClickUp due date                |

## Output

The completed job record (stored in `data/jobs/<id>.json`) contains:
- `stages[].output` for each stage — the full JSON output from that stage
- `stages["editorial"].output.body` — the final edited blog post in Markdown
- `stages["editorial"].output.title` — the final edited title
- `approval` — approval state (approved/not, timestamp, approver)
- `publishRecord` — publish handoff metadata

## Environment variables

| Variable             | Required | Description                          |
|----------------------|----------|--------------------------------------|
| ANTHROPIC_API_KEY    | Yes      | Anthropic API key for Claude calls   |
| ANTHROPIC_MODEL      | No       | Defaults to claude-opus-4-7          |
| CLICKUP_API_TOKEN    | No       | ClickUp personal API token           |
| CLICKUP_LIST_ID      | No       | ClickUp list to poll for briefs      |
| MS_INTAKE_MAILBOX    | No       | O365 mailbox to poll for email briefs|
| MS_NOTIFY_FROM       | No       | O365 mailbox used to send approvals  |
| SLACK_BOT_TOKEN      | No       | Slack bot token (xoxb-...)           |
| SLACK_NOTIFY_CHANNEL | No       | Slack channel ID for notifications   |
