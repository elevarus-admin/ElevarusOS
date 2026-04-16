import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";

let _client: SupabaseClient | null = null;

/**
 * Returns a singleton Supabase client using the service role key.
 * Service role bypasses RLS — safe for server-side use only.
 *
 * Throws at first call if SUPABASE_URL or SUPABASE_SERVICE_KEY are not set.
 */
export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client;

  const { url, serviceKey } = config.supabase;
  if (!url || !serviceKey) {
    throw new Error(
      "Supabase not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env, " +
      "then set JOB_STORE=supabase."
    );
  }

  _client = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });

  return _client;
}

/** True when both SUPABASE_URL and SUPABASE_SERVICE_KEY are present in config. */
export function isSupabaseConfigured(): boolean {
  return Boolean(config.supabase.url && config.supabase.serviceKey);
}
