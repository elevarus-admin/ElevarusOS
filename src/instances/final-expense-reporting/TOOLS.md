# Tools — Final Expense Campaign Report Bot

ElevarusOS exposes the following endpoints this agent can call to get data and
trigger actions. The agent provides the intelligence (formatting, analysis,
decisions) — ElevarusOS provides the data and the delivery.

---

## Data APIs

### Ringba Revenue
```
GET /api/data/ringba/revenue
```
Returns live call and revenue metrics for the campaign.

**Query params:**
| Param | Required | Description |
|-------|----------|-------------|
| `instanceId` | yes* | `final-expense-reporting` — reads campaign config automatically |
| `campaign` | yes* | Ringba campaign name (alternative to instanceId) |
| `period` | no | `mtd` (default) \| `wtd` \| `ytd` \| `custom` |
| `startDate` | if custom | `YYYY-MM-DD` |
| `endDate` | if custom | `YYYY-MM-DD` |

*Either `instanceId` or `campaign` required.

**Response:**
```json
{
  "campaign": "O&O_SOMQ_FINAL_EXPENSE",
  "period": "2026-04-01 → 2026-04-16",
  "totalCalls": 177,
  "paidCalls": 61,
  "totalRevenue": 2881.10,
  "totalPayout": 2881.10,
  "avgPayout": 47.23,
  "pulledAt": "2026-04-16T14:23:00Z"
}
```

### Ringba Campaigns
```
GET /api/data/ringba/campaigns
```
Lists all campaigns in the account. Use to discover campaign names.

---

## Action APIs

### Post to Slack
```
POST /api/actions/slack
Content-Type: application/json

{
  "channel": "cli-final-expense",
  "text": "Plain text fallback (required)",
  "blocks": [ ... ]  // optional Block Kit layout
}
```
Returns: `{ published: true, ts: "1234567890.123456", channel: "cli-final-expense" }`

---

## ElevarusOS Workflow (automatic)

When a task is assigned to this agent in MC, ElevarusOS automatically:

1. **Data Collection** — calls Ringba API for MTD revenue
2. **Analysis** — Claude reads this agent's `MISSION.md` and analyzes the data
3. **Summary** — Claude formats the Slack message per `MISSION.md` format spec
4. **Slack Publish** — posts to `#cli-final-expense`
5. **Workspace update** — writes `WORKING.md` and appends to `MEMORY.md`
6. **MC notification** — updates task status to `done` with output as comment

---

## Environment

| Var | Description |
|-----|-------------|
| `RINGBA_API_KEY` | API token (Token auth, not Bearer) |
| `RINGBA_ACCOUNT_ID` | `RA7e98213968a843fb846e14751bbebdb4` |
| `SLACK_BOT_TOKEN` | `xoxb-...` — must be invited to `#cli-final-expense` |
