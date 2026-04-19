/**
 * LeadsProsper integration manifest.
 *
 * Registered via src/core/integration-registry.ts.
 */

import type { IntegrationManifest } from "../../core/integration-registry";

export const manifest: IntegrationManifest = {
  id:          "leadsprosper",
  name:        "LeadsProsper",
  description: "Lead routing + attribution. Incoming leads with buyer acceptance, cost/revenue, and status. Synced to Supabase every 15 minutes.",

  status: () =>
    process.env.LEADSPROSPER_API_KEY ? "configured" : "unconfigured",

  supabaseTables: [
    {
      name:        "lp_leads",
      description:
        "One row per lead routed by LeadsProsper. Status indicates whether the buyer accepted. Use for cost/revenue analysis by campaign, supplier, or state. Joins to ringba_calls via phone_normalized.",
      columns: {
        id:               "Primary key — LP lead ID string.",
        campaign_id:      "FK to lp_campaigns.id.",
        campaign_name:    "Campaign name (denormalized).",
        status:           "ACCEPTED | REJECTED | DUPLICATED | ERROR.",
        error_code:       "Numeric error code (0 when status='ACCEPTED').",
        error_message:    "Human-readable error (when status != 'ACCEPTED').",
        is_test:          "True for test leads — exclude for production metrics.",
        cost:             { description: "What we paid the supplier for the lead.",   type: "numeric(12,4)" },
        revenue:          { description: "What the buyer paid us for the lead.",      type: "numeric(12,4)" },
        lead_date:        { description: "Lead timestamp (from LP's lead_date_ms).",  type: "timestamptz" },
        phone:            "Lead's phone (original format from LP).",
        phone_normalized: "Digits-only phone — the reconciliation join key against ringba_calls.phone_normalized.",
        email:            "Lead's email.",
        state:            "US state code (2-letter).",
        zip_code:         "ZIP code.",
        sub1:             "LP sub ID 1 — traffic source tag.",
        sub2:             "LP sub ID 2.",
        sub3:             "LP sub ID 3.",
        supplier_id:      "Numeric supplier ID.",
        supplier_name:    "Supplier name (denormalized).",
        lead_data:        { description: "Long-tail lead fields that vary by vertical.", type: "jsonb" },
        buyers:           { description: "Array of buyer routing decisions.",            type: "jsonb" },
        raw:              { description: "Full original LP API payload. Heavy.",        type: "jsonb" },
        synced_at:        { description: "When the sync worker wrote this row.",       type: "timestamptz" },
        updated_at:       { description: "Row update timestamp.",                       type: "timestamptz" },
      },
    },
    {
      name:        "lp_campaigns",
      description: "Reference list of LP campaigns the account owns.",
      columns: {
        id:             "Primary key — LP campaign ID.",
        name:           "Campaign name.",
        raw:            { description: "Full LP campaign JSON. Heavy.", type: "jsonb" },
        first_seen_at:  { description: "When we first saw this campaign.", type: "timestamptz" },
        last_synced_at: { description: "Most recent sync timestamp.", type: "timestamptz" },
      },
    },
    {
      name:        "lp_sync_state",
      description: "Checkpoint for the LP sync worker.",
      columns: {
        sync_key:        "Logical sync stream — 'leads:global' or 'campaigns:global'.",
        last_synced_at:  { description: "When the worker last ran.",    type: "timestamptz" },
        high_water_mark: { description: "Latest lead_date we've seen.", type: "timestamptz" },
        last_error:      "Last error message (if any).",
        notes:           { description: "Free-form notes JSONB.",       type: "jsonb" },
      },
    },
  ],

  liveTools: [],

  features: [
    "Lead routing and attribution",
    "Buyer acceptance and rejection tracking",
    "Cost vs revenue analysis",
    "Supplier performance metrics",
    "Phone-normalized join to Ringba calls",
    "Supabase sync (15-minute cadence)",
  ],

  systemPromptBlurb:
    "LeadsProsper data lives in `lp_leads` (one row per lead, with status, cost, revenue, supplier, and phone_normalized for joining to ringba_calls). " +
    "Most questions should use `supabase_query` — filter out is_test=true and status='ERROR' for clean lead metrics.",

  exampleQuestions: [
    "How many accepted leads did we get from each supplier last week?",
    "What was our total LP cost vs revenue MTD?",
    "Which campaigns had the most rejected leads yesterday?",
  ],
};
