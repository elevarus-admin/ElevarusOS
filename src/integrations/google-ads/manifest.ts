/**
 * Google Ads integration manifest.
 *
 * Registered via src/core/integration-registry.ts. The Q&A bot picks up the
 * tables + tools + system-prompt blurb at boot; the dashboard `/integrations`
 * page picks up the same metadata at runtime.
 *
 * Differs from Meta in that data is Supabase-synced (nightly), so
 * `supabaseTables[]` is populated and `supabase_query` is the primary path.
 * Live API is only used for "today" queries and account discovery fallback.
 */

import type { IntegrationManifest } from "../../core/integration-registry";
import {
  googleAdsListAccountsTool,
  googleAdsTodaySpendTool,
} from "./live-tools";

export const manifest: IntegrationManifest = {
  id:          "google-ads",
  name:        "Google Ads",
  description: "Google Ads spend, impressions, clicks, conversions, CTR, and CPC across all sub-accounts under MCC 989-947-7831. Synced to Supabase nightly @ 02:00 PT.",

  status: () =>
    (process.env.GOOGLE_ADS_DEVELOPER_TOKEN
      && process.env.GOOGLE_ADS_CLIENT_ID
      && process.env.GOOGLE_ADS_CLIENT_SECRET
      && process.env.GOOGLE_ADS_REFRESH_TOKEN
      && process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID)
      ? "configured"
      : "unconfigured",

  supabaseTables: [
    {
      name:        "google_ads_customers",
      description:
        "Sub-account directory for the Elevarus MCC (9899477831). One row per customer (sub-account). " +
        "Use `manager = false` to filter to leaf advertiser accounts (exclude sub-MCCs). " +
        "Use `status = 'ENABLED'` to exclude CANCELED / SUSPENDED / CLOSED accounts.",
      columns: {
        customer_id:       "Primary key — 10-digit Google Ads CID, no dashes. What goes in instance.md `googleAds.customerId`.",
        descriptive_name:  "Display name in Google Ads (e.g. 'SaveOnMyQuote.com - HVAC').",
        manager:           "True if this is a sub-MCC, false for a leaf advertiser account. Filter to false for spend queries.",
        parent_manager_id: "Parent CID in the hierarchy. Null at MCC root.",
        level:             { description: "0 = MCC root, 1 = direct child, 2 = grandchild, ...", type: "smallint" },
        currency_code:     "ISO currency code (USD).",
        time_zone:         "IANA timezone for the account.",
        status:            "Account status: ENABLED | CANCELED | SUSPENDED | CLOSED | HIDDEN.",
        first_seen_at:     { description: "When the sync worker first saw this account.", type: "timestamptz" },
        last_synced_at:    { description: "Most recent sync timestamp for this row.",     type: "timestamptz" },
      },
    },
    {
      name:        "google_ads_daily_metrics",
      description:
        "Daily account-level Google Ads metrics. PRIMARY table for spend reporting — one row per (customer, date). " +
        "For total spend join `google_ads_customers` on customer_id to get the friendly name. " +
        "Sync worker pulls a 3-day rolling window @ 02:00 PT, so today's data is NOT in this table — use `google_ads_today_spend` for intraday.",
      columns: {
        customer_id:       "FK to google_ads_customers.customer_id.",
        date:              { description: "Date in account timezone (segments.date). Use for time-range filters.", type: "date" },
        cost:              { description: "Total cost (USD) for the customer/day. cost_micros / 1e6, primary spend column.", type: "numeric(12,2)" },
        impressions:       { description: "Ad impressions for the customer/day.", type: "bigint" },
        clicks:            { description: "Clicks for the customer/day.",         type: "bigint" },
        conversions:       { description: "Conversion count (per-account conversion-action config).",        type: "numeric(12,2)" },
        conversions_value: { description: "Conversion value in USD.",            type: "numeric(12,2)" },
        ctr:               { description: "Click-through rate as a fraction (0.0432 = 4.32%). Pre-computed.", type: "numeric(8,4)" },
        avg_cpc:           { description: "Average cost per click (USD). Pre-computed.",                     type: "numeric(8,4)" },
        synced_at:         { description: "When this row was last refreshed.", type: "timestamptz" },
      },
    },
    {
      name:        "google_ads_campaign_metrics",
      description:
        "Daily campaign-level Google Ads metrics. One row per (customer, campaign, date). " +
        "Use for campaign breakdowns; for total account spend `google_ads_daily_metrics` is faster.",
      columns: {
        customer_id:       "FK to google_ads_customers.customer_id.",
        campaign_id:       "Google Ads campaign ID.",
        campaign_name:     "Campaign display name.",
        campaign_status:   "ENABLED | PAUSED | REMOVED.",
        date:              { description: "Date in account timezone.", type: "date" },
        cost:              { description: "Cost (USD) for the campaign/day.", type: "numeric(12,2)" },
        impressions:       { type: "bigint",        description: "Impressions for the campaign/day." },
        clicks:            { type: "bigint",        description: "Clicks for the campaign/day." },
        conversions:       { type: "numeric(12,2)", description: "Conversions for the campaign/day." },
        conversions_value: { type: "numeric(12,2)", description: "Conversion value (USD)." },
        synced_at:         { type: "timestamptz",   description: "When this row was last refreshed." },
      },
    },
    {
      name:        "google_ads_sync_runs",
      description: "Log of every google-ads-sync worker run. Useful for debugging sync lag or failures.",
      columns: {
        id:                "Primary key — UUID.",
        started_at:        { description: "When the worker started.",  type: "timestamptz" },
        finished_at:       { description: "When the worker finished.", type: "timestamptz" },
        status:            "running | ok | partial | error.",
        customers_synced:  { description: "Successful customer pulls in this run.", type: "integer" },
        customers_failed:  { description: "Failed customer pulls in this run.",     type: "integer" },
        rows_upserted:     { description: "Total rows written across all metrics tables.", type: "integer" },
        window_days:       { description: "How many days back the run covered.", type: "smallint" },
        error_message:     "Last error message (if any).",
      },
    },
  ],

  liveTools: [googleAdsListAccountsTool, googleAdsTodaySpendTool],

  features: [
    "Spend, impressions, clicks, CTR, CPC, and conversions",
    "Per-customer (sub-account) and per-campaign breakdowns",
    "MCC sub-account discovery (989-947-7831)",
    "Nightly Supabase sync @ 02:00 PT (3-day rolling window)",
    "Live-API passthrough for today's intraday spend",
  ],

  systemPromptBlurb:
    "Google Ads spend lives in Supabase across three tables: `google_ads_daily_metrics` (account-day grain — primary), " +
    "`google_ads_campaign_metrics` (campaign-day grain), and `google_ads_customers` (sub-account directory under MCC 9899477831). " +
    "For ANY historical spend / CTR / CPC / conversions question, use `supabase_query` against these tables — " +
    "join `google_ads_customers` on customer_id to get the friendly account name. " +
    "Filter `google_ads_customers` with `manager = false` AND `status = 'ENABLED'` to exclude sub-MCCs and cancelled accounts. " +
    "Sync runs nightly @ 02:00 PT, so today's data is NOT in Supabase — for 'spend so far today' use `google_ads_today_spend` (live API, bounded to today only). " +
    "For account discovery (which sub-accounts exist, find the HVAC CID, etc.) use `google_ads_list_accounts`. " +
    "The `cost` column is already in USD (cost_micros has been converted on sync). " +
    "Common joins: `google_ads_daily_metrics` to `google_ads_customers` on customer_id for named rollups; " +
    "Google Ads spend can be combined with Meta spend (live, via meta tools) to produce a total paid-acquisition picture.",

  exampleQuestions: [
    "Which Google Ads accounts do we have access to?",
    "Find the Google Ads customer ID for SaveOnMyQuote HVAC.",
    "What was our Google Ads spend WTD on the HVAC account?",
    "Show Google Ads cost and clicks by sub-account for last week.",
    "Top 5 Google Ads campaigns by spend on the Final Expense account in the last 30 days.",
    "What's our Google Ads spend so far today on HVAC?",
    "Compare Google Ads CTR by account for the last 14 days.",
  ],
};
