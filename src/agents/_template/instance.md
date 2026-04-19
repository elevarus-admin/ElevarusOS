---
# ─── Required ─────────────────────────────────────────────────────────────────
id: your-instance-id          # must match the directory name exactly
name: Your Bot Instance Name  # shown in logs and the future UI
baseWorkflow: blog            # which base workflow to use: blog | reporting
enabled: true

# ─── Brand / Voice ────────────────────────────────────────────────────────────
# These values are injected into every prompt as {{BRAND_VOICE}} etc.
# Override individual prompts by adding files to this instance's prompts/ folder.

brand:
  voice: "Describe the writing style here. e.g. Professional, warm, jargon-free."
  audience: "Describe the target reader. e.g. Small business owners in the HVAC industry."
  tone: "e.g. Confident and approachable"
  industry: "e.g. Digital Marketing"   # optional

# ─── Notifications ────────────────────────────────────────────────────────────
notify:
  approver: approver@example.com     # who gets approval request emails
  slackChannel: ~                    # optional Slack channel ID (e.g. C0123456789)

# ─── Schedule (optional) ──────────────────────────────────────────────────────
# Set enabled: true and provide a cron expression to run this bot on a schedule.
# All cron times are UTC. Use https://crontab.guru to build expressions.
schedule:
  enabled: false
  cron: ~                            # e.g. "0 9 * * 1" = every Monday at 9am UTC
  description: ~                     # human-readable e.g. "Weekly blog on Mondays"
---

# Your Bot Instance Name

One paragraph describing what this bot instance does, which client/campaign it serves,
and what it produces.

## Prompt customisation

To override a base prompt for this instance:
1. Copy the base `.md` file from `src/workflows/<baseWorkflow>/prompts/`
2. Place it in `src/instances/<id>/prompts/` with the same filename
3. Edit freely — this file takes priority over the base for this instance only

Available brand placeholders (auto-injected into all prompts):

| Placeholder        | Value source          |
|--------------------|-----------------------|
| `{{INSTANCE_NAME}}`| name (above)          |
| `{{BRAND_VOICE}}`  | brand.voice           |
| `{{BRAND_AUDIENCE}}`| brand.audience       |
| `{{BRAND_TONE}}`   | brand.tone            |
| `{{BRAND_INDUSTRY}}`| brand.industry       |
