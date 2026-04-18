/**
 * Slack read-side helpers for the Q&A bot.
 *
 * Fetches the metadata we inject into the system prompt so follow-up questions
 * resolve naturally ("what about the other campaign?", "same question for
 * yesterday", etc.).
 *
 * Three API calls — all with `bot:read` scopes:
 *   - conversations.info / conversations.replies / conversations.history
 *   - users.info
 *
 * Everything degrades gracefully. If a call fails (missing scope, bot not in
 * channel, Slack 5xx), we log and return empty — the answer loop still runs,
 * just without channel context.
 *
 * Required bot scopes:
 *   channels:history, groups:history, im:history, mpim:history
 *   channels:read,    groups:read,    im:read,    mpim:read
 *   users:read
 */

import { logger } from "../../core/logger";
import { config } from "../../config";

const SLACK_API = "https://slack.com/api";

// ─── Types (narrow shapes of the Slack fields we care about) ──────────────────

export interface SlackChannelInfo {
  id:       string;
  name?:    string;
  purpose?: string;
  topic?:   string;
  isIm?:    boolean;
}

export interface SlackUserInfo {
  id:          string;
  name?:       string;
  realName?:   string;
  displayName?: string;
  isBot?:      boolean;
}

export interface SlackHistoryMessage {
  ts:         string;
  user?:      string;
  text:       string;
  threadTs?:  string;
  botId?:     string;
  appId?:     string;
  subtype?:   string;
}

export interface ChannelContext {
  channel:   SlackChannelInfo | null;
  asker:     SlackUserInfo    | null;
  /** Chronologically ordered (oldest → newest), excluding the current message. */
  history:   Array<SlackHistoryMessage & { authorLabel: string }>;
  /** Cache of user_id → display label, for callers that want to post-process. */
  userIndex: Map<string, SlackUserInfo>;
}

