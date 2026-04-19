/**
 * Parametric Supabase query builder for the Ask Elevarus bot.
 *
 * Claude gives us a structured shape (table + filters + select + groupBy +
 * aggregations + orderBy + limit). We validate every piece against the merged
 * schema annotations (core + integration manifests) and compose the query via
 * the Supabase JS client — no raw SQL, no string concatenation, no injection
 * surface.
 *
 * Overflow flow (configurable caps in DEFAULT_LIMIT / HARD_CEILING):
 *   1. Run a HEAD count query with the same filters.
 *   2. If total_available <= limit, fetch rows normally.
 *   3. If total_available > limit, fetch `limit` rows and set truncated=true.
 *      Caller surfaces the expansion prompt to the user.
 */

import { getSupabaseClient } from "./supabase-client";
import { logger }            from "./logger";
import {
  getAnnotatedSchema,
  isColumnWhitelisted,
  listTableColumns,
  listWhitelistedTables,
} from "./schema-annotations";

// ─── Types ────────────────────────────────────────────────────────────────────

export type FilterOp =
  | "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
  | "in" | "not_in"
  | "like" | "ilike"
  | "is_null" | "not_null"
  | "jsonb_contains";

export interface QueryFilter {
  column: string;
  op:     FilterOp;
  /** Not required for is_null / not_null. */
  value?: string | number | boolean | null | Array<string | number | boolean>;
}

export type AggregationFn = "sum" | "count" | "avg" | "min" | "max";

export interface QueryAggregation {
  fn:      AggregationFn;
  column:  string;           // use "*" with fn=count for total count
  alias?:  string;
}

export interface QueryOrderBy {
  column:    string;
  direction?: "asc" | "desc";
}

export interface SupabaseQueryInput {
  table:         string;
  select?:       string[];                  // required when no aggregations
  filters?:      QueryFilter[];
  groupBy?:      string[];
  aggregations?: QueryAggregation[];
  orderBy?:      QueryOrderBy[];
  limit?:        number;
}

export interface SupabaseQueryResult {
  rows:             Record<string, unknown>[];
  row_count:        number;
  total_available:  number;
  truncated:        boolean;
  elapsed_ms:       number;
  /** List of column names the query actually returned (helpful when aggregating). */
  columns:          string[];
  /** When truncated, the same input the caller can re-run with expanded=true. */
  expand_hint?:     string;
}

// ─── Caps ─────────────────────────────────────────────────────────────────────

export const DEFAULT_LIMIT = 2000;
export const HARD_CEILING  = 10_000;

// Columns that always inflate response size — dropped from select unless explicitly asked.
const HEAVY_DEFAULT_EXCLUDES = new Set([
  "raw",
  "routing_attempts",
  "lead_data",
  "buyers",
]);

const ALLOWED_OPS = new Set<FilterOp>([
  "eq", "neq", "gt", "gte", "lt", "lte",
  "in", "not_in",
  "like", "ilike",
  "is_null", "not_null",
  "jsonb_contains",
]);

const ALLOWED_AGG_FNS = new Set<AggregationFn>(["sum", "count", "avg", "min", "max"]);

// ─── Validation ───────────────────────────────────────────────────────────────

export class QueryValidationError extends Error {
  constructor(message: string, public readonly hint?: string) {
    super(message);
    this.name = "QueryValidationError";
  }
}

function assertTableWhitelisted(table: string): void {
  if (!getAnnotatedSchema()[table]) {
    throw new QueryValidationError(
      `Unknown or unwhitelisted table: "${table}"`,
      `Whitelisted tables: ${listWhitelistedTables().join(", ")}`,
    );
  }
}

function assertColumnWhitelisted(table: string, column: string, context: string): void {
  if (column === "*") return;
  if (!isColumnWhitelisted(table, column)) {
    const cols = listTableColumns(table);
    const close = cols
      .filter((c) => c.includes(column) || column.includes(c))
      .slice(0, 5);
    throw new QueryValidationError(
      `Unknown column "${column}" on table "${table}" (${context}).`,
      close.length > 0
        ? `Closest matches: ${close.join(", ")}`
        : `Available columns: ${cols.slice(0, 20).join(", ")}${cols.length > 20 ? ", ..." : ""}`,
    );
  }
}

