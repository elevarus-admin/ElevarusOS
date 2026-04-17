---
type: reporting
name: Campaign Report Bot
version: 1.0.0
description: Collects campaign performance data, generates an AI summary, and posts it to Slack
author: Elevarus

stages:
  - name: data-collection
    label: Data Collection
    description: Pulls raw campaign metrics from configured data sources (API, CSV, manual)
    aiPowered: false

  - name: analysis
    label: Analysis
    description: Claude analyses the raw data and identifies key trends, wins, and concerns
    aiPowered: true
    promptFile: analysis.md

  - name: summary
    label: Summary
    description: Claude produces a final formatted report (Markdown + Slack-ready text)
    aiPowered: true
    promptFile: summary.md

  - name: slack-publish
    label: Slack Publish
    description: Posts the summary to the configured Slack channel for this instance
    aiPowered: false

config:
  requiresApproval: false
  maxRetries: 2
---

# Campaign Report Bot

The Campaign Report Bot automates weekly (or on-demand) campaign performance reporting.
It collects metrics, uses Claude to surface insights, and posts a clean summary to Slack.

## How it works

```
data-collection → analysis → summary → slack-publish
```

1. **Data Collection** — pulls raw numbers from a configured data source
   (currently: manual JSON payload; future: Google Ads API, Meta API, CRM)
2. **Analysis** — Claude identifies trends, compares to prior period, flags anomalies
3. **Summary** — Claude writes a Slack-ready performance summary with key metrics and actions
4. **Slack Publish** — posts the formatted summary to the instance's Slack channel

## Tuning the AI stages

| Stage    | Prompt File              | Controls                              |
|----------|--------------------------|---------------------------------------|
| analysis | prompts/analysis.md      | Analyst persona, what to look for     |
| summary  | prompts/summary.md       | Report format, tone, what to include  |

Per-instance overrides: place a file with the same name in
`src/instances/<id>/prompts/` and it will be used instead of the base.

## Data source (TODO)

The `data-collection` stage currently accepts a manual JSON payload.
Future integrations:
- Google Ads API adapter
- Meta/Facebook Ads API adapter
- CSV file upload
- CRM webhook

## Inputs

| Field         | Required | Description                                  |
|---------------|----------|----------------------------------------------|
| title         | Yes      | Report title / period (e.g. "Week of Apr 14")|
| brief         | Yes      | Campaign context and what to focus on        |
| targetKeyword | No       | Campaign name / shortname                    |

## Output

- `stages["summary"].output.slackMessage` — Slack-formatted report text
- `stages["summary"].output.markdownReport` — full Markdown version
- Posted to the instance's configured Slack channel
