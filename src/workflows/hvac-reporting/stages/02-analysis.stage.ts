import * as fs   from "fs";
import * as path from "path";
import { IStage, requireStageOutput } from "../../../core/stage.interface";
import { Job } from "../../../models/job.model";
import { claudeJSON } from "../../../core/claude-client";
import { logger } from "../../../core/logger";
import { DataCollectionOutput } from "./01-data-collection.stage";

export interface AnalysisPeriod {
  sessions:     string;
  revenue:      string;
  metaSpend?:   string;
  metaCPC?:     string;
  metaCTR?:     string;
  profit?:      string;
  roi?:         string;
  margin?:      string;
  ringbaCalls?: string;
}

export interface AnalysisOutput {
  yesterdayLabel: string;
  mtdLabel:       string;
  yesterday:      AnalysisPeriod;
  mtd:            AnalysisPeriod;
  keyTrends:      string[];
  concerns:       string[];
  alertLevel:     "green" | "yellow" | "red";
}

const INSTANCES_DIR = path.resolve(__dirname, "../../../agents");

/**
 * Stage 2 — Analysis (HVAC)
 *
 * Loads the HVAC agent's MISSION.md as the primary instruction source,
 * then asks Claude to analyze collected data according to those instructions.
 *
 * The output matches the compact-slack-format's expected shape —
 * two periods (yesterday + mtd), each with the numbers the summary stage
 * needs to emit the 3-line report.
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
        : `## Mission\nAnalyze HVAC campaign performance data and surface actionable insights.`,
      soulMd ? `\n## Your Identity (soul.md)\n${soulMd}` : "",
      ``,
      `Return only valid JSON — no markdown fences, no explanation.`,
    ].filter(Boolean).join("\n");

    const userPrompt = [
      `Analyze the following HVAC campaign data. The volume metric is *sessions* (Thumbtack);`,
      `revenue is the combined Thumbtack owed_revenue + Ringba totalRevenue for the window.`,
      `If either revenue source is missing for the window, state "data unavailable" — never fabricate.`,
      ``,
      `<collected_data>`,
      JSON.stringify(collected.rawData, null, 2),
      `</collected_data>`,
      ``,
      `Return this exact JSON structure:`,
      JSON.stringify({
        yesterdayLabel: "<e.g. 'Yesterday — Apr 20'>",
        mtdLabel:       "<e.g. 'MTD Apr 1–20'>",
        yesterday: {
          sessions:     "<N or 'data unavailable'>",
          revenue:      "<$X or 'data unavailable'>",
          metaSpend:    "<$X or null>",
          profit:       "<$X or null>",
          roi:          "<% or null>",
          ringbaCalls:  "<N or null>",
        },
        mtd: {
          sessions:     "<N or 'data unavailable'>",
          revenue:      "<$X or 'data unavailable'>",
          metaSpend:    "<$X or null>",
          metaCPC:      "<$X or null>",
          metaCTR:      "<% or null>",
          profit:       "<$X or null>",
          roi:          "<% or null>",
          margin:       "<% or null>",
          ringbaCalls:  "<N or null>",
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
