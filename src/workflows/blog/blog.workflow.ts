import { IBlogStage } from "./stages/stage.interface";
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

/**
 * Assembles the ordered list of stages for the blog research and draft
 * workflow. The orchestrator iterates this list in order, passing the
 * mutated job object between stages.
 *
 * To add or reorder stages, modify this function — no changes to the
 * orchestrator are required.
 */
export function buildBlogWorkflow(notifiers: INotifyAdapter[]): IBlogStage[] {
  return [
    new IntakeStage(),
    new NormalizationStage(),
    new ResearchStage(),
    new OutlineStage(),
    new DraftingStage(),
    new EditorialStage(),
    new ApprovalNotifyStage(notifiers),
    new PublishPlaceholderStage(),
    new CompletionStage(notifiers),
  ];
}
