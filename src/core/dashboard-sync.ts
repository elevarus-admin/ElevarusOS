import * as path from "path";
import { listInstanceIds, loadInstanceConfig, InstanceConfig } from "./instance-config";
import { logger } from "./logger";

const INSTANCES_DIR = path.resolve(__dirname, "../instances");

/**
 * Syncs ElevarusOS bot instances to the Mission Control dashboard as agents.
 *
 * Called once at startup — and after any new instance is created. Uses the
 * /api/agents/register endpoint (idempotent) then follows up with a config
 * PUT to set the workspace path, model, and soul content so the MC Files
 * and Config tabs work correctly.
 *
 * Flow:
 *   1. POST /api/agents/register   — creates or refreshes agent status
 *   2. GET  /api/agents/{name}     — fetch the assigned agent ID
 *   3. PUT  /api/agents/{id}       — set workspace, model, soul_content
 */
export async function syncBotsToDashboard(instanceIds?: string[]): Promise<void> {
  const baseUrl = (process.env.MISSION_CONTROL_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const apiKey  = process.env.MISSION_CONTROL_API_KEY ?? "";

  if (!baseUrl || !apiKey) return;

  const ids = instanceIds ?? listInstanceIds(true); // include disabled
  if (ids.length === 0) return;

  let synced = 0;
  let failed = 0;

  for (const id of ids) {
    try {
      const cfg = loadInstanceConfig(id);
      await syncOneAgent(baseUrl, apiKey, cfg);
      synced++;
    } catch (err) {
      logger.warn("dashboard-sync: failed to sync instance", { instanceId: id, error: String(err) });
      failed++;
    }
  }

  if (synced > 0) {
    logger.info("dashboard-sync: bots synced to MC", { synced, failed });
  }
}

async function syncOneAgent(baseUrl: string, apiKey: string, cfg: InstanceConfig): Promise<void> {
  const role = cfg.baseWorkflow.includes("reporting") ? "researcher" : "assistant";
  const capabilities = [cfg.baseWorkflow, cfg.enabled ? "active" : "disabled"];

  // Step 1: register (idempotent upsert)
  const registerRes = await fetch(`${baseUrl}/api/agents/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      name:         cfg.id,
      role,
      capabilities,
      framework:    "ElevarusOS",
    }),
  });

  if (!registerRes.ok) {
    const text = await registerRes.text().catch(() => "");
    throw new Error(`register failed (${registerRes.status}): ${text.slice(0, 200)}`);
  }

  const registerData = await registerRes.json() as { agent?: { id: number } };
  const agentId: number = registerData.agent?.id ?? 0;
  if (!agentId) return; // shouldn't happen

  // Step 2: update config — workspace, model, soul content
  const instanceDir = path.join(INSTANCES_DIR, cfg.id);
  const soulContent = buildSoulContent(cfg);

  const updateRes = await fetch(`${baseUrl}/api/agents/${agentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      gateway_config: {
        workspace:    instanceDir,       // absolute path — fixes "workspace not configured"
        model:        "claude-opus-4-7",
        framework:    "ElevarusOS",
        workflow:     cfg.baseWorkflow,
        enabled:      cfg.enabled,
        openclawId:   cfg.id,
      },
      write_to_gateway: false,           // no OpenClaw gateway in this setup
    }),
  });

  if (!updateRes.ok) {
    const text = await updateRes.text().catch(() => "");
    logger.warn("dashboard-sync: config update failed", { agentId, instanceId: cfg.id, status: updateRes.status, body: text.slice(0, 200) });
    // Non-fatal — registration succeeded, config update is best-effort
  }

  // Step 3: set soul content (shows in the SOUL tab)
  await fetch(`${baseUrl}/api/agents/${agentId}/soul`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({ content: soulContent }),
  }).catch(() => {}); // best-effort
}

/** Generates the agent soul content from instance config — shown in MC's SOUL tab */
function buildSoulContent(cfg: InstanceConfig): string {
  return [
    `# ${cfg.name}`,
    ``,
    `**Framework:** ElevarusOS | **Workflow:** ${cfg.baseWorkflow} | **Status:** ${cfg.enabled ? "Active" : "Disabled"}`,
    ``,
    `## Voice & Brand`,
    `- **Voice:** ${cfg.brand.voice}`,
    `- **Audience:** ${cfg.brand.audience}`,
    `- **Tone:** ${cfg.brand.tone}`,
    cfg.brand.industry ? `- **Industry:** ${cfg.brand.industry}` : "",
    ``,
    `## Notifications`,
    cfg.notify.approver    ? `- **Approver:** ${cfg.notify.approver}` : "",
    cfg.notify.slackChannel ? `- **Slack:** ${cfg.notify.slackChannel}` : "",
    ``,
    cfg.schedule.enabled ? [
      `## Schedule`,
      `- **Cron:** \`${cfg.schedule.cron}\``,
      cfg.schedule.description ? `- **Description:** ${cfg.schedule.description}` : "",
    ].filter(Boolean).join("\n") : "",
  ].filter((l) => l !== undefined).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
