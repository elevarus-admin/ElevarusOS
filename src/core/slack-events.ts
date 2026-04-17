/**
 * Slack Events API inbound handler.
 *
 * Receives signed HTTP events from Slack (app_mention, message.im) and
 * dispatches them. Paired with the outbound `slack-client.ts`.
 *
 * Phase 2: replies using Claude with a static knowledge catalog of the
 * ElevarusOS instances, workflows, and integrations. No tool use yet —
 * answers are grounded in a single-shot system prompt assembled at request
 * time. See docs/qa-bot.md for the roadmap.
 *
 * Slack signature verification (v0):
 *   https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * Required env:
 *   SLACK_SIGNING_SECRET  — from Slack app "Basic Information" page
 *   SLACK_BOT_TOKEN       — xoxb-... for posting replies
 *   SLACK_APP_ID          — A... app id, used to drop self-events
 */

import * as crypto from "crypto";
import { config } from "../config";
import { logger } from "./logger";
import { postToSlack } from "./slack-client";
import { claudeConverseWithTools } from "./claude-converse";
import { buildKnowledgeCatalog } from "./knowledge-catalog";
import { WorkflowRegistry } from "./workflow-registry";
import { IJobStore } from "./job-store";
import { QA_TOOLS, claudeWantsBroadcast } from "./qa-tools";
import {
  fetchChannelContext,
  renderContextBlock,
  ChannelContext,
} from "./slack-context";

/** Max age of a Slack request we'll accept. Slack recommends 5 min. */
const MAX_REQUEST_AGE_SECONDS = 60 * 5;

/** Shown to the user when the bot hits a provider error. */
const FALLBACK_ERROR_MESSAGE =
  "Sorry — I hit an error trying to answer that. Check the ElevarusOS logs.";

export interface SlackEventDeps {
  /** Workflow registry used to enumerate registered workflow types. */
  registry: WorkflowRegistry;
  /** Job store used by QA tools for live state queries. */
  jobStore: IJobStore;
}

export interface SlackVerifyResult {
  ok:    boolean;
  error?: string;
}

export interface SlackEventEnvelope {
  type:       "url_verification" | "event_callback";
  token?:     string;
  challenge?: string;
  team_id?:   string;
  api_app_id?: string;
  event?:     SlackEvent;
  event_id?:  string;
  event_time?: number;
}

export type SlackEvent =
  | AppMentionEvent
  | MessageEvent
  | { type: string; [key: string]: unknown };

export interface AppMentionEvent {
  type:       "app_mention";
  user:       string;
  text:       string;
  ts:         string;
  channel:    string;
  thread_ts?: string;
  event_ts:   string;
  bot_id?:    string;
  app_id?:    string;
}

export interface MessageEvent {
  type:          "message";
  channel_type?: "im" | "channel" | "group" | "mpim";
  user?:         string;
  text?:         string;
  ts:            string;
  channel:       string;
  thread_ts?:    string;
  event_ts:      string;
  bot_id?:       string;
  app_id?:       string;
  subtype?:      string;
}

/**
 * Verify a Slack request using the v0 signing scheme.
 *
 * Computes HMAC-SHA256 of `v0:<timestamp>:<raw-body>` with the signing secret
 * and compares it (timing-safe) against the `x-slack-signature` header.
 */
export function verifySlackSignature(
  rawBody:       Buffer,
  timestamp:     string | undefined,
  signature:     string | undefined,
  signingSecret: string,
): SlackVerifyResult {
  if (!signingSecret)           return { ok: false, error: "SLACK_SIGNING_SECRET not set" };
  if (!timestamp || !signature) return { ok: false, error: "Missing Slack signing headers" };

  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return { ok: false, error: "Invalid timestamp" };

  const ageSec = Math.abs(Date.now() / 1000 - tsNum);
  if (ageSec > MAX_REQUEST_AGE_SECONDS) {
    return { ok: false, error: `Stale request (age=${Math.round(ageSec)}s)` };
  }

  const base     = `v0:${timestamp}:${rawBody.toString("utf8")}`;
  const expected = "v0=" + crypto.createHmac("sha256", signingSecret).update(base).digest("hex");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: "Signature mismatch" };
  }

  return { ok: true };
}

/**
 * Dispatch a verified Slack event envelope.
 *
 * Returns the response body the webhook route should send:
 *   - `{ challenge }` for URL verification
 *   - `{ ok: true }`  for every other event
 *
 * Side-effect: posts a threaded reply for app_mention and IM events.
 */
