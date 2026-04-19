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
import { config } from "../../config";
import { logger } from "../../core/logger";
import { postToSlack } from "./client";
import { claudeConverseWithTools } from "../../core/claude-converse";
import { buildKnowledgeCatalog } from "../../core/knowledge-catalog";
import { WorkflowRegistry } from "../../core/workflow-registry";
import { IJobStore } from "../../core/job-store";
import { QA_TOOLS, claudeWantsBroadcast } from "../../core/qa-tools";
import { getIntegrationTools } from "../../core/integration-registry";
import { DATA_TOOLS } from "./data-tools";
import {
  fetchChannelContext,
  renderContextBlock,
  ChannelContext,
} from "./context";

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
    const tools   = [...QA_TOOLS, ...DATA_TOOLS, ...getIntegrationTools()];
    const result  = await claudeConverseWithTools({
      system:        buildSystemPrompt(catalog, context),
      userMessage:   question,
      traceId,
      tools,
      toolContext:   {
        jobStore: deps.jobStore,
        registry: deps.registry,
        slack:    { userId: askerUserId, channelId: channel, traceId },
      },
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
    "You have tools for live, drill-down state. Prefer calling a tool over guessing or relying on the static catalog above.",
    "",
    "**Orientation (pick these first for 'what/who/how' questions):**",
    "- `list_instances` / `get_instance_detail` — bot configuration + mission text",
    "- `list_workflows` — registered workflow types and stage order",
    "- `list_integrations` — all registered integrations (auto-discovered from the integration registry) with runtime configured/unconfigured state and the Supabase tables they own",
    "- `describe_schema` — introspect Supabase tables/columns available to `supabase_query`. Call this BEFORE writing a supabase_query if you're unsure about column names.",
    "",
    "**Data access (preferred path for any 'numbers' question — revenue, volume, CPL, counts, trends):**",
    "- `supabase_query` — parametric SELECT against whitelisted tables (ringba_calls, lp_leads, jobs, etc.). Supports filters, groupBy, aggregations (sum/count/avg/min/max), orderBy, limit. **This is the workhorse — reach for it first for ad-hoc data questions.** Default cap 2000 rows; surface `truncated: true` to the user and offer to narrow.",
    "- `ringba_live_query` — live Ringba REST API. Use ONLY when (a) the user explicitly asks for fresh-within-minutes data, (b) you need a field that isn't in `ringba_calls`, or (c) `supabase_query` has confirmed the data is missing. Otherwise prefer `supabase_query` — it's faster and audited.",
    "- `list_ringba_publishers` / `list_ringba_campaigns` / `list_lp_campaigns` — helper lookups to resolve fuzzy user references like \"the CHP publisher\" to the exact string stored in the DB. Call these when a filter value isn't obvious.",
    "- `list_ringba_tags` — discover what tag keys are actually populated on `ringba_calls.tag_values` over the last 90 days (User:utm_campaign, Geo:Country, Technology:OS, etc.). Call this BEFORE writing a tag-based query so you use the right key.",
    "",
    "**Existing narrow-scope tools (use only when they exactly match the question):**",
    "- `query_jobs` / `get_job_output` — workflow run history",
    "- `get_ringba_revenue` — simple instance-bound revenue rollup (use `supabase_query` for anything with multiple campaigns, publishers, or custom filters)",
    "- `get_meta_spend` — simple instance-bound Meta spend",
    "- `broadcast_reply` — reply is also posted to the main channel (see rule below)",
    "",
    "Rules of thumb:",
    "- For any data question with filters on publisher, buyer, supplier, multiple campaigns, or custom date ranges — use `supabase_query`, NOT the narrow wrapper tools.",
    "- For revenue queries on `ringba_calls`, always filter `has_payout = true AND is_duplicate = false` unless the user asks otherwise.",
    "- For UTM / custom-tag queries on `ringba_calls`, use the `tag_values` JSONB column. Filter via `jsonb_contains` with an object value: `{ column: 'tag_values', op: 'jsonb_contains', value: { 'User:utm_campaign': 'spring_hvac' } }`. To group BY a tag, first pull the rows then aggregate — tag_values can't be used directly in groupBy with the current builder. If you need a breakdown by utm_campaign, pull each row's `tag_values` and the revenue columns, then the user can ask for the split in a second pass. Call `list_ringba_tags` first to see what keys exist.",
    "- You can chain tools — e.g. `describe_schema` → `supabase_query`, or `query_jobs` → `get_job_output`.",
    "- If a tool returns `{ error: ... }`, tell the user what's missing rather than guessing. Many errors include `hint:` fields with close-match column suggestions — use them.",
    "- If `supabase_query` returns `truncated: true`, surface the total and ask the user to narrow the filter (or offer the top-N with that cap).",
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
