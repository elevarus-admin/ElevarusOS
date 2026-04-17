import * as path from "path";
import { WorkflowDefinition } from "../../core/workflow-registry";
import { loadBotManifest } from "../../core/bot-manifest";
import { loadInstanceConfig } from "../../core/instance-config";
import { INotifyAdapter } from "../../adapters/notify/notify.interface";
import { DataCollectionStage } from "./stages/01-data-collection.stage";
import { AnalysisStage }       from "./stages/02-analysis.stage";
import { SummaryStage }        from "./stages/03-summary.stage";
import { SlackPublishStage }   from "./stages/04-slack-publish.stage";
import { logger } from "../../core/logger";

const BOT_MD = path.join(__dirname, "bot.md");

/**
 * Final Expense Reporting Workflow
 *
 * Campaign performance reporting for the final-expense-reporting MC agent.
 * Pulls Ringba revenue data for the O&O_SOMQ_FINAL_EXPENSE campaign and
 * posts a formatted report to the configured Slack channel.
 *
 * Stages:
 *   1. Data Collection  — pulls Ringba revenue data
 *   2. Analysis         — Claude surfaces trends and concerns
 *   3. Summary          — Claude produces Slack message + markdown report
 *   4. Slack Publish    — posts to #cli-final-expense
 */
export function buildFinalExpenseReportingWorkflow(
  notifiers: INotifyAdapter[],
): WorkflowDefinition {
  const _manifest = loadBotManifest(BOT_MD);

  try {
    const cfg = loadInstanceConfig("final-expense-reporting");
    logger.info("final-expense-reporting workflow registered", {
      ringbaCampaign:  cfg.ringba?.campaignName ?? "not configured",
      reportPeriod:    cfg.ringba?.reportPeriod  ?? "mtd",
      slackChannel:    cfg.notify.slackChannel   ?? "not configured",
      scheduleEnabled: cfg.schedule.enabled,
    });
  } catch (err) {
    logger.warn("Could not load instance config for final-expense-reporting", { error: String(err) });
  }

  return {
    type: "final-expense-reporting",
    stages: [
      new DataCollectionStage(),
      new AnalysisStage(),
      new SummaryStage(),
      new SlackPublishStage(),
    ],
  };
}
