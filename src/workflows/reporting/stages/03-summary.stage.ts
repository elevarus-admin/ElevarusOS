import * as path from "path";
import { IStage, requireStageOutput } from "../../../core/stage.interface";
import { Job } from "../../../models/job.model";
import { loadPrompt } from "../../../core/prompt-loader";
import { loadInstanceConfig, instanceVars } from "../../../core/instance-config";
import { claudeJSON } from "../../../core/claude-client";
import { logger } from "../../../core/logger";
import { AnalysisOutput } from "./02-analysis.stage";

export interface SummaryOutput {
  slackMessage: string;
  markdownReport: string;
  subject: string;
  oneLiner: string;
  alertLevel: "green" | "yellow" | "red";
}

const TEMPLATE = path.join(__dirname, "../prompts/summary.md");

/**
 * Stage 3 — Summary
 *
 * Uses Claude to produce the final formatted report: Slack message,
 * full Markdown version, and a one-liner headline.
 *
 * ✏️  Tune this stage:  src/workflows/reporting/prompts/summary.md
 * ✏️  Instance override: src/instances/{instanceId}/prompts/summary.md
 */
export class SummaryStage implements IStage {
  readonly stageName = "summary";

  async run(job: Job): Promise<SummaryOutput> {
    logger.info("Running summary stage", { jobId: job.id });

    const analysis = requireStageOutput<AnalysisOutput>(job, "analysis");

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
        ANALYSIS_JSON: JSON.stringify(analysis, null, 2),
      },
      { instanceId, extraVars }
    );

    const result = await claudeJSON<SummaryOutput>(systemPrompt, userPrompt, job.id);

    logger.info("Summary stage complete", {
      jobId: job.id,
      alertLevel: result.alertLevel,
      oneLiner: result.oneLiner?.slice(0, 80),
    });

    return result;
  }
}
