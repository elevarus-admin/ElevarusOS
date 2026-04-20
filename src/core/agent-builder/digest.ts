/**
 * Agent Builder — weekly digest builder.
 *
 * Renders a Slack message summarizing the past 7 days of Agent Builder activity:
 *   - Tickets submitted (with ClickUp links)
 *   - Sessions still open + their progress
 *   - Sessions abandoned (idle sweep)
 *   - One-line summary stats
 *
 * Pure functions — no side effects, easy to unit test. The digest worker
 * (digest-worker.ts) wraps this with the cron + Slack post.
 */

import { getSupabaseClient } from "../supabase-client";
import { logger }            from "../logger";
import { CANONICAL_COUNT, READY_TO_FINALIZE_INDEX } from "./prompts";
import type { AgentBuilderSession } from "./types";

const TABLE         = "agent_builder_sessions";
const DIGEST_DAYS   = 7;

export interface DigestData {
  windowStart:      string;       // ISO
  windowEnd:        string;       // ISO
  submitted:        AgentBuilderSession[];
  abandoned:        AgentBuilderSession[];
  open:             AgentBuilderSession[];
  // Totals across all sessions ever — useful "lifetime" signal
  totalsAllTime: {
    submitted:      number;
    open:           number;
    abandoned:      number;
  };
}

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface RenderedDigest {
  text:   string;        // plain-text fallback
  blocks: SlackBlock[];  // rich Block Kit
}

// ─── Query ──────────────────────────────────────────────────────────────────

export async function buildDigestData(now: Date = new Date()): Promise<DigestData> {
  const supabase    = getSupabaseClient();
  const windowEnd   = now.toISOString();
  const windowStart = new Date(now.getTime() - DIGEST_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Submitted in window — completed tickets
  const { data: submittedRows, error: subErr } = await supabase
    .from(TABLE)
    .select("*")
    .eq("status", "submitted")
    .gte("updated_at", windowStart)
    .order("updated_at", { ascending: false });
  if (subErr) logger.warn("digest: submitted query failed", { error: subErr.message });

  // Abandoned in window — sweep result + manual abandons
  const { data: abandonedRows, error: abErr } = await supabase
    .from(TABLE)
    .select("*")
    .eq("status", "abandoned")
    .gte("updated_at", windowStart)
    .order("updated_at", { ascending: false });
  if (abErr) logger.warn("digest: abandoned query failed", { error: abErr.message });

  // Open (any age) — currently in-flight, sorted by activity
  const { data: openRows, error: openErr } = await supabase
    .from(TABLE)
    .select("*")
    .eq("status", "open")
    .order("updated_at", { ascending: false });
  if (openErr) logger.warn("digest: open query failed", { error: openErr.message });

  // Lifetime totals
  const [{ count: subAll }, { count: openAll }, { count: abAll }] = await Promise.all([
    supabase.from(TABLE).select("id", { count: "exact", head: true }).eq("status", "submitted"),
    supabase.from(TABLE).select("id", { count: "exact", head: true }).eq("status", "open"),
    supabase.from(TABLE).select("id", { count: "exact", head: true }).eq("status", "abandoned"),
  ]);

  return {
    windowStart,
    windowEnd,
    submitted: (submittedRows ?? []).map(rowToSession),
    abandoned: (abandonedRows ?? []).map(rowToSession),
    open:      (openRows      ?? []).map(rowToSession),
    totalsAllTime: {
      submitted: subAll  ?? 0,
      open:      openAll ?? 0,
      abandoned: abAll   ?? 0,
    },
  };
}

// ─── Render ─────────────────────────────────────────────────────────────────

export function renderDigest(data: DigestData): RenderedDigest {
  const blocks: SlackBlock[] = [];
  const textLines: string[] = [];

  const fmtDate = (iso: string): string =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      month: "short",
      day:   "numeric",
    }).format(new Date(iso));

  const startLabel = fmtDate(data.windowStart);
  const endLabel   = fmtDate(data.windowEnd);

  // Header
  const headerText = `🤖 *Agent Builder weekly digest*  ·  ${startLabel} – ${endLabel}`;
  blocks.push({
    type: "header",
    text: { type: "plain_text", text: `Agent Builder · ${startLabel} – ${endLabel}` },
  });
  textLines.push(headerText);

  // Summary line — fast read for skimmers
  const summary =
    `*${data.submitted.length}* submitted  ·  ` +
    `*${data.open.length}* open  ·  ` +
    `*${data.abandoned.length}* abandoned this week  ·  ` +
    `_(lifetime: ${data.totalsAllTime.submitted} submitted, ` +
    `${data.totalsAllTime.open} open, ` +
    `${data.totalsAllTime.abandoned} abandoned)_`;
  blocks.push({ type: "section", text: { type: "mrkdwn", text: summary } });
  textLines.push(stripMrkdwn(summary));

  // Empty-week early-out
  if (data.submitted.length === 0 && data.open.length === 0 && data.abandoned.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_No Agent Builder activity this week._" },
    });
    textLines.push("No Agent Builder activity this week.");
    return { text: textLines.join("\n"), blocks };
  }

  blocks.push({ type: "divider" });

  // Submitted (the wins)
  if (data.submitted.length > 0) {
    blocks.push(sectionMrkdwn(`*✅ Tickets created (${data.submitted.length})*`));
    const items = data.submitted.map(formatSubmittedLine).join("\n");
    blocks.push(sectionMrkdwn(items));
    textLines.push("", `Tickets created (${data.submitted.length}):`);
    data.submitted.forEach((s) => textLines.push("  - " + stripMrkdwn(formatSubmittedLine(s))));
  }

  // Open (the in-flight)
  if (data.open.length > 0) {
    blocks.push(sectionMrkdwn(`*🟡 Open sessions (${data.open.length})*`));
    const items = data.open.map(formatOpenLine).join("\n");
    blocks.push(sectionMrkdwn(items));
    textLines.push("", `Open sessions (${data.open.length}):`);
    data.open.forEach((s) => textLines.push("  - " + stripMrkdwn(formatOpenLine(s))));
  }

  // Abandoned (cleanup signal)
  if (data.abandoned.length > 0) {
    blocks.push(sectionMrkdwn(`*⚪ Abandoned (${data.abandoned.length})*`));
    const items = data.abandoned.map(formatAbandonedLine).join("\n");
    blocks.push(sectionMrkdwn(items));
    textLines.push("", `Abandoned (${data.abandoned.length}):`);
    data.abandoned.forEach((s) => textLines.push("  - " + stripMrkdwn(formatAbandonedLine(s))));
  }

  blocks.push({
    type:     "context",
    elements: [{
      type: "mrkdwn",
      text: `_Generated ${fmtDate(new Date().toISOString())} · See \`docs/prd-agent-builder.md\`._`,
    }],
  });

  return { text: textLines.join("\n"), blocks };
}

