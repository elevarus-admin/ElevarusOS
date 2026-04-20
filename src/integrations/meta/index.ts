/**
 * Meta Ads Integration
 *
 * Pulls ad spend from the Meta Ads Graph API for P&L reporting.
 * The ad account ID is the per-agent identifier — configured in instance.md.
 *
 * Usage:
 *   import { getAdAccountSpend } from '../../../integrations/meta';
 *
 *   const report = await getAdAccountSpend({
 *     adAccountId: '999576488367816',
 *     startDate:   '2026-04-01',
 *     endDate:     '2026-04-17',
 *   });
 *
 * Env vars:
 *   META_ACCESS_TOKEN — System User token from Meta Business Manager.
 *                       One token covers all ad accounts the System User
 *                       has been granted access to.
 */

export { getAdAccountSpend }   from "./reports";
export { MetaAdsClient }       from "./client";
export type {
  MetaSpendReport,
  MetaSpendOptions,
  MetaInsightRecord,
  MetaAdAccountSummary,
}                              from "./types";
