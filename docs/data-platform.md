# ElevarusOS — Data Platform

This document describes the Supabase-backed data pattern for external integrations. LeadsProsper is the first integration built on it; Ringba and disposition reports will follow.

---

## Why we moved from live-API reads to a Supabase warehouse

Until Apr 2026, every reporting run called Ringba's API live. That pattern works for single-campaign daily reports but breaks down as we scale:

- **Rate limits.** Multiple reporting agents + the dashboard + ad-hoc queries all competing for the same API quota.
- **No history beyond what the vendor exposes.** Ringba's UI caps at ~90 days of granular data.
- **No cross-system joins.** We cannot ask "which Ringba call came from which LeadsProsper lead and which Meta campaign" because the data only ever exists in three separate vendor UIs.
- **Reconciliation needs a stable, queryable copy.** Buyers send disposition reports days after the call — we need the call sitting in our own DB to attach the disposition to.
- **Optimization needs trend data.** "Is supplier X declining?" requires months of history, not a live snapshot.

The new pattern keeps our own call-level and lead-level records in Supabase. Vendor APIs become the source we *sync from*, not the source we *read from at runtime*.

---

## The three-piece integration pattern

Every external data source follows the same split:

```
src/integrations/<source>/
  client.ts        — thin HTTP wrapper: auth + pagination only
  repository.ts    — Supabase read/write: the PUBLIC interface for workflows
  sync.ts          — cron worker: API → Supabase
  types.ts         — response + row types
  index.ts         — exports
```

### 1. Client — `client.ts`

No business logic. No aggregation. No report building. Just:

- Auth header assembly
- HTTP GET/POST helpers with graceful failure (returns `null`, logs a warning, never throws on 4xx/5xx)
- Pagination loops (offset or cursor, whichever the vendor uses)
- An `enabled` flag that's `false` when the API key is missing

The client is internal — workflows should not import it. Only the sync worker calls it in normal operation.

### 2. Repository — `repository.ts`

The public interface for every consumer of this data source. Wraps the Supabase client and exposes domain-meaningful methods:

- `getLeadsByDateRange(...)`, `findLeadsByPhone(...)` for LP
- (Future) `getCallsByDateRange(...)`, `getCallsByPhone(...)` for Ringba
- (Future) `getDispositionsByPhone(...)` for dispo reports

All read methods return `[]` when Supabase isn't configured, so stages can call them unconditionally without defensive checks.

Write methods (`upsertLeads`, `upsertCampaigns`, `setSyncState`) are called only by the sync worker.

### 3. Sync worker — `sync.ts`

A standalone class with `start()` / `stop()` / `runOnce()`. Registered in `src/index.ts` at daemon boot. Runs on its own cron — **not** via the instance `Scheduler`, because sync is a platform-level concern, not an instance-level one.

Standard tick:

1. Read checkpoint from `<source>_sync_state`
2. Fetch from vendor API covering `(checkpoint − overlap) → now`
3. Upsert into the main table (idempotent via primary key)
4. Advance the checkpoint to the latest timestamp seen
5. On error, leave the checkpoint unchanged, record `last_error`, and let the next tick retry

---

## Schema conventions

Every integration's main "fact" table follows the same shape:

```sql
CREATE TABLE <source>_<thing> (
  id                 <vendor-id-type> PRIMARY KEY,    -- vendor's own ID, for idempotent upsert
  -- promoted columns for common filters + joins:
  <business-keys>    ...,
  phone              TEXT,
  phone_normalized   TEXT GENERATED ALWAYS AS
                       (REGEXP_REPLACE(COALESCE(phone,''), '[^0-9]', '', 'g')) STORED,
  -- time:
  occurred_at        TIMESTAMPTZ NOT NULL,
  -- full payload:
  raw                JSONB NOT NULL,
  -- bookkeeping:
  synced_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Key decisions:**

- **Full payload in `raw` JSONB.** Schema drift on the vendor side never loses data. We can reparse historically if we decide we want a new promoted column.
- **Promoted columns are an index optimization, not a schema decision.** Anything we want to filter, join, or order on gets promoted. Everything else stays in JSONB.
- **`phone_normalized` is always a generated column.** Never normalized by application code — the database guarantees consistency, and indexes on it stay clean.
- **`synced_at` + `updated_at` on every row.** Upserts update `updated_at` via the shared `set_updated_at` trigger.

---

## Reconciliation model

**Phone number is the universal join key** across LeadsProsper, Ringba, and disposition reports. This was decided explicitly by the team — no shared lead ID is passed reliably across all three systems.

```
            ┌───────────────────┐
            │  lp_leads         │
            │  phone_normalized │ ◄──┐
            └───────────────────┘    │
                                     │  JOIN on phone_normalized
            ┌───────────────────┐    │  AND time window ±48h
            │  ringba_calls     │ ◄──┤
            │  phone_normalized │    │
            └───────────────────┘    │
                                     │
            ┌───────────────────┐    │
            │  dispositions    │ ◄──┘
            │  phone_normalized │
            └───────────────────┘
