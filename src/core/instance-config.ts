import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import { INSTANCES_DIR } from "./prompt-loader";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Brand and voice settings injected into prompts as placeholders.
 * Values flow into templates as {{BRAND_VOICE}}, {{BRAND_AUDIENCE}}, etc.
 */
export interface InstanceBrand {
  /** Writing style/voice. e.g. "Conversational, data-driven, agency-focused." */
  voice: string;
  /** Target reader description. Overrides per-request audience when the request field is blank. */
  audience: string;
  /** Tone descriptor. e.g. "Confident and practical" */
  tone: string;
  /** Industry context for richer prompts. e.g. "Digital marketing" */
  industry?: string;
}

/** Notification routing for this instance. */
export interface InstanceNotify {
  /** Email address that receives approval and completion notifications */
  approver?: string;
  /** Slack channel ID for job notifications */
  slackChannel?: string;
}

/** Ringba integration config — used by ppc-campaign-report workflow instances. */
export interface InstanceRingba {
  /** Ringba campaign name to pull metrics for. */
  campaignName: string;
  /** Reporting period: mtd | wtd | ytd | custom (default: mtd) */
  reportPeriod?: "mtd" | "wtd" | "ytd" | "custom";
  /** Start date for custom period (YYYY-MM-DD) */
  startDate?: string;
  /** End date for custom period (YYYY-MM-DD) */
  endDate?: string;
}

/** Optional cron schedule for this instance. */
export interface InstanceSchedule {
  enabled: boolean;
  /** Cron expression in UTC. e.g. "0 9 * * 1" = every Monday at 9am UTC */
  cron?: string;
  /** Human-readable description of the schedule */
  description?: string;
}

/**
 * Parsed config for one named bot instance (from src/instances/<id>/instance.md).
 *
 * A bot instance is a named, configured deployment of a base workflow.
 * All instances share the same workflow logic; instance configs control:
 *   - Which base workflow type to use
 *   - Brand voice and tone injected into every prompt
 *   - Notification routing (who gets emails/Slacks)
 *   - Optional cron schedule
 */
export interface InstanceConfig {
  /** Unique identifier — matches the directory name and job.workflowType */
  id: string;
  /** Human-readable name shown in logs and (future) UI */
  name: string;
  /** Which base workflow this instance runs ("blog", "reporting") */
  baseWorkflow: string;
  /** Whether this instance is active */
  enabled: boolean;
  /** Brand / voice settings injected into all prompts */
  brand: InstanceBrand;
  /** Notification routing */
  notify: InstanceNotify;
  /** Optional scheduling config */
  schedule: InstanceSchedule;
  /** Ringba integration config (ppc-campaign-report workflow only) */
  ringba?: InstanceRingba;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Loads the InstanceConfig for a given bot instance ID.
 * Reads from `src/instances/<instanceId>/instance.md`.
 */
export function loadInstanceConfig(instanceId: string): InstanceConfig {
  const instanceMdPath = path.join(INSTANCES_DIR, instanceId, "instance.md");

  let raw: string;
  try {
    raw = fs.readFileSync(instanceMdPath, "utf8");
  } catch {
    throw new Error(
      `instance-config: no config found for instance "${instanceId}" at "${instanceMdPath}"`
    );
  }

  const { data } = matter(raw);

  const brand    = (data.brand    as any) ?? {};
  const notify   = (data.notify   as any) ?? {};
  const schedule = (data.schedule as any) ?? {};
  const ringba   = (data.ringba   as any) ?? null;

  return {
    id: String(data.id ?? instanceId),
    name: String(data.name ?? instanceId),
    baseWorkflow: String(data.baseWorkflow ?? "blog"),
    enabled: Boolean(data.enabled ?? true),
    brand: {
      voice:    String(brand.voice    ?? ""),
      audience: String(brand.audience ?? ""),
      tone:     String(brand.tone     ?? ""),
      industry: brand.industry ? String(brand.industry) : undefined,
    },
    notify: {
      approver:     notify.approver     ? String(notify.approver)     : undefined,
      slackChannel: notify.slackChannel ? String(notify.slackChannel) : undefined,
    },
    schedule: {
      enabled:     Boolean(schedule.enabled ?? false),
      cron:        schedule.cron        ? String(schedule.cron)        : undefined,
      description: schedule.description ? String(schedule.description) : undefined,
    },
    ringba: ringba?.campaignName
      ? {
          campaignName: String(ringba.campaignName),
          reportPeriod: (ringba.reportPeriod ?? "mtd") as InstanceRingba["reportPeriod"],
          startDate:    ringba.startDate ? String(ringba.startDate) : undefined,
          endDate:      ringba.endDate   ? String(ringba.endDate)   : undefined,
        }
      : undefined,
  };
}

/**
 * Returns all instance IDs that have an instance.md under src/instances/.
 * Skips _template and disabled instances by default.
 */
export function listInstanceIds(includeDisabled = false): string[] {
  try {
    return fs
      .readdirSync(INSTANCES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("_"))
      .map((e) => e.name)
      .filter((id) => {
        if (includeDisabled) return true;
        try {
          return loadInstanceConfig(id).enabled;
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Returns placeholder vars from an InstanceConfig for injection into prompts.
 * These are merged into the `extraVars` of loadPrompt().
 */
export function instanceVars(cfg: InstanceConfig): Record<string, string> {
  return {
    INSTANCE_NAME: cfg.name,
    BRAND_VOICE: cfg.brand.voice,
    BRAND_AUDIENCE: cfg.brand.audience,
    BRAND_TONE: cfg.brand.tone,
    BRAND_INDUSTRY: cfg.brand.industry ?? "",
  };
}
