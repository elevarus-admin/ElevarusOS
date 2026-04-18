import * as fs   from "fs";
import * as path from "path";
import { IStage, requireStageOutput } from "../../../core/stage.interface";
import { Job } from "../../../models/job.model";
import { loadInstanceConfig } from "../../../core/instance-config";
import { postToSlack } from "../../../adapters/slack/client";
import { logger } from "../../../core/logger";
import { SummaryOutput } from "./03-summary.stage";

export interface SlackPublishOutput {
  published:   boolean;
  channel?:    string;
  message:     string;
  ts?:         string;   // Slack message timestamp (for threading future replies)
  publishedAt: string;
}

/**
 * Stage 4 — Slack Publish
 *
 * Posts the campaign summary to the Slack channel configured for this instance.
 *
 * Configuration (instance.md):
 *   notify:
 *     slackChannel: cli-final-expense   ← channel name or ID
 *
 * Env vars required:
 *   SLACK_BOT_TOKEN=xoxb-...
 *
 * The bot must be invited to the channel:
 *   /invite @YourBotName   (in Slack)
 *
 * If slackChannel is not set or SLACK_BOT_TOKEN is missing, the stage
 * completes successfully but logs a warning and skips the post.
 */
export class SlackPublishStage implements IStage {
  readonly stageName = "slack-publish";

  async run(job: Job): Promise<SlackPublishOutput> {
    logger.info("Running slack-publish stage", { jobId: job.id });

    const summary = requireStageOutput<SummaryOutput>(job, "summary");

    // Resolve the target Slack channel from instance config
    let slackChannel: string | undefined;
    try {
      const cfg = loadInstanceConfig(job.workflowType);
      slackChannel = cfg.notify.slackChannel;
    } catch { /* instance config optional */ }

    // Dry-run mode: skip Slack post and just print the report here for verification
    if (process.env.DRY_RUN === "true") {
      logger.info("slack-publish: DRY RUN — skipping Slack post");
      const publishedAt = new Date().toISOString();
      console.log("\n" + "═".repeat(60));
      console.log("DRY RUN — Final Expense Report (not posted to Slack)");
      console.log("═".repeat(60));
      console.log("\n📋 ONE-LINER:\n" + summary.oneLiner);
      console.log("\n📨 SLACK MESSAGE:\n");
      console.log(summary.slackMessage);
      console.log("\n" + "═".repeat(60) + "\n");
      this.writeReportToWorkspace(job.workflowType, summary, publishedAt, undefined, undefined);
      return {
        published:   false,
        message:     summary.slackMessage,
        publishedAt,
      };
    }

    if (!slackChannel) {
      logger.warn("slack-publish: no slackChannel configured — skipping", {
        jobId:        job.id,
        workflowType: job.workflowType,
        hint:         "Set notify.slackChannel in instance.md",
      });
      return {
        published:   false,
        message:     summary.slackMessage,
        publishedAt: new Date().toISOString(),
      };
    }

    // Post the compact message directly as mrkdwn — no Block Kit wrapper
    const ts = await postToSlack({
      channel: slackChannel,
      text:    summary.slackMessage,
    });

    const published = ts !== undefined;

    if (published) {
      logger.info("slack-publish: report posted", {
        jobId:   job.id,
        channel: slackChannel,
        ts,
      });
    } else {
      logger.warn("slack-publish: post skipped or failed — check SLACK_BOT_TOKEN", {
        jobId:   job.id,
        channel: slackChannel,
      });
    }

    const publishedAt = new Date().toISOString();

    // Write final report to instance workspace
    this.writeReportToWorkspace(job.workflowType, summary, publishedAt, slackChannel, ts);

    return {
      published,
      channel:     slackChannel,
      message:     summary.slackMessage,
      ts,
      publishedAt,
    };
  }

  private writeReportToWorkspace(
    instanceId:  string,
    summary:     SummaryOutput,
    publishedAt: string,
    channel?:    string,
    ts?:         string
  ): void {
    try {
      const workspaceDir = path.join(
        process.cwd(),
        "src", "instances", instanceId, "workspace"
      );
      fs.mkdirSync(workspaceDir, { recursive: true });

      const dateStr   = publishedAt.slice(0, 10);
      const reportDir = path.join(workspaceDir, "reports");
      fs.mkdirSync(reportDir, { recursive: true });

      // Write dated report file
      const reportPath = path.join(reportDir, `${dateStr}.md`);
      const reportContent = [
        `# Report — ${dateStr}`,
        ``,
        `**Published:** ${publishedAt}`,
        channel ? `**Slack channel:** #${channel}` : "",
        ts ? `**Slack ts:** ${ts}` : "",
        `**Alert level:** ${summary.alertLevel}`,
        ``,
        `## One-liner`,
        summary.oneLiner,
        ``,
        `## Slack Message`,
        "```",
        summary.slackMessage,
        "```",
        ``,
        `## Full Report`,
        summary.markdownReport,
      ].filter((l) => l !== "").join("\n");

      fs.writeFileSync(reportPath, reportContent, "utf8");
      logger.info("slack-publish: report written to workspace", { reportPath });
    } catch (err) {
      logger.warn("slack-publish: failed to write workspace report", { error: String(err) });
    }
  }
}
