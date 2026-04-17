/**
 * @deprecated Import from src/integrations/ringba instead.
 *
 * This file is a backward-compatibility shim.
 * The Ringba library has moved to src/integrations/ringba/.
 *
 * Update your imports:
 *   import { RingbaClient } from '../core/ringba-client'
 *   →
 *   import { RingbaHttpClient } from '../integrations/ringba'
 */
export { RingbaHttpClient as RingbaClient } from "../integrations/ringba/client";
export type {
  RingbaCallRecord,
  RingbaCampaign,
  RingbaRevenueReport,
} from "../integrations/ringba/types";
