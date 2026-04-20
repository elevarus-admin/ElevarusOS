/**
 * Integration registry.
 *
 * Every third-party data source in `src/integrations/<name>/` ships a
 * `manifest.ts` next to its client. This registry is the single place that
 * imports those manifests and exposes aggregated metadata to the rest of the
 * system:
 *
 *   - the Q&A bot (supabase_query whitelist, list_integrations tool output,
 *     system-prompt "available integrations" block, extra live-query tools)
 *   - the knowledge-catalog renderer
 *   - future surfaces (dashboard integration cards, docs generation, etc.)
 *
 * Adding a new integration is two steps:
 *   1. Create `src/integrations/<name>/manifest.ts` exporting a
 *      `IntegrationManifest` as `manifest`.
 *   2. Add one import line + push into INTEGRATION_MANIFESTS below.
 *
 * We prefer explicit imports over filesystem globbing so TypeScript / the
 * compiled `dist` tree both resolve manifests deterministically.
 */

import type { QATool } from "./qa-tools";

// ─── Types ────────────────────────────────────────────────────────────────────

export type IntegrationStatus = "configured" | "unconfigured";

/** One Supabase column, with its human description + optional type hint. */
export interface IntegrationColumn {
  description: string;
  /** Optional Postgres-style type hint, e.g. "timestamptz", "numeric(12,4)". */
  type?: string;
}

/** Convenience: a column may be declared as a bare description string. */
export type IntegrationColumnEntry = string | IntegrationColumn;

/** One Supabase table contributed by an integration. */
export interface IntegrationTable {
  name:        string;
  description: string;
  columns:     Record<string, IntegrationColumnEntry>;
}

/** Metadata block co-located with each integration. */
export interface IntegrationManifest {
  /** Stable id, matches the directory name. e.g. "ringba". */
  id:          string;
  /** Human-readable name. e.g. "Ringba". */
  name:        string;
  /** One-sentence description for `list_integrations` output. */
  description: string;
  /**
   * Runtime check for whether this integration is configured.
   * Called each time `list_integrations` runs, so it can react to env changes.
   */
  status: () => IntegrationStatus;
  /** Supabase tables this integration owns (empty for live-only sources). */
  supabaseTables?: IntegrationTable[];
  /** Extra Q&A tools this integration adds to the bot (e.g. ringba_live_query). */
  liveTools?: QATool[];
  /** Short paragraph injected into the system prompt. */
  systemPromptBlurb: string;
  /** Optional example questions for few-shot hints. */
  exampleQuestions?: string[];
  /** Human-readable feature list for dashboard integration cards. */
  features?: string[];
}

// ─── Manifest imports (one line per integration) ──────────────────────────────
//
// When adding a new integration, add an import line here and push it into
// INTEGRATION_MANIFESTS below. Do nothing else — downstream consumers pick
// up the new entry automatically.

import { manifest as ringbaManifest }        from "../integrations/ringba/manifest";
import { manifest as leadsprosperManifest }  from "../integrations/leadsprosper/manifest";
import { manifest as metaManifest }          from "../integrations/meta/manifest";
import { manifest as googleAdsManifest }     from "../integrations/google-ads/manifest";
import { manifest as clickupManifest }       from "../integrations/clickup/manifest";
import { manifest as everflowManifest }      from "../integrations/everflow/manifest";
import { manifest as thumbtackManifest }     from "../integrations/thumbtack/manifest";

export const INTEGRATION_MANIFESTS: IntegrationManifest[] = [
  ringbaManifest,
  leadsprosperManifest,
  metaManifest,
  googleAdsManifest,
  clickupManifest,
  everflowManifest,
  thumbtackManifest,
];

// ─── Aggregations ─────────────────────────────────────────────────────────────

/**
 * Full list of Supabase tables owned by any registered integration.
 * Used by the supabase_query tool to whitelist allowed tables.
 * Does NOT include core ElevarusOS tables (jobs, instances, etc.) — those
 * come from `data/schema-annotations.json` directly.
 */
export function listIntegrationTableNames(): string[] {
  return INTEGRATION_MANIFESTS.flatMap((m) =>
    (m.supabaseTables ?? []).map((t) => t.name)
  );
}

/**
 * All integration-contributed tables, keyed by table name.
 * Merged with core annotations to build the full schema surface.
 */
export function getIntegrationTables(): Record<string, IntegrationTable> {
  const out: Record<string, IntegrationTable> = {};
  for (const m of INTEGRATION_MANIFESTS) {
    for (const t of m.supabaseTables ?? []) {
      out[t.name] = t;
    }
  }
  return out;
}

/** Extra Q&A tools contributed by integrations (e.g. ringba_live_query). */
export function getIntegrationTools(): QATool[] {
  return INTEGRATION_MANIFESTS.flatMap((m) => m.liveTools ?? []);
}

/** Runtime snapshot used by the list_integrations tool. */
export function describeIntegrations(): Array<{
  id:          string;
  name:        string;
  description: string;
  status:      IntegrationStatus;
  tables:      string[];
  liveTools:   string[];
}> {
  return INTEGRATION_MANIFESTS.map((m) => ({
    id:          m.id,
    name:        m.name,
    description: m.description,
    status:      m.status(),
    tables:      (m.supabaseTables ?? []).map((t) => t.name),
    liveTools:   (m.liveTools ?? []).map((t) => t.spec.name),
  }));
}

/**
 * Render the "## Available Integrations" block for the system prompt.
 * Includes each integration's name, status, blurb, and example questions.
 */
export function renderIntegrationsForPrompt(): string {
  const lines: string[] = ["## Available Integrations"];
  for (const m of INTEGRATION_MANIFESTS) {
    const status = m.status();
    lines.push("");
    lines.push(`### ${m.name}  (${status})`);
    lines.push(m.systemPromptBlurb);
    if (m.supabaseTables && m.supabaseTables.length > 0) {
      lines.push(`- Supabase tables: ${m.supabaseTables.map((t) => `\`${t.name}\``).join(", ")}`);
    }
    if (m.liveTools && m.liveTools.length > 0) {
      lines.push(`- Live tools: ${m.liveTools.map((t) => `\`${t.spec.name}\``).join(", ")}`);
    }
    if (m.exampleQuestions && m.exampleQuestions.length > 0) {
      lines.push("- Example questions:");
      for (const q of m.exampleQuestions) lines.push(`  - ${q}`);
    }
  }
  return lines.join("\n");
}
