import * as path from "path";
import { WorkflowDefinition } from "../../core/workflow-registry";
import { loadBotManifest } from "../../core/bot-manifest";
import { loadInstanceConfig } from "../../core/instance-config";
import { INotifyAdapter } from "../../adapters/notify/notify.interface";
import { FetchAlertsStage } from "./stages/01-fetch-alerts.stage";
import { SlackPublishStage } from "./stages/02-slack-publish.stage";
import { logger } from "../../core/logger";

const BOT_MD = path.join(__dirname, "bot.md");

/**
 * HVAC Weather Notification Workflow
 *
 * Pulls active NWS alerts once daily, groups HVAC-relevant events (heat/cold)
 * by state, and posts a single Slack notification to #cli-hvac listing the
 * affected states per campaign bucket. If no relevant alerts are active the
 * run completes silently (no Slack post).
 *
 * Stages:
 *   1. Fetch Alerts   — call api.weather.gov/alerts/active, bucket by state
 *   2. Slack Publish  — post to configured channel (skips if buckets empty)
 */
export function buildHvacWeatherNotificationWorkflow(
  _notifiers: INotifyAdapter[],
): WorkflowDefinition {
  const _manifest = loadBotManifest(BOT_MD);

  try {
    const cfg = loadInstanceConfig("hvac-weather-notification");
    logger.info("hvac-weather-notification workflow registered", {
      slackChannel:    cfg.notify.slackChannel   ?? "not configured",
      scheduleEnabled: cfg.schedule.enabled,
      cron:            cfg.schedule.cron         ?? "(none)",
      timezone:        cfg.schedule.timezone     ?? "UTC",
    });
  } catch (err) {
    logger.warn("Could not load instance config for hvac-weather-notification", {
      error: String(err),
    });
  }

  return {
    type: "hvac-weather-notification",
    stages: [
      new FetchAlertsStage(),
      new SlackPublishStage(),
    ],
  };
}