function validateInput(input: SupabaseQueryInput): Required<Pick<SupabaseQueryInput, "limit">> & SupabaseQueryInput {
  if (!input || typeof input !== "object") {
    throw new QueryValidationError("Query input must be an object.");
  }
  if (!input.table || typeof input.table !== "string") {
    throw new QueryValidationError("Query input must include `table`.");
  }
  assertTableWhitelisted(input.table);

  // Filters
  for (const f of input.filters ?? []) {
    if (!ALLOWED_OPS.has(f.op)) {
      throw new QueryValidationError(
        `Unsupported filter op: "${f.op}"`,
        `Allowed: ${[...ALLOWED_OPS].join(", ")}`,
      );
    }
    assertColumnWhitelisted(input.table, f.column, `filter`);
  }

  // Select
  for (const c of input.select ?? []) {
    assertColumnWhitelisted(input.table, c, "select");
  }

  // groupBy
  for (const c of input.groupBy ?? []) {
    assertColumnWhitelisted(input.table, c, "groupBy");
  }

  // Aggregations
  for (const a of input.aggregations ?? []) {
    if (!ALLOWED_AGG_FNS.has(a.fn)) {
      throw new QueryValidationError(
        `Unsupported aggregation fn: "${a.fn}"`,
        `Allowed: ${[...ALLOWED_AGG_FNS].join(", ")}`,
      );
    }
    if (a.fn === "count" && a.column === "*") continue;
    assertColumnWhitelisted(input.table, a.column, `aggregation ${a.fn}`);
  }

  // orderBy
  for (const o of input.orderBy ?? []) {
    if (o.direction && o.direction !== "asc" && o.direction !== "desc") {
      throw new QueryValidationError(
        `Unsupported orderBy direction: "${o.direction}". Use "asc" or "desc".`,
      );
    }
    // orderBy against an aggregation alias is valid (alias may not be a real column)
    const aliases = new Set((input.aggregations ?? []).map((a) => a.alias).filter(Boolean) as string[]);
    if (!aliases.has(o.column)) {
      assertColumnWhitelisted(input.table, o.column, "orderBy");
    }
  }

  // Limit
  const requested = input.limit ?? DEFAULT_LIMIT;
  if (typeof requested !== "number" || requested <= 0) {
    throw new QueryValidationError("`limit` must be a positive integer.");
  }
  const limit = Math.min(requested, HARD_CEILING);

  return { ...input, limit };
}

// ─── Query composition ───────────────────────────────────────────────────────

/**
 * Compose the PostgREST select string for a supabase_query call.
 *
 * Raw column list  → "col1,col2,col3"
 * With aggregation → "col1,col2,col3.sum(),count()"   (PostgREST groups by the
 *                    non-aggregated columns automatically)
 *
 * When neither select nor aggregations are provided, we expand to every
 * column in the table minus heavy JSONB defaults.
 */
function buildSelectString(input: SupabaseQueryInput): { selectStr: string; returnedColumns: string[] } {
  const hasAggs = (input.aggregations ?? []).length > 0;

  if (hasAggs) {
    const groupCols = input.groupBy ?? [];
    const aggParts  = (input.aggregations ?? []).map((a) => {
      const column = a.column === "*" ? undefined : a.column;
      const fn     = a.fn;
      // PostgREST agg syntax:
      //   col.sum()           → sum of col
      //   col.sum(alias)?     → aliasing via rename is different; we use alias:col.sum()
      //   count()             → count(*)
      const expr =
        a.fn === "count" && !column
          ? "count()"
          : `${column}.${fn}()`;
      return a.alias ? `${a.alias}:${expr}` : expr;
    });
    const parts = [...groupCols, ...aggParts];
    const returnedColumns = [...groupCols, ...aggParts.map((p) => {
      const colon = p.indexOf(":");
      return colon >= 0 ? p.slice(0, colon) : p.replace(/\..*$/, "");
    })];
    return { selectStr: parts.join(","), returnedColumns };
  }

  if (input.select && input.select.length > 0) {
    return { selectStr: input.select.join(","), returnedColumns: input.select.slice() };
  }

  // No select specified — expand to all columns minus heavy JSONB defaults.
  const allCols = listTableColumns(input.table);
  const defaulted = allCols.filter((c) => !HEAVY_DEFAULT_EXCLUDES.has(c));
  return { selectStr: defaulted.join(","), returnedColumns: defaulted };
}

/** Apply a single filter to a PostgREST builder. */
function applyFilter(builder: SupabaseFilterBuilder, f: QueryFilter): SupabaseFilterBuilder {
  switch (f.op) {
    case "eq":        return builder.eq(f.column, f.value as never);
    case "neq":       return builder.neq(f.column, f.value as never);
    case "gt":        return builder.gt(f.column, f.value as never);
    case "gte":       return builder.gte(f.column, f.value as never);
    case "lt":        return builder.lt(f.column, f.value as never);
    case "lte":       return builder.lte(f.column, f.value as never);
    case "like":      return builder.like(f.column, String(f.value));
    case "ilike":     return builder.ilike(f.column, String(f.value));
    case "in":        return builder.in(f.column, (f.value as Array<string | number | boolean>) ?? []);
    case "not_in":    return builder.not(f.column, "in", `(${formatList(f.value)})`);
    case "is_null":   return builder.is(f.column, null);
    case "not_null":  return builder.not(f.column, "is", null);
    case "jsonb_contains": {
      if (typeof f.value !== "object" || f.value === null || Array.isArray(f.value)) {
        throw new QueryValidationError(
          `jsonb_contains requires an object value (got ${typeof f.value}).`,
          `Example: { column: "tag_values", op: "jsonb_contains", value: { "User:utm_campaign": "spring_hvac" } }`,
        );
      }
      return builder.contains(f.column, f.value as Record<string, unknown>);
    }
    default:
      throw new QueryValidationError(`Unsupported filter op: "${(f as QueryFilter).op}"`);
  }
}

