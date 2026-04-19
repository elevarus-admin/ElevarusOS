import { INotifyAdapter } from "../notify/notify.interface";
import { Job } from "../../models/job.model";
import { EditorialOutput } from "../../models/output.model";
import { config } from "../../config";
import { logger } from "../../core/logger";

const SLACK_API = "https://slack.com/api";

/**
 * Sends workflow notifications to a Slack channel via the Slack Web API.
 *
 * Auth:      Bot token (xoxb-...) via Authorization header
 * Endpoint:  POST /chat.postMessage
 *
 * Thread support: the ts of the first message for each job is stored in
 * memory so all subsequent messages are threaded under it. This keeps the
 * channel feed clean — only the job-started message appears at the top
 * level; everything else is a reply.
 */
export class SlackNotifyAdapter implements INotifyAdapter {
  readonly name = "slack";

  /** job.id → parent thread_ts */
  private readonly threadTs = new Map<string, string>();

  async sendJobStarted(job: Job): Promise<void> {
    const ts = await this.post({
      text: [
        `*Blog workflow started* :rocket:`,
        `*Job:* \`${job.id}\``,
        `*Title:* ${job.request.title}`,
        `*Keyword:* ${job.request.targetKeyword}`,
        `*Approver:* ${job.request.approver ?? "—"}`,
      ].join("\n"),
    });
    if (ts) this.threadTs.set(job.id, ts);
  }

  async sendApprovalRequest(job: Job): Promise<void> {
    const editorial = this.getStageOutput<EditorialOutput>(job, "editorial");
    const wordCount = editorial?.wordCount ?? "—";
    const preview = editorial
      ? editorial.body.slice(0, 400) + (editorial.body.length > 400 ? "…" : "")
      : "_Draft not yet available_";

    const title = editorial?.title ?? job.request.title;

    // Block Kit message with interactive Approve / Reject buttons.
    // Slack sends a POST to /api/webhooks/slack/interactions when clicked.
    // The value field carries the job ID so the handler can route the decision.
    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: "✏️ Draft Ready for Approval", emoji: true },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Title:*\n${title}` },
          { type: "mrkdwn", text: `*Words:*\n${wordCount}` },
          { type: "mrkdwn", text: `*Job:*\n\`${job.id}\`` },
          { type: "mrkdwn", text: `*Edit summary:*\n${editorial?.editSummary ?? "—"}` },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Preview:*\n${preview}` },
      },
      { type: "divider" },
      {
        type: "actions",
        elements: [
          {
            type:      "button",
            text:      { type: "plain_text", text: "✅ Approve", emoji: true },
            style:     "primary",
            action_id: "approve_job",
            value:     job.id,
            confirm: {
              title:   { type: "plain_text", text: "Approve this draft?" },
              text:    { type: "mrkdwn", text: "This will continue the workflow and publish the content." },
              confirm: { type: "plain_text", text: "Yes, approve" },
              deny:    { type: "plain_text", text: "Cancel" },
            },
          },
          {
            type:      "button",
            text:      { type: "plain_text", text: "❌ Reject", emoji: true },
            style:     "danger",
            action_id: "reject_job",
            value:     job.id,
            confirm: {
              title:   { type: "plain_text", text: "Reject this draft?" },
              text:    { type: "mrkdwn", text: "This will stop the workflow. The job will be marked as rejected." },
              confirm: { type: "plain_text", text: "Yes, reject" },
              deny:    { type: "plain_text", text: "Cancel" },
            },
          },
        ],
      },
    ];

    await this.postBlocks(
      {
        text:   `Draft ready for approval: ${title} (job \`${job.id}\`)`,
        blocks,
      },
      job.id
    );
  }

  async sendFailure(job: Job, error: string): Promise<void> {
    await this.post(
      {
        text: [
          `*Workflow failed* :x:`,
          `*Job:* \`${job.id}\``,
          `*Title:* ${job.request.title}`,
          `*Error:* ${error}`,
        ].join("\n"),
      },
      job.id
    );
  }

  async sendCompletion(job: Job): Promise<void> {
    await this.post(
      {
        text: [
          `*Workflow completed* :white_check_mark:`,
          `*Job:* \`${job.id}\``,
          `*Title:* ${job.request.title}`,
        ].join("\n"),
      },
      job.id
    );
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Post a Block Kit message with interactive elements.
   * If jobId is provided and a thread_ts exists, replies in the thread.
   * @returns The message ts on success, undefined on skip/error.
   */
  private async postBlocks(
    payload: { text: string; blocks: unknown[] },
    jobId?: string
  ): Promise<string | undefined> {
    if (!this.isConfigured()) {
      logger.warn("Slack adapter is not configured — skipping block notification", {
        adapter: this.name,
      });
      return undefined;
    }

    const body: Record<string, unknown> = {
      channel: config.slack.notifyChannel,
      text:    payload.text,
      blocks:  payload.blocks,
    };

    if (jobId) {
      const thread = this.threadTs.get(jobId);
      if (thread) body["thread_ts"] = thread;
    }

    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${config.slack.botToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      logger.error("Slack API HTTP error (blocks)", { adapter: this.name, status: res.status });
      return undefined;
    }

    const data = (await res.json()) as { ok: boolean; ts?: string; error?: string };
    if (!data.ok) {
      logger.error("Slack API returned error (blocks)", { adapter: this.name, error: data.error });
      return undefined;
    }

    logger.info("Slack block message sent", {
      adapter: this.name,
      channel: config.slack.notifyChannel,
      ts: data.ts,
    });

    return data.ts;
  }

  /**
   * Post a plain text message. If jobId is provided and a thread_ts exists for it,
   * the message is sent as a thread reply.
   * @returns The message ts on success, undefined on skip/error.
   */
  private async post(
    payload: { text: string },
    jobId?: string
  ): Promise<string | undefined> {
    if (!this.isConfigured()) {
      logger.warn("Slack adapter is not configured — skipping notification", {
        adapter: this.name,
      });
      return undefined;
    }

    const body: Record<string, unknown> = {
      channel: config.slack.notifyChannel,
      text: payload.text,
    };

    if (jobId) {
      const thread = this.threadTs.get(jobId);
      if (thread) body["thread_ts"] = thread;
    }

    logger.debug("Posting Slack message", {
      channel: config.slack.notifyChannel,
      threaded: !!body["thread_ts"],
    });

    const res = await fetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${config.slack.botToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      logger.error("Slack API HTTP error", {
        adapter: this.name,
        status: res.status,
      });
      return undefined;
    }

    const data = (await res.json()) as { ok: boolean; ts?: string; error?: string };

    if (!data.ok) {
      logger.error("Slack API returned error", {
        adapter: this.name,
        error: data.error,
      });
      return undefined;
    }

    logger.info("Slack message sent", {
      adapter: this.name,
      channel: config.slack.notifyChannel,
      ts: data.ts,
    });

    return data.ts;
  }

  private isConfigured(): boolean {
    const { botToken, notifyChannel } = config.slack;
    if (!botToken || !notifyChannel) return false;
    // Reject obvious placeholders
    if (botToken === "xoxb-..." || notifyChannel === "C0123456789") return false;
    return botToken.startsWith("xoxb-");
  }

  private getStageOutput<T>(job: Job, stageName: string): T | undefined {
    const stage = job.stages.find((s) => s.name === stageName);
    return stage?.output as T | undefined;
  }
}
