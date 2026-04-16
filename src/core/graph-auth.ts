import { config } from "../config";
import { logger } from "./logger";

interface TokenCache {
  accessToken: string;
  expiresAt: number; // unix ms
}

let cache: TokenCache | undefined;

/**
 * Acquires a Microsoft Graph access token using the client credentials flow.
 * Tokens are cached in-process until 60 seconds before expiry.
 *
 * Required env vars: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET
 */
export async function acquireGraphToken(): Promise<string> {
  const now = Date.now();

  if (cache && cache.expiresAt > now + 60_000) {
    logger.debug("Using cached Graph access token");
    return cache.accessToken;
  }

  const { tenantId, clientId, clientSecret } = config.microsoft;

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });

  logger.debug("Acquiring Microsoft Graph access token");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Graph token acquisition failed (${res.status}): ${text.slice(0, 300)}`
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  cache = {
    accessToken: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };

  logger.info("Microsoft Graph access token acquired", {
    expiresInSeconds: data.expires_in,
  });

  return cache.accessToken;
}

/** Clear the cached token (useful in tests or after auth errors) */
export function clearGraphTokenCache(): void {
  cache = undefined;
}
