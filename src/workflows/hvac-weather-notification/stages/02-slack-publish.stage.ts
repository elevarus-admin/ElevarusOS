import * as fs from "fs";
import * as path from "path";
import { IStage, requireStageOutput } from "../../../core/stage.interface";
import { Job } from "../../../models/job.model";
import { loadInstanceConfig } from "../../../core/instance-config";
import { postToSlack } from "../../../adapters/slack/client";
import { logger } from "../../../core/logger";
import { FetchAlertsOutput } from "./01-fetch-alerts.stage";

export interface SlackPublishOutput {
  published:   boolean;
  skipped:     boolean;
  reason?:     string;
  channel?:    string;
  message?:    string;
  ts?:         string;
  publishedAt: string;
}

export class SlackPublishStage implements IStage {
  readonly stageName = "slack-publish";

  async run(job: Job): Promise<SlackPublishOutput> {
    logger.info("Running slack-publish stage", { jobId: job.id });

    const alerts = requireStageOutput<FetchAlertsOutput>(job, "fetch-alerts");
    const publishedAt = new Date().toISOString();

    if (!alerts.hasAny) {
      logger.info("slack-publish: no HVAC-relevant alerts — skipping post", {
        jobId: job.id,
      });
      return {
        published:   false,
        skipped:     true,
        reason:      "no-alerts",
        publishedAt,
      };
    }

    let slackChannel: string | undefined;
    try {
      const cfg = loadInstanceConfig(job.workflowType);
      slackChannel = cfg.notify.slackChannel;
    } catch { /* instance config optional */ }

    const message = buildSlackMessage(alerts);

    if (process.env.DRY_RUN === "true") {
      logger.info("slack-publish: DRY RUN — skipping Slack post");
      console.log("\n" + "═".repeat(60));
      console.log("DRY RUN — HVAC Weather Notification (not posted)");
      console.log("═".repeat(60));
      console.log(message);
      console.log("═".repeat(60) + "\n");
      this.writeWorkspaceReport(job.workflowType, alerts, message, publishedAt);
      return {
        published:   false,
        skipped:     true,
        reason:      "dry-run",
        message,
        publishedAt,
      };
    }

    if (!slackChannel) {
      logger.warn("slack-publish: no slackChannel configured — skipping", {
        jobId:        job.id,
        workflowType: job.workflowType,
      });
      return {
        published:   false,
        skipped:     true,
        reason:      "no-channel",
        message,
        publishedAt,
      };
    }

    const ts = await postToSlack({ channel: slackChannel, text: message });
    const published = ts !== undefined;

    if (published) {
      logger.info("slack-publish: notification posted", {
        jobId:   job.id,
        channel: slackChannel,
        ts,
      });
    } else {
      logger.warn("slack-publish: post failed — check SLACK_BOT_TOKEN", {
        jobId:   job.id,
        channel: slackChannel,
      });
    }

    this.writeWorkspaceReport(job.workflowType, alerts, message, publishedAt, slackChannel, ts);

    return {
      published,
      skipped:     false,
      channel:     slackChannel,
      message,
      ts,
      publishedAt,
    };
  }

  private writeWorkspaceReport(
    instanceId:  string,
    alerts:      FetchAlertsOutput,
    message:     string,
    publishedAt: string,
    channel?:    string,
    ts?:         string,
  ): void {
    try {
      const reportDir = path.join(
        process.cwd(),
        "src", "instances", instanceId, "workspace", "reports",
      );
      fs.mkdirSync(reportDir, { recursive: true });

      const dateStr    = publishedAt.slice(0, 10);
      const reportPath = path.join(reportDir, `${dateStr}.md`);
      const lines = [
        `# Weather Notification — ${dateStr}`,
        ``,
        `**Published:** ${publishedAt}`,
        channel ? `**Slack channel:** #${channel}` : "",
        ts ? `**Slack ts:** ${ts}` : "",
        `**Total active NWS alerts:** ${alerts.totalAlerts}`,
        `**HVAC-relevant alerts:** ${alerts.relevant}`,
        ``,
        `## Heat (AC campaign)`,
        `- States (${alerts.heat.stateCount}): ${alerts.heat.states.join(", ") || "(none)"}`,
        `- Event types: ${alerts.heat.events.join(", ") || "(none)"}`,
        ``,
        `## Cold (Heating campaign)`,
        `- States (${alerts.cold.stateCount}): ${alerts.cold.states.join(", ") || "(none)"}`,
        `- Event types: ${alerts.cold.events.join(", ") || "(none)"}`,
        ``,
        `## Slack Message`,
        "```",
        message,
        "```",
      ].filter((l) => l !== "").join("\n");

      fs.writeFileSync(reportPath, lines, "utf8");
      logger.info("slack-publish: report written", { reportPath });
    } catch (err) {
      logger.warn("slack-publish: failed to write workspace report", { error: String(err) });
    }
  }
}

function buildSlackMessage(a: FetchAlertsOutput): string {
  const date = a.fetchedAt.slice(0, 10);
  const lines: string[] = [`🌡️ *HVAC Weather Alert — ${date}*`];

  if (a.heat.stateCount > 0) {
    lines.push("");
    lines.push(
      `🔥 *Heat — ${a.heat.stateCount} state${a.heat.stateCount === 1 ? "" : "s"}* → AC campaign`,
    );
    lines.push(`• ${a.heat.states.join(", ")}`);
    lines.push(`_Alerts: ${a.heat.events.join(", ")}_`);
  }

  if (a.cold.stateCount > 0) {
    lines.push("");
    lines.push(
      `❄️ *Cold — ${a.cold.stateCount} state${a.cold.stateCount === 1 ? "" : "s"}* → Heating campaign`,
    );
    lines.push(`• ${a.cold.states.join(", ")}`);
    lines.push(`_Alerts: ${a.cold.events.join(", ")}_`);
  }

  lines.push("");
  lines.push("_Source: NWS active alerts (api.weather.gov)_");
  return lines.join("\n");
}
