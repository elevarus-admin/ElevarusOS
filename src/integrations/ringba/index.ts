/**
 * Ringba Integration
 *
 * Shared library for all ElevarusOS agents that pull Ringba data.
 * Used by ppc-campaign-report workflow and any future workflows needing call data.
 *
 * Usage:
 *   import { getCampaignRevenue, getMTDRevenue, getWTDRevenue } from '../../integrations/ringba';
 *   import { RingbaHttpClient } from '../../integrations/ringba';
 */
export { RingbaHttpClient } from "./client";
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
