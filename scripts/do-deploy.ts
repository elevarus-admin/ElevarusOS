/**
 * One-shot DigitalOcean App Platform deploy/update helper.
 *
 * What it does:
 *   1. Reads .do/app.yaml (the canonical spec, env keys only — no values)
 *   2. Reads .env and dashboard/.env.local (your local secrets)
 *   3. For each env var in the spec marked `type: SECRET` (or any var with no
 *      `value:` field), injects the value from your local files
 *   4. Writes the enriched spec to a tempfile
 *   5. Either CREATES the app (if none exists) or UPDATES the existing one
 *   6. Deletes the tempfile, prints the app URL
 *
 * Usage:
 *   npx ts-node scripts/do-deploy.ts                # create or update (auto-detect)
 *   npx ts-node scripts/do-deploy.ts --dry-run      # show enriched spec, don't deploy
 *   npx ts-node scripts/do-deploy.ts --update <id>  # explicit update of an existing app
 *
 * Requires:
 *   - doctl installed and authed (doctl auth init)
 *   - .env and dashboard/.env.local populated locally
 */

import * as fs     from "fs";
import * as path   from "path";
import * as os     from "os";
import * as crypto from "crypto";
import { execSync } from "child_process";

const ROOT_ENV  = path.resolve(__dirname, "../.env");
const DASH_ENV  = path.resolve(__dirname, "../dashboard/.env.local");
const SPEC_PATH = path.resolve(__dirname, "../.do/app.yaml");
const ENV_FILES = [ROOT_ENV, DASH_ENV];

// ─── Ensure a shared API_SECRET exists in .env (one-time generation) ────────
//
// API_SECRET (used by the api service for x-api-key auth) and
// ELEVARUS_API_SECRET (used by the dashboard's proxy routes) MUST match.
// We generate a single random secret and ensure it's in both places.

function ensureApiSecret(): string {
  let envText = fs.readFileSync(ROOT_ENV, "utf8");
  const match = envText.match(/^API_SECRET=(.+)$/m);
  if (match && match[1].trim()) {
    // Already set — reuse
    return match[1].trim();
  }

  const secret = crypto.randomBytes(32).toString("hex");
  console.log(`Generated new API_SECRET (32 bytes hex). Persisting to .env.`);
  if (match) {
    envText = envText.replace(/^API_SECRET=.*$/m, `API_SECRET=${secret}`);
  } else {
    envText += `\n# Shared secret for the dashboard → api proxy. Do not rotate without updating both services.\nAPI_SECRET=${secret}\n`;
  }
  fs.writeFileSync(ROOT_ENV, envText);

  // Also mirror to dashboard/.env.local as ELEVARUS_API_SECRET
  let dashText = fs.existsSync(DASH_ENV) ? fs.readFileSync(DASH_ENV, "utf8") : "";
  const dashMatch = dashText.match(/^ELEVARUS_API_SECRET=(.+)$/m);
  if (dashMatch) {
    dashText = dashText.replace(/^ELEVARUS_API_SECRET=.*$/m, `ELEVARUS_API_SECRET=${secret}`);
  } else {
    dashText += `\nELEVARUS_API_SECRET=${secret}\n`;
  }
  fs.writeFileSync(DASH_ENV, dashText);

  return secret;
}

// ─── Tiny .env parser ────────────────────────────────────────────────────────

function loadEnvFiles(files: string[]): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key   = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && /^[A-Z_][A-Z0-9_]*$/.test(key)) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

// ─── Inline YAML transform — preserve formatting + inject values ────────────
//
// We don't want to fully parse + re-emit YAML (would lose comments/formatting).
// Instead we do a targeted text transform: walk line-by-line, and when we see
// an envs entry with no `value:`, append `value: "..."` from the local env.

