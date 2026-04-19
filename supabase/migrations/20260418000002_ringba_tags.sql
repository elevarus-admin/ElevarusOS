-- =============================================================================
-- ElevarusOS — Ringba tag capture
-- Migration: 006
-- =============================================================================
--
-- Adds tag_values JSONB + GIN index to ringba_calls.
--
-- Background
--   Ringba's /calllogs endpoint has two response modes:
--     (a) No valueColumns in body → returns a default ~50-field response.
--     (b) valueColumns specified   → returns ONLY those fields.
--
--   Tag values (system tags like Geo:Country + user-defined tags like
--   User:utm_campaign) are ONLY returned in mode (b) when explicitly
--   requested as `tag:TagType:TagName` column entries. The existing sync
--   uses mode (a) so all tag values are currently lost.
--
--   This migration adds the storage column. The sync worker change in this
--   commit requests all tags discovered via /tags at sync time and stores
--   them here as a flat map keyed "TagType:TagName" → string value.
--
-- Example:
--   tag_values = {
--     "Geo:Country":        "US",
--     "Geo:SubDivisionCode": "NY",
--     "Technology:OS":       "iOS",
--     "User:utm_campaign":   "spring_hvac_2026",
--     "User:utm_content":    "ad_variant_b"
--   }
--
-- =============================================================================

ALTER TABLE ringba_calls
  ADD COLUMN IF NOT EXISTS tag_values JSONB NOT NULL DEFAULT '{}'::jsonb;

-- GIN index for fast `tag_values @> '{"User:utm_campaign": "x"}'` lookups
CREATE INDEX IF NOT EXISTS ringba_calls_tag_values_idx
  ON ringba_calls USING GIN (tag_values);

-- Backfill note:
-- Existing rows default to {}. Re-running forward sync picks up tags for recent
-- calls (30-min overlap window). For historical tags, run:
--   npm run backfill:ringba -- --months 24
-- after deploying this migration.
