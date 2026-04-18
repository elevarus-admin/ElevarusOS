/**
 * Schema annotations loader.
 *
 * Reads `data/schema-annotations.json` (core ElevarusOS tables) and merges it
 * with every integration-contributed table block (ringba_calls, lp_leads,
 * etc.) from the integration registry. Result is the single source of truth
 * for:
 *
 *   - the supabase_query whitelist (which tables/columns Claude may query)
 *   - describe_schema output
 *   - system-prompt "## Schema" hints
 */

import * as fs   from "fs";
import * as path from "path";
import {
  getIntegrationTables,
  type IntegrationColumnEntry,
  type IntegrationTable,
} from "./integration-registry";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnnotatedColumn {
  description: string;
  type?:       string;
}

export interface AnnotatedTable {
  description: string;
  columns:     Record<string, AnnotatedColumn>;
}

type CoreAnnotationsFile = Record<string, AnnotatedTable | { description?: string }>;

// ─── Loading ──────────────────────────────────────────────────────────────────

const ANNOTATIONS_PATH = path.resolve(__dirname, "../../data/schema-annotations.json");

let _cache: Record<string, AnnotatedTable> | null = null;

/** Reset the cache (test-only). */
export function resetSchemaAnnotationsCache(): void {
  _cache = null;
}

/**
 * Full annotated schema — core tables + every integration-contributed table.
 * Cached after first call. Restart required to pick up edits.
 */
export function getAnnotatedSchema(): Record<string, AnnotatedTable> {
  if (_cache) return _cache;

  const merged: Record<string, AnnotatedTable> = {};

  // Core tables from JSON
  const raw = readCoreAnnotationsFile();
  for (const [table, block] of Object.entries(raw)) {
    if (table.startsWith("_")) continue;          // `_meta` etc.
    if (!isAnnotatedTable(block)) continue;
    merged[table] = normaliseTable(block);
  }

  // Integration tables from registry
  const integrationTables = getIntegrationTables();
  for (const [name, table] of Object.entries(integrationTables)) {
    merged[name] = normaliseIntegrationTable(table);
  }

  _cache = merged;
  return merged;
}

/** All tables Claude may query (whitelist for supabase_query). */
export function listWhitelistedTables(): string[] {
  return Object.keys(getAnnotatedSchema()).sort();
}

/** True when (table, column) pair is in the whitelist. */
export function isColumnWhitelisted(table: string, column: string): boolean {
  const t = getAnnotatedSchema()[table];
  if (!t) return false;
  if (column === "*") return true;
  return Object.prototype.hasOwnProperty.call(t.columns, column);
}

/** Returns the list of column names for one table (or [] if unknown). */
export function listTableColumns(table: string): string[] {
  const t = getAnnotatedSchema()[table];
  return t ? Object.keys(t.columns) : [];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readCoreAnnotationsFile(): CoreAnnotationsFile {
  try {
    const raw = fs.readFileSync(ANNOTATIONS_PATH, "utf8");
    return JSON.parse(raw) as CoreAnnotationsFile;
  } catch (err) {
    // Fail loud — the annotations are load-bearing.
    throw new Error(
      `schema-annotations: failed to read ${ANNOTATIONS_PATH}: ${String(err)}`
    );
  }
}

function isAnnotatedTable(block: unknown): block is AnnotatedTable {
  return (
    typeof block === "object" &&
    block !== null &&
    typeof (block as AnnotatedTable).description === "string" &&
    typeof (block as AnnotatedTable).columns === "object" &&
    (block as AnnotatedTable).columns !== null
  );
}

function normaliseTable(block: AnnotatedTable): AnnotatedTable {
  const columns: Record<string, AnnotatedColumn> = {};
  for (const [name, entry] of Object.entries(block.columns)) {
    columns[name] = normaliseColumn(entry as unknown as IntegrationColumnEntry);
  }
  return { description: block.description, columns };
}

function normaliseIntegrationTable(t: IntegrationTable): AnnotatedTable {
  const columns: Record<string, AnnotatedColumn> = {};
  for (const [name, entry] of Object.entries(t.columns)) {
    columns[name] = normaliseColumn(entry);
  }
  return { description: t.description, columns };
}

function normaliseColumn(entry: IntegrationColumnEntry | AnnotatedColumn): AnnotatedColumn {
  if (typeof entry === "string") return { description: entry };
  // Already object-shaped (IntegrationColumn or AnnotatedColumn).
  return {
    description: (entry as AnnotatedColumn).description,
    type:        (entry as AnnotatedColumn).type,
  };
}
