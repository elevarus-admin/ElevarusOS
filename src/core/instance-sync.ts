import { getSupabaseClient, isSupabaseConfigured } from "./supabase-client";
import { listInstanceIds, loadInstanceConfig, InstanceConfig } from "./instance-config";
import { logger } from "./logger";

/**
 * Syncs all bot instance configs from their instance.md files into the
 * Supabase `instances` table.
 *
 * Called once at startup so the dashboard and REST API can query instance
 * metadata from the DB rather than reading .md files on every request.
 *
 * Safe to call repeatedly — uses upsert so it is idempotent.
 */
export async function syncInstancesToSupabase(): Promise<void> {
  if (!isSupabaseConfigured()) return;

  const instanceIds = listInstanceIds(true); // include disabled
  if (instanceIds.length === 0) return;

  const rows = instanceIds.flatMap((id) => {
    try {
      const cfg = loadInstanceConfig(id);
      return [toRow(cfg)];
    } catch (err) {
      logger.warn("instance-sync: could not load config — skipping", {
        instanceId: id,
        error: String(err),
      });
      return [];
    }
  });

  const { error } = await getSupabaseClient()
    .from("instances")
    .upsert(rows, { onConflict: "id" });

  if (error) {
    logger.warn("instance-sync: upsert failed", { error: error.message });
    return;
  }

  logger.info("instance-sync: synced to Supabase", { count: rows.length });
}

function toRow(cfg: InstanceConfig) {
  return {
    id:            cfg.id,
    name:          cfg.name,
    base_workflow: cfg.baseWorkflow,
    enabled:       cfg.enabled,
    brand:         cfg.brand,
    notify:        cfg.notify,
    schedule:      cfg.schedule,
    synced_at:     new Date().toISOString(),
  };
}
