/**
 * QA tools — the agentic surface Claude calls to answer questions in Slack.
 *
 * Each tool has:
 *   - name / description / JSON schema (the Anthropic tool spec)
 *   - an execute() function that runs locally and returns a JSON-serializable
 *     result
 *
 * All tools are read-only. Write actions (approving jobs, kicking off
 * workflows) are intentionally deferred until per-user auth lands.
 *
 * The tool loop itself lives in `claude-converse.ts`. This module just defines
 * what can be called.
 */

import * as fs from "fs";
import * as path from "path";
import { INSTANCES_DIR } from "./prompt-loader";
import { loadInstanceConfig, listInstanceIds } from "./instance-config";
import { WorkflowRegistry } from "./workflow-registry";
import { IJobStore } from "./job-store";
import { logger } from "./logger";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Anthropic tool spec — shape matches the `tools` parameter on messages.create. */
export interface ToolSpec {
  name:         string;
  description:  string;
  input_schema: {
    type:       "object";
    properties: Record<string, unknown>;
    required?:  string[];
  };
}

export interface QAToolContext {
  jobStore: IJobStore;
  registry: WorkflowRegistry;
}

export interface QATool {
  spec:    ToolSpec;
  execute: (input: unknown, ctx: QAToolContext) => Promise<unknown>;
}

// ─── Tool: list_instances ─────────────────────────────────────────────────────

const listInstancesTool: QATool = {
  spec: {
    name: "list_instances",
    description:
      "List every bot instance (MC Agent) configured in ElevarusOS. Returns each instance's id, display name, base workflow, enabled state, brand voice, audience, and schedule summary. Use this first to orient yourself before drilling into a specific instance.",
    input_schema: {
      type: "object",
      properties: {
        includeDisabled: {
          type: "boolean",
          description: "If true, include instances with enabled=false. Defaults to false.",
        },
      },
    },
  },
  async execute(input) {
    const { includeDisabled } = (input as { includeDisabled?: boolean } | null) ?? {};
    const ids = listInstanceIds(Boolean(includeDisabled));
    return ids.map((id) => {
      try {
        const cfg = loadInstanceConfig(id);
        return {
          id:           cfg.id,
          name:         cfg.name,
          baseWorkflow: cfg.baseWorkflow,
          enabled:      cfg.enabled,
          brand:        cfg.brand,
          schedule:     cfg.schedule.enabled
            ? { cron: cfg.schedule.cron, description: cfg.schedule.description }
            : { enabled: false },
          hasRingba:  Boolean(cfg.ringba),
          hasMeta:    Boolean(cfg.meta),
        };
      } catch (err) {
        return { id, error: String(err) };
      }
    });
  },
};

// ─── Tool: get_instance_detail ────────────────────────────────────────────────

const getInstanceDetailTool: QATool = {
  spec: {
    name: "get_instance_detail",
    description:
      "Get full configuration + a MISSION.md excerpt for one bot instance. Use this after list_instances when you need more detail on a specific bot (e.g. to answer 'what does the HVAC reporting agent do?').",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Instance id — e.g. 'final-expense-reporting'." },
      },
      required: ["id"],
    },
  },
  async execute(input) {
    const { id } = input as { id: string };
    try {
      const cfg = loadInstanceConfig(id);
      const mission = readInstanceMission(id);
      return { ...cfg, mission: mission ?? null };
    } catch (err) {
      return { error: String(err) };
    }
  },
};

function readInstanceMission(id: string): string | undefined {
  const p = path.join(INSTANCES_DIR, id, "MISSION.md");
  try {
    const raw = fs.readFileSync(p, "utf8");
    return stripFrontmatter(raw).trim().slice(0, 2000);
  } catch {
    return undefined;
  }
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  return end === -1 ? raw : raw.slice(end + 4);
}

// ─── Tool: list_workflows ─────────────────────────────────────────────────────

