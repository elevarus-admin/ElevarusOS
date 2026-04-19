import * as fs   from "fs";
import * as path from "path";
import { IStage, requireStageOutput } from "../../../core/stage.interface";
import { Job } from "../../../models/job.model";
import { claudeJSON } from "../../../core/claude-client";
import { logger } from "../../../core/logger";
import { AnalysisOutput } from "./02-analysis.stage";

export interface SummaryOutput {
  slackMessage:   string;
  markdownReport: string;
  subject:        string;
  oneLiner:       string;
  alertLevel:     "green" | "yellow" | "red";
}

const INSTANCES_DIR = path.resolve(__dirname, "../../../agents");

/**
 * Stage 3 — Summary
 *
 * Loads the MC agent's MISSION.md for formatting instructions, then produces:
 *   - slackMessage   — copy-pasteable Slack post (format defined in MISSION.md)
 *   - markdownReport — full report written to the agent's workspace
 *   - oneLiner       — headline for the MC task comment
 *   - alertLevel     — green / yellow / red (thresholds defined in MISSION.md)
 *
 * The agent's MISSION.md is the single source of truth for:
 *   - Slack message format (which bullet points, emoji, labels)
 *   - Alert thresholds (what P&L% triggers red vs yellow)
 *   - Tone and voice
 *   - Which metrics to surface
 */
export class SummaryStage implements IStage {
  readonly stageName = "summary";

  async run(job: Job): Promise<SummaryOutput> {
    logger.info("Running summary stage", { jobId: job.id });

    const analysis   = requireStageOutput<AnalysisOutput>(job, "analysis");
    const { missionMd, soulMd } = this.loadAgentContext(job.workflowType);

    const systemPrompt = [
      `You are the ${job.workflowType} agent producing the final formatted report.`,
      ``,
      missionMd
        ? `## Your Operating Instructions (MISSION.md)\n${missionMd}`
        : `## Mission\nProduce a clear, accurate campaign performance report.`,
      soulMd ? `\n## Your Identity\n${soulMd}` : "",
      ``,
      `Return only valid JSON — no markdown fences, no explanation.`,
    ].filter(Boolean).join("\n");

    const userPrompt = [
      `Produce the final report for: ${job.request.title}`,
      ``,
      `<analysis>`,
      JSON.stringify(analysis, null, 2),
      `</analysis>`,
      ``,
      `Return this exact JSON structure:`,
      JSON.stringify({
        slackMessage:   "<Slack-formatted report following the format defined in your MISSION.md. Copy-pasteable as-is.>",
        markdownReport: "<Full Markdown report with ## headings and metric tables for the agent workspace.>",
        subject:        "<Email/notification subject line>",
        oneLiner:       "<Single sentence headline with the most important number. e.g. '61 billable calls, $2,881 revenue MTD.'>",
        alertLevel:     "green | yellow | red",
      }, null, 2),
    ].join("\n");

    const result = await claudeJSON<SummaryOutput>(systemPrompt, userPrompt, job.id);

    logger.info("Summary stage complete", {
      jobId:      job.id,
      alertLevel: result.alertLevel,
      oneLiner:   result.oneLiner?.slice(0, 100),
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
