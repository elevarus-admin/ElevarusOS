# Tools — HVAC Campaign Report Bot

ElevarusOS exposes the following endpoints + integration tools this agent uses.

---

## Data — Expense (Meta Ads)

```
GET /api/data/meta/spend?instanceId=hvac-reporting&period=mtd
```

Reads `meta.adAccountId` from this agent's `instance.md` (`24568971736103024`).
Returns `totalSpend`, `cpc`, `ctr`.

---

## Data — Revenue (Thumbtack — PENDING)

No live API integration yet. Revenue source is a shared report — "daily sessions" tab, sum of `owed revenue` column.

Once the proposed `hvac-thumbtack-report-import` agent is built, this workflow will read from a Supabase table populated by that agent (e.g. `thumbtack_daily_sessions` — `date, sessions, owed_revenue`).

Open design questions for the import agent:
- What's the share format? Google Sheet, CSV email attachment, Thumbtack web download?
- How is the sheet authenticated (Google service account, IMAP creds, manual upload)?
- Daily cadence — when does the source sheet update?

---

## Action — Post to Slack

```
POST /api/actions/slack
Content-Type: application/json

{
  "channel": "cli-hvac",
  "text": "Plain text fallback (required)",
  "blocks": [ ... ]
}
```

---

## Environment

| Var | Description |
|-----|-------------|
| `META_ACCESS_TOKEN` | Meta ad-spend source — must include account `24568971736103024` |
| `SLACK_BOT_TOKEN` | `xoxb-...` — must be invited to `#cli-hvac` |
