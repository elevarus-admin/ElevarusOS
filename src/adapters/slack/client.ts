import { logger } from "../../core/logger";

const SLACK_API = "https://slack.com/api/chat.postMessage";

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackPostOptions {
  channel: string;         // channel ID (C...) or name (#cli-final-expense)
  text:    string;         // plain-text fallback (required for notifications)
  blocks?: SlackBlock[];   // rich Block Kit layout (optional)
  threadTs?: string;       // reply into an existing thread
  /**
   * When true alongside threadTs, the threaded reply also appears at the
   * channel's top level ("Also send to channel"). Slack API: reply_broadcast.
   */
  replyBroadcast?: boolean;
}

/**
 * Thin Slack Web API client.
 *
 * Requires SLACK_BOT_TOKEN (xoxb-...) in .env.
 * Bot must be invited to the target channel.
 *
 * Required OAuth scopes:
 *   chat:write        — post messages
 *   chat:write.public — post to public channels without joining (optional)
 *
 * Returns the message timestamp (ts) on success — save it to thread replies.
 */
export async function postToSlack(opts: SlackPostOptions): Promise<string | undefined> {
  const token = process.env.SLACK_BOT_TOKEN ?? "";

  if (!token || token === "xoxb-..." || !token.startsWith("xoxb-")) {
    logger.warn("slack-client: SLACK_BOT_TOKEN not configured — skipping Slack post", {
      channel: opts.channel,
    });
    return undefined;
  }

  const body: Record<string, unknown> = {
    channel: opts.channel,
    text:    opts.text,
  };
  if (opts.blocks)   body.blocks    = opts.blocks;
  if (opts.threadTs) body.thread_ts = opts.threadTs;
  if (opts.threadTs && opts.replyBroadcast) body.reply_broadcast = true;

  try {
    const res = await fetch(SLACK_API, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization:  `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      logger.error("slack-client: HTTP error", { status: res.status, channel: opts.channel });
      return undefined;
    }

    const data = await res.json() as { ok: boolean; ts?: string; error?: string };

    if (!data.ok) {
      logger.error("slack-client: API error", { error: data.error, channel: opts.channel });
      return undefined;
    }

    logger.info("slack-client: message posted", { channel: opts.channel, ts: data.ts });
    return data.ts;
  } catch (err) {
    logger.error("slack-client: fetch error", { error: String(err), channel: opts.channel });
    return undefined;
  }
}

/**
 * Build a rich Slack Block Kit layout for a campaign performance report.
 * Used by the reporting slack-publish stage.
 */
export function buildReportBlocks(opts: {
  title:        string;
  oneLiner:     string;
  alertLevel:   "green" | "yellow" | "red";
  slackMessage: string;
  instanceId:   string;
}): SlackBlock[] {
  const alertEmoji: Record<string, string> = {
    green:  "✅",
    yellow: "⚠️",
    red:    "🚨",
  };
  const emoji = alertEmoji[opts.alertLevel] ?? "📊";

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} ${opts.title}`, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${opts.oneLiner}*` },
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: opts.slackMessage },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Posted by ElevarusOS · ${opts.instanceId} · ${new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}`,
        },
      ],
    },
  ];
}
