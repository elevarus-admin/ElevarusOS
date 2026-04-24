---
type: hvac-weather-notification
name: HVAC Weather Notification
version: 1.0.0
description: Daily Slack alert listing US states under active NWS heat/cold advisories, bucketed for AC and heating ad campaigns
author: Elevarus

stages:
  - name: fetch-alerts
    label: Fetch NWS Alerts
    description: Pulls active alerts from api.weather.gov and buckets HVAC-relevant events by state
    aiPowered: false

  - name: slack-publish
    label: Slack Publish
    description: Posts the bucketed state list to the configured Slack channel; skips when no HVAC-relevant alerts are active
    aiPowered: false

config:
  requiresApproval: false
  maxRetries: 2
---

# HVAC Weather Notification

Daily ad-campaign targeting signal. Pulls active NWS alerts once per morning
and posts to `#cli-hvac` with the US states currently affected by unusual
heat or cold — the HVAC buying moments for AC and heating respectively.

## How it works

```
fetch-alerts → slack-publish
```

1. **Fetch Alerts** — one GET to `https://api.weather.gov/alerts/active`.
   Filters features to HVAC-relevant event types and groups affected states
   via the first 2 chars of each UGC geocode (state abbreviation).
2. **Slack Publish** — if either bucket has states, posts one message to the
   configured channel. If both buckets are empty (common in shoulder
   seasons), the stage logs and skips — no Slack noise.

## Alert classification

**Heat (AC campaign target)**
- Excessive Heat Warning
- Excessive Heat Watch
- Heat Advisory

**Cold (Heating campaign target)**
- Extreme Cold Warning
- Extreme Cold Watch
- Cold Weather Advisory
- Wind Chill Warning
- Wind Chill Advisory
- Winter Storm Warning
- Winter Storm Watch
- Winter Weather Advisory
- Freeze Warning

**Explicitly excluded:** Frost Advisory (agricultural signal, not an HVAC
buying trigger — furnaces are already running in frost-advisory conditions).

## Inputs

No job inputs required. The fetch stage pulls live data from the NWS API.

## Output

- `stages["fetch-alerts"].output` — bucketed state lists and alert counts
- `stages["slack-publish"].output` — Slack message text, ts, skip reason
- Per-run markdown archive written to
  `src/instances/hvac-weather-notification/workspace/reports/YYYY-MM-DD.md`

## Environment

- `SLACK_BOT_TOKEN` — required for posting; stage no-ops with a warning if missing
- `DRY_RUN=true` — prints message to stdout instead of posting
