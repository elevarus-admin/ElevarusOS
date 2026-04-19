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

/**
 * Meta Ads integration config — used by reporting workflow instances.
 * The ad account ID is the per-agent identifier; different agents can point to
 * different ad accounts. A single META_ACCESS_TOKEN env var covers all of them
 * as long as the System User has been granted access to each account.
 */
export interface InstanceMeta {
  /** Numeric ad account ID (without act_ prefix). e.g. "999576488367816" */
  adAccountId: string;
  /**
   * Optional campaign ID filter.
   * When empty (default), total account-level spend is used.
   * When provided, spend is filtered to only these campaigns.
   */
  campaignIds?: string[];
}

/**
 * ClickUp integration config — opt-in per instance. When present and
 * `syncEnabled` is true, the `clickup-sync` workflow stage posts a completion
 * comment + status update on the originating ClickUp task at end-of-job.
 * No-op when the job has no `metadata.clickupTaskId`.
 */
export interface InstanceClickUp {
  /** ClickUp list ID this instance owns. Used by inbound webhook agent resolution (Phase 4). */
  listId:      string;
  /** ClickUp space containing the list. */
  spaceId:     string;
  /** Master switch — when false the clickup-sync stage no-ops cleanly. */
  syncEnabled: boolean;
  /** Map of ElevarusOS job state → ClickUp status string for THIS list. Status strings are case-sensitive. */
  statusMap: {
    queued?:    string;
    running:    string;
    completed:  string;
    failed:     string;
  };
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
  /** Cron expression. e.g. "0 9,11,13,15,17 * * 1-5" = weekdays 9am–5pm every 2h */
  cron?: string;
  /** IANA timezone for the cron expression. Defaults to "UTC". e.g. "America/New_York" */
  timezone?: string;
  /** Human-readable description of the schedule */
  description?: string;
}

/**
 * Parsed config for one named bot instance (from src/agents/<id>/instance.md).
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
  /** Ringba integration config (reporting workflow instances) */
  ringba?: InstanceRingba;
  /** Meta Ads integration config (reporting workflow instances) */
  meta?: InstanceMeta;
  /** ClickUp integration config (any instance opting into clickup-sync) */
  clickup?: InstanceClickUp;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

/**
 * Loads the InstanceConfig for a given bot instance ID.
 * Reads from `src/agents/<instanceId>/instance.md`.
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
  const meta     = (data.meta     as any) ?? null;
  const clickup  = (data.clickup  as any) ?? null;

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
      timezone:    schedule.timezone    ? String(schedule.timezone)    : undefined,
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
    meta: meta?.adAccountId
      ? {
          adAccountId: String(meta.adAccountId),
          campaignIds: Array.isArray(meta.campaignIds)
            ? meta.campaignIds.map(String).filter(Boolean)
            : undefined,
        }
      : undefined,
    clickup: clickup?.listId
      ? {
          listId:      String(clickup.listId),
          spaceId:     String(clickup.spaceId ?? ""),
          syncEnabled: Boolean(clickup.syncEnabled ?? false),
          statusMap: {
            queued:    clickup.statusMap?.queued    ? String(clickup.statusMap.queued)    : undefined,
            running:   String(clickup.statusMap?.running   ?? "in progress"),
            completed: String(clickup.statusMap?.completed ?? "completed"),
            failed:    String(clickup.statusMap?.failed    ?? "needs input"),
          },
        }
      : undefined,
  };
}

/**
 * Returns all instance IDs that have an instance.md under src/agents/.
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
