import * as dotenv from "dotenv";
dotenv.config();
import { getSession, renderPRD } from "../src/core/agent-builder";

async function main() {
  const sid = process.argv[2] ?? "";
  if (!sid) { console.error("usage: preview-agent-builder-prd.ts <sessionId>"); process.exit(1); }
  const session = await getSession(sid);
  const rendered = renderPRD(session, {
    proposedName: "LinkedIn Ads Reporting",
    proposedSlug: "linkedin-ads-reporting",
    verticalTag:  "vertical:agency",
    capabilityTag: "capability:reporting",
  });
  console.log("=== TITLE ===\n" + rendered.title);
  console.log("\n=== TAGS ===\n" + JSON.stringify(rendered.tags));
  console.log("\n=== BODY ===\n" + rendered.body);
}
main().catch((e) => { console.error(e); process.exit(1); });
