import * as path from "path";
import { WorkflowDefinition } from "../../core/workflow-registry";
import { loadBotManifest } from "../../core/bot-manifest";
import { loadInstanceConfig } from "../../core/instance-config";
import { INotifyAdapter } from "../../adapters/notify/notify.interface";
import { DataCollectionStage } from "./stages/01-data-collection.stage";
import { AnalysisStage } from "./stages/02-analysis.stage";
import { SummaryStage } from "./stages/03-summary.stage";
import { SlackPublishStage } from "./stages/04-slack-publish.stage";
import { logger } from "../../core/logger";

const BOT_MD = path.join(__dirname, "bot.md");

/**
 * Builds a reporting WorkflowDefinition for the given bot instance.
 *
 * `instanceId` must match a directory under src/instances/ that has:
 *   - instance.md with baseWorkflow: reporting
 *
 * The workflowType on the registered definition equals the instanceId,
 * so jobs with workflowType: "u65-reporting" run this workflow.
 */
export function buildReportingWorkflowDefinition(
  notifiers: INotifyAdapter[],
  instanceId: string
): WorkflowDefinition {
  const manifest = loadBotManifest(BOT_MD);

  // Log instance config at startup to surface misconfiguration early
  try {
    const cfg = loadInstanceConfig(instanceId);
    logger.info(`Reporting workflow registered: ${cfg.name}`, {
      instanceId,
      slackChannel: cfg.notify.slackChannel ?? "not configured",
      scheduleEnabled: cfg.schedule.enabled,
    });
  } catch (err) {
    logger.warn(`Could not load instance config for "${instanceId}"`, {
      error: String(err),
    });
  }

  return {
    type: instanceId,           // e.g. "u65-reporting", "hvac-reporting"
    stages: [
      new DataCollectionStage(),
      new AnalysisStage(),
      new SummaryStage(),
      new SlackPublishStage(notifiers),
    ],
  };
}