// ─── Per-session formatters ─────────────────────────────────────────────────

function formatSubmittedLine(s: AgentBuilderSession): string {
  const name = s.proposed_name ?? "(unnamed)";
  const url  = s.clickup_task_url ?? "";
  const by   = s.created_by ? ` · by \`${s.created_by}\`` : "";
  return `• <${url}|${name}>${by}`;
}

function formatOpenLine(s: AgentBuilderSession): string {
  const idx     = s.current_question_index;
  const progress =
    idx === 0 ? "not started" :
    idx === READY_TO_FINALIZE_INDEX ? "ready to finalize" :
    `Q${idx}/${CANONICAL_COUNT}`;
  const idle = humanRelativeTime(s.updated_at);
  const by   = s.created_by ? `\`${s.created_by}\`` : "(unknown)";
  const src  = s.source === "slack" ? "Slack" : "Dashboard";
  return `• ${by} — *${progress}* · ${src} · last activity ${idle}`;
}

function formatAbandonedLine(s: AgentBuilderSession): string {
  const idx     = s.current_question_index;
  const stoppedAt =
    idx === 0 ? "before Q1" :
    idx === READY_TO_FINALIZE_INDEX ? "ready to finalize (didn't submit)" :
    `at Q${idx}`;
  const by = s.created_by ? `\`${s.created_by}\`` : "(unknown)";
  return `• ${by} — stopped ${stoppedAt}`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function sectionMrkdwn(text: string): SlackBlock {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function stripMrkdwn(s: string): string {
  return s.replace(/\*([^*]+)\*/g, "$1").replace(/_([^_]+)_/g, "$1");
}

function humanRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 60)         return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24)          return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function rowToSession(row: Record<string, unknown>): AgentBuilderSession {
  return {
    id:                      String(row.id),
    source:                  row.source as AgentBuilderSession["source"],
    created_by:              (row.created_by as string | null) ?? null,
    slack_channel_id:        (row.slack_channel_id as string | null) ?? null,
    slack_thread_ts:         (row.slack_thread_ts  as string | null) ?? null,
    created_at:              String(row.created_at),
    updated_at:              String(row.updated_at),
    status:                  row.status as AgentBuilderSession["status"],
    current_question_index:  Number(row.current_question_index  ?? 0),
    adaptive_followup_count: Number(row.adaptive_followup_count ?? 0),
    transcript:              (row.transcript  as AgentBuilderSession["transcript"])  ?? [],
    attachments:             (row.attachments as AgentBuilderSession["attachments"]) ?? [],
    proposed_name:           (row.proposed_name   as string | null) ?? null,
    proposed_slug:           (row.proposed_slug   as string | null) ?? null,
    vertical_tag:            (row.vertical_tag    as string | null) ?? null,
    capability_tag:          (row.capability_tag  as string | null) ?? null,
    clickup_task_id:         (row.clickup_task_id  as string | null) ?? null,
    clickup_task_url:        (row.clickup_task_url as string | null) ?? null,
  };
}
