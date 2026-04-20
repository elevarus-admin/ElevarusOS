# PRD: Google Ads Integration

**Status:** Draft v1
**Author:** Shane McIntyre
**Date:** 2026-04-19
**Audience:** ElevarusOS engineering team

---

## Quick Reference

| Item | Value |
|---|---|
| Integration dir | `src/integrations/google-ads/` |
| Manifest entry | `src/core/integration-registry.ts` (push `googleAdsManifest`) |
| Env vars | `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_LOGIN_CUSTOMER_ID` |
| MCC ID | `9899477831` (no dashes) — covers all sub-accounts |
| API version | v23 (released 2026-01-28; Google now ships monthly) |
| Endpoint base | `https://googleads.googleapis.com/v23` |
| Reporting endpoint | `POST customers/{customerId}/googleAds:searchStream` (GAQL) |
| SDK | `google-ads-api` npm (Opteo) — recommended over raw fetch |
| Slack surface | Claude `liveTools[]` on the integration manifest |
| Dashboard surface | Auto — manifest-driven card on `/integrations` |
| Storage | **Supabase sync** (`google_ads_*` tables) — see §5 |
| Sync cadence | Nightly worker @ 02:00 PT + on-demand `today` live passthrough |
| Live API docs | https://developers.google.com/google-ads/api/docs/start |

---

## Decisions Locked In

