/**
 * Ringba Integration — Supabase-backed pattern (see docs/data-platform.md).
 *
 * Workflows should read via `getCampaignRevenue` (which now queries the
 * RingbaRepository with a live-API fallback) or via RingbaRepository directly.
 * RingbaHttpClient is still exported for the sync worker and edge cases,
 * but normal workflow code should not call it.
 *
 * Usage:
 *   import { getCampaignRevenue, getMTDRevenue } from '../../integrations/ringba';
 *   import { RingbaRepository }                   from '../../integrations/ringba';
 */
export { RingbaHttpClient }   from "./client";
export { RingbaRepository }   from "./repository";
export { RingbaSyncWorker }   from "./sync";
export {
  getCampaignRevenue,
  getMTDRevenue,
  getWTDRevenue,
  getMTDRange,
  getWTDRange,
  getYTDRange,
  getDateRange,
} from "./reports";
export type {
  RingbaCallRecord,
  RingbaCampaign,
  RingbaRevenueReport,
  RingbaCallLogOptions,
} from "./types";
