# DigitalOcean App Platform deployment

This directory holds the App Platform spec for ElevarusOS. The full spec lives
in [`app.yaml`](./app.yaml) — read its top comment for architecture details.

---

## First-time setup

### 1. Connect GitHub to DigitalOcean

In the DO console: Apps → Create App → choose GitHub as source → grant access
to `elevarus-admin/ElevarusOS`. (One-time auth.)

### 2. Import the spec

Two ways:

**A. Via the DO UI (no doctl needed):**
1. DO console → Apps → Create App
2. Click the **"Create via API"** link in the right sidebar
3. Paste the contents of [`app.yaml`](./app.yaml)
4. DO renders a form pre-filled from the spec

**B. Via doctl (after install):**
```bash
brew install doctl
doctl auth init                                    # paste a Personal Access Token
doctl apps create --spec .do/app.yaml              # creates the app
```

### 3. Fill in SECRET env vars

After import, DO will prompt for every env var marked `type: SECRET`. Copy them
from your local `.env` and `dashboard/.env.local`:

**API service** needs:
- `ANTHROPIC_API_KEY`
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`
- `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_SECRET`, `SLACK_VERIFICATION_TOKEN`
- `CLICKUP_API_TOKEN`, `CLICKUP_WEBHOOK_SECRET`
- `META_ACCESS_TOKEN`
- `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`
- `RINGBA_API_KEY`
- `LEADSPROSPER_API_KEY`
- `EVERFLOW_API_KEY`
- `MS_CLIENT_SECRET`
- `MISSION_CONTROL_API_KEY`, `MC_WEBHOOK_SECRET`
- `API_SECRET` — **generate a new random 32-char string** (e.g. `openssl rand -hex 32`).
  Will be reused as `ELEVARUS_API_SECRET` on the dashboard service. Both must match.

Plain (non-secret) env vars:
- Slack channel IDs, ClickUp team/list IDs, Google Ads MCC ID, Ringba account ID,
  Thumbtack sheet ID/tab, MS tenant/client/mailboxes, Mission Control URL, etc.

**Dashboard service** needs:
- `NEXT_PUBLIC_SUPABASE_URL` (same value as `SUPABASE_URL` above — different name)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Supabase Project Settings → API → `anon` key)
- `SUPABASE_SERVICE_KEY` (same value as in API)
- `ELEVARUS_API_SECRET` (same value as `API_SECRET` in API)

### 4. Deploy

Click Create. First build takes ~5-8 minutes. DO assigns a URL like
`https://elevarus-os-xxxxx.ondigitalocean.app`.

---

## Post-deploy checklist

These need updating once you have the production URL:

### Slack app config
At https://api.slack.com/apps → ElevarusOS → Event Subscriptions:
- **Request URL**: `https://<your-app-url>/api/webhooks/slack`
- **Interactivity & Shortcuts → Request URL**: `https://<your-app-url>/api/webhooks/slack/interactions`

Slack will hit the URL with a `challenge` payload to verify. Watch logs:
```bash
doctl apps logs <APP_ID> api --follow
```

### ClickUp webhooks (if/when wired — Phase 4 of clickup PRD)
For each registered webhook, re-register against:
`https://<your-app-url>/api/webhooks/clickup`

### Update the smoke test references
The local `.env` still has `ELEVARUS_PUBLIC_URL=` empty (used for local ngrok).
DO sets this automatically via `${APP_URL}` substitution — no action needed
in the spec.

---

## Day-2 operations

### Trigger a redeploy without a code change
```bash
doctl apps create-deployment <APP_ID>
```

### Tail logs
```bash
doctl apps logs <APP_ID> api --follow
doctl apps logs <APP_ID> dashboard --follow
```

### Shell into a running container (debugging only)
```bash
doctl apps console <APP_ID> --component api
```
Filesystem is ephemeral — changes don't survive restart.

### Update the spec (env var added, scaling change, etc.)
1. Edit `.do/app.yaml`
2. Commit + push (or apply directly without committing):
   ```bash
   doctl apps update <APP_ID> --spec .do/app.yaml
   ```

### Roll back to a previous deployment
DO console → Apps → elevarus-os → Deployments → click an older successful
deployment → "Re-deploy this version".

---

## Cost (as of the initial spec)

| Service | Size | Cost |
|---|---|---|
| api | basic-xxs (512MB / shared vCPU) | $5/mo |
| dashboard | basic-xs (1GB / shared vCPU) | $12/mo |
| **Total** | | **$17/mo** |

Bandwidth: 50GB/mo included on Basic; ElevarusOS won't get close.
Build minutes: 400/mo included.

If `api` runs out of memory (cron worker batches are heavy), bump to
`basic-xs` ($12) for $24/mo total.

---

## Database

ElevarusOS uses **Supabase**, not DO Managed Postgres. Don't add a database
component to the App Platform — it would be unused. The spec deliberately
omits any `databases:` block.

Migrations are applied via the Supabase Management API (see `setup.sh`).
Run them manually post-deploy:
```bash
# from a checkout of the repo with .env populated
bash setup.sh
```

A future improvement: add a `jobs:` component to App Platform that runs
`bash setup.sh` once per deploy. Skipped for v1 — manual is fine.

---

## Local dev still works

After deploying, your laptop's `.env` and `dashboard/.env.local` are untouched.
`make start` continues to run both services locally against the same Supabase
project (which is also production data — see the conversation notes about
adding a separate dev Supabase project when you're ready).
