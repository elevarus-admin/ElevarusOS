import { INotifyAdapter } from "./notify.interface";
import { Job } from "../../models/job.model";
import { EditorialOutput } from "../../models/output.model";
import { config } from "../../config";
import { logger } from "../../core/logger";

/**
 * Sends workflow notifications to a Slack channel via the Slack Web API.
 *
 * Integration points:
 * - Requires SLACK_BOT_TOKEN and SLACK_NOTIFY_CHANNEL in env
 * - Uses chat.postMessage: POST https://slack.com/api/chat.postMessage
 *   Headers: { Authorization: `Bearer ${token}` }
 *
 * TODO: Add thread support — keep all messages for a job in one thread
 *       using the timestamp (ts) returned from the first postMessage call.
 * TODO: Add Block Kit layouts for richer approval request messages.
 */
export class SlackNotifyAdapter implements INotifyAdapter {
  readonly name = "slack";

  async sendJobStarted(job: Job): Promise<void> {
    await this.post({
      text: `*Blog workflow started* :rocket:\n*Job:* \`${job.id}\`\n*Title:* ${job.request.title}\n*Keyword:* ${job.request.targetKeyword}`,
    });
  }

  async sendApprovalRequest(job: Job): Promise<void> {
    const editorial = this.getStageOutput<EditorialOutput>(job, "editorial");
    const wordCount = editorial?.wordCount ?? "—";
    const preview = editorial
      ? editorial.body.slice(0, 400) + (editorial.body.length > 400 ? "…" : "")
      : "_Draft not yet available_";

    await this.post({
      text: [
        `*Draft ready for approval* :pencil2:`,
        `*Job:* \`${job.id}\``,
        `*Title:* ${editorial?.title ?? job.request.title}`,
        `*Words:* ${wordCount}`,
        `*Approver:* ${job.request.approver ?? "—"}`,
        `\n*Preview:*\n${preview}`,
        `\n_Reply to this message or update the approval record to approve._`,
      ].join("\n"),
    });
  }

  async sendFailure(job: Job, error: string): Promise<void> {
    await this.post({
      text: `*Workflow failed* :x:\n*Job:* \`${job.id}\`\n*Title:* ${job.request.title}\n*Error:* ${error}`,
    });
  }

  async sendCompletion(job: Job): Promise<void> {
    await this.post({
      text: `*Workflow completed* :white_check_mark:\n*Job:* \`${job.id}\`\n*Title:* ${job.request.title}`,
    });
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async post(payload: { text: string }): Promise<void> {
    if (!config.slack.botToken || !config.slack.notifyChannel) {
      logger.warn("Slack adapter is not configured — skipping notification", {
        adapter: this.name,
      });
      return;
    }

    logger.debug("Posting Slack message", {
      channel: config.slack.notifyChannel,
      preview: payload.text.slice(0, 80),
    });

    // TODO: Implement real Slack API call
    // fetch("https://slack.com/api/chat.postMessage", {
    //   method: "POST",
    //   headers: {
    //     "Content-Type": "application/json; charset=utf-8",
    //     Authorization: `Bearer ${config.slack.botToken}`,
    //   },
    //   body: JSON.stringify({
    //     channel: config.slack.notifyChannel,
    //     text: payload.text,
    //   }),
    // });

    logger.info("Slack notification stubbed", {
      adapter: this.name,
      preview: payload.text.slice(0, 120),
    });
  }

  private getStageOutput<T>(job: Job, stageName: string): T | undefined {
    const stage = job.stages.find((s) => s.name === stageName);
    return stage?.output as T | undefined;
  }
}
