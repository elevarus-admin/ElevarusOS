/**
 * Meta Ads integration manifest.
 *
 * Live API only — no Supabase cache yet. Once a meta-sync worker lands,
 * supabaseTables will be populated and meta_query becomes a supabase passthrough.
 */

import type { IntegrationManifest } from "../../core/integration-registry";

export const manifest: IntegrationManifest = {
  id:          "meta",
  name:        "Meta Ads",
  description: "Meta (Facebook) Ads spend, impressions, clicks, and CTR/CPC/CPM rate metrics. Live Graph API — no Supabase cache yet.",

  status: () =>
    process.env.META_ACCESS_TOKEN ? "configured" : "unconfigured",

  // No Supabase tables yet — Meta hits the live Graph API.
  supabaseTables: [],

  liveTools: [],

  systemPromptBlurb:
    "Meta Ads data is NOT in Supabase. Use the existing `get_meta_spend` tool (resolves from instance config) for simple instance-bound queries, " +
    "or the forthcoming `meta_query` tool for arbitrary ad account / breakdown / date-range queries.",

  exampleQuestions: [
    "What was our Meta spend WTD on the U65 ad account?",
    "Show Meta CPC for each campaign last week.",
  ],
};
