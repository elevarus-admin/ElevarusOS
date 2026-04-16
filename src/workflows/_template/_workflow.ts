/**
 * Workflow definition for [Bot Name].
 *
 * Copy this file to src/workflows/<bot-type>/<bot-type>.workflow.ts,
 * then fill in the imports and stage list.
 *
 * Registration (in src/index.ts):
 *   import { buildXxxWorkflowDefinition } from "./workflows/xxx/xxx.workflow";
 *   registry.register(buildXxxWorkflowDefinition(notifiers));
 */

import * as path from "path";
import { WorkflowDefinition } from "../../core/workflow-registry";
import { loadBotManifest } from "../../core/bot-manifest";
import { INotifyAdapter } from "../../adapters/notify/notify.interface";

// Import your stage classes here:
// import { IntakeStage } from "./stages/01-intake.stage";
// import { ProcessStage } from "./stages/02-process.stage";
// import { NotifyStage } from "./stages/03-notify.stage";

const BOT_MD = path.join(__dirname, "bot.md");

export function buildXxxWorkflowDefinition(
  notifiers: INotifyAdapter[]
): WorkflowDefinition {
  // Load and validate the bot.md manifest at startup.
  // This ensures bot.md is always in sync and throws early if something is wrong.
  const manifest = loadBotManifest(BOT_MD);

  return {
    type: manifest.type,   // comes from bot.md frontmatter
    stages: [
      // List your IStage instances in the same order as bot.md stages:
      // new IntakeStage(),
      // new ProcessStage(),
      // new NotifyStage(notifiers),
    ],
  };
}
