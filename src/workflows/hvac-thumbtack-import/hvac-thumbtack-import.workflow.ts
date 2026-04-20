import * as path from "path";
import { WorkflowDefinition } from "../../core/workflow-registry";
import { loadBotManifest } from "../../core/bot-manifest";
import { loadInstanceConfig } from "../../core/instance-config";
import { INotifyAdapter } from "../../adapters/notify/notify.interface";
import { ImportThumbtackSheetStage } from "./stages/01-import-thumbtack-sheet.stage";
import { logger } from "../../core/logger";

const BOT_MD = path.join(__dirname, "bot.md");

/**
 * HVAC Thumbtack Import Workflow
 *
 * Daily ingestion of the shared Thumbtack "daily sessions" sheet into Supabase
 * (`thumbtack_daily_sessions`). One stage — read sheet, upsert rows, log run.
 *
 * The hvac-reporting agent reads the resulting Supabase rows for its P&L report.
 *
 * Schedule: configured per-instance in `src/agents/hvac-thumbtack-import/instance.md`
 * (default: daily at 06:00 PT — early enough to land before the morning reporting
 * runs at 09:00 EST).
 */
export function buildHvacThumbtackImportWorkflow(
  _notifiers: INotifyAdapter[],
): WorkflowDefinition {
  const _manifest = loadBotManifest(BOT_MD);

  try {
    const cfg = loadInstanceConfig("hvac-thumbtack-import");
    logger.info("hvac-thumbtack-import workflow registered", {
      scheduleEnabled: cfg.schedule.enabled,
      cron:            cfg.schedule.cron ?? "(none)",
      timezone:        cfg.schedule.timezone ?? "UTC",
    });
  } catch (err) {
    logger.warn("Could not load instance config for hvac-thumbtack-import", { error: String(err) });
  }

  return {
    type: "hvac-thumbtack-import",
    stages: [
      new ImportThumbtackSheetStage(),
    ],
  };
}
