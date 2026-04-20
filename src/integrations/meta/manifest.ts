/**
 * Meta Ads integration manifest.
 *
 * Live API only — no Supabase cache yet. Once a meta-sync worker lands,
 * supabaseTables will be populated and meta_query becomes a supabase passthrough.
 */

import type { IntegrationManifest } from "../../core/integration-registry";
import { metaListAdAccountsTool, metaQueryTool } from "./live-tools";

export const manifest: IntegrationManifest = {
  id:          "meta",
  name:        "Meta Ads",
  description: "Meta (Facebook) Ads spend, impressions, clicks, and CTR/CPC/CPM rate metrics. Live Graph API — no Supabase cache yet.",

  status: () =>
    process.env.META_ACCESS_TOKEN ? "configured" : "unconfigured",

  // No Supabase tables yet — Meta hits the live Graph API.
  supabaseTables: [],

  liveTools: [metaListAdAccountsTool, metaQueryTool],

  features: [
    "Meta (Facebook) Ads spend reporting",
    "Impressions, clicks, CTR, CPC, and CPM metrics",
    "Per-campaign / per-ad-set / per-ad breakouts via meta_query",
    "Optional breakdown dimensions (placement, age, gender, device)",
    "Ad account discovery via System User token",
    "Live Graph API (no Supabase cache yet)",
  ],

  systemPromptBlurb:
    "Meta Ads data is NOT in Supabase. Three tools: " +
    "(1) `meta_list_ad_accounts` — discover every ad account the System User token can see (accountId, name, business, status, currency). Useful for 'which Meta accounts do we have access to' or 'find the U65 ad account'. " +
    "(2) `get_meta_spend` — simple instance-bound account-level spend rollup. Use for 'what was our Meta spend MTD?'. Fast path for total-account numbers, NOT for per-campaign / per-ad questions. " +
    "(3) `meta_query` — **per-entity Insights** (level=account|campaign|adset|ad). This is the right tool for 'which ad has the best CPC?', 'top 5 campaigns by CTR last week', 'best ad set by spend MTD', or any question that needs a breakout rather than an account total. Pass `instanceId` as a shortcut (resolves to meta.adAccountId) or pass `adAccountId` directly. Supports `breakdowns` (placement, age, gender, device_platform), server-side campaign/ad filtering, PT-anchored date presets. " +
    "**Statistical significance caveat:** when comparing CTR / CPC across variants, rows with < 1,000 impressions are not meaningful — surface the confidence caveat to the user rather than declaring a winner prematurely. `meta_query` returns a `confidence_note` field when any returned row is below this threshold.",

  exampleQuestions: [
    "Which Meta ad accounts can we access?",
    "Find the Meta ad account ID for HVAC.",
    "What was our Meta spend WTD on the U65 ad account?",
    "Which HVAC ad has the best CPC + CTR with statistical significance?",
    "Top 5 U65 campaigns by CTR last week.",
    "Break down HVAC spend by publisher_platform MTD.",
    "Best-performing ad set in the FE account last month.",
  ],
};
