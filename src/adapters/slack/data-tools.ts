/**
 * Data-access tools for the Ask Elevarus Slack bot.
 *
 * Adds the following Q&A tools alongside the existing knowledge-tools in
 * src/core/qa-tools.ts:
 *
 *   - supabase_query          — parametric SELECT against whitelisted tables
 *   - describe_schema         — introspect column names + descriptions
 *   - list_ringba_publishers  — helper lookup (cached 5 min)
 *   - list_ringba_campaigns   — helper lookup
 *   - list_lp_campaigns       — helper lookup
 *
 * Every tool execution is audited to the `ask_elevarus_queries` table.
 * Audit writes never block the tool response — a failed insert logs a warn
 * and returns the original result to Claude.
 */

import { getSupabaseClient } from "../../core/supabase-client";
import { auditQueryTool }    from "../../core/audit-log";
import {
  executeSupabaseQuery,
  DEFAULT_LIMIT,
  HARD_CEILING,
  QueryValidationError,
  type SupabaseQueryInput,
} from "../../core/query-builder";
import {
  getAnnotatedSchema,
  listWhitelistedTables,
} from "../../core/schema-annotations";
import type { QATool } from "../../core/qa-tools";

// ─── supabase_query ───────────────────────────────────────────────────────────

const supabaseQueryTool: QATool = {
  spec: {
    name: "supabase_query",
    description:
      "Run a parametric SELECT against whitelisted Supabase tables (ringba_calls, ringba_campaigns, lp_leads, lp_campaigns, jobs, instances, job_stages_view, etc.). Use filters (eq, neq, gt, gte, lt, lte, in, not_in, like, ilike, is_null, not_null) and optional aggregations (sum, count, avg, min, max) with groupBy + orderBy. Default row cap is 2000; for larger result sets, narrow your filter or request an expansion. Call describe_schema first if you are unsure about columns.",
    input_schema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          description:
            "Table or view name. Use describe_schema to list available tables if you don't know.",
        },
        select: {
          type: "array",
          items: { type: "string" },
          description:
            "Columns to return. Omit to get all non-heavy columns. Required column names must exist in describe_schema output.",
        },
        filters: {
          type: "array",
          description:
            "List of { column, op, value } filters. Ops: eq, neq, gt, gte, lt, lte, in, not_in, like, ilike, is_null, not_null, jsonb_contains. Omit `value` for is_null/not_null. Use jsonb_contains with an object value for JSONB columns like `tag_values` — e.g. { column: 'tag_values', op: 'jsonb_contains', value: { 'User:utm_campaign': 'spring_hvac' } } matches calls whose tag_values contains that key/value pair.",
          items: {
            type: "object",
            properties: {
              column: { type: "string" },
              op:     { type: "string" },
              value:  {},
            },
            required: ["column", "op"],
          },
        },
        groupBy: {
          type: "array",
          items: { type: "string" },
          description:
            "Columns to GROUP BY when aggregations are specified. Ignored without aggregations.",
        },
        aggregations: {
          type: "array",
          description:
            "List of aggregations { fn, column, alias? }. fn: sum, count, avg, min, max. For count over all rows, pass column='*'.",
          items: {
            type: "object",
            properties: {
              fn:     { type: "string" },
              column: { type: "string" },
              alias:  { type: "string" },
            },
            required: ["fn", "column"],
          },
        },
        orderBy: {
          type: "array",
          description: "List of { column, direction? } — direction is 'asc' or 'desc' (default asc). Can reference an aggregation alias.",
          items: {
            type: "object",
            properties: {
              column:    { type: "string" },
              direction: { type: "string" },
            },
            required: ["column"],
          },
        },
        limit: {
          type: "integer",
          description: `Max rows to return. Default ${DEFAULT_LIMIT}, hard ceiling ${HARD_CEILING}.`,
        },
      },
      required: ["table"],
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const params    = input as SupabaseQueryInput;

    try {
      const result = await executeSupabaseQuery(params);

      await auditQueryTool(ctx, {
        tool_name:       "supabase_query",
        params,
        status:          result.truncated ? "capped" : "ok",
        row_count:       result.row_count,
        total_available: result.total_available,
        elapsed_ms:      result.elapsed_ms,
      });

      return result;
    } catch (err) {
      const elapsed_ms = Date.now() - startedAt;
      const message    = err instanceof QueryValidationError
        ? `${err.message}${err.hint ? ` — ${err.hint}` : ""}`
        : String(err);

      await auditQueryTool(ctx, {
        tool_name:     "supabase_query",
        params,
        status:        "error",
        elapsed_ms,
        error_message: message,
      });

      return {
        error: message,
        hint:  err instanceof QueryValidationError ? err.hint : undefined,
      };
    }
  },
};

// ─── describe_schema ──────────────────────────────────────────────────────────

