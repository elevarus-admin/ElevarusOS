/**
 * Ringba integration manifest.
 *
 * Registered via src/core/integration-registry.ts. The Q&A bot picks up
 * these tables + tools + prompt guidance at boot.
 */

import type { IntegrationManifest } from "../../core/integration-registry";
import { ringbaLiveQueryTool } from "./live-tools";

export const manifest: IntegrationManifest = {
  id:          "ringba",
  name:        "Ringba",
  description: "Call-tracking revenue, paid calls, publisher attribution, and campaign performance. Synced to Supabase every 15 minutes.",

  status: () =>
    (process.env.RINGBA_API_KEY && process.env.RINGBA_ACCOUNT_ID)
      ? "configured"
      : "unconfigured",

  supabaseTables: [
    {
      name:        "ringba_calls",
      description:
        "One row per inbound call to a Ringba campaign. The 'winning' routing attempt (non-duplicate, has_payout preferred) is promoted to top-level columns; all routing attempts are in the `routing_attempts` JSONB. Custom + system tag values (utm_campaign, Geo:Country, etc.) are in `tag_values` JSONB (GIN-indexed). Use has_payout=true AND is_duplicate=false for accurate revenue/paid-call metrics.",
      columns: {
        inbound_call_id:          "Primary key — Ringba inbound call ID.",
        campaign_id:              "FK to ringba_campaigns.id.",
        campaign_name:            "Campaign name (denormalized from ringba_campaigns).",
        inbound_phone:            "Caller's phone number (E.164 or local format).",
        phone_normalized:         "Digits-only phone — the reconciliation join key against lp_leads.phone_normalized.",
        call_dt:                  { description: "Timestamp of the call (UTC). Use for time-range filters.", type: "timestamptz" },
        call_length_seconds:      { description: "Total call duration in seconds.", type: "integer" },
        connected_length_seconds: { description: "Connected portion of the call (after routing).", type: "integer" },
        has_connected:            "True if the call connected to a buyer.",
        has_converted:            "True if the call was marked converted.",
        has_payout:               "True if a buyer paid for this call. Combine with is_duplicate=false for billable-call counts.",
        is_duplicate:             "True if Ringba flagged this as a duplicate routing attempt. Exclude for revenue reports.",
        no_conversion_reason:     "Text reason the call didn't convert (if applicable).",
        conversion_amount:        { description: "Amount the buyer paid us for the conversion.", type: "numeric(12,4)" },
        payout_amount:            { description: "Dollar amount paid out for this call. Primary revenue column.", type: "numeric(12,4)" },
        profit_net:               { description: "Net profit on the call.", type: "numeric(12,4)" },
        total_cost:               { description: "Our cost for the call (inbound fees + routing).", type: "numeric(12,4)" },
        winning_buyer:            "Name of the buyer who paid for the call.",
        target_name:              "Ringba target (the specific buyer endpoint).",
        publisher_name:           "Traffic source / affiliate that drove the call. Use for publisher-level attribution.",
        recording_url:            "URL to the call recording (if captured).",
        routing_attempt_count:    { description: "How many buyers the call was offered to.", type: "integer" },
        routing_attempts:         { description: "Full JSONB array of every routing attempt (verbatim from Ringba). Heavy — exclude from SELECT unless needed.", type: "jsonb" },
        raw:                      { description: "Full winning-attempt API record verbatim from Ringba. Heavy — exclude from SELECT unless you need a field not promoted to a column.", type: "jsonb" },
        tag_values:               { description: "Flat map of every tag value Ringba captured for this call. Keys are 'TagType:TagName' (e.g. 'User:utm_campaign', 'User:utm_content', 'Geo:Country', 'Technology:OS'). Values are strings. GIN-indexed — use JSONB containment (tag_values @> '{\"User:utm_campaign\": \"x\"}') or `->>` for filters.", type: "jsonb" },
        synced_at:                { description: "When the sync worker wrote this row.", type: "timestamptz" },
        updated_at:               { description: "Row update timestamp.", type: "timestamptz" },
      },
    },
    {
      name:        "ringba_campaigns",
      description: "Reference list of every Ringba campaign in the account.",
      columns: {
        id:             "Primary key — Ringba campaign ID.",
        name:           "Campaign name.",
        enabled:        "Whether the campaign is active.",
        raw:            { description: "Full Ringba campaign JSON. Heavy.", type: "jsonb" },
        first_seen_at:  { description: "When we first saw this campaign.", type: "timestamptz" },
        last_synced_at: { description: "Most recent sync timestamp.", type: "timestamptz" },
      },
    },
    {
      name:        "ringba_sync_state",
      description: "Checkpoint for the Ringba sync worker. Primarily useful for debugging sync lag.",
      columns: {
        sync_key:        "Logical sync stream — 'calls:global' or 'campaigns:global'.",
        last_synced_at:  { description: "When the worker last ran.", type: "timestamptz" },
        high_water_mark: { description: "Latest call_dt we've seen.", type: "timestamptz" },
        low_water_mark:  { description: "Earliest call_dt we've synced. For coverage checks.", type: "timestamptz" },
        last_error:      "Last error message (if any).",
        notes:           { description: "Free-form notes JSONB.", type: "jsonb" },
      },
    },
  ],

  liveTools: [ringbaLiveQueryTool],

  systemPromptBlurb:
    "Ringba data lives in `ringba_calls` (one row per call with publisher_name, campaign_name, payout_amount, call_dt, has_payout, is_duplicate). " +
    "For revenue rollups prefer `supabase_query` with filters `has_payout = true AND is_duplicate = false` and aggregations on `payout_amount`. " +
    "The sync worker runs every 15 minutes — for fresher data or fields not in the schema, fall back to `ringba_live_query`. " +
    "CUSTOM + SYSTEM TAGS: every call also has a `tag_values` JSONB column keyed 'TagType:TagName' (e.g. 'User:utm_campaign', 'User:utm_content', 'Geo:Country', 'Technology:OS', 'Date:ISODate'). " +
    "Use `list_ringba_tags` to see what tag keys are actually populated on this account, then filter via `supabase_query` with " +
    "`{ column: 'tag_values', op: 'jsonb_contains', value: { 'User:utm_campaign': 'spring_hvac' } }`. " +
    "Note: User:* tags (utm_campaign, utm_content) populate only when Ringba is configured to capture them via URL-param capture or JS tag — if list_ringba_tags shows no User:* keys, the capture may not be set up yet.",

  exampleQuestions: [
    "What was our WTD Ringba revenue for the CHP and CLARO publishers across all campaigns?",
    "Which Ringba publisher drove the most paid calls yesterday?",
    "Show call volume by campaign for the last 7 days.",
    "Revenue breakdown by utm_campaign for the last 30 days.",
    "Top 5 utm_content values by paid-call count this week.",
    "Which US state (Geo:SubDivisionCode) drove the most billable calls last month?",
  ],
};
