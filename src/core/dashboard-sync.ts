import { listInstanceIds, loadInstanceConfig } from "./instance-config";
import { logger } from "./logger";

/**
 * Syncs ElevarusOS bot instances to the Mission Control dashboard as agents.
 *
 * Called once at startup. Uses the /api/agents/register endpoint which is
 * idempotent — safe to call repeatedly. Each bot instance appears in the
 * Mission Control agent list with its role, capabilities, and framework.
 */
export async function syncBotsToDashboard(): Promise<void> {
  const baseUrl = (process.env.MISSION_CONTROL_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const apiKey  = process.env.MISSION_CONTROL_API_KEY ?? "";

  if (!baseUrl || !apiKey) return;

  const instanceIds = listInstanceIds(true); // include disabled
  if (instanceIds.length === 0) return;

  let synced = 0;
  let failed = 0;

  for (const id of instanceIds) {
    try {
      const cfg = loadInstanceConfig(id);

      const role = cfg.baseWorkflow.includes("reporting") ? "researcher" : "assistant";
      const capabilities = [cfg.baseWorkflow, cfg.enabled ? "active" : "disabled"];

      const res = await fetch(`${baseUrl}/api/agents/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({
          name:         cfg.id,
          role,
          capabilities,
          framework:    "ElevarusOS",
        }),
      });

      if (res.ok) {
        synced++;
      } else {
        const text = await res.text().catch(() => "");
        logger.warn("dashboard-sync: agent register failed", { instanceId: id, status: res.status, body: text.slice(0, 200) });
        failed++;
      }
    } catch (err) {
      logger.warn("dashboard-sync: could not register agent", { instanceId: id, error: String(err) });
      failed++;
    }
  }

  if (synced > 0) {
    logger.info("dashboard-sync: bots registered as MC agents", { synced, failed });
  }
}