const describeSchemaTool: QATool = {
  spec: {
    name: "describe_schema",
    description:
      "Introspect the Supabase schema available to supabase_query. Returns each table's description and columns (with human descriptions + optional type hints). Call this BEFORE supabase_query when you're unsure about exact column names or what a table contains.",
    input_schema: {
      type: "object",
      properties: {
        tables: {
          type: "array",
          items: { type: "string" },
          description:
            "Specific tables to describe. Omit to list all whitelisted tables with a short description each.",
        },
      },
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const { tables } = (input as { tables?: string[] } | null) ?? {};
    const schema = getAnnotatedSchema();

    try {
      let result: unknown;
      if (!tables || tables.length === 0) {
        result = Object.entries(schema).map(([name, t]) => ({
          name,
          description: t.description,
          column_count: Object.keys(t.columns).length,
        }));
      } else {
        result = tables.map((name) => {
          const t = schema[name];
          if (!t) {
            return {
              name,
              error: `Unknown table "${name}". Whitelisted: ${listWhitelistedTables().join(", ")}`,
            };
          }
          return {
            name,
            description: t.description,
            columns: Object.entries(t.columns).map(([col, meta]) => ({
              name:        col,
              description: meta.description,
              type:        meta.type ?? null,
            })),
          };
        });
      }

      await auditQueryTool(ctx, {
        tool_name:  "describe_schema",
        params:     { tables },
        status:     "ok",
        elapsed_ms: Date.now() - startedAt,
      });

      return result;
    } catch (err) {
      await auditQueryTool(ctx, {
        tool_name:     "describe_schema",
        params:        { tables },
        status:        "error",
        elapsed_ms:    Date.now() - startedAt,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

// ─── Helper lookups ───────────────────────────────────────────────────────────

/** Small in-memory cache shared by helper tools. */
const helperCache = new Map<string, { value: unknown; expiresAt: number }>();
const HELPER_TTL_MS = 5 * 60 * 1000;

function cacheGet<T>(key: string): T | undefined {
  const hit = helperCache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt < Date.now()) {
    helperCache.delete(key);
    return undefined;
  }
  return hit.value as T;
}

function cacheSet(key: string, value: unknown): void {
  helperCache.set(key, { value, expiresAt: Date.now() + HELPER_TTL_MS });
}

const listRingbaPublishersTool: QATool = {
  spec: {
    name: "list_ringba_publishers",
    description:
      "List distinct publisher_name values seen in ringba_calls over the last 90 days. Use this to resolve fuzzy user references like 'the CHP publisher' to the exact string stored in the database. Cached 5 minutes.",
    input_schema: { type: "object", properties: {} },
  },
  async execute(_input, ctx) {
    const startedAt = Date.now();
    const cacheKey = "ringba_publishers";
    try {
      const cached = cacheGet<string[]>(cacheKey);
      if (cached) {
        await auditQueryTool(ctx, {
          tool_name:  "list_ringba_publishers",
          params:     {},
          status:     "ok",
          row_count:  cached.length,
          elapsed_ms: Date.now() - startedAt,
        });
        return { publishers: cached, cached: true };
      }

      const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from("ringba_calls")
        .select("publisher_name")
        .gte("call_dt", since)
        .not("publisher_name", "is", null)
        .limit(10_000);
      if (error) throw new Error(error.message);

      const seen = new Set<string>();
      for (const row of (data ?? []) as Array<{ publisher_name: string }>) {
        if (row.publisher_name) seen.add(row.publisher_name);
      }
      const publishers = [...seen].sort();
      cacheSet(cacheKey, publishers);

      await auditQueryTool(ctx, {
        tool_name:  "list_ringba_publishers",
        params:     {},
        status:     "ok",
        row_count:  publishers.length,
        elapsed_ms: Date.now() - startedAt,
      });

      return { publishers, cached: false };
    } catch (err) {
      await auditQueryTool(ctx, {
        tool_name:     "list_ringba_publishers",
        params:        {},
        status:        "error",
        elapsed_ms:    Date.now() - startedAt,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

const listRingbaCampaignsTool: QATool = {
  spec: {
    name: "list_ringba_campaigns",
    description:
      "List every Ringba campaign (id + name + enabled flag) from ringba_campaigns. Helps disambiguate user references like 'the U65 campaign'.",
    input_schema: {
      type: "object",
      properties: {
        includeDisabled: {
          type: "boolean",
          description: "Set true to include campaigns with enabled=false.",
        },
      },
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const { includeDisabled } = (input as { includeDisabled?: boolean } | null) ?? {};
    try {
      const supabase = getSupabaseClient();
      let query = supabase.from("ringba_campaigns").select("id,name,enabled");
      if (!includeDisabled) query = query.eq("enabled", true);
      const { data, error } = await query.order("name", { ascending: true }).limit(1000);
      if (error) throw new Error(error.message);

      await auditQueryTool(ctx, {
        tool_name:  "list_ringba_campaigns",
        params:     { includeDisabled },
        status:     "ok",
        row_count:  (data ?? []).length,
        elapsed_ms: Date.now() - startedAt,
      });

      return { campaigns: data ?? [] };
    } catch (err) {
      await auditQueryTool(ctx, {
        tool_name:     "list_ringba_campaigns",
        params:        { includeDisabled },
        status:        "error",
        elapsed_ms:    Date.now() - startedAt,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

const listRingbaTagsTool: QATool = {
  spec: {
    name: "list_ringba_tags",
    description:
      "List the distinct tag keys actually present on Ringba calls over the last 90 days, with occurrence counts and a sample value. Use this BEFORE building a tag query so you pick the right key — the account's /tags endpoint lists all *defined* tags, but this tool shows which ones are *populated*. Keys are in the form 'TagType:TagName' (e.g. 'User:utm_campaign', 'Geo:Country'). Pair with `supabase_query` + `jsonb_contains` to filter calls by a tag value. Cached 5 min.",
    input_schema: {
      type: "object",
      properties: {
        tagTypePrefix: {
          type: "string",
          description:
            "Optional filter — return only tag keys starting with this type. e.g. 'User' returns only custom user-defined tags (utm_*, etc.). Case-sensitive.",
        },
      },
    },
  },
  async execute(input, ctx) {
    const startedAt = Date.now();
    const { tagTypePrefix } = (input as { tagTypePrefix?: string } | null) ?? {};
    const cacheKey = `ringba_tag_keys:${tagTypePrefix ?? ""}`;

    try {
      const cached = cacheGet<Array<{ key: string; count: number; sample: string }>>(cacheKey);
      if (cached) {
        await auditQueryTool(ctx, {
          tool_name:  "list_ringba_tags",
          params:     { tagTypePrefix },
          status:     "ok",
          row_count:  cached.length,
          elapsed_ms: Date.now() - startedAt,
        });
        return { tag_keys: cached, cached: true };
      }

      const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const supabase = getSupabaseClient();
      // Pull a recent slice of tag_values JSONB — client-side aggregation keeps
      // this simple (no RPC needed). 5000 rows is plenty to see what tag keys
      // are populated on the account.
      const { data, error } = await supabase
        .from("ringba_calls")
        .select("tag_values")
        .gte("call_dt", since)
        .neq("tag_values", "{}")
        .limit(5000);
      if (error) throw new Error(error.message);

      const counts   = new Map<string, number>();
      const samples  = new Map<string, string>();
      for (const row of (data ?? []) as Array<{ tag_values: Record<string, string> | null }>) {
        const tv = row.tag_values;
        if (!tv || typeof tv !== "object") continue;
        for (const [k, v] of Object.entries(tv)) {
          if (tagTypePrefix && !k.startsWith(`${tagTypePrefix}:`)) continue;
          counts.set(k, (counts.get(k) ?? 0) + 1);
          if (!samples.has(k) && typeof v === "string" && v.length > 0) {
            samples.set(k, v.length > 80 ? v.slice(0, 80) + "…" : v);
          }
        }
      }

      const tagKeys = [...counts.entries()]
        .map(([key, count]) => ({ key, count, sample: samples.get(key) ?? "" }))
        .sort((a, b) => b.count - a.count);

      cacheSet(cacheKey, tagKeys);

      await auditQueryTool(ctx, {
        tool_name:  "list_ringba_tags",
        params:     { tagTypePrefix },
        status:     "ok",
        row_count:  tagKeys.length,
        elapsed_ms: Date.now() - startedAt,
      });

      return {
        tag_keys:          tagKeys,
        scanned_row_count: (data ?? []).length,
        window:            { since_days: 90 },
        cached:            false,
      };
    } catch (err) {
      await auditQueryTool(ctx, {
        tool_name:     "list_ringba_tags",
        params:        { tagTypePrefix },
        status:        "error",
        elapsed_ms:    Date.now() - startedAt,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

const listLpCampaignsTool: QATool = {
  spec: {
    name: "list_lp_campaigns",
    description:
      "List every LeadsProsper campaign (id + name) from lp_campaigns. Helps disambiguate campaign references.",
    input_schema: { type: "object", properties: {} },
  },
  async execute(_input, ctx) {
    const startedAt = Date.now();
    try {
      const supabase = getSupabaseClient();
      const { data, error } = await supabase
        .from("lp_campaigns")
        .select("id,name")
        .order("name", { ascending: true })
        .limit(1000);
      if (error) throw new Error(error.message);

      await auditQueryTool(ctx, {
        tool_name:  "list_lp_campaigns",
        params:     {},
        status:     "ok",
        row_count:  (data ?? []).length,
        elapsed_ms: Date.now() - startedAt,
      });

      return { campaigns: data ?? [] };
    } catch (err) {
      await auditQueryTool(ctx, {
        tool_name:     "list_lp_campaigns",
        params:        {},
        status:        "error",
        elapsed_ms:    Date.now() - startedAt,
        error_message: String(err),
      });
      return { error: String(err) };
    }
  },
};

// ─── Export ───────────────────────────────────────────────────────────────────

/** Tool set contributed by the Slack adapter to the Q&A runtime. */
export const DATA_TOOLS: QATool[] = [
  supabaseQueryTool,
  describeSchemaTool,
  listRingbaPublishersTool,
  listRingbaCampaignsTool,
  listRingbaTagsTool,
  listLpCampaignsTool,
];