const listWorkflowsTool: QATool = {
  spec: {
    name: "list_workflows",
    description:
      "List every workflow registered in the runtime, with its ordered stage names. Use this to answer questions about what happens during a workflow (e.g. 'what stages does the blog workflow run?').",
    input_schema: { type: "object", properties: {} },
  },
  async execute(_input, ctx) {
    return ctx.registry.registeredTypes.map((type) => {
      const def = ctx.registry.get(type);
      return {
        type,
        stages: def ? def.stages.map((s) => s.stageName) : [],
      };
    });
  },
};

// ─── Tool: list_integrations ──────────────────────────────────────────────────

const listIntegrationsTool: QATool = {
  spec: {
    name: "list_integrations",
    description:
      "List the third-party data sources any workflow can read from (ringba, leadsprosper, meta). Returns each integration's id, purpose, and runtime configuration state.",
    input_schema: { type: "object", properties: {} },
  },
  async execute() {
    return [
      {
        id:      "ringba",
        summary: "Call-tracking revenue, paid calls, campaign performance. Supabase-backed.",
        configured: Boolean(process.env.RINGBA_API_KEY && process.env.RINGBA_ACCOUNT_ID),
      },
      {
        id:      "leadsprosper",
        summary: "Lead routing + attribution. Sync worker pulls leads into Supabase every 15 min.",
        configured: Boolean(process.env.LEADSPROSPER_API_KEY),
      },
      {
        id:      "meta",
        summary: "Meta Ads spend, impressions, CPL. Live-API for P&L reporting.",
        configured: Boolean(process.env.META_ACCESS_TOKEN),
      },
    ];
  },
};

// ─── Tool: query_jobs ─────────────────────────────────────────────────────────

const queryJobsTool: QATool = {
  spec: {
    name: "query_jobs",
    description:
      "Query the job store for recent workflow runs. Filter by status, by instanceId (workflowType), or by limit. Returns compact summaries — use get_job_output for full stage outputs.",
    input_schema: {
      type: "object",
      properties: {
        instanceId: {
          type: "string",
          description: "Filter by workflow type / instance id, e.g. 'hvac-reporting'.",
        },
        status: {
          type: "string",
          description:
            "Filter by status — one of: queued, running, awaiting_approval, approved, completed, failed.",
        },
        limit: {
          type: "integer",
          description: "Max rows to return. Default 10, max 50.",
        },
      },
    },
  },
  async execute(input, ctx) {
    const { instanceId, status, limit } = (input as {
      instanceId?: string;
      status?:     string;
      limit?:      number;
    }) ?? {};

    const cap = Math.max(1, Math.min(Number(limit ?? 10), 50));
    let jobs  = await ctx.jobStore.list();
    if (instanceId) jobs = jobs.filter((j) => j.workflowType === instanceId);
    if (status)     jobs = jobs.filter((j) => j.status === status);

    jobs = jobs
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, cap);

    return jobs.map((j) => ({
      jobId:           j.id,
      workflowType:    j.workflowType,
      status:          j.status,
      title:           j.request.title,
      createdAt:       j.createdAt,
      completedAt:     j.completedAt ?? null,
      currentStage:    j.stages.find((s) => s.status === "running")?.name ?? null,
      completedStages: j.stages.filter((s) => s.status === "completed").length,
      totalStages:     j.stages.length,
      error:           j.error ?? null,
    }));
  },
};

// ─── Tool: get_job_output ─────────────────────────────────────────────────────