export async function handleSlackEvent(
  envelope: SlackEventEnvelope,
  deps:     SlackEventDeps,
): Promise<Record<string, unknown>> {
  if (envelope.type === "url_verification") {
    return { challenge: envelope.challenge };
  }

  if (envelope.type !== "event_callback" || !envelope.event) {
    return { ok: true };
  }

  const event = envelope.event;

  if (isSelfEvent(event)) {
    logger.debug("slack-events: ignored self event", { eventType: event.type });
    return { ok: true };
  }

  if (event.type === "app_mention") {
    await answerQuestion(event as AppMentionEvent, envelope.event_id ?? "", deps);
  } else if (event.type === "message" && (event as MessageEvent).channel_type === "im") {
    await answerDM(event as MessageEvent, envelope.event_id ?? "", deps);
  } else {
    logger.debug("slack-events: unhandled event type", { eventType: event.type });
  }

  return { ok: true };
}

/**
 * A Slack event is a "self" event (our bot's own message) when either:
 *   - `event.bot_id` is present (any bot-authored message, including ours), or
 *   - `event.app_id` matches our app id (our bot authored this message).
 *
 * NOTE: do *not* fall back to `envelope.api_app_id` — that field is always
 * our app id (it's the envelope saying "this event is routed to app X"),
 * not an indicator of who wrote the message. An earlier version of this
 * function did that and silently dropped every real app_mention.
 */
function isSelfEvent(event: SlackEvent): boolean {
  const e = event as Record<string, unknown>;
  if (typeof e.bot_id === "string" && e.bot_id.length > 0) return true;

  const ourAppId = config.slack.appId;
  if (ourAppId && typeof e.app_id === "string" && e.app_id === ourAppId) return true;

  return false;
}

// ─── Answering ────────────────────────────────────────────────────────────────

async function answerQuestion(
  event:   AppMentionEvent,
  eventId: string,
  deps:    SlackEventDeps,
): Promise<void> {
  const question = stripMentions(event.text).trim();
  const threadTs = event.thread_ts ?? event.ts;
  const traceId  = eventId || event.event_ts;

  logger.info("slack-events: app_mention", {
    channel: event.channel,
    user:    event.user,
    ts:      event.ts,
    chars:   question.length,
    traceId,
  });

  await respond({
    channel:        event.channel,
    threadTs,
    question,
    traceId,
    deps,
    askerUserId:    event.user,
    currentTs:      event.ts,
    inThread:       Boolean(event.thread_ts),
    allowBroadcast: true,
  });
}

async function answerDM(
  event:   MessageEvent,
  eventId: string,
  deps:    SlackEventDeps,
): Promise<void> {
  // Ignore edits, deletions, joins, and bot-authored messages.
  if (event.subtype) return;
  if (!event.user)   return;
  if (!event.text)   return;

  const question = event.text.trim();
  const threadTs = event.thread_ts ?? event.ts;
  const traceId  = eventId || event.event_ts;

  logger.info("slack-events: DM", {
    channel: event.channel,
    user:    event.user,
    ts:      event.ts,
    chars:   question.length,
    traceId,
  });

  await respond({
    channel:        event.channel,
    threadTs,
    question,
    traceId,
    deps,
    askerUserId:    event.user,
    currentTs:      event.ts,
    inThread:       Boolean(event.thread_ts),
    allowBroadcast: false, // DMs have no channel to broadcast to
  });
}

async function respond(args: {
  channel:        string;
  threadTs:       string;
  question:       string;
  traceId:        string;
  deps:           SlackEventDeps;
  askerUserId:    string | undefined;
  currentTs:      string;
  inThread:       boolean;
  allowBroadcast: boolean;
}): Promise<void> {
  const {
    channel, threadTs, question, traceId, deps,
    askerUserId, currentTs, inThread, allowBroadcast,
  } = args;

  if (question.length === 0) {
    await postToSlack({
      channel,
      threadTs,
      text: "Ask me a question — for example: _what does the HVAC reporting agent do?_",
    });
    return;
  }

  let reply:          string;
  let replyBroadcast = false;

  try {
    const context = await fetchChannelContext({
      channel,
      askerUserId,
      currentTs,
      threadTs: inThread ? threadTs : undefined,
    });

    logger.debug("slack-events: context fetched", {
      traceId,
      messages: context.history.length,
      hasChannel: !!context.channel,
      hasAsker:   !!context.asker,
    });

    const catalog = buildKnowledgeCatalog({ registry: deps.registry });
    const result  = await claudeConverseWithTools({
      system:        buildSystemPrompt(catalog, context),
      userMessage:   question,
      traceId,
      tools:         QA_TOOLS,
      toolContext:   { jobStore: deps.jobStore, registry: deps.registry },
      maxIterations: maxToolIterations(),
    });

    replyBroadcast = allowBroadcast && claudeWantsBroadcast(result.toolCalls);

    logger.info("slack-events: answer generated", {
      traceId,
      toolCalls:      result.toolCalls.length,
      truncated:      result.truncated,
      broadcast:      replyBroadcast,
      inputTokens:    result.usage.inputTokens,
      outputTokens:   result.usage.outputTokens,
    });

    reply = result.text;
  } catch (err) {
    logger.error("slack-events: claudeConverseWithTools failed", {
      traceId,
      error: String(err),
    });
    await postToSlack({ channel, threadTs, text: FALLBACK_ERROR_MESSAGE });
    return;
  }

  await postToSlack({
    channel,
    threadTs,
    replyBroadcast,
    text: reply.length > 0
      ? reply
      : "Hey! Didn't catch a specific question. Try something like _\"what was today's spend?\"_, _\"did the HVAC report run?\"_, or _\"what does the U65 bot do?\"_.",
  });
}

