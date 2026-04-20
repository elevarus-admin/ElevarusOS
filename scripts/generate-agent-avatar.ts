/**
 * scripts/generate-agent-avatar.ts
 *
 * Generates a deterministic DiceBear robot avatar for a given agent ID
 * and saves it as `src/agents/<agentId>/avatar.svg`.
 *
 * Usage (with ts-node):
 *   npx ts-node scripts/generate-agent-avatar.ts final-expense-reporting
 *
 * When creating a new agent via Claude Code, run this script immediately
 * after creating the agent directory to persist the avatar locally.
 * The dashboard falls back to the DiceBear CDN URL if avatar.svg is absent.
 */

import * as fs from "fs";
import * as path from "path";
import * as https from "https";

const BG_COLORS = ["b6e3f4", "c0aede", "d1d4f9", "ffd5dc", "ffdfbf"];

function agentAvatarUrl(agentId: string): string {
  const hash = agentId.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const bg = BG_COLORS[hash % BG_COLORS.length];
  const params = new URLSearchParams({ seed: agentId, backgroundColor: bg, size: "120" });
  return `https://api.dicebear.com/9.x/bottts/svg?${params.toString()}`;
}

async function fetchSvg(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end",  () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

async function main() {
  const agentId = process.argv[2];
  if (!agentId) {
    console.error("Usage: npx ts-node scripts/generate-agent-avatar.ts <agentId>");
    process.exit(1);
  }

  const agentDir = path.resolve(process.cwd(), "src", "agents", agentId);
  if (!fs.existsSync(agentDir)) {
    console.error(`Agent directory not found: ${agentDir}`);
    process.exit(1);
  }

  const url = agentAvatarUrl(agentId);
  console.log(`Fetching avatar for "${agentId}" from DiceBear…`);
  console.log(`  URL: ${url}`);

  const svg = await fetchSvg(url);
  const dest = path.join(agentDir, "avatar.svg");
  fs.writeFileSync(dest, svg, "utf8");
  console.log(`  ✓ Saved to ${dest}`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