function injectValues(specText: string, env: Record<string, string>): { text: string; missing: string[] } {
  const lines = specText.split("\n");
  const out: string[] = [];
  const missing: string[] = [];

  // Inline form: `- { key: NAME, scope: RUN_TIME, type: SECRET }`
  const inlineRegex = /^(\s*-\s*\{[^}]*?key:\s*([A-Z_][A-Z0-9_]*)[^}]*?\})\s*$/;
  // Also need to catch inline form WITHOUT a value but with type field
  const inlineHasValue = /value\s*:/;

  // Block form anchor: `- key: NAME` (followed by scope/type lines, no value:)
  const blockKeyRegex = /^(\s*)-\s*key:\s*([A-Z_][A-Z0-9_]*)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Inline form
    const inlineMatch = inlineRegex.exec(line);
    if (inlineMatch && !inlineHasValue.test(line)) {
      const key = inlineMatch[2];
      const value = env[key];
      if (value === undefined || value === "") {
        missing.push(key);
        out.push(line); // leave as-is; doctl will reject if required
        continue;
      }
      // Convert inline → block form so we can add the value cleanly
      const indent = (line.match(/^\s*/) ?? [""])[0];
      // Extract scope/type from the inline body
      const body = line.match(/\{([^}]+)\}/)?.[1] ?? "";
      const scope = body.match(/scope:\s*([A-Z_]+)/)?.[1] ?? "RUN_TIME";
      const isSecret = /type:\s*SECRET/.test(body);
      out.push(`${indent}- key: ${key}`);
      out.push(`${indent}  scope: ${scope}`);
      if (isSecret) out.push(`${indent}  type: SECRET`);
      out.push(`${indent}  value: ${yamlString(value)}`);
      continue;
    }

    // Block form: scan ahead to determine if this entry already has a value:
    const blockMatch = blockKeyRegex.exec(line);
    if (blockMatch) {
      const key = blockMatch[2];
      // Look ahead until next list item or end of envs block
      let j = i + 1;
      let hasValue = false;
      while (j < lines.length) {
        const peek = lines[j];
        if (/^\s*-/.test(peek)) break;
        if (!/^\s+/.test(peek) && peek.trim() !== "") break;
        if (/^\s+value\s*:/.test(peek)) { hasValue = true; break; }
        j += 1;
      }

      if (hasValue) {
        out.push(line);
        continue;
      }

      const value = env[key];
      if (value === undefined || value === "") {
        missing.push(key);
        out.push(line);
        continue;
      }

      // Inject the value at the end of this block entry
      out.push(line);
      // Copy scope/type lines through, then append value
      let k = i + 1;
      while (k < lines.length) {
        const peek = lines[k];
        if (/^\s*-/.test(peek)) break;
        if (!/^\s+/.test(peek) && peek.trim() !== "") break;
        out.push(peek);
        k += 1;
      }
      // Determine indent for child fields by looking at the first child line
      const childLine = lines[i + 1] ?? "";
      const childIndent = (childLine.match(/^\s*/) ?? ["    "])[0];
      out.push(`${childIndent}value: ${yamlString(value)}`);
      i = k - 1;
      continue;
    }

    out.push(line);
  }

  return { text: out.join("\n"), missing };
}

/** Quote YAML strings safely. */
function yamlString(s: string): string {
  // Always single-quote and escape any embedded single quotes
  return `'${s.replace(/'/g, "''")}'`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function run(cmd: string, opts: { capture?: boolean } = {}): string {
  if (opts.capture) {
    return execSync(cmd, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" }).trim();
  }
  execSync(cmd, { stdio: "inherit" });
  return "";
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun       = argv.includes("--dry-run");
  const updateIdFlag = argv.find((a) => a.startsWith("--update="));
  const explicitUpdateId = updateIdFlag?.split("=")[1];

  console.log("Loading spec + env values...");
  const apiSecret = ensureApiSecret();
  const specText  = fs.readFileSync(SPEC_PATH, "utf8");
  const env       = loadEnvFiles(ENV_FILES);
  // ELEVARUS_API_SECRET in dashboard service must match API_SECRET
  env.ELEVARUS_API_SECRET = apiSecret;
  const { text: enriched, missing } = injectValues(specText, env);

  if (missing.length > 0) {
    console.warn(`\n⚠ ${missing.length} env vars with no value in .env / .env.local:`);
    for (const k of missing) console.warn(`    - ${k}`);
    console.warn("  (these will be left empty in the spec — set them in the DO dashboard later)\n");
  }

  if (dryRun) {
    console.log("\n=== ENRICHED SPEC (dry run) ===\n");
    console.log(enriched);
    return;
  }

  // Write to a tempfile
  const tmp = path.join(os.tmpdir(), `elevarus-os-spec-${Date.now()}.yaml`);
  fs.writeFileSync(tmp, enriched, { mode: 0o600 });
  console.log(`Wrote enriched spec to ${tmp}`);

  try {
    // Detect existing app
    let appId = explicitUpdateId;
    if (!appId) {
      const list = run(`doctl apps list --format ID,Spec.Name --no-header`, { capture: true });
      const match = list.split("\n").find((l) => l.includes("elevarus-os"));
      if (match) appId = match.split(/\s+/)[0];
    }

    if (appId) {
      console.log(`\nUpdating existing app ${appId}...`);
      run(`doctl apps update ${appId} --spec ${tmp}`);
      console.log(`\n✓ Updated. Get app URL: doctl apps get ${appId}`);
    } else {
      console.log("\nCreating new app...");
      run(`doctl apps create --spec ${tmp}`);
      console.log("\n✓ Created. Run `doctl apps list` to see the new app ID + URL.");
      console.log("Initial build takes ~5-8 minutes. Tail logs with:");
      console.log("    doctl apps logs <APP_ID> api --follow");
      console.log("    doctl apps logs <APP_ID> dashboard --follow");
    }
  } finally {
    fs.unlinkSync(tmp);
    console.log(`\nCleaned up tempfile.`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
