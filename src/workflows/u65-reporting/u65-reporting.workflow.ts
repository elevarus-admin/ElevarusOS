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
 * U65 Reporting Workflow
 *
 * Campaign performance reporting for the u65-reporting MC agent.
 * Pulls Ringba revenue data for the under-65 health insurance campaign and
 * posts a formatted report to the configured Slack channel.
 *
 * Stages:
 *   1. Data Collection  — pulls Ringba revenue data
 *   2. Analysis         — Claude surfaces trends and concerns
 *   3. Summary          — Claude produces Slack message + markdown report
 *   4. Slack Publish    — posts to configured channel
 */
export function buildU65ReportingWorkflow(
  notifiers: INotifyAdapter[],
): WorkflowDefinition {
  const _manifest = loadBotManifest(BOT_MD);

  try {
    const cfg = loadInstanceConfig("u65-reporting");
    logger.info("u65-reporting workflow registered", {
      ringbaCampaign:  cfg.ringba?.campaignName ?? "not configured",
      reportPeriod:    cfg.ringba?.reportPeriod  ?? "mtd",
      slackChannel:    cfg.notify.slackChannel   ?? "not configured",
      scheduleEnabled: cfg.schedule.enabled,
    });
  } catch (err) {
    logger.warn("Could not load instance config for u65-reporting", { error: String(err) });
  }

  return {
    type: "u65-reporting",
    stages: [
      new DataCollectionStage(),
      new AnalysisStage(),
      new SummaryStage(),
      new SlackPublishStage(),
    ],
  };
}
