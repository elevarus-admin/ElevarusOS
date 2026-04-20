/**
 * Agent Builder integration manifest.
 *
 * Registered via src/core/integration-registry.ts. The Slack bot picks up
 * the 3 tools + system prompt blurb at boot; the dashboard /integrations
 * page picks up the same metadata for display.
 *
 * This is a "feature as pseudo-integration" — it has no external API or
 * Supabase table OWNED by an external source. The one Supabase table
 * (agent_builder_sessions) is internal state, not a data source for querying,
 * so it's deliberately omitted from supabaseTables[] (we don't want Claude
 * querying sessions via supabase_query).
 */

import type { IntegrationManifest } from "../integration-registry";
import { agentBuilderLiveTools }    from "./slack-tools";
import { SYSTEM_PROMPT_BLURB }      from "./prompts";

export const manifest: IntegrationManifest = {
  id:          "agent-builder",
  name:        "Agent Builder",
  description: "Structured 6-question flow that turns 'I want a bot that...' into a ClickUp PRD engineering can implement from. Available via Slack (@Elevarus I want to build an agent...) and the dashboard (/agents/new).",

  status: () => {
    const hasClickup = Boolean(process.env.CLICKUP_API_TOKEN && process.env.CLICKUP_TEAM_ID);
    const hasList    = Boolean(process.env.AGENT_BUILDER_CLICKUP_LIST_ID || process.env.CLICKUP_DEFAULT_LIST_ID);
    return hasClickup && hasList ? "configured" : "unconfigured";
  },

  // No data-source tables — internal state only.
  supabaseTables: [],

  liveTools: agentBuilderLiveTools,

  features: [
    "6-question scoping flow for new agents",
    "Server-enforced question order (no short-circuits)",
    "Adaptive follow-ups when answers are ambiguous",
    "Session resume in the same Slack thread",
    "Auto-creates a ClickUp ticket with a 10-section PRD",
    "Slack + Dashboard (Phase 3) surfaces share the same backend",
  ],

  systemPromptBlurb: SYSTEM_PROMPT_BLURB,

  exampleQuestions: [
    "Can you help me scope a new LinkedIn Ads reporting agent?",
    "I want a bot that summarizes overnight call failures — walk me through it.",
    "We need something that watches ClickUp for new HVAC leads and starts a workflow.",
  ],
};
