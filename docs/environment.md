# ElevarusOS Environment Variable Reference

All environment variables are loaded from `.env` at the project root. Copy `.env.example` to `.env` to get started.

Variables marked **Required** will cause ElevarusOS to fail at startup if absent. Variables marked **Optional** have safe defaults or disable the associated feature gracefully when not set.

---

## Anthropic / Claude

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | **Required** | — | Anthropic API key. Obtain at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys). Format: `sk-ant-...` |
| `ANTHROPIC_MODEL` | Optional | `claude-opus-4-7` | Model ID used for all Claude API calls in workflow stages. Override to use a different Claude model |

`ANTHROPIC_API_KEY` is the only strictly required variable in the entire system — all others enable optional integrations or tune defaults.

---

## Ringba

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RINGBA_API_KEY` | Optional | — | API Access Token from Ringba dashboard: Security > API Access Tokens. When absent, all Ringba calls return `null` silently |
| `RINGBA_ACCOUNT_ID` | Optional | — | Account ID visible in the `app.ringba.com` URL. Format: `RA_XXXXXXXX`. Required alongside `RINGBA_API_KEY` to enable the integration |

Both variables must be set for the Ringba integration to activate. Either missing disables the integration.

---

## Meta Ads

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `META_ACCESS_TOKEN` | Optional | — | System User token from Meta Business Manager. One token covers all ad accounts the System User has been granted access to. Generate in Meta Business Manager > System Users > Generate Token |

Ad account IDs are **not** set here — they are configured per-agent in `instance.md` under the `meta.adAccountId` field. This allows multiple agents to report on different ad accounts using the same token.

---

## Google Ads

All five variables must be set together for the Google Ads integration to enable. Any missing → `GoogleAdsClient.enabled` is `false` and methods no-op silently.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Optional | — | 22-char token from the MCC API Center: https://ads.google.com/aw/apicenter. One per company. Apply for **Basic** access (15k ops/day) — Standard is not required for reading sub-accounts in our own MCC |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Optional | — | MCC ID, no dashes (`9899477831`). Sent as `login-customer-id` header on every request to scope to the manager hierarchy |
| `GOOGLE_ADS_CLIENT_ID` | Optional | — | OAuth2 client ID. Create a "Desktop app" credential in GCP Console → APIs & Services → Credentials |
| `GOOGLE_ADS_CLIENT_SECRET` | Optional | — | Paired with client ID |
| `GOOGLE_ADS_REFRESH_TOKEN` | Optional | — | Long-lived refresh token from a one-time OAuth flow. Mint with `npx ts-node scripts/google-ads-oauth.ts` — sign in as a Google account with access to the MCC |

Customer IDs (sub-account CIDs) are **not** set here — they are configured per-agent in `instance.md` under `googleAds.customerId`. One set of env vars covers every sub-account under the MCC.

**Smoke test:** `npx ts-node scripts/google-ads-smoke-test.ts` enumerates every sub-account under the MCC and confirms credentials are wired correctly.

---

## Slack

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | Optional | — | Bot token for the ElevarusOS Slack app. Format: `xoxb-...`. Required OAuth scopes: `chat:write` (and optionally `chat:write.public` for public channels without joining). Used by both `postToSlack` (report delivery) and `SlackNotifyAdapter` (lifecycle notifications) |
| `SLACK_NOTIFY_CHANNEL` | Optional | — | Channel ID (`C...`) for `SlackNotifyAdapter` workflow lifecycle messages (job started, approval needed, failed, completed). Separate from per-agent `slackChannel` set in `instance.md`, which controls where report output is posted |

---

## Email (Microsoft Graph)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MS_TENANT_ID` | Optional | — | Azure AD tenant ID. Found in Azure Portal > Azure Active Directory > Overview |
| `MS_CLIENT_ID` | Optional | — | App registration client ID |
| `MS_CLIENT_SECRET` | Optional | — | App registration client secret |
| `MS_INTAKE_MAILBOX` | Optional | — | Email address ElevarusOS monitors for incoming content requests (e.g. `content-requests@yourdomain.com`) |
| `MS_NOTIFY_FROM` | Optional | — | Sender address for outbound approval and notification emails (e.g. `no-reply@yourdomain.com`) |

All five variables must be set to enable the Microsoft Graph email adapter. The adapter polls `MS_INTAKE_MAILBOX` for new messages and uses `MS_NOTIFY_FROM` to send approval emails.

---

## ClickUp

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLICKUP_API_TOKEN` | Optional | — | ClickUp personal API token. Format: `pk_...`. Enables the ClickUp intake adapter, which watches a list for new tasks to convert to ElevarusOS jobs |
| `CLICKUP_LIST_ID` | Optional | — | ID of the ClickUp list to watch for incoming job requests |

---

## Dashboard

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CORS_ORIGINS` | Optional | `http://localhost:3000` | Comma-separated list of origins the API allows CORS requests from. Set to `*` to allow all origins (not recommended in production). The dashboard at port 3000 is included by default |

> Dashboard-specific environment variables (Supabase keys, `ELEVARUS_API_SECRET`) are set in `dashboard/.env.local` — see `dashboard/README.md` for details.

---

