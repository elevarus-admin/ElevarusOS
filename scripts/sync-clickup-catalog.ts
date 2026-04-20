/**
 * Refresh data/clickup-spaces.json from the live ClickUp API.
 *
 *   - Pulls the team, every space, every list per space, and every member.
 *   - Preserves hand-edited `slackUserId` mappings on existing member rows.
 *   - Idempotent — safe to run on a cron later.
 *
 * Usage:
 *   npx tsx scripts/sync-clickup-catalog.ts
 *
 * Requires: CLICKUP_API_TOKEN + CLICKUP_TEAM_ID in .env.
 */

import * as fs from "fs";
import * as path from "path";
import { ClickUpHttpClient } from "../src/integrations/clickup/client";
import type { ClickUpCatalog, ClickUpCatalogMember } from "../src/integrations/clickup/types";

const CATALOG_PATH = path.resolve(__dirname, "../data/clickup-spaces.json");

async function main(): Promise<void> {
  const client = new ClickUpHttpClient();
  if (!client.enabled) {
    console.error("ClickUp not configured — set CLICKUP_API_TOKEN + CLICKUP_TEAM_ID in .env");
    process.exit(1);
  }

  console.log(`Refreshing ClickUp catalog → ${CATALOG_PATH}`);
  console.log(`Team: ${client.teamId}`);

  // ── Existing catalog (for slackUserId preservation) ────────────────────────
  let existing: Partial<ClickUpCatalog> = {};
  try {
    existing = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8")) as Partial<ClickUpCatalog>;
  } catch {
    /* first run — file doesn't exist or is malformed; we'll overwrite */
  }
  const existingSlackMap: Record<string, string> = {};
  for (const m of existing.members ?? []) {
    if (m.slackUserId) existingSlackMap[m.id] = m.slackUserId;
  }

  // ── Spaces ─────────────────────────────────────────────────────────────────
  const spaces = await client.listSpaces();
  console.log(`  spaces: ${spaces.length}`);

  // ── Lists (per space — both folderless AND folder-nested) ─────────────────
  // ClickUp organizes lists in two places:
  //   1. Directly under a space (folderless lists)  → GET /space/{id}/list
  //   2. Inside folders within a space              → GET /space/{id}/folder (lists embedded)
  // We collect both so the catalog reflects everything the user can see in the UI.
  const lists: ClickUpCatalog["lists"] = [];
  for (const space of spaces) {
    const folderless = await client.listSpaceLists(space.id);
    const folders    = await client.listSpaceFolders(space.id);
    const folderLists = folders.flatMap((f) =>
      f.lists.map((l) => ({ id: l.id, name: `${f.name} / ${l.name}`, spaceId: space.id }))
    );
    const directLists = folderless.map((l) => ({ id: l.id, name: l.name, spaceId: space.id }));
    lists.push(...directLists, ...folderLists);
    console.log(`  ${space.name}: ${directLists.length} folderless + ${folderLists.length} in ${folders.length} folder(s)`);
  }

  // ── Members (with slackUserId preservation) ───────────────────────────────
  const rawMembers = await client.listMembers();
  const members: ClickUpCatalogMember[] = rawMembers.map((m) => ({
    id:          m.id,
    username:    m.username,
    email:       m.email,
    ...(existingSlackMap[m.id] ? { slackUserId: existingSlackMap[m.id] } : {}),
  }));
  console.log(`  members: ${members.length} (${Object.keys(existingSlackMap).length} slackUserId mappings preserved)`);

  // ── Write ──────────────────────────────────────────────────────────────────
  const catalog: ClickUpCatalog = {
    teamId: client.teamId,
    spaces,
    lists,
    members,
  };

  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + "\n", "utf8");
  console.log(`\n✔ Wrote ${CATALOG_PATH}`);
  console.log(`  Spaces: ${spaces.length} · Lists: ${lists.length} · Members: ${members.length}`);

  if (members.some((m) => !m.slackUserId)) {
    console.log("\nNote: some members have no slackUserId. Hand-edit data/clickup-spaces.json to add them — the next sync will preserve them.");
  }
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
