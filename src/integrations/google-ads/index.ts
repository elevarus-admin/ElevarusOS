/**
 * Google Ads Integration
 *
 * Pulls ad spend from the Google Ads API for P&L reporting and Slack Q&A.
 * The customer ID (10-digit CID) is the per-agent identifier — configured
 * in instance.md under `googleAds.customerId`.
 *
 * Differs from Meta in that Google Ads is Supabase-synced (nightly) rather
 * than live-only — Google's Basic-tier quota of 15k ops/day doesn't favor
 * ad-hoc Slack queries hitting the API directly. See docs/prd-google-ads-integration.md.
 *
 * Env vars (all required):
 *   GOOGLE_ADS_DEVELOPER_TOKEN     — from MCC API Center
 *   GOOGLE_ADS_CLIENT_ID           — OAuth2 Desktop client
 *   GOOGLE_ADS_CLIENT_SECRET       — paired with client ID
 *   GOOGLE_ADS_REFRESH_TOKEN       — minted via scripts/google-ads-oauth.ts
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID   — MCC ID, no dashes (9899477831)
 */

export { getCustomerSpend }      from "./reports";
export { GoogleAdsClient }       from "./client";
export { GoogleAdsSyncWorker, runGoogleAdsSync } from "./sync-worker";
export type {
  GoogleAdsCustomerSummary,
  GoogleAdsDailyMetric,
  GoogleAdsCampaignMetric,
  GoogleAdsSpendOptions,
  GoogleAdsSpendReport,
  GoogleAdsSyncRunResult,
} from "./types";