## API Server

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_PORT` | Optional | `3001` | TCP port the ElevarusOS REST API server listens on |
| `API_SECRET` | Optional | — | When set, all API requests (except webhook routes) must include `x-api-key: <API_SECRET>`. When absent, the API is unauthenticated |

---

## Orchestrator

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `POLL_INTERVAL_MS` | Optional | `60000` | Reserved — not currently used. Left for forward compatibility |
| `MAX_STAGE_RETRIES` | Optional | `2` | Maximum number of retries per workflow stage on failure. Total attempts = `MAX_STAGE_RETRIES + 1`. Retries use exponential backoff (2s, 4s) |
| `LOG_LEVEL` | Optional | `info` | Logging verbosity. One of `debug`, `info`, `warn`, `error` |
| `JOB_STORE` | Optional | `memory` | Job persistence backend. `memory` = lost on restart. `file` = persisted to `JOB_STORE_PATH`. `supabase` = persisted to Supabase (requires `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`) |
| `JOB_STORE_PATH` | Optional | `./data/jobs` | Directory for file-based job storage when `JOB_STORE=file` |
| `DRY_RUN` | Optional | — | When set to any truthy value, skips external API calls in certain stages (used in development/testing) |

---

## Database (Supabase)

Used only when `JOB_STORE=supabase`. Supabase stores detailed job execution records (all stages, outputs, errors) for analytics and audit. MC remains the source of truth for task status.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SUPABASE_URL` | Optional | — | Supabase project URL. Found in Supabase dashboard: Project Settings > API > URL. Format: `https://your-project.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Optional | — | Service role key (not the anon key). Found in Supabase dashboard: Project Settings > API > `service_role`. Grants full database access — keep this secret |
| `DATABASE_URL` | Optional | — | Postgres connection string. Used by `setup.sh` to apply migrations directly. Format: `postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres` |
| `SUPABASE_ACCESS_TOKEN` | Optional | — | Personal access token from [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens). Used by `setup.sh` to apply migrations without needing `psql` installed |
| `SUPABASE_PROJECT_REF` | Optional | — | Project reference ID (the short alphanumeric ID in your Supabase project URL). Used by `setup.sh` alongside `SUPABASE_ACCESS_TOKEN` |

To apply database migrations: `bash setup.sh`

---

## `.env.example`

The complete template. Copy to `.env` and fill in values before starting ElevarusOS.

```bash
# Copy this file to .env and fill in your values.
# cp .env.example .env

# ─── Anthropic (required) ────────────────────────────────────────────────────
# Get your key at https://console.anthropic.com/settings/keys
ANTHROPIC_API_KEY=sk-ant-...

# ─── ClickUp (optional — enables ClickUp intake adapter) ─────────────────────
CLICKUP_API_TOKEN=pk_...
CLICKUP_LIST_ID=

# ─── Microsoft Graph / Office 365 (optional — enables email intake) ──────────
MS_TENANT_ID=
MS_CLIENT_ID=
MS_CLIENT_SECRET=
MS_INTAKE_MAILBOX=content-requests@yourdomain.com
MS_NOTIFY_FROM=no-reply@yourdomain.com

# ─── Slack (optional — enables Slack notifications and approval buttons) ──────
SLACK_BOT_TOKEN=xoxb-...
SLACK_NOTIFY_CHANNEL=C0123456789

# ─── Ringba (optional — enables live call/revenue data for reporting agents) ──
# API Access Token: Ringba → Security → API Access Tokens
RINGBA_API_KEY=
# Account ID visible in the app.ringba.com URL (e.g. RA_XXXXXXXX)
RINGBA_ACCOUNT_ID=

# ─── Meta Ads (optional — enables ad spend data for P&L reporting) ────────────
# System User token from Meta Business Manager → System Users → Generate Token
# One token covers all ad accounts the System User has been granted access to.
# Ad account IDs are configured per-agent in instance.md (not here).
META_ACCESS_TOKEN=

# ─── Google Ads (optional — enables ad spend data for P&L reporting) ─────────
# Developer token from MCC API Center: https://ads.google.com/aw/apicenter
# Apply for Basic access (15k ops/day). MCC ID covers all sub-accounts.
# Mint REFRESH_TOKEN once: npx ts-node scripts/google-ads-oauth.ts
# Customer IDs (sub-account CIDs) are configured per-agent in instance.md.
GOOGLE_ADS_DEVELOPER_TOKEN=
GOOGLE_ADS_LOGIN_CUSTOMER_ID=
GOOGLE_ADS_CLIENT_ID=
GOOGLE_ADS_CLIENT_SECRET=
GOOGLE_ADS_REFRESH_TOKEN=

# ─── Orchestrator (optional overrides) ───────────────────────────────────────
MAX_STAGE_RETRIES=2
LOG_LEVEL=info
JOB_STORE=file
JOB_STORE_PATH=./data/jobs

# ─── API server ───────────────────────────────────────────────────────────────
API_PORT=3001
# Leave blank for no auth; set to require x-api-key header on /api/* routes
API_SECRET=
# Comma-separated list of origins allowed for CORS (dashboard origin by default)
CORS_ORIGINS=http://localhost:3000

# ─── Supabase (optional — enables persistent job storage) ────────────────────
# Create a project at https://supabase.com, then:
#   Project Settings -> API -> URL and service_role key
# Apply migrations: bash setup.sh  (or: psql $DATABASE_URL -f supabase/migrations/*.sql)
# Set JOB_STORE=supabase to activate
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=sb_secret_...
# Personal access token — from https://supabase.com/dashboard/account/tokens
# Used by setup.sh to apply migrations automatically (no psql needed)
SUPABASE_ACCESS_TOKEN=sbp_...
SUPABASE_PROJECT_REF=your-project-ref
```
