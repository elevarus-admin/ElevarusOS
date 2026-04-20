import type { IntegrationManifest } from "../../core/integration-registry";
import {
  everflowListOffersTool,
  everflowOfferPayoutsTool,
} from "./live-tools";

export const manifest: IntegrationManifest = {
  id:          "everflow",
  name:        "Everflow",
  description: "Affiliate / partner network. Offers, partners (affiliates), and payout reporting. Live API only — no Supabase mirror yet.",

  status: () =>
    process.env.EVERFLOW_API_KEY ? "configured" : "unconfigured",

  supabaseTables: [],

  liveTools: [
    everflowListOffersTool,
    everflowOfferPayoutsTool,
  ],

  features: [
    "Offer discovery (list + filter by name)",
    "Per-offer payout rollups over arbitrary PT date ranges",
    "Per-partner payout breakdown",
    "Substring-based partner exclusion (e.g. drop 'INTERNAL' test partners)",
  ],

  systemPromptBlurb:
    "Everflow is the affiliate / partner network. Use `everflow_list_offers` to discover offer IDs by name. Use `everflow_offer_payouts` to roll up payouts (and revenue / conversions) for a single offer over a PT date range, with optional `excludePartnerPatterns: ['INTERNAL']` to drop test or internal partners. " +
    "Date range is YYYY-MM-DD in PT (Everflow timezone is hardcoded to America/Los_Angeles). " +
    "For 'how much did we owe partners on offer 8 last week?' or 'what's MTD payout on the U65 offer excluding INTERNAL?' — `everflow_offer_payouts` is the right tool.",

  exampleQuestions: [
    "What's MTD partner payout on offer 8, excluding INTERNAL partners?",
    "Find the Everflow offer ID for U65.",
    "Which Everflow partners drove the most revenue last week on offer 8?",
  ],
};
