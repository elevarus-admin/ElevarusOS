/**
 * Shared audit-log helper for Ask Elevarus data tools.
 *
 * Every invocation of a data-access tool (supabase_query, describe_schema,
 * ringba_live_query, etc.) writes one row to the `ask_elevarus_queries`
 * table. Failures never block the tool response — a failed insert logs a
 * warn and the tool's result still reaches Claude.
 */

import { getSupabaseClient } from "./supabase-client";
import { logger }            from "./logger";
import type { QAToolContext } from "./qa-tools";

export interface AuditRow {
  tool_name:         string;
  params:            unknown;
  status:            "ok" | "capped" | "error";
  row_count?:        number;
  total_available?:  number;
  elapsed_ms?:       number;
  error_message?:    string;
}

export async function auditQueryTool(
  ctx: QAToolContext,
  row: AuditRow,
): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from("ask_elevarus_queries").insert({
      tool_name:        row.tool_name,
      params:           row.params ?? {},
      status:           row.status,
      row_count:        row.row_count        ?? null,
      total_available:  row.total_available  ?? null,
      elapsed_ms:       row.elapsed_ms       ?? null,
      error_message:    row.error_message    ?? null,
      slack_user_id:    ctx.slack?.userId    ?? null,
      slack_channel_id: ctx.slack?.channelId ?? null,
      trace_id:         ctx.slack?.traceId   ?? null,
    });
    if (error) {
      logger.warn("audit-log: insert failed", { tool: row.tool_name, error: error.message });
    }
  } catch (err) {
    logger.warn("audit-log: insert threw", { tool: row.tool_name, error: String(err) });
  }
}
