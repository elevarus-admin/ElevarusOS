import { IStage, requireStageOutput } from "../../../core/stage.interface";
import { Job } from "../../../models/job.model";
import { INotifyAdapter } from "../../../adapters/notify/notify.interface";
import { loadInstanceConfig } from "../../../core/instance-config";
import { logger } from "../../../core/logger";
import { SummaryOutput } from "./03-summary.stage";

export interface SlackPublishOutput {
  published: boolean;
  channel?: string;
  message: string;
  publishedAt: string;
}

/**
 * Stage 4 — Slack Publish
 *
 * Posts the campaign summary to the Slack channel configured for this instance.
 *
 * The Slack channel is read from the instance's instance.md (notify.slackChannel).
 * If no channel is configured, the report is logged but not posted.
 *
 * TODO: Add a dedicated Slack publishing method to INotifyAdapter, or create
 * a separate IPublishAdapter for structured Slack posts.
 */
export class SlackPublishStage implements IStage {
  readonly stageName = "slack-publish";

  constructor(private readonly notifiers: INotifyAdapter[]) {}

  async run(job: Job): Promise<SlackPublishOutput> {
    logger.info("Running slack-publish stage", { jobId: job.id });

    const summary = requireStageOutput<SummaryOutput>(job, "summary");

    // Resolve the target Slack channel from the instance config
    let slackChannel: string | undefined;
    if (job.workflowType) {
      try {
        const cfg = loadInstanceConfig(job.workflowType);
        slackChannel = cfg.notify.slackChannel;
      } catch { /* instance config optional */ }
    }

    if (!slackChannel) {
      logger.warn("No Slack channel configured for this instance — skipping publish", {
        jobId: job.id,
        workflowType: job.workflowType,
      });
      return {
        published: false,
        message: summary.slackMessage,
        publishedAt: new Date().toISOString(),
      };
    }

    // TODO: Post directly to Slack using the configured channel.
    // Currently logs the message — wire up SlackNotifyAdapter or a dedicated
    // Slack publisher when the channel IDs are configured.
    logger.info("Slack report ready (channel not yet wired)", {
      jobId: job.id,
      channel: slackChannel,
      alertLevel: summary.alertLevel,
      messagePreview: summary.slackMessage.slice(0, 100),
    });

    return {
      published: false, // flip to true once Slack posting is wired
      channel: slackChannel,
      message: summary.slackMessage,
      publishedAt: new Date().toISOString(),
    };
  }
}
