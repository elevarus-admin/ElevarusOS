/**
 * Smoke-test Google Ads API credentials.
 *
 * Usage:
 *   npx ts-node scripts/google-ads-smoke-test.ts
 *
 * Steps:
 *   1. Exchange refresh_token → access_token
 *   2. GET customers:listAccessibleCustomers (top-level CIDs the OAuth user can see)
 *   3. GAQL query against the MCC for the customer_client tree → enumerate sub-accounts
 *
 * Prints the sub-account list so we can confirm the integration sees what we expect.
 */

import * as dotenv from "dotenv";
dotenv.config();

const DEV_TOKEN     = process.env.GOOGLE_ADS_DEVELOPER_TOKEN     ?? "";
const CLIENT_ID     = process.env.GOOGLE_ADS_CLIENT_ID           ?? "";
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET       ?? "";
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN       ?? "";
const MCC_ID        = process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID   ?? "";

const API_VERSION = "v21";
const API_BASE    = `https://googleads.googleapis.com/${API_VERSION}`;

if (!DEV_TOKEN || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !MCC_ID) {
  console.error("Missing one or more Google Ads env vars. Need:");
  console.error("  GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID,");
  console.error("  GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN,");
  console.error("  GOOGLE_ADS_LOGIN_CUSTOMER_ID");
  process.exit(1);
}

async function getAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type:    "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  const json = await res.json() as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Token refresh failed: ${json.error ?? res.status} ${json.error_description ?? ""}`);
  }
  return json.access_token;
}

function commonHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization:       `Bearer ${accessToken}`,
    "developer-token":   DEV_TOKEN,
    "login-customer-id": MCC_ID,
    "Content-Type":      "application/json",
  };
}

async function listAccessibleCustomers(accessToken: string): Promise<string[]> {
  const res = await fetch(`${API_BASE}/customers:listAccessibleCustomers`, {
    method:  "GET",
    headers: commonHeaders(accessToken),
  });
  const json = await res.json() as { resourceNames?: string[]; error?: { message?: string; code?: number } };
  if (!res.ok) {
    throw new Error(`listAccessibleCustomers failed: ${res.status} ${JSON.stringify(json.error ?? json)}`);
  }
  return json.resourceNames ?? [];
}

interface CustomerClientRow {
  customerClient: {
    id:              string;
    descriptiveName?: string;
    manager:         boolean;
    level:           string;
    currencyCode?:   string;
    timeZone?:       string;
    status?:         string;
  };
}

async function listCustomerClientsUnderMcc(accessToken: string): Promise<CustomerClientRow[]> {
  const query = `
    SELECT
      customer_client.id,
      customer_client.descriptive_name,
      customer_client.manager,
      customer_client.level,
      customer_client.currency_code,
      customer_client.time_zone,
      customer_client.status
    FROM customer_client
  `.replace(/\s+/g, " ").trim();

  const res = await fetch(`${API_BASE}/customers/${MCC_ID}/googleAds:searchStream`, {
    method:  "POST",
    headers: commonHeaders(accessToken),
    body:    JSON.stringify({ query }),
  });
  const json = await res.json() as Array<{ results?: CustomerClientRow[] }> | { error?: unknown };

  if (!res.ok) {
    throw new Error(`customer_client query failed: ${res.status} ${JSON.stringify(json)}`);
  }
  // searchStream returns an array of result chunks
  const chunks = Array.isArray(json) ? json : [];
  const all: CustomerClientRow[] = [];
  for (const chunk of chunks) {
    for (const row of chunk.results ?? []) all.push(row);
  }
  return all;
}

async function main(): Promise<void> {
  console.log(`MCC: ${MCC_ID}`);
  console.log(`API version: ${API_VERSION}`);
  console.log("");

  console.log("Step 1: refreshing access token...");
  const accessToken = await getAccessToken();
  console.log(`  access token acquired (${accessToken.slice(0, 12)}...)`);
  console.log("");

  console.log("Step 2: listAccessibleCustomers");
  const accessible = await listAccessibleCustomers(accessToken);
  console.log(`  ${accessible.length} top-level customer(s) visible to this OAuth identity:`);
  for (const r of accessible) console.log(`    ${r}`);
  console.log("");

  console.log("Step 3: customer_client tree under MCC");
  const rows = await listCustomerClientsUnderMcc(accessToken);
  console.log(`  ${rows.length} client account(s) (incl. the MCC itself at level 0):`);
  console.log("");
  console.log("  level  type      id            currency  status      name");
  console.log("  ─────  ────────  ────────────  ────────  ──────────  ─────────────────────────────");
  for (const { customerClient: c } of rows) {
    const level    = String(c.level).padStart(5);
    const type     = (c.manager ? "manager" : "leaf").padEnd(8);
    const id       = c.id.padEnd(12);
    const currency = (c.currencyCode ?? "").padEnd(8);
    const status   = (c.status ?? "").padEnd(10);
    const name     = c.descriptiveName ?? "(no name)";
    console.log(`  ${level}  ${type}  ${id}  ${currency}  ${status}  ${name}`);
  }
  console.log("");
  console.log("✓ Smoke test passed.");
}

main().catch((err) => {
  console.error("");
  console.error("✗ Smoke test failed:");
  console.error(`  ${err.message ?? err}`);
  process.exit(1);
});
