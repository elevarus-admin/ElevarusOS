/**
 * Everflow Integration
 *
 * Affiliate / partner network. Live API only — no Supabase mirror.
 *
 * Usage from a workflow stage:
 *   import { EverflowClient } from '../../../integrations/everflow';
 *   const c = new EverflowClient();
 *   const summary = await c.getOfferPayouts({
 *     offerId: 8, startDate, endDate,
 *     excludePartnerPatterns: ['INTERNAL'],
 *   });
 *
 * Env vars:
 *   EVERFLOW_API_KEY — Network API key from
 *                      https://elevarus.everflowclient.io → API
 */
export { EverflowClient } from "./client";
export type {
  EverflowOffer,
  EverflowPartner,
  EverflowReportRow,
  EverflowReportFilters,
  EverflowOfferPayoutSummary,
} from "./types";
