---
# ─── Required fields ─────────────────────────────────────────────────────────
type: your-bot-type          # unique identifier — becomes job.workflowType
name: Your Bot Name
version: 1.0.0
description: One sentence describing what this bot produces

# ─── Optional ─────────────────────────────────────────────────────────────────
author: Elevarus

# ─── Stages (in execution order) ─────────────────────────────────────────────
# Each entry MUST have a `name` matching the IStage.stageName in your stage file.
# `label` and `description` are for humans and docs only — not used at runtime.
# Set aiPowered: true and add a promptFile for Claude-powered stages.

stages:
  - name: intake
    label: Intake
    description: Validates and ingests the incoming request
    aiPowered: false

  - name: process
    label: Process
    description: Claude processes the input and produces structured output
    aiPowered: true
    promptFile: process.md      # relative to this workflow's prompts/ directory

  - name: notify
    label: Notify
    description: Sends completion notification via configured notifiers
    aiPowered: false

# ─── Orchestration config ─────────────────────────────────────────────────────
config:
  requiresApproval: false       # set to true if a human must approve before completion
  approvalStage: ~              # stage name that triggers awaiting_approval status
  maxRetries: 2                 # per-stage retry limit (overrides global MAX_STAGE_RETRIES)
---

# Your Bot Name

One paragraph describing what this bot does, who it's for, and what it produces.

## How it works

```
intake → process → notify
```

Describe each stage in plain English.

## Tuning the AI stages

Each Claude-powered stage has a Markdown prompt file in `prompts/`. Edit these to
change the bot's persona, instructions, or JSON output format without touching TypeScript.

| Stage   | Prompt File        | Controls                     |
|---------|--------------------|------------------------------|
| process | prompts/process.md | Persona, task, output schema |

### Prompt file format

```markdown
---
systemPrompt: "You are a ... Return only valid JSON."
---

Your task is to ...

Title: {{TITLE}}
Context: {{CONTEXT}}
```

- `systemPrompt` — the Claude system message (persona + constraints)
- Body — the user message template; `{{PLACEHOLDER}}` markers are filled at runtime
- All static text (instructions, JSON schema) is editable here with no code changes

## Input fields

Describe what fields the intake adapter needs to supply.

## Output

Describe what the completed job contains and where to find the useful data.

## How to wire this up

1. Complete the stages in `stages/` (see `_stage.stage.ts` template)
2. Complete the prompt files in `prompts/` (see `_stage.md` template)
3. Complete `<name>.workflow.ts` (see template)
4. In `src/index.ts`, import and register:
   ```typescript
   import { buildYourBotWorkflowDefinition } from "./workflows/your-bot-type/your-bot-type.workflow";
   registry.register(buildYourBotWorkflowDefinition(notifiers));
   ```
