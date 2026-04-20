/**
 * One-time OAuth flow to mint a Google Ads API refresh token.
 *
 * Usage:
 *   npx ts-node scripts/google-ads-oauth.ts
 *
 * Requires GOOGLE_ADS_CLIENT_ID + GOOGLE_ADS_CLIENT_SECRET in .env.
 *
 * Flow:
 *   1. Spins up a local HTTP listener on http://127.0.0.1:8765/callback
 *   2. Opens your browser to Google's consent screen (scope: adwords)
 *   3. You sign in as a user with access to MCC 989-947-7831 and click Allow
 *   4. Google redirects to the local callback with ?code=...
 *   5. Script exchanges the code for a refresh token and prints it
 *   6. Paste the refresh token into .env as GOOGLE_ADS_REFRESH_TOKEN
 *
 * The refresh token does not expire (unless revoked), so this runs once.
 */

import * as http from "http";
import { exec } from "child_process";
import * as dotenv from "dotenv";

dotenv.config();

const CLIENT_ID     = process.env.GOOGLE_ADS_CLIENT_ID     ?? "";
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET ?? "";
const REDIRECT_URI  = "http://127.0.0.1:8765/callback";
const SCOPE         = "https://www.googleapis.com/auth/adwords";
const PORT          = 8765;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Missing GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET in .env");
  process.exit(1);
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? `open "${url}"` :
    process.platform === "win32"  ? `start "" "${url}"` :
                                    `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.log(`(Could not auto-open browser. Open this URL manually:)\n${url}`);
  });
}

async function exchangeCode(code: string): Promise<{ refresh_token?: string; access_token?: string; error?: string }> {
  const body = new URLSearchParams({
    code,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri:  REDIRECT_URI,
    grant_type:    "authorization_code",
  });
  const res  = await fetch("https://oauth2.googleapis.com/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  return res.json() as Promise<{ refresh_token?: string; access_token?: string; error?: string }>;
}

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: "code",
    scope:         SCOPE,
    access_type:   "offline",
    prompt:        "consent",
  }).toString();

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith("/callback")) {
    res.writeHead(404).end();
    return;
  }
  const url   = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const code  = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end(`OAuth error: ${error}`);
    console.error(`OAuth error: ${error}`);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("Missing ?code");
    return;
  }

  console.log("Got authorization code, exchanging for refresh token...");
  const tokens = await exchangeCode(code);

  if (tokens.error || !tokens.refresh_token) {
    res.writeHead(500, { "Content-Type": "text/plain" }).end("Token exchange failed. See terminal.");
    console.error("Token exchange failed:", tokens);
    server.close();
    process.exit(1);
  }

  res.writeHead(200, { "Content-Type": "text/html" }).end(
    "<h2>Done — you can close this tab.</h2><p>Refresh token is in your terminal.</p>"
  );

  console.log("\n────────────────────────────────────────────────────────────");
  console.log("Refresh token:");
  console.log(tokens.refresh_token);
  console.log("────────────────────────────────────────────────────────────");
  console.log("\nPaste into .env as:");
  console.log(`GOOGLE_ADS_REFRESH_TOKEN=${tokens.refresh_token}\n`);

  server.close();
  process.exit(0);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Listening on ${REDIRECT_URI}`);
  console.log("Opening browser for Google OAuth consent...");
  console.log("Sign in as a user with access to MCC 989-947-7831.\n");
  openBrowser(authUrl);
});