const getJobOutputTool: QATool = {
  spec: {
    name: "get_job_output",
    description:
      "Fetch the full stage outputs for a single job. Use this after query_jobs when you need the actual report body, draft, or metrics. Outputs are truncated to keep responses compact.",
    input_schema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Job id returned by query_jobs." },
      },
      required: ["jobId"],
    },
  },
  async execute(input, ctx) {
    const { jobId } = input as { jobId: string };
    const job = await ctx.jobStore.get(jobId);
    if (!job) return { error: `No job with id ${jobId}` };

    const stages: Record<string, unknown> = {};
    for (const s of job.stages) {
      if (s.output !== undefined) {
        stages[s.name] = truncateOutput(s.output);
      }
    }

    return {
      jobId:        job.id,
      workflowType: job.workflowType,
      status:       job.status,
      title:        job.request.title,
      createdAt:    job.createdAt,
      completedAt:  job.completedAt ?? null,
      error:        job.error ?? null,
      stages,
    };
  },
};

/** Truncate long string fields inside stage output so we don't blow context. */
function truncateOutput(value: unknown, maxStr = 2000): unknown {
  if (typeof value === "string") {
    return value.length > maxStr ? value.slice(0, maxStr) + "…[truncated]" : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => truncateOutput(v, maxStr));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateOutput(v, maxStr);
    }
    return out;
  }
  return value;
}

// ─── Tool: get_ringba_revenue ─────────────────────────────────────────────────

const getRingbaRevenueTool: QATool = {
  spec: {
    name: "get_ringba_revenue",
    description:
      "Pull live revenue metrics from Ringba for a given campaign + date range. Use this to answer questions about call volume, revenue, or CPL for reporting bots. Returns null if Ringba is not configured.",
    input_schema: {
      type: "object",
      properties: {
        campaign: {
          type: "string",
          description: "Ringba campaign name. Or provide instanceId to resolve it from instance config.",
        },
        instanceId: {
          type: "string",
          description: "Instance id — reads ringba.campaignName from that instance's config.",
        },
        period: {
          type: "string",
          description: "One of: mtd | wtd | ytd | custom. Defaults to mtd.",
        },
        startDate: {
          type: "string",
          description: "YYYY-MM-DD (required when period=custom).",
        },
        endDate: {
          type: "string",
          description: "YYYY-MM-DD (required when period=custom).",
        },
      },
    },
  },
  async execute(input) {
    const { campaign, instanceId, period = "mtd", startDate, endDate } =
      (input as {
        campaign?:   string;
        instanceId?: string;
        period?:     string;
        startDate?:  string;
        endDate?:    string;
      }) ?? {};

    let campaignName = campaign;
    if (!campaignName && instanceId) {
      try {
        campaignName = loadInstanceConfig(instanceId).ringba?.campaignName;
      } catch { /* ignore */ }
    }
    if (!campaignName) {
      return { error: "Provide either `campaign` or `instanceId` with ringba config." };
    }

    const { getCampaignRevenue, getDateRange } = await import("../integrations/ringba");
    const range = getDateRange(period, startDate, endDate);

    try {
      const report = await getCampaignRevenue({
        campaignName,
        startDate: range.startDate,
        endDate:   range.endDate,
      });
      if (!report) {
        return { error: "Ringba not configured — RINGBA_API_KEY + RINGBA_ACCOUNT_ID required." };
      }
      return {
        campaign:     report.campaignName,
        period:       `${report.startDate} → ${report.endDate}`,
        totalCalls:   report.totalCalls,
        paidCalls:    report.paidCalls,
        totalRevenue: report.totalRevenue,
        totalPayout:  report.totalPayout,
        avgPayout:    report.avgPayout,
        pulledAt:     new Date().toISOString(),
      };
    } catch (err) {
      return { error: `Ringba fetch failed: ${String(err)}` };
    }
  },
};

// ─── Tool: get_meta_spend ─────────────────────────────────────────────────────

