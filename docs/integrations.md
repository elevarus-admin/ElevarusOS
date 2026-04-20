# ElevarusOS Integration Reference

This document covers the external integrations used by ElevarusOS agents: Ringba (call tracking and revenue), LeadsProsper (lead routing and attribution), Meta Ads (ad spend, live), Google Ads (ad spend, Supabase-synced), Slack (notifications and report delivery), and Mission Control (task orchestration and agent management).

**Integration patterns.** Most data sources use the **Supabase-backed pattern**: a sync worker pulls API data into Supabase on a cron; workflows read from a repository class. Meta Ads is the exception — it stays on the live Graph API (ad spend is low-volume enough that caching isn't necessary yet). Google Ads ships Supabase-synced from day one because the Basic-tier API quota (15k ops/day) doesn't tolerate ad-hoc Slack queries. See [data-platform.md](./data-platform.md) for the pattern spec.

---

## Ringba

**Source:** `src/integrations/ringba/`

Supabase-backed. Workflows read via `getCampaignRevenue()` (now repository-first with live-API fallback) or `RingbaRepository` directly. The sync worker is the only code that calls Ringba's API in normal operation.

Pulls inbound call logs and revenue metrics from the Ringba Pay-Per-Call platform. Used by reporting agents (e.g. `final-expense-reporting`, `u65-reporting`) to produce campaign performance summaries.

### Configuration

| Env var | Description |
|---------|-------------|
| `RINGBA_API_KEY` | API Access Token. Ringba dashboard: Security > API Access Tokens |
| `RINGBA_ACCOUNT_ID` | Account ID visible in the `app.ringba.com` URL (format: `RA_XXXXXXXX`) |

The `RingbaHttpClient` checks for both variables at construction time. If either is missing, `client.enabled` is `false` and all functions return `null` without making any network calls. This is safe — reporting stages skip gracefully when the integration is not configured.

### Primary function: `getCampaignRevenue(opts)`

```typescript
import { getCampaignRevenue } from '../integrations/ringba';

const report = await getCampaignRevenue({
  campaignName:           'O&O_SOMQ_FINAL_EXPENSE',
  startDate:              '2026-04-01',
  endDate:                '2026-04-17',
  minCallDurationSeconds: 0,   // 0 = MTD/historical; 30 = real-time today
});
```

**Options**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `campaignName` | string | Yes | — | Exact Ringba campaign name |
| `startDate` | string | Yes | — | `YYYY-MM-DD` |
| `endDate` | string | Yes | — | `YYYY-MM-DD` |
| `minCallDurationSeconds` | number | No | `0` | Minimum call length for a record to count toward `totalCalls`. See call counting logic below |

**Returns:** `RingbaRevenueReport | null`

`null` is returned when Ringba is not configured or the campaign is not found.

**`RingbaRevenueReport` fields**

| Field | Type | Description |
|-------|------|-------------|
| `campaignId` | string | Ringba campaign ID |
| `campaignName` | string | Campaign name (as passed in opts) |
| `startDate` | string | Report start date |
| `endDate` | string | Report end date |
| `totalCalls` | number | Calls meeting `minCallDurationSeconds` threshold |
| `paidCalls` | number | Calls where `hasPayout=true`, `isDuplicate=false`, and duration >= threshold |
| `totalRevenue` | number | Sum of `conversionAmount` across all records (buyer revenue, USD) |
| `totalPayout` | number | Sum of `payoutAmount` (publisher payout, USD) |
| `avgPayout` | number | `totalRevenue / paidCalls` (0 when paidCalls is 0) |
| `calls` | `RingbaCallRecord[]` | Full raw call log (omitted from API responses to protect context window size) |

### Call counting logic

Ringba's API returns one record per routing attempt. A single inbound call can appear multiple times if it was tried at multiple buyers. The Ringba UI applies a minimum call duration (buffer time) to filter out routing failures.

ElevarusOS mirrors this logic:

**`totalCalls`** — records where `callLengthInSeconds >= minCallDurationSeconds`:
- `minCallDurationSeconds: 0` (default) — counts all records. Use this for MTD/historical date ranges where all calls are finalized. Matches the Ringba UI "Incoming" column exactly.
- `minCallDurationSeconds: 30` — filters out calls shorter than 30 seconds. Use this for the current day window, where real-time data includes in-progress calls and routing failures.

**`paidCalls`** — records where `hasPayout=true` AND `isDuplicate=false` AND `callLengthInSeconds >= minCallDurationSeconds`. With `minCallDurationSeconds: 0` (MTD), this matches the Ringba UI "Paid" column exactly. `paidCalls` can never exceed `totalCalls`.

**`totalRevenue`** — sum of `conversionAmount` across all records regardless of duration. Routing duplicates have `conversionAmount=0` so including them is safe.

**Mapping to the Pamela-style Slack report:**

| Slack report label | `RingbaRevenueReport` field |
|--------------------|------------------------------|
| "Total Calls" | `totalCalls` |
| "Total Billable Calls" | `paidCalls` |
| "Ringba Revenue" | `totalRevenue` |

### Convenience shortcuts

```typescript
import { getMTDRevenue, getWTDRevenue } from '../integrations/ringba';

// Month-to-date: 1st of current month through today, minCallDurationSeconds=0
const mtd = await getMTDRevenue('O&O_SOMQ_FINAL_EXPENSE');

// Week-to-date: Monday of current week through today
const wtd = await getWTDRevenue('O&O_SOMQ_FINAL_EXPENSE');
```

### Date range helpers

```typescript
import { getMTDRange, getWTDRange, getYTDRange, getDateRange } from '../integrations/ringba';

// Predefined ranges
getMTDRange();  // { startDate: '2026-04-01', endDate: '2026-04-17' }
getWTDRange();  // { startDate: '2026-04-14', endDate: '2026-04-17' }
getYTDRange();  // { startDate: '2026-01-01', endDate: '2026-04-17' }

// Used by GET /api/data/ringba/revenue to resolve the ?period= query param
getDateRange('mtd');                              // same as getMTDRange()
getDateRange('custom', '2026-04-01', '2026-04-07');  // custom range
```

### Instance config

Reporting instances declare their campaign in `instance.md`:

```yaml
ringba:
  campaignName: O&O_SOMQ_FINAL_EXPENSE
  reportPeriod: mtd   # mtd | wtd | custom
```

The data-collection workflow stage reads this config and calls `getCampaignRevenue` with the appropriate date range. The `GET /api/data/ringba/revenue` endpoint also accepts `?instanceId=` to read from instance config.

### Pieces

| File | Role |
|------|------|
| `client.ts`     | Thin HTTP wrapper. Auth, offset pagination, Ringba quirks. **Called by the sync worker only** in normal operation. |
| `repository.ts` | Supabase read/write. Reproduces `getCampaignRevenue` from `ringba_calls.routing_attempts` — same aggregation semantics, same numbers. |
| `sync.ts`       | `RingbaSyncWorker` — cron-driven pull into `ringba_calls` / `ringba_campaigns`. |
| `reports.ts`    | Public `getCampaignRevenue(opts)`. Supabase-first; falls back to live API if the requested range is outside sync coverage. Pass `liveOnly: true` to force the legacy path. |
| `types.ts`      | API response types and report types. |

### Supabase tables

| Table | Rows | Notes |
|-------|------|-------|
| `ringba_campaigns`  | one per campaign    | `id` PK, `enabled`, full object in `raw` |
| `ringba_calls`      | one per inbound call | PK = `inbound_call_id`; winning record promoted; all routing attempts in `routing_attempts` JSONB; `phone_normalized` generated |
| `ringba_sync_state` | one per sync stream  | `high_water_mark` = latest synced `call_dt`, `low_water_mark` = earliest — together they define the Supabase-authoritative range |

Migration file: [supabase/migrations/20260417000002_ringba.sql](../supabase/migrations/20260417000002_ringba.sql).

### Read-path behavior — when does `getCampaignRevenue` use Supabase vs live?

```
1. If liveOnly=true             → live API
2. If Supabase not configured   → live API
3. If sync_state coverage is complete for [startDate, endDate]  → Supabase
4. Otherwise                    → live API
```

"Coverage complete" = `low_water_mark <= startDate` AND `high_water_mark >= endDate` for the `calls:global` sync key. This is the safe default: the repo is only trusted for ranges we've actually synced.

### Aggregation semantics preserved

The Supabase path unnests the `routing_attempts` JSONB and applies the exact same filters as the live aggregation:

- `totalCalls` = routing attempts with `callLengthInSeconds >= minCallDurationSeconds`
- `paidCalls` = attempts with `hasPayout && !isDuplicate && callLengthInSeconds >= minCallDurationSeconds`
- `totalRevenue` = sum of `conversionAmount` across all attempts (duplicates are $0)
- `totalPayout` = sum of `payoutAmount` across all attempts

Numbers match the Ringba UI byte-for-byte when `minCallDurationSeconds=0`.

### Sync worker

`RingbaSyncWorker` runs standalone (not via instance Scheduler). Default cron: every 15 min. Overlap: 30 min.

**Tick behavior:**

1. Refresh campaign list into `ringba_campaigns`
2. Read `high_water_mark` from `ringba_sync_state` (or cold-start 3 days back)
3. Pull `/callLogs` for `(high_water_mark − 30 min) → now` (offset-paginated, 20/page)
4. Group by `inboundCallId`, pick winning record, preserve all attempts in JSONB
5. Upsert into `ringba_calls`
6. Advance `high_water_mark`; leave `low_water_mark` alone (backfill script manages it)

**Winning-record selection.** When a call has multiple routing attempts, the repository and sync worker pick one as "authoritative" for the top-level columns. Ordering: `!isDuplicate` > `hasPayout` > `hasConverted` > `hasConnected`. The full set of attempts is always preserved in `routing_attempts`.

### Historical backfill

```bash
npm run backfill:ringba                # walk back until 6 empty months
npm run backfill:ringba -- --months 12 # last 12 months only
npm run backfill:ringba -- --from 2024-01-01 --to 2026-04-17
```

Backfill advances `low_water_mark` as it goes. Once backfill completes, `getCampaignRevenue` will use Supabase for any range inside `[low_water_mark, high_water_mark]`.

---

## LeadsProsper

**Source:** `src/integrations/leadsprosper/`

LeadsProsper (LP) is where lead routing is configured. Every lead that flows through Elevarus's platforms passes through LP, which decides which buyer receives it and at what price. LP also enriches Ringba calls with attribution (UTM, sub-IDs, supplier) that flows through at dial time.

This is the first integration built on the Supabase-backed pattern: workflows read from `lp_leads` / `lp_campaigns`, and a sync worker is the only code that calls the LP API. See [data-platform.md](./data-platform.md) for the pattern.

### Configuration

| Env var | Description |
|---------|-------------|
| `LEADSPROSPER_API_KEY` | Developer API Key from the LP dashboard. Single header value used as `Authorization: Bearer {key}` |

The `LeadsProsperClient` checks for the key at construction time. If absent, `client.enabled` is `false` and all methods return `[]` / `null` without making any network calls. The sync worker no-ops cleanly in that state.

### Pieces

| File | Role |
|------|------|
| `client.ts`     | Thin HTTP wrapper. Auth, pagination (`search_after` cursor), nothing else. Workflows should not import this. |
| `repository.ts` | Supabase read/write. **This is the public interface for workflows and reconciliation code.** |
| `sync.ts`       | `LeadsProsperSyncWorker` — cron-driven pull from LP into `lp_leads` / `lp_campaigns`. |
| `types.ts`      | API response types and Supabase row types. |

### Supabase tables

| Table | Rows | Notes |
|-------|------|-------|
| `lp_campaigns`   | one per LP campaign | full campaign JSON in `raw`, name promoted for lookups |
| `lp_leads`       | one per lead        | phone promoted + `phone_normalized` (digits-only generated column) is the reconciliation join key |
| `lp_sync_state`  | one per sync stream | checkpoint: `high_water_mark` = latest `lead_date` we've seen |

Migration file: [supabase/migrations/20260417000001_leadsprosper.sql](../supabase/migrations/20260417000001_leadsprosper.sql).

### Reading data — repository API

```typescript
import { LeadsProsperRepository } from "../../integrations/leadsprosper";

const repo = new LeadsProsperRepository();

// Time-range query
const leads = await repo.getLeadsByDateRange({
  startDate:  "2026-04-01T00:00:00Z",
  endDate:    "2026-04-17T23:59:59Z",
  campaignId: 23880,          // optional
  status:     "ACCEPTED",     // optional
});

// Reconciliation — find LP lead(s) for a phone number in a Ringba call window
const matches = await repo.findLeadsByPhone({
  phone:     "+1 (410) 309-7989",   // any format; normalized internally
  startDate: "2026-04-17T00:00:00Z",
  endDate:   "2026-04-17T23:59:59Z",
});
```

The repository's methods all safely return `[]` when Supabase is not configured — so consuming stages can call it unconditionally.

### Sync worker

`LeadsProsperSyncWorker` runs on a standalone cron (default: every 15 min). It does not use the instance Scheduler, because sync is a platform-level concern, not an instance-level one.

**Tick behavior:**

1. Refresh campaign list (`/campaigns`) — cheap, runs every tick
2. Read `lp_sync_state.high_water_mark` (or fall back to now − 3 days on cold start)
3. Pull all leads from `(high_water_mark − 30 min overlap)` to `now`, across every campaign
4. Upsert into `lp_leads` keyed by LP lead ID (idempotent)
5. Advance `high_water_mark` to the latest `lead_date` seen
6. On error, leave `high_water_mark` unchanged and record `last_error` — next tick retries

The 30-minute overlap is intentional: LP mutates lead records post-hoc when buyers accept/reject after the initial POST. Re-pulling the recent window on every tick captures those revisions.

**Runs on boot.** The worker fires one sync immediately at `start()` so data is fresh without waiting for the next cron tick.

### Reconciliation model

Phone number is the universal join key across LeadsProsper, Ringba, and disposition reports. `lp_leads.phone_normalized` is a `GENERATED ALWAYS AS ... STORED` column containing digits-only — indexed and ready for `JOIN ON ringba_calls.inbound_phone_normalized = lp_leads.phone_normalized` once Ringba is migrated to this pattern.

Because phone numbers are fragile (recycled, shared devices), reconciliation queries must always include a time window (typically ±48 h around the Ringba `callDt`).

---

## Meta Ads

**Source:** `src/integrations/meta/`

Pulls ad spend data from the Meta Ads Graph API. Used alongside Ringba data in P&L reporting agents to calculate cost-per-call and margin.

### Configuration

| Env var | Description |
|---------|-------------|
| `META_ACCESS_TOKEN` | System User token from Meta Business Manager. One token covers all ad accounts the System User has been granted access to. Generate it in Meta Business Manager > System Users > Generate Token |

The `MetaAdsClient` checks for this token at construction time. When absent, `client.enabled` is `false` and functions return `null`.

### Primary function: `getAdAccountSpend(opts)`

```typescript
import { getAdAccountSpend } from '../integrations/meta';

const report = await getAdAccountSpend({
  adAccountId: '999576488367816',
  startDate:   '2026-04-01',
  endDate:     '2026-04-17',
  // campaignIds omitted = total account spend
});

// Filter to specific campaigns
const filtered = await getAdAccountSpend({
  adAccountId: '999576488367816',
  startDate:   '2026-04-01',
  endDate:     '2026-04-17',
  campaignIds: ['120201234567890', '120209876543210'],
});
```

**Options (`MetaSpendOptions`)**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `adAccountId` | string | Yes | Numeric ad account ID without the `act_` prefix |
| `startDate` | string | Yes | `YYYY-MM-DD` |
| `endDate` | string | Yes | `YYYY-MM-DD` |
| `campaignIds` | `string[]` | No | When provided, aggregates spend only for these campaigns. When omitted or empty, returns total account-level spend |

**Returns:** `MetaSpendReport | null`

`null` when the integration is not configured, the API call fails, or no insight rows are returned for the period.

**`MetaSpendReport` fields**

| Field | Type | Description |
|-------|------|-------------|
| `adAccountId` | string | The account ID used in the request |
| `startDate` | string | Report start date |
| `endDate` | string | Report end date |
| `totalSpend` | number | Total USD spend for the period, rounded to 2 decimal places |
| `impressions` | number | Total impressions |
| `clicks` | number | Total clicks |
| `cpm` | number | Cost per 1,000 impressions (weighted average across rows) |
| `cpc` | number | Cost per click (weighted average across rows) |
| `ctr` | number | Click-through rate as a percentage (weighted average across rows) |
| `campaignIds` | `string[]` | Campaign IDs used to filter, or `undefined` for account-level |

### Instance config

Reporting instances declare their ad account in `instance.md`:

```yaml
meta:
  adAccountId: "999576488367816"
  campaignIds: []   # empty = entire account spend
```

The ad account ID is the per-agent identifier. If one ad account runs multiple unrelated verticals, use `campaignIds` to scope the spend to only the campaigns relevant to that agent.

---

## Google Ads

**Source:** `src/integrations/google-ads/`

Pulls ad spend from the Google Ads API across all sub-accounts under the Elevarus MCC (`989-947-7831`). Used alongside Meta Ads in P&L reporting workflows. Synced to Supabase nightly @ 02:00 PT — see [docs/prd-google-ads-integration.md](./prd-google-ads-integration.md) for the full design rationale.

### Configuration

| Env var | Description |
|---------|-------------|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Developer token from MCC API Center: https://ads.google.com/aw/apicenter |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | MCC ID, no dashes (`9899477831`). Sent as `login-customer-id` header on every request |
| `GOOGLE_ADS_CLIENT_ID` | OAuth2 Desktop client ID from GCP Console → APIs & Services → Credentials |
| `GOOGLE_ADS_CLIENT_SECRET` | Paired with client ID |
| `GOOGLE_ADS_REFRESH_TOKEN` | Long-lived refresh token from a one-time OAuth flow. Run `npx ts-node scripts/google-ads-oauth.ts` to mint one — sign in as a user with access to the MCC |

All five must be set for the integration to enable. Missing any → `GoogleAdsClient.enabled` is `false` and methods no-op (return `[]` / `null`).

**Access tier:** Basic (15,000 ops/day) is sufficient for our use case (reading sub-accounts under our own MCC). Standard access is **not** required and would only be needed if we exposed this to third-party advertisers.

### Supabase tables

The sync worker maintains four tables (defined in `supabase/migrations/20260419000020_google_ads.sql`):

| Table | Grain | Purpose |
|-------|-------|---------|
| `google_ads_customers` | one row per CID | Sub-account directory. `manager=false` filters to leaf advertiser accounts; `status='ENABLED'` excludes cancelled/closed |
| `google_ads_daily_metrics` | one row per (customer, date) | **Primary** spend rollup. cost (USD) / impressions / clicks / conversions / ctr / avg_cpc |
| `google_ads_campaign_metrics` | one row per (customer, campaign, date) | Same metrics broken out by campaign |
| `google_ads_sync_runs` | one row per sync invocation | Run log — duration, rows upserted, customers synced/failed |

### Sync worker

`GoogleAdsSyncWorker` (in `src/integrations/google-ads/sync-worker.ts`) runs on a node-cron schedule from inside the daemon. Default: `0 2 * * *` in `America/Los_Angeles` (02:00 PT). Each tick pulls a 3-day rolling window per ENABLED leaf account, which absorbs Google's ~3h reporting lag and any late-attribution bumps.

**Why no initial-on-boot run:** unlike Ringba (where API calls are essentially free), Google Ads counts every returned row against the daily quota. A startup-tick on each daemon restart would burn ~5k ops with no value over the next scheduled run.

**Manual invocation:**

```bash
npm run sync:google-ads                    # default: 3-day window
npm run sync:google-ads -- --days=90       # backfill 90 days
npm run sync:google-ads -- --customer=8951980121   # one account only
```

### Primary function: `getCustomerSpend(opts)`

Workflow-level reporting helper. Reads from Supabase, never the live API.

```typescript
import { getCustomerSpend } from '../integrations/google-ads';

const report = await getCustomerSpend({
  customerId: '8951980121',
  startDate:  '2026-04-01',
  endDate:    '2026-04-17',
  // campaignIds omitted = total customer spend
});
```

Returns `GoogleAdsSpendReport | null`. Mirrors the contract of `getAdAccountSpend` (Meta), so reporting workflows can pull both side-by-side.

### Slack bot tools (live)

Two tools contributed via the manifest, picked up automatically by the Q&A bot:

- `google_ads_list_accounts` — Supabase-backed (live-API fallback if mirror is empty). Filters: `statusFilter[]`, `nameContains`, `includeManagers`. For all account-discovery questions.
- `google_ads_today_spend` — live-API only, **bounded to today**. Use only when the user asks about intraday spend; the nightly sync covers everything else.

Everything else (date-range spend, campaign breakdowns, joins to Ringba/LP) goes through the existing `supabase_query` tool, which auto-picks up the four `google_ads_*` tables from the manifest.

### Instance config

Reporting instances declare their sub-account in `instance.md`:

```yaml
googleAds:
  customerId: "8951980121"   # SaveOnMyQuote HVAC — dashes auto-stripped on load
  campaignIds: []            # empty = total customer spend
```

The customer ID is the per-agent identifier. Like Meta, multiple agents can share a single set of `GOOGLE_ADS_*` env vars.

### Sub-account directory

Top sub-accounts under MCC `989-947-7831` as of the initial sync (run `npm run sync:google-ads` to refresh):

| CID | Name |
|-----|------|
| `8951980121` | SaveOnMyQuote.com - HVAC |
| `2030848149` | SaveOnMyQuote.com - Final Expense |
| `5429908344` | SaveOnMyQuote.com - Timeshare |
| `6475741945` | Claro ACA-Private-Health Account 1 |
| `8420957497` | Claro Health Ad Account Medicare |
| `9221668405` | SOMQ_Auto Insurance |

Use `google_ads_list_accounts` for the full live list.

---

## Slack

**Source:** `src/adapters/slack/client.ts`, `src/adapters/slack/notify.adapter.ts`

Two separate Slack surfaces exist in ElevarusOS:

1. **`postToSlack` / `buildReportBlocks`** (`slack-client.ts`) — used by reporting agents to deliver formatted campaign reports to any channel.
2. **`SlackNotifyAdapter`** (`slack.adapter.ts`) — used by content/blog workflows to send job lifecycle notifications (started, approval needed, failed, completed) to the configured `SLACK_NOTIFY_CHANNEL`.

### Configuration

| Env var | Description |
|---------|-------------|
| `SLACK_BOT_TOKEN` | Bot token starting with `xoxb-`. Required OAuth scopes: `chat:write` and optionally `chat:write.public` |
| `SLACK_NOTIFY_CHANNEL` | Channel ID (`C...`) or name for `SlackNotifyAdapter` lifecycle notifications. Not used by `postToSlack` (which accepts channel as a parameter) |

### `postToSlack(opts)`

Posts a message to any channel. Returns the message `ts` (timestamp) on success, or `undefined` if Slack is not configured or the call fails.

```typescript
import { postToSlack } from '../adapters/slack/client';

const ts = await postToSlack({
  channel: 'C0123456789',
  text:    'MTD: 312 calls | 198 billable | $14,220 revenue',
  blocks:  buildReportBlocks({ ... }),  // optional rich formatting
});
```

**`SlackPostOptions`**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `channel` | string | Yes | Channel ID (`C...`) or name (`#channel-name`). The bot must be a member |
| `text` | string | Yes | Plain-text fallback. Required by Slack for push notifications even when `blocks` are provided |
| `blocks` | `SlackBlock[]` | No | Block Kit blocks for rich formatting |
| `threadTs` | string | No | Pass the `ts` of a parent message to reply in a thread |

### `buildReportBlocks(opts)`

Builds a Slack Block Kit layout for campaign performance reports. Returns a `SlackBlock[]` array ready to pass to `postToSlack`.

```typescript
import { buildReportBlocks } from '../adapters/slack/client';

const blocks = buildReportBlocks({
  title:        'Final Expense MTD Report',
  oneLiner:     'Strong MTD performance — revenue 12% above target',
  alertLevel:   'green',     // 'green' | 'yellow' | 'red'
  slackMessage: 'MTD: 312 calls | 198 billable | $14,220 revenue\n...',
  instanceId:   'final-expense-reporting',
});
```

**Options**

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Report title, shown in the Block Kit header |
| `oneLiner` | string | Single-sentence headline, shown bold under the header |
| `alertLevel` | `"green" \| "yellow" \| "red"` | Determines the alert emoji: green=✅, yellow=⚠️, red=🚨 |
| `slackMessage` | string | Formatted body text (supports Slack `mrkdwn`) |
| `instanceId` | string | Bot instance ID, shown in the footer context block |

**Block structure produced**

1. Header block — `{emoji} {title}`
2. Section block — `*{oneLiner}*`
3. Divider
4. Section block — `{slackMessage}` (mrkdwn)
5. Context block — `"Posted by ElevarusOS · {instanceId} · {date}"`

### `SlackNotifyAdapter`

The `SlackNotifyAdapter` class implements the `INotifyAdapter` interface and sends lifecycle notifications for blog/content workflows. It uses `SLACK_BOT_TOKEN` and `SLACK_NOTIFY_CHANNEL` from config.

All notifications after the first for a given job are posted as thread replies, keeping the channel feed clean.

```typescript
// Used internally by the orchestrator — not typically called directly
adapter.sendJobStarted(job);        // first message, establishes thread
adapter.sendApprovalRequest(job);   // threaded: draft preview + approval request
adapter.sendFailure(job, error);    // threaded: error message
adapter.sendCompletion(job);        // threaded: workflow complete
```

---

## Mission Control

**Source:** `src/core/mc-client.ts`, `src/core/mc-worker.ts`

Mission Control (MC) is the task board and agent registry that ElevarusOS treats as its source of truth. All task status, assignment, and approval state lives in MC. ElevarusOS acts as the execution runtime.

### Configuration

| Env var | Description |
|---------|-------------|
| `MISSION_CONTROL_URL` | Base URL of the MC instance (e.g. `http://localhost:3000`) |
| `MISSION_CONTROL_API_KEY` | API key for authenticating MC requests (sent as `x-api-key`) |
| `MC_WEBHOOK_SECRET` | Shared secret for HMAC-SHA256 verification of incoming MC webhooks |
| `ELEVARUS_PUBLIC_URL` | Public URL where ElevarusOS is reachable, used to register the webhook receiver with MC (e.g. `https://your-domain.com`) |

### MCClient

`MCClient` is a thin HTTP wrapper around MC's REST API. All methods are safe to call when MC is not configured — they log a warning and no-op when `client.enabled` is `false`.

```typescript
import { MCClient } from '../core/mc-client';

const client = new MCClient();
if (!client.enabled) {
  // MISSION_CONTROL_URL or MISSION_CONTROL_API_KEY not set
}
```

**Agent management**

```typescript
// Register or refresh a bot instance as an MC agent (idempotent)
const agentId = await client.registerAgent({
  name:         'final-expense-reporting',
  role:         'researcher',
  capabilities: ['ppc-campaign-report', 'active'],
  framework:    'ElevarusOS',
  workspace:    '/path/to/instances/final-expense-reporting',
  soulContent:  '# Final Expense Bot\n...',  // shown in MC SOUL tab
});
```

**Task management**

```typescript
// Create a task
const taskId = await client.createTask({
  title:       'Final Expense MTD Report',
  description: 'Pull MTD Ringba + Meta data and post to Slack',
  status:      'in_progress',   // MCWorker sets this directly to avoid MC trying openclaw
  priority:    'medium',
  assigned_to: 'final-expense-reporting',
  tags:        ['final-expense-reporting'],
  metadata:    { request: { ... } },
});

// Poll the queue for the next task assigned to this agent
const task = await client.pollQueue('final-expense-reporting');

// Update task state
await client.updateTask(taskId, {
  status:      'review',
  description: '...',
  metadata:    { ... },
});

// Submit Aegis quality review (required before MC marks a task "done")
await client.submitAegisApproval(taskId, 'Auto-approved — automated workflow complete');

// Post a comment (report output appears in MC task detail view)
await client.addComment(taskId, '## Campaign Report\n\n...');
```

**Webhook registration**

```typescript
// Register ElevarusOS as a webhook receiver
await client.registerWebhook(
  'https://your-domain.com/api/webhooks/mc',
  ['task.updated', 'agent.registered']
);
```

### MCWorker

`MCWorker` is the daemon-mode engine. It runs continuously, polling MC for tasks and executing workflows. A single MCWorker instance manages all registered bot instances.

**Lifecycle**

```
MCWorker.start()
  → scaffolds workspace files for all instances
  → registers each instance as an MC agent (registerAgents)
  → begins polling loop (every POLL_INTERVAL_MS, default 60s)

Poll cycle:
  for each registered agent:
    client.pollQueue(agentName)
    → if task returned: executeTask(task, agentName)
```

**Task execution flow**

```
1. Build internal Job from MC task metadata
2. Save Job to Supabase (if JOB_STORE=supabase)
3. client.updateTask → status: "in_progress"
4. Run workflow stages sequentially:
   - For normal stages: run with retry (MAX_STAGE_RETRIES, exponential backoff)
   - For "approval_notify" stage:
       a. Run the stage (sends email/Slack to approver)
       b. client.updateTask → status: "review"
       c. Wait for notifyApproval() (up to 24 hours)
       d. On approval: client.updateTask → status: "in_progress"
       e. Continue remaining stages
5. client.submitAegisApproval() → MC advances task to "done"
```

**Approval flow**

When a workflow reaches the `approval_notify` stage, MCWorker blocks on a Promise that resolves only when:
- The webhook receiver receives a `task.updated` event with `status: "done"` or `status: "quality_review"`, OR
- The 24-hour timeout fires (resolves as rejected)

```typescript
// Called by POST /api/webhooks/mc when MC fires task.updated
mcWorker.notifyApproval(mcTaskId, true);  // approved=true unblocks the workflow
```

**Recurring tasks via MC task templates**

MC supports recurring task templates with a `metadata.recurrence.cron_expr` field. When MC spawns a child task from a template, it sets `assigned_to` to the agent name. MCWorker picks this up on the next poll cycle like any other task.

**Agent registration**

On `start()`, MCWorker calls `registerAgent` for every instance found in `src/instances/`. Registration is idempotent — safe to run on every restart. New instances created via `POST /api/instances` are registered on the next restart.

The MC agent role is derived from `baseWorkflow`:
- `ppc-campaign-report` or any workflow containing `"reporting"` → role `"researcher"`
- All others → role `"assistant"`

**SOUL content**

`MCClient.buildSoulContent(cfg)` generates the markdown displayed in MC's SOUL tab for each agent:

```typescript
const soul = MCClient.buildSoulContent(loadInstanceConfig('elevarus-blog'));
// Returns a markdown string with brand voice, audience, tone, schedule, and notification config
```

### Adding a new bot instance

1. Create `src/instances/<id>/instance.md` (copy from `src/instances/_template/`) — or use `POST /api/instances`.
2. Register the workflow in `src/index.ts`:
   ```typescript
   registry.register(buildBlogWorkflowDefinition(notifiers, 'my-new-bot'));
   ```
3. Restart ElevarusOS. MCWorker registers the new agent in MC automatically.
4. Assign a task in the MC Task Board, or submit one via `POST /api/jobs`.