```

**Why a time window is non-negotiable.** Phone numbers are recycled. DNC lists churn. Shared household devices submit multiple leads. Without a ±48h window, a recycled number will falsely link a new lead to a call from the previous owner three months ago.

Standard pattern for reconciliation queries:

```sql
SELECT lp.id AS lead_id, rb.inbound_call_id AS call_id, dp.disposition
FROM ringba_calls rb
LEFT JOIN lp_leads     lp ON lp.phone_normalized = rb.phone_normalized
                          AND lp.lead_date BETWEEN (rb.call_dt - INTERVAL '48 hours')
                                               AND (rb.call_dt + INTERVAL '48 hours')
LEFT JOIN dispositions dp ON dp.phone_normalized = rb.phone_normalized
                          AND dp.call_date    BETWEEN (rb.call_dt - INTERVAL '48 hours')
                                               AND (rb.call_dt + INTERVAL '48 hours')
WHERE rb.call_dt BETWEEN $1 AND $2;
```

---

## Sync cadence (current defaults)

| Source          | Cadence         | Overlap   | Notes |
|-----------------|-----------------|-----------|-------|
| LeadsProsper    | every 15 min    | 30 min    | Cold-start lookback: 3 days |
| Ringba          | **TBD**         | **TBD**   | Migration pending |
| Dispositions    | event-driven    | n/a       | Processed as emails arrive via O365 adapter |

All defaults are overridable via constructor options on each sync worker.

---

## Migration path for Ringba

Ringba today uses the live-API pattern. Migrating will preserve the current `getCampaignRevenue()` public signature:

1. Add tables: `ringba_calls`, `ringba_campaigns`, `ringba_sync_state`
2. Add `RingbaRepository` with `getCallsByDateRange(...)`, `getCallsByPhone(...)`
3. Add `RingbaSyncWorker` (same tick pattern as LP)
4. Rewrite `src/integrations/ringba/reports.ts::getCampaignRevenue()` to read from the repository, falling back to a live API call only when Supabase has no data for the requested window (e.g. a date range before we started syncing)
5. Existing reporting workflows are unchanged — they still call `getCampaignRevenue()` with the same args

Step 4 is the only behavior change visible to existing callers, and it's additive: cold data comes from live API exactly as before; warm data comes from Supabase.

---

## Guardrails and failure modes

- **Every sync worker no-ops cleanly** when its API key or Supabase is missing. No crash on boot, no retry loop.
- **Sync errors do not advance the checkpoint.** The next tick re-pulls the same window. `last_error` on the sync state row surfaces the issue for observability.
- **Upserts are keyed on the vendor's ID.** Re-running a sync over an overlapping window is always safe.
- **`inFlight` guard** prevents overlapping runs if a tick is slow (e.g. during a large backfill).
- **`raw` JSONB is write-once on insert, overwrite on upsert.** If the vendor changes the payload shape, the latest version wins — historical shape is lost. If we need append-only audit, we'll add a separate `<source>_events` append-only table; don't bolt it onto the fact table.

---

## When to create a new sync stream

Add a new row to `<source>_sync_state` (not a new table) when:

- You want to track a different time dimension for the same source (e.g. "leads by `lead_date`" vs. "leads by `updated_at`")
- You want per-campaign checkpoints instead of a global one (useful if some campaigns are high-volume and shouldn't block others on error)

Create a new table only when the underlying vendor object is genuinely different (e.g. `lp_campaigns` vs. `lp_leads`).
