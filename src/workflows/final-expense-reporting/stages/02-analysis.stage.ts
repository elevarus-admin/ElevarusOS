import * as fs   from "fs";
import * as path from "path";
import { IStage, requireStageOutput } from "../../../core/stage.interface";
import { Job } from "../../../models/job.model";
import { claudeJSON } from "../../../core/claude-client";
import { logger } from "../../../core/logger";
import { DataCollectionOutput } from "./01-data-collection.stage";

export interface AnalysisPeriod {
  calls:         string;
  billableCalls: string;
  billableRate:  string;
  revenue:       string;
  avgPayout?:    string;
  metaSpend?:    string;
  metaCPC?:      string;
  metaCTR?:      string;
  profit?:       string;
  roi?:          string;
  margin?:       string;
}

export interface AnalysisOutput {
  todayLabel: string;
  mtdLabel:   string;
  today:      AnalysisPeriod;
  mtd:        AnalysisPeriod;
  keyTrends:  string[];
  concerns:   string[];
  alertLevel: "green" | "yellow" | "red";
}

const INSTANCES_DIR = path.resolve(__dirname, "../../../agents");

/**
 * Stage 2 — Analysis
 *
 * Loads the MC agent's MISSION.md as the primary instruction source,
 * then asks Claude to analyze collected data according to those instructions.
 *
 * All formatting preferences, alert thresholds, and report definitions
 * live in the MC agent's workspace (MISSION.md) — not in ElevarusOS templates.
 * ElevarusOS only provides the data and the delivery mechanism.
 *
 * Instruction priority:
 *   1. src/agents/{instanceId}/MISSION.md  ← MC agent workspace (primary)
 *   2. src/agents/{instanceId}/soul.md     ← agent identity (secondary)
 *   3. Generic fallback if neither exists
 */
export class AnalysisStage implements IStage {
  readonly stageName = "analysis";

  async run(job: Job): Promise<AnalysisOutput> {
    logger.info("Running analysis stage", { jobId: job.id });

    const collected = requireStageOutput<DataCollectionOutput>(job, "data-collection");
    const { missionMd, soulMd } = this.loadAgentContext(job.workflowType);

    const systemPrompt = [
      `You are the ${job.workflowType} agent running a scheduled data analysis task.`,
      ``,
      missionMd
        ? `## Your Operating Instructions (MISSION.md)\n${missionMd}`
        : `## Mission\nAnalyze campaign performance data and surface actionable insights.`,
      soulMd ? `\n## Your Identity (soul.md)\n${soulMd}` : "",
      ``,
      `Return only valid JSON — no markdown fences, no explanation.`,
    ].filter(Boolean).join("\n");

    const userPrompt = [
      `Analyze the following campaign data:`,
      ``,
      `<collected_data>`,
      JSON.stringify(collected.rawData, null, 2),
      `</collected_data>`,
      ``,
      `Return this exact JSON structure:`,
      JSON.stringify({
        todayLabel: "<e.g. 'Today — Apr 17'>",
        mtdLabel:   "<e.g. 'Month to Date — Apr 1–17'>",
        today: {
          calls: "<N>", billableCalls: "<N>", billableRate: "<%>",
          revenue: "<$X>", metaSpend: "<$X or null>", profit: "<$X or null>", roi: "<%  or null>",
        },
        mtd: {
          calls: "<N>", billableCalls: "<N>", billableRate: "<%>",
          revenue: "<$X>", avgPayout: "<$X>",
          metaSpend: "<$X or null>", metaCPC: "<$X or null>", metaCTR: "<% or null>",
          profit: "<$X or null>", roi: "<% or null>", margin: "<% or null>",
        },
        keyTrends:  ["<trend with numbers>"],
        concerns:   ["<concern with numbers>"],
        alertLevel: "green | yellow | red",
      }, null, 2),
    ].join("\n");

    const result = await claudeJSON<AnalysisOutput>(systemPrompt, userPrompt, job.id);

    logger.info("Analysis stage complete", {
      jobId:        job.id,
      trendCount:   result.keyTrends?.length ?? 0,
      concernCount: result.concerns?.length  ?? 0,
      alertLevel:   result.alertLevel,
    });

    return result;
  }

  private loadAgentContext(instanceId: string): { missionMd: string; soulMd: string } {
    const base = path.join(INSTANCES_DIR, instanceId);
    const read = (file: string): string => {
      try { return fs.readFileSync(path.join(base, file), "utf8").trim(); }
      catch { return ""; }
    };
    return { missionMd: read("MISSION.md"), soulMd: read("soul.md") };
  }
}
