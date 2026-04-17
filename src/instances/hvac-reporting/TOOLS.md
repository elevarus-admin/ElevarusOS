# Tools — HVAC Campaign Report Bot

## Available Capabilities

### Claude API (via ElevarusOS)
- Model: `claude-opus-4-7`
- Used for: research, outlining, drafting, analysis, summarisation

### Reporting Stages
- `data-collection` — raw metric ingestion
- `analysis` — trend analysis and benchmarking
- `summary` — Claude-generated executive summary
- `slack-publish` — Slack delivery

### Notifications
- Slack: not configured (set `notify.slackChannel` in instance.md)
- Email: via Microsoft Graph adapter

### Mission Control Integration
- Tasks polled from MC queue automatically
- Status updates pushed to MC in real time
- Approval gate: task moves to `review` awaiting human sign-off