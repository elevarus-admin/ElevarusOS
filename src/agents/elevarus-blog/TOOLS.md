# Tools — Elevarus Blog Bot

## Available Capabilities

### Claude API (via ElevarusOS)
- Model: `claude-opus-4-7`
- Used for: research, outlining, drafting, analysis, summarisation

### Blog Stages
- `research` — topic and keyword research
- `outline` — structure generation
- `drafting` — full article draft
- `editorial` — polish and fact-check
- `publish_placeholder` — delivery to publish adapters

### Notifications
- Slack: not configured (set `notify.slackChannel` in instance.md)
- Email: via Microsoft Graph adapter

### Mission Control Integration
- Tasks polled from MC queue automatically
- Status updates pushed to MC in real time
- Approval gate: task moves to `review` awaiting human sign-off