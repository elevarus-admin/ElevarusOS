# ElevarusOS REST API Reference

The ElevarusOS API server runs on port `3001` by default (configurable via `API_PORT`). It exposes endpoints for managing bot instances, querying job state, submitting new workflow jobs, fetching integration data, and handling approval actions.

---

## Authentication

**API key (optional).** Set `API_SECRET` in `.env` to require an `x-api-key` header on every request. When `API_SECRET` is unset, the server accepts all requests without authentication.

```
x-api-key: <your-API_SECRET-value>
```

Webhook routes (`/api/webhooks/*`) are exempt from API key auth and use their own signature verification.

---

## Endpoints

### GET /api/health

Liveness check. Returns immediately without hitting any dependencies.

**Response**

```json
{
  "status": "ok",
  "uptime": 3821.4,
  "ts": "2026-04-17T14:22:00.000Z"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `"ok"` | Always `"ok"` when the process is running |
| `uptime` | number | Process uptime in seconds (`process.uptime()`) |
| `ts` | string | Current time (ISO 8601) |

**Example**

```bash
curl http://localhost:3001/api/health
```

---

### GET /api/bots

Returns all registered bot instances with a summary of their last job.

**Response**

```json
{
  "bots": [
    {
      "instanceId": "final-expense-reporting",
      "name": "Final Expense Campaign Report Bot",
      "baseWorkflow": "ppc-campaign-report",
      "enabled": true,
      "brand": {
        "voice": "Clear, concise, numbers-first.",
        "tone": "Analytical and direct"
      },
      "schedule": {
        "enabled": true,
        "cron": "0 9,11,13,15,17 * * 1-5",
        "description": "Weekday campaign report every 2 hours 9am-5pm EST"
      },
      "notify": {
        "approver": null
      },
      "stats": {
        "total": 42,
        "running": 0,
        "lastJobId": "a1b2c3d4-...",
        "lastJobStatus": "completed",
        "lastJobAt": "2026-04-17T11:00:01.000Z",
        "lastJobTitle": "Final Expense MTD Report"
      }
    }
  ]
}
```

**Example**

```bash
curl http://localhost:3001/api/bots
```

---

### GET /api/bots/:instanceId

Returns full config and job statistics for a single instance.

**Path parameters**

| Parameter | Description |
|-----------|-------------|
| `instanceId` | Instance slug (e.g. `final-expense-reporting`) |

**Response**

```json
{
  "instanceId": "elevarus-blog",
  "config": {
    "id": "elevarus-blog",
    "name": "Elevarus Blog Bot",
    "baseWorkflow": "blog",
    "enabled": true,
    "brand": { ... },
    "notify": { ... },
    "schedule": { ... }
  },
  "stats": {
    "total": 12,
    "byStatus": {
      "completed": 10,
      "failed": 1,
      "awaiting_approval": 1
    },
    "recentJobs": [
      {
        "jobId": "a1b2c3d4-...",
        "status": "completed",
        "title": "How AI is transforming agency operations",
        "createdAt": "2026-04-15T09:00:00.000Z",
        "completedAt": "2026-04-15T09:07:32.000Z"
      }
    ]
  }
}
```

**Error responses**

| Status | Condition |
|--------|-----------|
| 404 | Instance ID not found |

**Example**

```bash
curl http://localhost:3001/api/bots/elevarus-blog
```

---

### GET /api/jobs

List jobs with optional filtering. Returns the most recent jobs first.

**Query parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | — | Filter by job status: `queued`, `running`, `awaiting_approval`, `approved`, `rejected`, `completed`, `failed` |
| `instanceId` | string | — | Filter by workflow type / instance ID |
| `limit` | number | `50` | Max results per page. Capped at `200` |
| `offset` | number | `0` | Number of records to skip (for pagination) |

**Response**

```json
{
  "jobs": [
    {
      "jobId": "a1b2c3d4-e5f6-...",
      "workflowType": "final-expense-reporting",
      "status": "completed",
      "title": "Final Expense MTD Report",
      "createdAt": "2026-04-17T11:00:00.000Z",
      "updatedAt": "2026-04-17T11:01:45.000Z",
      "completedAt": "2026-04-17T11:01:45.000Z",
      "currentStage": null,
      "completedStages": 4,
      "totalStages": 4,
      "approvalPending": false,
      "error": null
    }
  ],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

**Example**

```bash
# All running jobs
curl "http://localhost:3001/api/jobs?status=running"

# Last 10 jobs for the blog bot
curl "http://localhost:3001/api/jobs?instanceId=elevarus-blog&limit=10"
```

---

### GET /api/jobs/:jobId

Full job detail including all stage records.

**Path parameters**

| Parameter | Description |
|-----------|-------------|
| `jobId` | UUID assigned to the job when it was created |

**Response**

```json
{
  "jobId": "a1b2c3d4-...",
  "workflowType": "elevarus-blog",
  "status": "completed",
  "title": "How AI is transforming agency operations",
  "createdAt": "2026-04-15T09:00:00.000Z",
  "updatedAt": "2026-04-15T09:07:32.000Z",
  "completedAt": "2026-04-15T09:07:32.000Z",
  "error": null,
  "request": {
    "title": "How AI is transforming agency operations",
    "brief": "...",
    "audience": "Digital agency owners",
    "targetKeyword": "AI agency operations",
    "cta": "Book a strategy call",
    "approver": "shane@elevarus.com",
    "workflowType": "elevarus-blog"
  },
  "approval": {
    "required": true,
    "approved": true,
    "approvedBy": "dashboard",
    "approvedAt": "2026-04-15T09:06:00.000Z"
  },
  "publishRecord": null,
  "stages": [
    {
      "name": "research",
      "status": "completed",
      "attempts": 1,
      "startedAt": "2026-04-15T09:00:05.000Z",
      "completedAt": "2026-04-15T09:01:10.000Z",
      "error": null,
      "hasOutput": true
    }
  ]
}
```

Note: `stages[].hasOutput` is `true` when stage output is stored. Retrieve the actual output via `GET /api/jobs/:jobId/output`.

**Error responses**

| Status | Condition |
|--------|-----------|
| 404 | Job ID not found |

**Example**

```bash
curl http://localhost:3001/api/jobs/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

---

### GET /api/jobs/:jobId/output

Returns the full stage outputs for a job. Most useful after a job completes.

The response surfaces the most commonly needed outputs at the top level as shortcuts, and includes the complete stage-by-stage output map.

**Path parameters**

| Parameter | Description |
|-----------|-------------|
| `jobId` | Job UUID |

**Response**

```json
{
  "jobId": "a1b2c3d4-...",
  "workflowType": "final-expense-reporting",
  "status": "completed",
  "title": "Final Expense MTD Report",
  "completedAt": "2026-04-17T11:01:45.000Z",

  "report": "## Final Expense MTD Report\n\n...",
  "slackMessage": "MTD: 312 calls | 198 billable | $14,220 revenue",
  "alertLevel": "green",
  "oneLiner": "Strong MTD performance — revenue 12% above target",
  "finalDraft": null,
  "initialDraft": null,

  "stages": {
    "data-collection": { ... },
    "summary": {
      "markdownReport": "## Final Expense MTD Report\n\n...",
      "slackMessage": "MTD: 312 calls | 198 billable | $14,220 revenue",
      "alertLevel": "green",
      "oneLiner": "Strong MTD performance — revenue 12% above target"
    },
    "slack-publish": { ... }
  }
}
```

**Top-level shortcut fields**

| Field | Source | Description |
|-------|--------|-------------|
| `report` | `stages.summary.markdownReport` | Full markdown report (reporting workflows) |
| `slackMessage` | `stages.summary.slackMessage` | Short Slack-formatted summary text |
| `alertLevel` | `stages.summary.alertLevel` | `green`, `yellow`, or `red` |
| `oneLiner` | `stages.summary.oneLiner` | Single-sentence headline |
| `finalDraft` | `stages.editorial.editedDraft` | Final edited blog post (blog workflows) |
| `initialDraft` | `stages.drafting.draft` | Initial draft before editorial (blog workflows) |

**Example**

```bash
# Get the markdown report from a reporting job
curl http://localhost:3001/api/jobs/<jobId>/output | jq '.report'

# Get the final blog draft
curl http://localhost:3001/api/jobs/<jobId>/output | jq '.finalDraft'
```

---

### POST /api/jobs

Submit a new workflow job.

Runs the workflow asynchronously in-process via the `Orchestrator`. Returns `202` immediately with a `jobId` to poll.

**Request body**

```json
{
  "workflowType": "elevarus-blog",
  "title": "How AI is reshaping agency billing",
  "brief": "Cover the shift from hourly billing to outcome-based pricing in AI-powered agencies. Include 2-3 real examples.",
  "audience": "Digital agency owners",
  "targetKeyword": "AI agency billing",
  "cta": "Book a free strategy call",
  "approver": "shane@elevarus.com"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `workflowType` | Yes | Instance ID — must match a registered workflow (see `GET /api/instances`) |
| `title` | Yes | Job title / blog post title |
| `brief` | Yes | Content brief or instructions for the agent |
| `audience` | No | Target reader description |
| `targetKeyword` | No | Primary SEO keyword |
| `cta` | No | Call-to-action text |
| `approver` | No | Email address for approval notifications |

**Response**

```json
{
  "message": "Job submitted",
  "jobId": "a1b2c3d4-...",
  "workflowType": "elevarus-blog",
  "pollUrl": "/api/jobs/a1b2c3d4-..."
}
```

**Error responses**

| Status | Condition |
|--------|-----------|
| 400 | Missing required fields (`workflowType`, `title`, or `brief`) |
| 400 | `workflowType` not registered in the workflow registry |
| 503 | Orchestrator is not available |

**Example**

```bash
curl -X POST http://localhost:3001/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "workflowType": "elevarus-blog",
    "title": "How AI is reshaping agency billing",
    "brief": "Cover the shift to outcome-based pricing in AI-powered agencies.",
    "audience": "Digital agency owners",
    "targetKeyword": "AI agency billing",
    "cta": "Book a free strategy call",
    "approver": "shane@elevarus.com"
  }'
```

---

### GET /api/schedule

Returns all instances that have scheduling enabled, with their cron expression and description.

**Response**

```json
{
  "schedule": [
    {
      "instanceId": "final-expense-reporting",
      "name": "Final Expense Campaign Report Bot",
      "cron": "0 9,11,13,15,17 * * 1-5",
      "description": "Weekday campaign report every 2 hours 9am-5pm EST",
      "timezone": "UTC"
    }
  ]
}
```

Note: `timezone` is always `"UTC"` in the API response. Cron expressions in `instance.md` may reference a local timezone in their comments, but the scheduler runs them in UTC.

**Example**

```bash
curl http://localhost:3001/api/schedule
```

---

### GET /api/instances

Returns all configured instance configs, including disabled ones.

**Response**

```json
{
  "instances": [
    {
      "id": "elevarus-blog",
      "name": "Elevarus Blog Bot",
      "baseWorkflow": "blog",
      "enabled": true,
      "brand": {
        "voice": "Conversational but authoritative...",
        "audience": "Digital agency owners...",
        "tone": "Confident, practical, forward-thinking",
        "industry": "AI-powered agency operations"
      },
      "notify": {
        "approver": "shane@elevarus.com",
        "slackChannel": null
      },
      "schedule": {
        "enabled": false,
        "cron": null,
        "description": "On-demand — submitted via ClickUp or CLI"
      },
      "instanceDir": "/path/to/src/instances/elevarus-blog"
    }
  ]
}
```

**Example**

```bash
curl http://localhost:3001/api/instances
```

---

### POST /api/instances

Creates a new bot instance on disk. Register the workflow in `src/index.ts` and restart ElevarusOS to activate it.

**Request body**

```json
{
  "id": "acme-blog",
  "name": "Acme Blog Bot",
  "baseWorkflow": "blog",
  "voice": "Conversational and technical, written for developers",
  "audience": "Software engineers building SaaS products",
  "tone": "Practical, no-fluff",
  "industry": "Developer tools",
  "approver": "editor@acme.com",
  "slackChannel": "C0123456789"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique slug. Lowercase letters, numbers, and hyphens only (`^[a-z0-9][a-z0-9-]{0,62}$`) |
| `name` | Yes | Human-readable display name |
| `baseWorkflow` | No | `"blog"` (default) or `"ppc-campaign-report"` |
| `voice` | No | Brand voice descriptor |
| `audience` | No | Target reader description |
| `tone` | No | Tone descriptor |
| `industry` | No | Industry context |
| `approver` | No | Approver email for content workflows |
| `slackChannel` | No | Slack channel ID for notifications |

**Response**

```json
{
  "message": "Instance created",
  "id": "acme-blog",
  "name": "Acme Blog Bot",
  "baseWorkflow": "blog",
  "instanceDir": "/path/to/src/instances/acme-blog",
  "mcRegistered": false,
  "nextStep": "Add registry.register(buildBlogWorkflowDefinition(notifiers, \"acme-blog\")); to src/index.ts and restart."
}
```

`mcRegistered` is always `false`. Add the instance to `src/index.ts` and restart ElevarusOS — the agent appears in the Dashboard automatically.

**Error responses**

| Status | Condition |
|--------|-----------|
| 400 | `id` or `name` missing |
| 400 | `id` fails slug validation |
| 400 | `baseWorkflow` is not `"blog"` or `"ppc-campaign-report"` |
| 409 | Instance with this `id` already exists |

**Example**

```bash
curl -X POST http://localhost:3001/api/instances \
  -H "Content-Type: application/json" \
  -d '{
    "id": "acme-blog",
    "name": "Acme Blog Bot",
    "baseWorkflow": "blog",
    "voice": "Conversational and technical",
    "audience": "Software engineers",
    "tone": "Practical"
  }'
```

---

### GET /api/data/ringba/revenue

Fetches revenue metrics for a Ringba campaign over a specified period. Designed to be called by MC agents as a data tool during task execution.

**Query parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `campaign` | Conditional | Ringba campaign name (e.g. `O&O_SOMQ_FINAL_EXPENSE`). Required if `instanceId` is not provided or the instance has no `ringba.campaignName` configured |
| `instanceId` | Conditional | Instance ID to read `ringba.campaignName` from (e.g. `final-expense-reporting`) |
| `period` | No | `mtd` (default), `wtd`, `ytd`, or `custom` |
| `startDate` | Conditional | `YYYY-MM-DD` — required when `period=custom` |
| `endDate` | Conditional | `YYYY-MM-DD` — required when `period=custom` |

**Period defaults**

| Period | Date range |
|--------|------------|
| `mtd` | 1st of current month through today |
| `wtd` | Monday of current week through today |
| `ytd` | January 1st of current year through today |
| `custom` | `startDate` to `endDate` (both required) |

**Response**

```json
{
  "campaign": "O&O_SOMQ_FINAL_EXPENSE",
  "campaignId": "CA_abc123",
  "period": "2026-04-01 → 2026-04-17",
  "startDate": "2026-04-01",
  "endDate": "2026-04-17",
  "totalCalls": 312,
  "paidCalls": 198,
  "totalRevenue": 14220.00,
  "totalPayout": 9900.00,
  "avgPayout": 71.82,
  "pulledAt": "2026-04-17T14:30:00.000Z"
}
```

| Field | Description |
|-------|-------------|
| `totalCalls` | Calls meeting the duration threshold (MTD: all calls; see Ringba integration docs for filtering logic) |
| `paidCalls` | Calls where `hasPayout=true` and `isDuplicate=false` |
| `totalRevenue` | Sum of `conversionAmount` across all records (buyer revenue, USD) |
| `totalPayout` | Sum of `payoutAmount` (publisher payout, USD) |
| `avgPayout` | `totalRevenue / paidCalls` |

**Error responses**

| Status | Condition |
|--------|-----------|
| 400 | Neither `campaign` nor a valid `instanceId` with `ringba.campaignName` was provided |
| 503 | `RINGBA_API_KEY` or `RINGBA_ACCOUNT_ID` not configured |
| 500 | Ringba API call failed |

**Example**

```bash
# By campaign name
curl "http://localhost:3001/api/data/ringba/revenue?campaign=O%26O_SOMQ_FINAL_EXPENSE&period=mtd"

# By instance ID
curl "http://localhost:3001/api/data/ringba/revenue?instanceId=final-expense-reporting&period=wtd"

# Custom date range
curl "http://localhost:3001/api/data/ringba/revenue?campaign=O%26O_SOMQ_FINAL_EXPENSE&period=custom&startDate=2026-04-01&endDate=2026-04-07"
```

---

### GET /api/data/ringba/campaigns

Lists all Ringba campaigns available on the configured account. Useful for MC agents discovering which campaigns exist before querying revenue.

**Response**

```json
{
  "campaigns": [
    { "id": "CA_abc123", "name": "O&O_SOMQ_FINAL_EXPENSE", "enabled": true },
    { "id": "CA_def456", "name": "O&O_SOMQ_U65", "enabled": true }
  ],
  "count": 2
}
```

**Error responses**

| Status | Condition |
|--------|-----------|
| 503 | Ringba not configured |

**Example**

```bash
curl http://localhost:3001/api/data/ringba/campaigns
```

---

### POST /api/actions/slack

Posts a message to a Slack channel. Designed to be called by MC agents after they have formatted their output. ElevarusOS handles authentication and delivery.

**Request body**

```json
{
  "channel": "C0123456789",
  "text": "MTD: 312 calls | 198 billable | $14,220 revenue",
  "blocks": [
    {
      "type": "header",
      "text": { "type": "plain_text", "text": "Final Expense MTD Report" }
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `channel` | Yes | Slack channel ID (`C...`) or name (`#channel-name`). The bot must be a member of the channel |
| `text` | Yes | Plain-text fallback (required by Slack for notifications) |
| `blocks` | No | Slack Block Kit blocks array for rich formatting |

**Response**

```json
{
  "published": true,
  "ts": "1713362400.123456",
  "channel": "C0123456789"
}
```

`ts` is the Slack message timestamp. Save it to post thread replies.

**Error responses**

| Status | Condition |
|--------|-----------|
| 400 | `channel` or `text` missing |
| 500 | Slack API call failed (check `SLACK_BOT_TOKEN`) |

**Example**

```bash
curl -X POST http://localhost:3001/api/actions/slack \
  -H "Content-Type: application/json" \
  -d '{
    "channel": "C0123456789",
    "text": "MTD: 312 calls | 198 billable | $14,220 revenue"
  }'
```

---

### POST /api/jobs/:jobId/approve

Approves a job that is waiting at the `approval_notify` stage. Resolves the `ApprovalStore` promise, allowing the workflow to resume with the remaining stages.

**Path parameters**

| Parameter | Description |
|-----------|-------------|
| `jobId` | UUID of the job to approve |

**Response**

```json
{ "approved": true, "jobId": "a1b2c3d4-..." }
```

**Error responses**

| Status | Condition |
|--------|-----------|
| 404 | No pending approval for this job ID |

**Example**

```bash
curl -X POST http://localhost:3001/api/jobs/a1b2c3d4-.../approve \
  -H "x-api-key: $API_SECRET"
```

---

### POST /api/jobs/:jobId/reject

Rejects a job that is waiting at the `approval_notify` stage. Resolves the `ApprovalStore` promise with `false`, causing the Orchestrator to mark the job `rejected`.

**Path parameters**

| Parameter | Description |
|-----------|-------------|
| `jobId` | UUID of the job to reject |

**Response**

```json
{ "approved": false, "jobId": "a1b2c3d4-..." }
```

**Error responses**

| Status | Condition |
|--------|-----------|
| 404 | No pending approval for this job ID |

**Example**

```bash
curl -X POST http://localhost:3001/api/jobs/a1b2c3d4-.../reject \
  -H "x-api-key: $API_SECRET"
```

---

### POST /api/webhooks/slack/interactions

Receives Slack Block Kit interactive button payloads (Approve/Reject buttons on the approval message). This endpoint is called by Slack — you do not call it directly.

**Authentication**

Verifies the `X-Slack-Signature` header using `SLACK_SIGNING_SECRET` when set. Skipped if the env var is absent (acceptable for local dev).

**Handled actions**

| `action_id` | Behavior |
|-------------|----------|
| `approve_job` | Calls `approvalStore.notifyApproval(jobId, true)` |
| `reject_job` | Calls `approvalStore.notifyApproval(jobId, false)` |

The `value` field on the button contains the `jobId`. After handling the action, ElevarusOS calls Slack's `response_url` to update the original message with the decision.

**Response**

Returns `200 OK` immediately (Slack requires acknowledgement within 3 seconds).

**Error responses**

| Status | Condition |
|--------|-----------|
| 401 | Invalid Slack signature (when `SLACK_SIGNING_SECRET` is set) |
