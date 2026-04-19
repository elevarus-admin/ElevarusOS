import * as path from "path";
import { WorkflowDefinition } from "../../core/workflow-registry";
import { loadBotManifest } from "../../core/bot-manifest";
import { loadInstanceConfig } from "../../core/instance-config";
import { INotifyAdapter } from "../../adapters/notify/notify.interface";
import { IntakeStage } from "./stages/01-intake.stage";
import { NormalizationStage } from "./stages/02-normalization.stage";
import { ResearchStage } from "./stages/03-research.stage";
import { OutlineStage } from "./stages/04-outline.stage";
import { DraftingStage } from "./stages/05-drafting.stage";
import { EditorialStage } from "./stages/06-editorial.stage";
import { ApprovalNotifyStage } from "./stages/07-approval-notify.stage";
import { PublishPlaceholderStage } from "./stages/08-publish-placeholder.stage";
import { CompletionStage } from "./stages/09-completion.stage";
import { logger } from "../../core/logger";

const BOT_MD = path.join(__dirname, "bot.md");

/**
 * Builds a blog WorkflowDefinition for the given bot instance.
 *
 * `instanceId` must match a directory under src/agents/ that has:
 *   - instance.md with baseWorkflow: blog
 *
 * The workflowType on the registered definition equals the instanceId,
 * so jobs with workflowType: "elevarus-blog" run this workflow.
 *
 * Pass instanceId = "blog" for the default/generic fallback registration.
 *
 * To add, remove, or reorder stages:
 *   1. Update bot.md stages list
 *   2. Add/remove the stage class below
 *   No orchestrator changes required.
 */
export function buildBlogWorkflowDefinition(
  notifiers: INotifyAdapter[],
  instanceId = "blog"
): WorkflowDefinition {
  const manifest = loadBotManifest(BOT_MD);

  // Log instance config at startup to surface misconfiguration early
  if (instanceId !== "blog") {
    try {
      const cfg = loadInstanceConfig(instanceId);
      logger.info(`Blog workflow registered: ${cfg.name}`, {
        instanceId,
        approver: cfg.notify.approver ?? "not configured",
        scheduleEnabled: cfg.schedule.enabled,
      });
    } catch (err) {
      logger.warn(`Could not load instance config for "${instanceId}"`, {
        error: String(err),
      });
    }
  }

  return {
    type: instanceId,           // e.g. "elevarus-blog", "nes-blog", or "blog" (default)
    stages: [
      new IntakeStage(),
      new NormalizationStage(),
      new ResearchStage(),
      new OutlineStage(),
      new DraftingStage(),
      new EditorialStage(),
      new ApprovalNotifyStage(notifiers),
      new PublishPlaceholderStage(),
      new CompletionStage(notifiers),
    ],
  };
}