const getMetaSpendTool: QATool = {
  spec: {
    name: "get_meta_spend",
    description:
      "Pull live Meta Ads spend for a reporting bot. Resolves the ad account id from instance config. Returns null if META_ACCESS_TOKEN is not configured.",
    input_schema: {
      type: "object",
      properties: {
        instanceId: {
          type: "string",
          description: "Instance id — reads meta.adAccountId from that instance's config.",
        },
        adAccountId: {
          type: "string",
          description: "Numeric ad account id (no 'act_' prefix). Overrides instanceId if provided.",
        },
        period: {
          type: "string",
          description: "One of: mtd | wtd | ytd | custom. Defaults to mtd.",
        },
        startDate: { type: "string", description: "YYYY-MM-DD for custom range." },
        endDate:   { type: "string", description: "YYYY-MM-DD for custom range." },
      },
    },
  },
  async execute(input) {
    const { instanceId, adAccountId, period = "mtd", startDate, endDate } =
      (input as {
        instanceId?: string;
        adAccountId?: string;
        period?:      string;
        startDate?:   string;
        endDate?:     string;
      }) ?? {};

    let accountId = adAccountId;
    let campaignIds: string[] | undefined;
    if (!accountId && instanceId) {
      try {
        const cfg = loadInstanceConfig(instanceId);
        accountId   = cfg.meta?.adAccountId;
        campaignIds = cfg.meta?.campaignIds;
      } catch { /* ignore */ }
    }
    if (!accountId) {
      return { error: "Provide either `adAccountId` or `instanceId` with meta config." };
    }

    const { getAdAccountSpend } = await import("../integrations/meta");
    const { getDateRange }      = await import("../integrations/ringba");
    const range = getDateRange(period, startDate, endDate);

    try {
      const report = await getAdAccountSpend({
        adAccountId: accountId,
        campaignIds,
        startDate:   range.startDate,
        endDate:     range.endDate,
      });
      if (!report) {
        return { error: "Meta not configured — META_ACCESS_TOKEN required." };
      }
      return report;
    } catch (err) {
      return { error: `Meta fetch failed: ${String(err)}` };
    }
  },
};

// ─── Tool: broadcast_reply ────────────────────────────────────────────────────

/**
 * Reserved tool name — looked up by slack-events after the loop finishes.
 * See `claudeWantsBroadcast()` below.
 */
export const BROADCAST_TOOL_NAME = "broadcast_reply";

const broadcastReplyTool: QATool = {
  spec: {
    name: BROADCAST_TOOL_NAME,
    description:
      "Signal that the final answer should ALSO be posted to the main channel, not only into the thread. Call this ONLY when the user explicitly asks for a channel-level / broadcast reply (e.g. 'also post in the channel', 'send to the main channel too', 'broadcast this'). Do NOT call it by default — threaded replies are the standard. This tool has no arguments and no side effects; it simply records the broadcast intent for the Slack posting layer.",
    input_schema: { type: "object", properties: {} },
  },
  async execute() {
    return { acknowledged: true };
  },
};

/** Returns true if any tool call in the trace was `broadcast_reply`. */
export function claudeWantsBroadcast(
  toolCalls: Array<{ name: string }>,
): boolean {
  return toolCalls.some((c) => c.name === BROADCAST_TOOL_NAME);
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const QA_TOOLS: QATool[] = [
  listInstancesTool,
  getInstanceDetailTool,
  listWorkflowsTool,
  listIntegrationsTool,
  queryJobsTool,
  getJobOutputTool,
  getRingbaRevenueTool,
  getMetaSpendTool,
  broadcastReplyTool,
];

/**
 * Execute a tool by name. Catches errors and returns a JSON-serializable
 * error object so the agent loop can keep running without crashing.
 */
export async function executeQATool(
  name:   string,
  input:  unknown,
  ctx:    QAToolContext,
): Promise<unknown> {
  const tool = QA_TOOLS.find((t) => t.spec.name === name);
  if (!tool) return { error: `Unknown tool: ${name}` };

  try {
    return await tool.execute(input, ctx);
  } catch (err) {
    logger.error("qa-tools: execution failed", { tool: name, error: String(err) });
    return { error: `Tool ${name} threw: ${String(err)}` };
  }
}
