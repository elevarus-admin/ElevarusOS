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

    const alertEmoji = analysis.alertLevel === "green" ? "✅" : analysis.alertLevel === "yellow" ? "⚠️" : "🚨";

    const userPrompt = [
      `Produce the final report for: ${job.request.title}`,
      ``,
      `<analysis>`,
      JSON.stringify(analysis, null, 2),
      `</analysis>`,
      ``,
      `The slackMessage field MUST follow this exact compact format — no deviations, no extra lines:`,
      ``,
      `${alertEmoji} *FE · <date e.g. Apr 17>*`,
      ``,
      `*Today* · 📞 <N> calls, <N> billable (<rate>%) · 💰 $<X,XXX> · 💸 $<X,XXX> spend · 📊 <($X,XXX) or +$X,XXX> ROI <+/-><%>`,
      `*MTD* <e.g. Apr 1–17> · 📞 <N> calls, <N> billable (<rate>%) · 💰 $<X,XXX> · 💸 $<X,XXX> spend · 📊 <($X,XXX) or +$X,XXX> ROI <+/-><%>`,
      ``,
      `Rules:`,
      `- Exactly 4 lines: alert header, blank line, Today line, MTD line`,
      `- No Trends section, no bullet points, no extra sections`,
      `- Dollar amounts rounded to nearest dollar (no cents), with commas`,
      `- Negative P&L as ($1,848) — parentheses, no minus sign`,
      `- Positive P&L as +$1,234`,
      `- Omit 💸 spend and 📊 P&L tokens only if that data is null`,
      ``,
      `Return this exact JSON — no markdown fences:`,
      JSON.stringify({
        slackMessage:   "<Slack message following the exact format above>",
        markdownReport: "<Full Markdown report with ## headings and metric tables>",
        subject:        "<e.g. 'Final Expense Report — Apr 17 | MTD: ($1,848)'>",
        oneLiner:       "<One sentence MTD summary with the most important numbers>",
        alertLevel:     analysis.alertLevel,
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
