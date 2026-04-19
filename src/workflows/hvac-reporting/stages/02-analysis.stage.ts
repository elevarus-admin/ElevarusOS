import * as fs   from "fs";
import * as path from "path";
import { IStage, requireStageOutput } from "../../../core/stage.interface";
import { Job } from "../../../models/job.model";
import { claudeJSON } from "../../../core/claude-client";
import { logger } from "../../../core/logger";
import { DataCollectionOutput } from "./01-data-collection.stage";

export interface AnalysisOutput {
  periodLabel:        string;
  headlineMetrics:    Record<string, string>;
  keyTrends:          string[];
  wins:               string[];
  concerns:           string[];
  vsLastPeriod:       string;
  recommendedActions: string[];
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
      `Analyze the following campaign data for: ${job.request.title}`,
      ``,
      `<collected_data>`,
      JSON.stringify(collected.rawData, null, 2),
      `</collected_data>`,
      ``,
      `Return this exact JSON structure:`,
      JSON.stringify({
        periodLabel:        "<human-readable period, e.g. 'April MTD (Apr 1–16)'>",
        headlineMetrics:    { "<metric>": "<formatted value>" },
        keyTrends:          ["<trend>"],
        wins:               ["<positive finding>"],
        concerns:           ["<concern or risk>"],
        vsLastPeriod:       "<one sentence vs prior period, or 'No prior period data'>",
        recommendedActions: ["<specific, actionable recommendation>"],
      }, null, 2),
    ].join("\n");

    const result = await claudeJSON<AnalysisOutput>(systemPrompt, userPrompt, job.id);

    logger.info("Analysis stage complete", {
      jobId:        job.id,
      trendCount:   result.keyTrends?.length  ?? 0,
      concernCount: result.concerns?.length   ?? 0,
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
