---
id: hvac-weather-notification
name: HVAC Weather Notification
baseWorkflow: hvac-weather-notification
enabled: true

brand:
  voice: "Concise operations alert. States-only, no prose."
  audience: "Elevarus media buyers and account managers running HVAC ad campaigns"
  tone: "Direct, signal-first"
  industry: "Home services — HVAC (heating, ventilation, air conditioning)"

notify:
  approver: ~
  slackChannel: cli-hvac

schedule:
  enabled: true
  cron: "0 6 * * *"
  timezone: America/Los_Angeles
  description: Daily at 6:00 AM Pacific — posts states under active NWS heat/cold alerts for HVAC ad targeting
---

# HVAC Weather Notification

Daily 6:00 AM Pacific notification to `#cli-hvac` listing US states
currently under active NWS heat or cold alerts — the ad-targeting signal
for AC (heat) and heating (cold) campaigns.

## Behavior

- Runs once daily; makes a single call to `api.weather.gov/alerts/active`
- If any HVAC-relevant alerts are active, posts one Slack message grouped
  into Heat and Cold buckets
- If both buckets are empty (common in late spring / early fall), **no
  Slack message is posted** — the run completes silently

## Alert types monitored

See `src/workflows/hvac-weather-notification/bot.md` for the full list.
Frost Advisory is intentionally excluded (not an HVAC buying trigger).

## Data source

NWS public API — free, no key, no rate limits relevant at daily cadence.
Requires a descriptive `User-Agent` header (already set in the stage).
