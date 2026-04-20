/**
 * Meta Ads integration manifest.
 *
 * Live API only — no Supabase cache yet. Once a meta-sync worker lands,
 * supabaseTables will be populated and meta_query becomes a supabase passthrough.
 */

import type { IntegrationManifest } from "../../core/integration-registry";
import { metaListAdAccountsTool } from "./live-tools";

export const manifest: IntegrationManifest = {
  id:          "meta",
  name:        "Meta Ads",
  description: "Meta (Facebook) Ads spend, impressions, clicks, and CTR/CPC/CPM rate metrics. Live Graph API — no Supabase cache yet.",

  status: () =>
    process.env.META_ACCESS_TOKEN ? "configured" : "unconfigured",

  // No Supabase tables yet — Meta hits the live Graph API.
  supabaseTables: [],

  liveTools: [metaListAdAccountsTool],

  features: [
    "Meta (Facebook) Ads spend reporting",
    "Impressions, clicks, CTR, CPC, and CPM metrics",
    "Ad account and campaign breakdowns",
    "Ad account discovery via System User token",
    "Live Graph API (no Supabase cache yet)",
  ],

  systemPromptBlurb:
    "Meta Ads data is NOT in Supabase. " +
    "Use `meta_list_ad_accounts` to discover every ad account the System User token can see (returns accountId, name, business, status, currency) — useful for 'which Meta accounts do we have access to' or 'find the U65 ad account'. " +
    "Use the existing `get_meta_spend` tool (resolves from instance config) for simple instance-bound spend queries, " +
    "or the forthcoming `meta_query` tool for arbitrary ad account / breakdown / date-range queries.",

  exampleQuestions: [
    "Which Meta ad accounts can we access?",
    "Find the Meta ad account ID for HVAC.",
    "What was our Meta spend WTD on the U65 ad account?",
    "Show Meta CPC for each campaign last week.",
  ],
};