1. **Sync to Supabase, don't go live-only.** Unlike Meta (which is live Graph API), Google Ads ships with a `google-ads-sync` worker from day one. Reasoning: Basic-tier quota is 15,000 ops/day per developer token shared across all reads, and a single 30-day × 10-account campaign-level GAQL pull can return 3-10k rows (each row = 1 op). Two or three ad-hoc Slack queries would burn the daily ceiling. Nightly sync collapses that into one ~5k-op batch and gives the Slack bot sub-100ms Supabase reads. See §5.
2. **Apply for Basic access, not Standard.** Our use case is reading reporting from sub-accounts inside our own MCC. Google explicitly permits this on Basic access — Standard is only required for tools exposed to third-party advertisers. Skipping Standard avoids the ~10-business-day review and the RMF (Required Minimum Functionality) compliance burden. ([access levels doc](https://developers.google.com/google-ads/api/docs/api-policy/access-levels)).
3. **Use the Opteo `google-ads-api` SDK.** Google does not publish an official Node SDK. Reimplementing GAQL string handling, gRPC-with-REST transcoding, refresh-token rotation, `searchStream` chunked decoding, and proto enum mapping is multi-week work for no benefit. The SDK tracks the latest API version and accepts a refresh token directly. Caveat: it's community-maintained — keep a thin client wrapper so we can swap to raw fetch if the SDK lags a v-bump.
4. **One shared OAuth identity, one refresh token.** Generated once via the OAuth playground using a Google account that is a user on MCC `989-947-7831`. Stored as `GOOGLE_ADS_REFRESH_TOKEN`. The `login-customer-id` header (set to the MCC ID) is what scopes every request to the manager hierarchy.
5. **Reporting is Phase 1; publishing ads is Phase 4 (deferred).** Writes are in scope as a future phase but explicitly out of v1 — same shape as the ClickUp PRD's "reads first, writes second" stance. Basic access permits mutations on our own MCC's accounts; no extra OAuth scope needed.
6. **Dashboard surface is automatic.** The Next.js dashboard already renders `/integrations` from the manifest registry ([dashboard/src/app/(dashboard)/integrations/page.tsx](../dashboard/src/app/(dashboard)/integrations/page.tsx)). Adding the manifest gives us a card with feature badges, table schemas, and live-tool count for free.

---

## 1. Problem

Meta Ads spend is wired into ElevarusOS for P&L reporting and Slack Q&A. Google Ads is the other half of the paid-acquisition picture for HVAC, U65, and final-expense agents — and it's currently invisible to:

- The Slack bot (no way to ask "what was our Google spend on HVAC last week").
- The reporting workflows (P&L pulls miss Google entirely; numbers are incomplete).
- The dashboard `/integrations` page (no card, no schema discovery).

This PRD wires Google Ads in mirroring the Meta integration's shape, with one upgrade: Supabase sync from day one (§5) instead of live-only.

---

## 2. Goals & Non-Goals

### Goals

- **Reporting is the headline.** Slack bot can answer spend / impressions / clicks / CTR / CPC / conversions questions across the MCC and per sub-account, scoped by date range.
- **Dashboard parity.** `/integrations` shows Google Ads alongside Meta, ClickUp, Ringba — auto via manifest.
- **Per-instance binding.** Each agent's `instance.md` declares `googleAds.customerId` (the sub-account CID) the same way it declares `meta.adAccountId`.
- **Account discovery tool.** `google_ads_list_accounts` enumerates every sub-account under the MCC so we can wire new instances without leaving Slack.
- **Nightly Supabase sync.** Collapses ad-hoc query load and lets us join Google spend to Ringba / LeadsProsper dimensional data already in Supabase.
- **Audit trail.** Every Slack-initiated query logs via `auditQueryTool` with row counts and elapsed ms.

### Non-Goals (v1)

- Publishing / mutating campaigns or ads (Phase 4).
- Conversion-action setup, audience management, keyword research.
- Standard-access application. Basic suffices.
- Per-user OAuth. One shared MCC-scoped refresh token.
- YouTube / Display Video 360 / Search Ads 360. Just Google Ads.
- Cross-MCC support. One `GOOGLE_ADS_LOGIN_CUSTOMER_ID` only.

---

## 3. Topology

```
┌────────────────────────────────────────────────────────────────────┐
│                       GOOGLE ADS API (v23)                         │
│  MCC 989-947-7831  →  N sub-account customers                      │
│  GAQL searchStream · listAccessibleCustomers · customer_client     │
└───────────────────┬───────────────────────────────────────────────┘
                    │  OAuth2 (refresh token) + login-customer-id
                    ▼
┌────────────────────────────────────────────────────────────────────┐
│                      ElevarusOS                                    │
│                                                                    │
│  src/integrations/google-ads/                                      │
│    ├─ client.ts          GoogleAdsClient (wraps Opteo SDK)         │
│    ├─ types.ts           Customer / Insight / SyncRow shapes       │
│    ├─ index.ts           barrel export                             │
│    ├─ manifest.ts        IntegrationManifest (tables + tools)      │
│    ├─ live-tools.ts      QATool[]: list_accounts, today_spend      │
│    ├─ reports.ts         getCustomerSpend() — Supabase-first       │
│    └─ sync-worker.ts     Nightly pull → upsert google_ads_*        │
│                                                                    │
│  Supabase (new tables — see §5)                                    │
│    google_ads_customers                                            │
│    google_ads_daily_metrics       (account-day grain)              │
│    google_ads_campaign_metrics    (campaign-day grain)             │
│    google_ads_sync_runs           (worker run log)                 │
└────────────────────────────────────────────────────────────────────┘
       ▲                                            │
       │                                            ▼
┌──────┴──────────────────┐               ┌────────────────────────┐
│  Slack: @Elevarus       │               │  Reporting workflows   │
│  Claude tool calls →    │               │  pull spend in P&L     │
│  supabase_query (cached)│               │  (Supabase, not live)  │
│  + google_ads_today_*   │               │                        │
│  for intraday           │               │                        │
└─────────────────────────┘               └────────────────────────┘
```

The Slack bot reads Google Ads spend the same way it reads Ringba: through `supabase_query` against the synced tables. A small live passthrough (`google_ads_today_spend`) covers "spend so far today" since the nightly sync lags by up to a calendar day.

---

## 4. API Access — How We Get It

**One-time setup, in order:**

1. **Confirm the MCC owner.** A Google account that's already a user on MCC `989-947-7831` will hold the refresh token. Loss of this account = re-issue. (Action: Shane confirms which Google identity to use before Phase 1 starts.)
2. **Apply for the developer token.** Sign in to Google Ads as the MCC, open https://ads.google.com/aw/apicenter, fill the API access form. Token issues immediately at **Test** tier (test accounts only). The form auto-promotes to **Explorer** tier (production access, 2,880 ops/day) after submission.
3. **Apply for Basic access from the same API Center page.** Free-form text application; describe the use case ("internal reporting tool for our own MCC's sub-accounts; no third-party advertisers"). Approval is fast (minutes-to-hours, occasionally a day) since it's not RMF-reviewed. Result: 15,000 ops/day cap, sufficient for nightly sync + ad-hoc Slack queries.
4. **Create a Google Cloud OAuth client.** GCP Console → APIs & Services → Credentials → Create OAuth client ID → "Desktop app" type. Save `client_id` + `client_secret`. Enable the Google Ads API on the project.
5. **Generate the refresh token.** Run the [`generate_user_credentials`](https://developers.google.com/google-ads/api/samples/generate-user-credentials) flow once locally with the OAuth playground, signing in as the MCC user from step 1. Scope: `https://www.googleapis.com/auth/adwords`. Save the resulting refresh token.
6. **Drop into `.env`** (see §8). `GoogleAdsClient.enabled` flips to true; manifest `status()` returns `configured`.

**Standard access is not on the path.** It's required only if we ever expose this tool to third-party advertisers. If that day comes, it's a separate ~10-business-day Google review with screenshots/demo creds — track it as a future PRD, not a v1 dependency.

**Quota math (Basic = 15,000 ops/day):**
- Each row returned from `searchStream` = 1 op.
- Nightly sync: ~10 sub-accounts × ~30 days × campaign-grain ≈ 5,000 ops on a fresh full backfill, ~500/day in steady state (only delta-pulling current + previous day).
- Slack ad-hoc queries hit Supabase, not the API — 0 quota.
- Live `today_spend` passthrough: ~10 accounts × 1 row each = ~10 ops per call.
- Comfortable headroom for daily operations and an occasional ad-hoc backfill.

---

## 5. Storage: Supabase Sync (the Departure from Meta)

Meta is live-only because the Graph API is fast and rate limits are generous. Google Ads is the opposite — searchStream is 300-1500ms per account and Basic-tier quota is tight. So Google Ads sits in Supabase from day one.

### New tables

```
google_ads_customers
  customer_id            text PK         -- 10-digit CID, no dashes
  descriptive_name       text
  manager                boolean         -- true if this is a sub-MCC, not a leaf account
  parent_manager_id      text NULL       -- parent CID in the hierarchy
  level                  smallint        -- 0 = MCC root, 1 = direct child, etc.
  currency_code          text
  time_zone              text
  status                 text            -- ENABLED | CANCELED | SUSPENDED | CLOSED
  last_synced_at         timestamptz

google_ads_daily_metrics
  customer_id            text   FK
  date                   date            -- segments.date
  cost                   numeric(12,2)   -- cost_micros / 1e6
  impressions            bigint
  clicks                 bigint
  conversions            numeric(12,2)
  conversions_value      numeric(12,2)
  ctr                    numeric(8,4)    -- derived
  avg_cpc                numeric(8,4)    -- derived
  synced_at              timestamptz
  PRIMARY KEY (customer_id, date)

google_ads_campaign_metrics
  customer_id            text   FK
  campaign_id            text
  campaign_name          text
  campaign_status        text
  date                   date
  cost                   numeric(12,2)
  impressions            bigint
  clicks                 bigint
  conversions            numeric(12,2)
  conversions_value      numeric(12,2)
  synced_at              timestamptz
  PRIMARY KEY (customer_id, campaign_id, date)

google_ads_sync_runs
  id                     uuid PK
  started_at             timestamptz
  finished_at            timestamptz
  status                 text             -- ok | partial | error
  customers_synced       int
  rows_upserted          int
  ops_consumed           int              -- approximate, for quota tracking
  error_message          text NULL
```

### Sync worker shape

`src/integrations/google-ads/sync-worker.ts` — runnable as `npm run sync:google-ads` and wired into the existing scheduler ([src/core/scheduler.ts](../src/core/scheduler.ts)) on `0 2 * * *` PT (matching the team's existing nightly window). Steps:

1. `listAccessibleCustomers` → enumerate sub-accounts via recursive `customer_client` query → upsert `google_ads_customers`.
2. For each leaf customer (`manager = false`):
   a. Pull last 3 days of `metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value` segmented by date at `customer` resource → upsert `google_ads_daily_metrics`.
   b. Same window at `campaign` resource → upsert `google_ads_campaign_metrics`.
   c. (3-day rolling window absorbs Google's ~3h reporting lag and any late-attribution bumps.)
3. Log a row in `google_ads_sync_runs`.
4. On error in any account, continue with the rest and mark run as `partial`.

**Initial backfill:** one-shot script that pulls 90 days. Estimated cost: ~5,000-15,000 ops depending on account/campaign count — single-day operation, no impact on subsequent quota.

### Live passthrough for "today"

`google_ads_today_spend` live tool covers the gap between "last sync ran at 02:00" and "user asks at 14:00 PT." Hits searchStream directly with `segments.date = today` and returns account-level rollup. ~1 op per account, used sparingly.

---

## 6. Slack Bot Surface (Tool Inventory)

All on `googleAdsManifest.liveTools[]`. Read-only in v1.

| Tool name | Mode | Purpose |
|---|---|---|
| `google_ads_list_accounts` | read | Returns every sub-account under the MCC from `google_ads_customers` (Supabase, not live). Filterable by `nameContains`, `status`, `manager` (true/false). Use this to discover newly granted accounts before wiring them into `instance.md`. Mirrors `meta_list_ad_accounts`. |
| `google_ads_today_spend` | read (live) | Hits the Google Ads API directly for today's spend across one or more customers. Bounded — only `segments.date = today`. Used when the Supabase sync is stale. |

For everything else (date-range spend, campaign breakdowns, CTR/CPC/conversions, joins to other Supabase tables) the Slack bot uses the existing `supabase_query` tool against the `google_ads_*` tables — same pattern as Ringba. The manifest's `supabaseTables[]` block teaches the schema to Claude automatically.

A tool-level `get_google_ads_spend` is **not** added; the Supabase tables expose enough surface that GAQL-style aggregation is unnecessary at the tool layer. If a workflow needs a typed report, it imports `getCustomerSpend()` from `src/integrations/google-ads/reports.ts` (Supabase-backed; mirrors `meta/reports.ts`).

### System prompt blurb

> "Google Ads spend is in Supabase (`google_ads_daily_metrics` for account-day, `google_ads_campaign_metrics` for campaign-day, `google_ads_customers` for the account directory). Use `supabase_query` for any historical reporting question — joins to Ringba and LeadsProsper work natively. Use `google_ads_list_accounts` to discover sub-accounts, and `google_ads_today_spend` only when the user asks about spend so far today (the nightly sync lags by 1 day). Do NOT call `google_ads_today_spend` for any date other than today."

---

## 7. Dashboard Surface

Zero code changes to the dashboard. The `/integrations` page already renders manifest cards from the API's `/api/integrations` response ([dashboard/src/app/(dashboard)/integrations/page.tsx:153](../dashboard/src/app/(dashboard)/integrations/page.tsx:153)). Adding `googleAdsManifest` to the registry produces:

- A card with status badge (`Enabled` / `Disabled`).
- Feature badges from `manifest.features[]` (e.g. "Account discovery via MCC", "Cost / impressions / clicks / conversions sync", "Nightly Supabase sync").
- Live-tool count (2 in v1).
- Expandable "Tables exposed" section showing `google_ads_customers`, `google_ads_daily_metrics`, `google_ads_campaign_metrics` with column descriptions.

If we want a richer surface later (sync run history, last-synced timestamp, ops-consumed gauge), that's a Phase 3 add — `google_ads_sync_runs` already has the data.

---

## 8. Configuration

### Env vars

| Variable | Required | Description |
|---|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Yes | 22-char alphanumeric token from the API Center. One per company. |
| `GOOGLE_ADS_CLIENT_ID` | Yes | OAuth2 client ID from GCP Console (Desktop-app type). |
| `GOOGLE_ADS_CLIENT_SECRET` | Yes | Paired with client ID. |
| `GOOGLE_ADS_REFRESH_TOKEN` | Yes | Long-lived refresh token from the one-time OAuth flow. Owner = whichever Google account ran the playground. |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Yes | `9899477831` — the MCC ID, no dashes. Sent as the `login-customer-id` header on every request. |

`GoogleAdsClient` constructor sets `this.enabled = Boolean(devToken && clientId && clientSecret && refreshToken && loginCustomerId)`. All methods no-op when disabled. Manifest `status()` returns `"unconfigured"` so `list_integrations` and the dashboard reflect reality.

### Per-instance config

Add `InstanceGoogleAds` to [src/core/instance-config.ts](../src/core/instance-config.ts):

```ts
interface InstanceGoogleAds {
  customerId:   string;          // sub-account CID, no dashes
  campaignIds?: string[];        // optional: scope reporting to specific campaigns
}
```

Same null-guard pattern as `meta`. Workflows resolve via `instanceConfig.googleAds?.customerId` and pass it to `getCustomerSpend()`.

---

## 9. Code Layout

### New files (Phase 1)

```
src/integrations/google-ads/
  client.ts          GoogleAdsClient — wraps Opteo SDK, handles auth + retries
  types.ts           GoogleAdsCustomer, DailyMetric, CampaignMetric, SyncRunResult
  index.ts           barrel export (mirrors meta/index.ts)
  manifest.ts        IntegrationManifest — supabaseTables[] + liveTools[]
  live-tools.ts      QATool[]: google_ads_list_accounts, google_ads_today_spend
  reports.ts         getCustomerSpend() — Supabase-backed
  sync-worker.ts     nightly pull, upsert google_ads_* tables
```

### Touched files

- `src/core/integration-registry.ts` — one import + push to `INTEGRATION_MANIFESTS`.
- `src/core/instance-config.ts` — add `InstanceGoogleAds` + parser.
- `src/core/scheduler.ts` — register the nightly sync worker on `0 2 * * *` PT.
- `package.json` — add `google-ads-api` dependency + `npm run sync:google-ads` script.
- `data/schema-annotations.json` — extended automatically by manifest (no manual edit).
- `docs/environment.md`, `docs/integrations.md` — document env vars + Google Ads section.
- `docs/qa-bot.md` — add Google Ads to the available-integrations narrative.

### Migrations

One Supabase migration adds the four `google_ads_*` tables (§5). No changes to existing tables.

---

## 10. Phased Rollout

| Phase | Deliverable | Effort | Gates |
|---|---|---|---|
| **0. Access setup (prereq)** | Apply for developer token, get Basic access, generate OAuth refresh token. | 0.5 day (mostly waiting) | `.env` populated; `GoogleAdsClient.enabled === true` in a local repl. |
| **1. Read path + sync** | `client.ts`, `types.ts`, `manifest.ts`, `sync-worker.ts`, Supabase migration, `google_ads_list_accounts` live tool, `getCustomerSpend()` Supabase reader. Manifest registered. Initial 90-day backfill run. | 2.5 days | Demos: (a) `/integrations` shows Google Ads card with 3 tables, (b) Slack: "which Google Ads accounts do we have?" returns sub-account list, (c) Slack: "what was Google Ads spend on HVAC last week?" returns Supabase-backed answer with sub-second latency, (d) Slack: "Google Ads CTR by campaign for U65 last 7 days" via `supabase_query`. |
| **2. Live `today` passthrough + scheduled sync** | `google_ads_today_spend` live tool, nightly sync wired into scheduler at 02:00 PT, `google_ads_sync_runs` populated. | 1 day | Slack: "what's our Google Ads spend so far today on HVAC?" returns live-API answer. Nightly sync runs unattended for 3 consecutive days without intervention. |
| **3. Workflow integration** | Per-instance `googleAds.customerId` config, P&L reporting workflow consumes `getCustomerSpend()` alongside Meta. Pilot on `final-expense-reporting` instance. | 1 day | Reporting workflow output shows Google Ads spend line item next to Meta. |
| **4. (Deferred) Publishing** | Mutate path: `google_ads_create_campaign`, `google_ads_pause_campaign`, etc. Separate PRD when prioritized. | TBD | N/A |

Total through Phase 3: ~5 working days, plus access-setup wait time.

---

## 11. Risks & Open Questions

- **OQ-01** — **Refresh-token owner.** Which Google account on the MCC will hold it? Loss of that account (departure, password loss without recovery) = re-issue and re-deploy. Recommend a shared `automation@elevarus.com` if one exists, otherwise Shane's account.
- **OQ-02** — **Opteo SDK lag risk.** SDK is community-maintained; if a v-bump breaks before maintainers patch, we may need a temporary raw-fetch escape hatch for `searchStream`. Mitigate by keeping `client.ts` thin so the swap is local.
- **OQ-03** — **Standard access trigger.** Confirm we have no near-term plans to expose this tool to third-party advertisers (which would force the ~10-day Standard review). If not, this is non-blocking.
- **OQ-04** — **Backfill window.** 90 days is the default. If P&L workflows need year-over-year comparisons, bump to 400+ days at one-time setup cost (~50k-100k ops; a single one-off is fine, well under daily Basic cap if done off-hours).
- **OQ-05** — **Conversion attribution.** Google's `conversions` and `conversions_value` reflect whatever conversion actions are configured per-account. We don't unify or normalize across accounts — agents that care must declare which conversion actions count. (Out of scope for v1.)
- **OQ-06** — **Currency normalization.** `google_ads_customers.currency_code` is per-account. If we ever mix non-USD accounts, downstream reporting needs an FX layer. Today every account is USD; flag if that changes.
- **OQ-07** — **Rate-limit retry policy.** Wrap SDK calls in our own backoff for `RESOURCE_EXHAUSTED` (HTTP 429). The SDK's built-in retry is thin. Same pattern as `RingbaHttpClient`.

---

## 12. References (live URLs)

- API Center (request developer token): https://ads.google.com/aw/apicenter
- Developer token policy: https://developers.google.com/google-ads/api/docs/api-policy/developer-token
- Access levels (Test / Explorer / Basic / Standard): https://developers.google.com/google-ads/api/docs/api-policy/access-levels
- Quotas & rate limits: https://developers.google.com/google-ads/api/docs/best-practices/quotas
- Auth headers (incl. `login-customer-id`): https://developers.google.com/google-ads/api/rest/auth
- Refresh-token sample: https://developers.google.com/google-ads/api/samples/generate-user-credentials
- Release notes (v23 current): https://developers.google.com/google-ads/api/docs/release-notes
- v23 RPC reference: https://developers.google.com/google-ads/api/reference/rpc/v23/overview
- Search & SearchStream: https://developers.google.com/google-ads/api/rest/common/search
- GAQL grammar: https://developers.google.com/google-ads/api/docs/query/grammar
- Account hierarchy enumeration: https://developers.google.com/google-ads/api/docs/account-management/get-account-hierarchy
- listAccessibleCustomers: https://developers.google.com/google-ads/api/docs/account-management/listing-accounts
- Node SDK (Opteo): https://github.com/Opteo/google-ads-api · https://www.npmjs.com/package/google-ads-api