export interface FetchChannelContextOpts {
  channel:     string;
  askerUserId: string | undefined;
  /** Current message ts — excluded from history so we don't echo the question back. */
  currentTs:   string;
  /** If present, pull thread replies instead of channel history. */
  threadTs?:   string | undefined;
  /** Max messages to return. Defaults to QA_CHANNEL_HISTORY_LIMIT or 20. */
  limit?:      number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch channel + thread context for one Slack question.
 *
 * Always resolves — failures are swallowed and logged. Callers can assume the
 * returned structure is safe to stringify into a system prompt.
 */
export async function fetchChannelContext(opts: FetchChannelContextOpts): Promise<ChannelContext> {
  const token = config.slack.botToken;
  if (!token || !token.startsWith("xoxb-")) {
    logger.warn("slack-context: SLACK_BOT_TOKEN missing — returning empty context");
    return emptyContext();
  }

  const limit = opts.limit ?? parseInt(process.env.QA_CHANNEL_HISTORY_LIMIT ?? "20", 10);

  const [channel, rawMessages] = await Promise.all([
    fetchChannelInfo(opts.channel, token),
    opts.threadTs
      ? fetchThreadReplies(opts.channel, opts.threadTs, token, limit)
      : fetchChannelHistory(opts.channel, token, limit),
  ]);

  // Exclude the current question + anything with no text content
  const filtered = rawMessages
    .filter((m) => m.ts !== opts.currentTs)
    .filter((m) => typeof m.text === "string" && m.text.trim().length > 0)
    // Drop message_changed / message_deleted / channel_join / etc.
    .filter((m) => !m.subtype || m.subtype === "bot_message" || m.subtype === "thread_broadcast")
    .sort((a, b) => a.ts.localeCompare(b.ts));

  // Resolve all unique user ids in parallel (including the asker)
  const userIds = new Set<string>();
  if (opts.askerUserId) userIds.add(opts.askerUserId);
  for (const m of filtered) if (m.user) userIds.add(m.user);

  const userIndex = new Map<string, SlackUserInfo>();
  await Promise.all(
    [...userIds].map(async (id) => {
      const info = await fetchUserInfo(id, token);
      if (info) userIndex.set(id, info);
    }),
  );

  const asker = opts.askerUserId ? userIndex.get(opts.askerUserId) ?? null : null;

  const history = filtered.map((m) => ({
    ...m,
    authorLabel: authorLabelFor(m, userIndex),
  }));

  return { channel, asker, history, userIndex };
}

/**
 * Render a ChannelContext as a compact Markdown block suitable for a system
 * prompt. Empty sections are omitted. Returns "" when there's nothing to show.
 */
export function renderContextBlock(ctx: ChannelContext, maxMessages = 20): string {
  const lines: string[] = [];

  if (ctx.channel) {
    const parts: string[] = [`**Channel:** #${ctx.channel.name ?? ctx.channel.id}`];
    if (ctx.channel.isIm)             parts.push("_(direct message)_");
    if (ctx.channel.purpose)          parts.push(`purpose: ${ctx.channel.purpose}`);
    if (ctx.channel.topic && ctx.channel.topic !== ctx.channel.purpose) {
      parts.push(`topic: ${ctx.channel.topic}`);
    }
    lines.push(parts.join(" · "));
  }

  if (ctx.asker) {
    const label = ctx.asker.displayName || ctx.asker.realName || ctx.asker.name || ctx.asker.id;
    lines.push(`**Asker:** ${label}`);
  }

  if (ctx.history.length > 0) {
    const tail = ctx.history.slice(-maxMessages);
    lines.push("");
    lines.push(`**Recent messages (oldest → newest, last ${tail.length}):**`);
    for (const m of tail) {
      const text = m.text.length > 300 ? m.text.slice(0, 300) + "…" : m.text;
      lines.push(`- _${m.authorLabel}:_ ${text.replace(/\s+/g, " ")}`);
    }
  }

  return lines.join("\n").trim();
}

// ─── Internals ────────────────────────────────────────────────────────────────

function emptyContext(): ChannelContext {
  return { channel: null, asker: null, history: [], userIndex: new Map() };
}

function authorLabelFor(msg: SlackHistoryMessage, userIndex: Map<string, SlackUserInfo>): string {
  if (msg.botId) return "bot";
  if (!msg.user) return "unknown";
  const u = userIndex.get(msg.user);
  return u?.displayName || u?.realName || u?.name || msg.user;
}

async function slackGet<T>(
  method: string,
  params: Record<string, string | number | undefined>,
  token:  string,
): Promise<T | null> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }

  try {
    const res = await fetch(`${SLACK_API}/${method}?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      logger.warn("slack-context: HTTP error", { method, status: res.status });
      return null;
    }
    const data = (await res.json()) as { ok: boolean; error?: string } & Record<string, unknown>;
    if (!data.ok) {
      logger.warn("slack-context: API error", { method, error: data.error });
      return null;
    }
    return data as unknown as T;
  } catch (err) {
    logger.warn("slack-context: fetch failed", { method, error: String(err) });
    return null;
  }
}

async function fetchChannelInfo(channel: string, token: string): Promise<SlackChannelInfo | null> {
  type Response = {
    channel: {
      id:       string;
      name?:    string;
      is_im?:   boolean;
      purpose?: { value?: string };
      topic?:   { value?: string };
    };
  };

  const data = await slackGet<Response>("conversations.info", { channel }, token);
  if (!data) return null;
  const c = data.channel;
  return {
    id:      c.id,
    name:    c.name,
    purpose: c.purpose?.value || undefined,
    topic:   c.topic?.value   || undefined,
    isIm:    Boolean(c.is_im),
  };
}

async function fetchUserInfo(user: string, token: string): Promise<SlackUserInfo | null> {
  type Response = {
    user: {
      id:       string;
      name?:    string;
      real_name?: string;
      is_bot?:  boolean;
      profile?: { display_name?: string; real_name?: string };
    };
  };

  const data = await slackGet<Response>("users.info", { user }, token);
  if (!data) return null;
  const u = data.user;
  return {
    id:          u.id,
    name:        u.name,
    realName:    u.profile?.real_name || u.real_name,
    displayName: u.profile?.display_name || undefined,
    isBot:       Boolean(u.is_bot),
  };
}

async function fetchChannelHistory(
  channel: string,
  token:   string,
  limit:   number,
): Promise<SlackHistoryMessage[]> {
  type Response = { messages: RawMessage[] };
  const data = await slackGet<Response>("conversations.history", { channel, limit }, token);
  return data ? data.messages.map(normalizeMessage) : [];
}

async function fetchThreadReplies(
  channel: string,
  threadTs: string,
  token:   string,
  limit:   number,
): Promise<SlackHistoryMessage[]> {
  type Response = { messages: RawMessage[] };
  const data = await slackGet<Response>(
    "conversations.replies",
    { channel, ts: threadTs, limit },
    token,
  );
  return data ? data.messages.map(normalizeMessage) : [];
}

interface RawMessage {
  ts:        string;
  user?:     string;
  text?:     string;
  thread_ts?: string;
  bot_id?:   string;
  app_id?:   string;
  subtype?:  string;
}

function normalizeMessage(m: RawMessage): SlackHistoryMessage {
  return {
    ts:       m.ts,
    user:     m.user,
    text:     m.text ?? "",
    threadTs: m.thread_ts,
    botId:    m.bot_id,
    appId:    m.app_id,
    subtype:  m.subtype,
  };
}
