import * as path from "path";
import { IStage, requireStageOutput } from "../../../core/stage.interface";
import { Job } from "../../../models/job.model";
import { loadPrompt } from "../../../core/prompt-loader";
import { loadInstanceConfig, instanceVars } from "../../../core/instance-config";
import { claudeJSON } from "../../../core/claude-client";
import { logger } from "../../../core/logger";
import { DataCollectionOutput } from "./01-data-collection.stage";

export interface AnalysisOutput {
  periodLabel: string;
  headlineMetrics: Record<string, string>;
  keyTrends: string[];
  wins: string[];
  concerns: string[];
  vsLastPeriod: string;
  recommendedActions: string[];
}

const TEMPLATE = path.join(__dirname, "../prompts/analysis.md");

/**
 * Stage 2 — Analysis
 *
 * Uses Claude to analyse the raw campaign data and surface insights.
 *
 * ✏️  Tune this stage:  src/workflows/reporting/prompts/analysis.md
 * ✏️  Instance override: src/instances/{instanceId}/prompts/analysis.md
 */
export class AnalysisStage implements IStage {
  readonly stageName = "analysis";

  async run(job: Job): Promise<AnalysisOutput> {
    logger.info("Running analysis stage", { jobId: job.id });

    const collected = requireStageOutput<DataCollectionOutput>(job, "data-collection");

    // Load instance config for brand vars if this job has a workflowType
    const instanceId = job.workflowType;
    let extraVars: Record<string, string> = {};
    if (instanceId) {
      try {
        const cfg = loadInstanceConfig(instanceId);
        extraVars = instanceVars(cfg);
      } catch { /* instance config optional */ }
    }

    const { systemPrompt, userPrompt } = loadPrompt(
      TEMPLATE,
      {
        TITLE: job.request.title,
        BRIEF: job.request.brief,
        RAW_DATA: JSON.stringify(collected.rawData, null, 2),
      },
      { instanceId, extraVars }
    );

    const result = await claudeJSON<AnalysisOutput>(systemPrompt, userPrompt, job.id);

    logger.info("Analysis stage complete", {
      jobId: job.id,
      trendCount: result.keyTrends?.length ?? 0,
      concernCount: result.concerns?.length ?? 0,
    });

    return result;
  }
}
