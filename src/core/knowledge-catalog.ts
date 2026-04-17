/**
 * Knowledge catalog for the Q&A bot.
 *
 * Builds a compact, Markdown-flavored summary of the three ElevarusOS layers
 * every time a question is asked:
 *
 *   1. Instances (MC Agents)  — configured bots in src/instances/
 *   2. Workflows              — registered workflow definitions + stage order
 *   3. Integrations           — third-party data sources in src/integrations/
 *
 * The catalog is injected into the Claude system prompt so answers stay
 * grounded in current configuration rather than a stale/hallucinated picture.
 *
 * Phase 2 is read-only and reads directly from disk / the workflow registry.
 * Phase 3 replaces most of this with tools Claude can call on demand.
 */

import * as fs from "fs";
import * as path from "path";
import { INSTANCES_DIR } from "./prompt-loader";
import { loadInstanceConfig, listInstanceIds } from "./instance-config";
import { WorkflowRegistry } from "./workflow-registry";

/**
 * Max characters pulled from each instance's MISSION.md. Keeps the catalog
 * compact — the bot can read more via tools in later phases if needed.
 */
const MISSION_EXCERPT_CHARS = 600;

/** Integration catalog entries. Descriptions match docs/integrations.md. */
const INTEGRATIONS: Array<{ id: string; summary: string }> = [
  {
    id:      "ringba",
    summary: "Call-tracking revenue, paid calls, campaign performance. Supabase-backed.",
  },
  {
    id:      "leadsprosper",
    summary: "Lead routing + attribution data. Sync worker pulls leads into Supabase every 15 min.",
  },
  {
    id:      "meta",
    summary: "Meta Ads spend, impressions, CPL. Live-API for P&L reporting.",
  },
];

export interface KnowledgeCatalogOptions {
  /** Authoritative list of registered workflow types + stages. */
  registry:        WorkflowRegistry;
  /** Whether to include disabled instances. Default false. */
  includeDisabled?: boolean;
}

/**
 * Build the static knowledge catalog as a single Markdown string suitable
 * for injection into a Claude system prompt.
 */
export function buildKnowledgeCatalog(opts: KnowledgeCatalogOptions): string {
  const sections = [
    renderInstances(opts.includeDisabled ?? false),
    renderWorkflows(opts.registry),
    renderIntegrations(),
  ];
  return sections.join("\n\n");
}

// ─── Instances ────────────────────────────────────────────────────────────────

function renderInstances(includeDisabled: boolean): string {
  const ids = listInstanceIds(includeDisabled);

  if (ids.length === 0) {
    return "## Instances (MC Agents)\n\n_No instances configured._";
  }

  const lines: string[] = ["## Instances (MC Agents)"];

  for (const id of ids) {
    try {
      const cfg = loadInstanceConfig(id);
      const mission = readInstanceMission(id);

      lines.push("");
      lines.push(`### ${cfg.name}  \`${cfg.id}\``);
      lines.push(`- baseWorkflow: \`${cfg.baseWorkflow}\`  ·  enabled: ${cfg.enabled}`);
      if (cfg.brand.voice)    lines.push(`- voice: ${cfg.brand.voice}`);
      if (cfg.brand.audience) lines.push(`- audience: ${cfg.brand.audience}`);
      if (cfg.brand.industry) lines.push(`- industry: ${cfg.brand.industry}`);
      if (cfg.notify.slackChannel) lines.push(`- slack channel: ${cfg.notify.slackChannel}`);
      if (cfg.schedule.enabled) {
        lines.push(`- schedule: ${cfg.schedule.cron ?? "(no cron)"}${cfg.schedule.description ? ` — ${cfg.schedule.description}` : ""}`);
      }
      if (cfg.ringba) lines.push(`- ringba campaign: \`${cfg.ringba.campaignName}\` (${cfg.ringba.reportPeriod ?? "mtd"})`);
      if (cfg.meta)   lines.push(`- meta ad account: \`${cfg.meta.adAccountId}\``);
      if (mission) {
        lines.push("- mission excerpt:");
        for (const line of mission.split("\n")) lines.push(`  > ${line}`);
      }
    } catch (err) {
      lines.push(`### ${id}  _config unavailable_`);
      lines.push(`- error: ${String(err)}`);
    }
  }

  return lines.join("\n");
}

/** Reads the first ~600 chars of the instance's MISSION.md, if present. */
function readInstanceMission(instanceId: string): string | undefined {
  const missionPath = path.join(INSTANCES_DIR, instanceId, "MISSION.md");
  try {
    const raw = fs.readFileSync(missionPath, "utf8");
    const body = stripFrontmatter(raw).trim();
    if (body.length === 0) return undefined;
    return body.length > MISSION_EXCERPT_CHARS
      ? body.slice(0, MISSION_EXCERPT_CHARS).trimEnd() + "…"
      : body;
  } catch {
    return undefined;
  }
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return raw;
  return raw.slice(end + 4);
}

// ─── Workflows ────────────────────────────────────────────────────────────────

function renderWorkflows(registry: WorkflowRegistry): string {
  const types = registry.registeredTypes;
  if (types.length === 0) {
    return "## Workflows\n\n_No workflows registered._";
  }

  const lines: string[] = ["## Workflows"];
  for (const type of types) {
    const def = registry.get(type);
    if (!def) continue;
    const stages = def.stages.map((s) => s.stageName).join(" → ");
    lines.push("");
    lines.push(`### \`${type}\``);
    lines.push(`- stages: ${stages || "(none)"}`);
  }
  return lines.join("\n");
}

// ─── Integrations ─────────────────────────────────────────────────────────────

function renderIntegrations(): string {
  const lines: string[] = ["## Integrations"];
  for (const entry of INTEGRATIONS) {
    lines.push(`- **${entry.id}** — ${entry.summary}`);
  }
  return lines.join("\n");
}