function formatList(v: unknown): string {
  if (!Array.isArray(v)) return "";
  return v.map((x) => {
    if (typeof x === "string") return `"${x.replace(/"/g, '\\"')}"`;
    return String(x);
  }).join(",");
}

// PostgREST builder type — use a narrow interface to avoid leaking @supabase/supabase-js shape.
interface SupabaseFilterBuilder {
  eq(col: string, v: never):           SupabaseFilterBuilder;
  neq(col: string, v: never):          SupabaseFilterBuilder;
  gt(col: string, v: never):           SupabaseFilterBuilder;
  gte(col: string, v: never):          SupabaseFilterBuilder;
  lt(col: string, v: never):           SupabaseFilterBuilder;
  lte(col: string, v: never):          SupabaseFilterBuilder;
  like(col: string, v: string):        SupabaseFilterBuilder;
  ilike(col: string, v: string):       SupabaseFilterBuilder;
  in(col: string, v: Array<string | number | boolean>): SupabaseFilterBuilder;
  is(col: string, v: null):            SupabaseFilterBuilder;
  not(col: string, op: string, v: unknown): SupabaseFilterBuilder;
  contains(col: string, v: Record<string, unknown>): SupabaseFilterBuilder;
  order(col: string, opts: { ascending: boolean }): SupabaseFilterBuilder;
  limit(n: number):                    SupabaseFilterBuilder;
}

// ─── Execution ────────────────────────────────────────────────────────────────

export async function executeSupabaseQuery(
  rawInput: SupabaseQueryInput,
): Promise<SupabaseQueryResult> {
  const startedAt = Date.now();
  const input     = validateInput(rawInput);

  const { selectStr, returnedColumns } = buildSelectString(input);

  const supabase = getSupabaseClient();
  const hasAggs  = (input.aggregations ?? []).length > 0;

  // ── Step 1: COUNT query (HEAD). Not meaningful for aggregation-group queries
  //    because the server collapses rows; in that case we fetch the group set
  //    and treat total_available == row_count.
  let totalAvailable: number;
  if (!hasAggs) {
    let countBuilder = supabase
      .from(input.table)
      .select("*", { count: "exact", head: true }) as unknown as SupabaseFilterBuilder;
    for (const f of input.filters ?? []) {
      countBuilder = applyFilter(countBuilder, f);
    }
    const countResp = await (countBuilder as unknown as Promise<{
      count: number | null;
      error: { message: string } | null;
    }>);
    if (countResp.error) {
      throw new Error(`count query failed: ${countResp.error.message}`);
    }
    totalAvailable = countResp.count ?? 0;
  } else {
    totalAvailable = -1; // resolved after the fetch below
  }

  // ── Step 2: Actual SELECT (with cap)
  let builder = supabase
    .from(input.table)
    .select(selectStr) as unknown as SupabaseFilterBuilder;
  for (const f of input.filters ?? []) {
    builder = applyFilter(builder, f);
  }
  for (const o of input.orderBy ?? []) {
    builder = builder.order(o.column, { ascending: (o.direction ?? "asc") === "asc" });
  }
  builder = builder.limit(input.limit);

  const resp = await (builder as unknown as Promise<{
    data: Record<string, unknown>[] | null;
    error: { message: string } | null;
  }>);
  if (resp.error) {
    throw new Error(`select query failed: ${resp.error.message}`);
  }
  const rows = resp.data ?? [];

  if (hasAggs) {
    totalAvailable = rows.length;
  }

  const truncated = !hasAggs && totalAvailable > input.limit;

  const result: SupabaseQueryResult = {
    rows,
    row_count:       rows.length,
    total_available: totalAvailable,
    truncated,
    elapsed_ms:      Date.now() - startedAt,
    columns:         returnedColumns,
    ...(truncated
      ? { expand_hint: `Query matched ${totalAvailable} rows; showing first ${input.limit}. Ask user to narrow the filter or re-run with limit up to ${HARD_CEILING}.` }
      : {}),
  };

  logger.info("query-builder: supabase_query executed", {
    table:           input.table,
    rows:            result.row_count,
    total_available: result.total_available,
    truncated:       result.truncated,
    elapsed_ms:      result.elapsed_ms,
  });

  return result;
}