function maxToolIterations(): number {
  const raw = process.env.QA_MAX_TOOL_ITERATIONS;
  const n   = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 6;
}

/**
 * Strip `<@U123>` user mentions from a Slack message. The @mention the user
 * used to invoke the bot is noise — we want just the question text.
 */
function stripMentions(text: string): string {
  return text.replace(/<@[UW][A-Z0-9]+(?:\|[^>]+)?>/g, "").replace(/\s+/g, " ");
}

function buildSystemPrompt(catalog: string, context?: ChannelContext): string {
  const sections: string[] = [
    "You are **Ask Elevarus**, the in-channel assistant for ElevarusOS — an internal AI agent orchestration system built at Elevarus.",
    "",
    "## Your job",
    "Answer questions from the Elevarus team about the bots running on the platform. Be specific and grounded: cite the exact instance name, workflow, job id, or integration involved.",
    "",
    "## ElevarusOS has three layers",
    "1. **Instances (MC Agents)** — named bot deployments (e.g. `hvac-reporting`, `elevarus-blog`). Each has a brand, schedule, and optional integration config.",
    "2. **Workflows** — reusable multi-stage templates (e.g. the blog workflow or the PPC reporting workflow). Instances pick one as their `baseWorkflow`.",
    "3. **Integrations** — third-party data sources (ringba, leadsprosper, meta) any workflow can read from.",
    "",
    "## Orientation catalog (static snapshot)",
    catalog,
    "",
    "## Tools available",
    "You have tools for live, drill-down state. Prefer calling a tool over guessing or relying on the static catalog above:",
    "- `list_instances` / `get_instance_detail` — bot configuration + mission text",
    "- `list_workflows` — registered workflow types and stage order",
    "- `list_integrations` — integration catalog with runtime configured/unconfigured state",
    "- `query_jobs` — recent job runs, filterable by instance or status",
    "- `get_job_output` — full stage outputs for one job",
    "- `get_ringba_revenue` — live Ringba call/revenue metrics for a campaign",
    "- `get_meta_spend` — live Meta Ads spend for an instance",
    "- `broadcast_reply` — reply is also posted to the main channel (see rule below)",
    "",
    "Rules of thumb:",
    "- For anything time-sensitive (\"did today's run go?\", \"what was CPL last week?\"), call a tool.",
    "- You can chain tools — e.g. `query_jobs` then `get_job_output` on the latest id.",
    "- If a tool returns `{ error: ... }`, tell the user what's missing rather than guessing.",
    "",
    "## Thread vs channel (broadcast)",
    "By default, reply ONLY in the thread you were mentioned in. Call the `broadcast_reply` tool ONLY when the user explicitly asks for the answer to also appear in the main channel — e.g. \"also post in the channel\", \"send this to the channel too\", \"broadcast this\", \"share with the room\". Do not call it based on your own judgement about how useful the answer is — the asker decides. Never broadcast for DMs. Write your actual reply text as usual; the broadcast tool just signals the posting layer.",
  ];

  if (context) {
    const contextBlock = renderContextBlock(context);
    if (contextBlock) {
      sections.push(
        "",
        "## Conversation context",
        "The question comes from a Slack channel. Use this block to resolve pronouns and follow-ups (\"what about the other campaign?\", \"same question for yesterday\") — but do *not* quote it back at the user.",
        "",
        contextBlock,
      );
    }
  }

  sections.push(
    "",
    "## Reply style",
    "- Keep replies short and Slack-friendly. Use Slack mrkdwn: single `*bold*`, `_italic_`, `` `code` ``, and `<http://url|label>` for links. Do NOT use standard Markdown double-asterisks — Slack renders `**foo**` literally.",
    "- When listing bots, prefer the display name with the id in backticks: _Final Expense Reporting (`final-expense-reporting`)_.",
    "- Cite job ids verbatim so the user can grep for them.",
    "- If you don't know, say so. Don't invent instances, workflows, or integrations.",
    "- **Never produce an empty reply.** If the mention has no real question (e.g. someone tagged you to introduce you, or to mark you as a participant), respond with a short friendly nudge — e.g. _\"Hey! Ask me anything about the Elevarus bots, workflows, or today's metrics.\"_ — and offer 2–3 example questions. This rule overrides everything else; text output is mandatory on the final turn.",
  );

  return sections.join("\n");
}
