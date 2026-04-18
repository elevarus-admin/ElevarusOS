# PRD: Ask Elevarus — Data Access, Memory, and Future-Integration Readiness

**Status:** Approved design — ready for implementation
**Author:** Shane McIntyre
**Date:** 2026-04-18 (rev 3)
**Audience:** ElevarusOS engineering team

---

## Quick Reference

| Item | Value |
|---|---|
| **New tools (data)** | `supabase_query`, `ringba_live_query`, `meta_query`, `describe_schema`, `list_ringba_publishers`, `list_ringba_campaigns`, `list_lp_campaigns` |
| **New tools (memory)** | `recall_memory`, `save_memory`, `forget_memory`, `list_memories` |
| **New Supabase tables** | `ask_elevarus_queries` (audit), `ask_elevarus_memories` (learned facts/preferences) |
| **New modules** | `src/adapters/slack/data-tools.ts`, `src/core/query-builder.ts`, `src/adapters/slack/image-ingest.ts`, `src/core/memory-store.ts`, `src/core/integration-registry.ts` |
| **Integration registry** | Auto-discovery via `src/integrations/<name>/manifest.ts`; new integrations become Q&A-visible at boot without touching the bot |
| **Existing modules reused** | `RingbaRepository`, `RingbaHttpClient`, `LeadsProsperRepository`, `MetaAdsClient`, `getSupabaseClient` |
| **Env vars** | None new in Phase 1 (service role key + `SLACK_BOT_TOKEN` already present) |
| **Auth model** | Service role + server-side enforcement; no raw SQL from Claude |
| **Row cap** | 2000 per query; overflow triggers a confirm-to-expand flow |
| **PII posture** | No masking — internal use only |
| **Multimodal** | Bot accepts screenshots/images via Slack `files`, passes as Claude image blocks |
| **Memory budget** | ≤1.5K tokens auto-loaded into system prompt; richer recall via on-demand tool |

---

## 1. Overview and Problem Statement

The Slack Q&A bot answers questions by calling a small set of pre-wired tools that each resolve an `instanceId` to a single Ringba campaign name or Meta ad account ID. This breaks down as soon as a question doesn't match a wired instance.

Concrete blocker from the field: Bluejay asked for a WTD revenue rollup across **two Ringba publishers** (`CHP PRIVATE HEALTH INSURANCE`, `CLARO PRIVATE HEALTH INSURANCE`) spanning **multiple campaigns**. The current `get_ringba_revenue` tool accepts one campaign name or one instance — it cannot express "multi-campaign filtered by publisher." The bot had to bail.

The data is already in Supabase (`ringba_calls` has `publisher_name`, `campaign_name`, `payout_amount`, `call_dt`). The gap is purely in the tool surface. Every similar ad-hoc question hits the same wall: new data source, new instance config, new PR. That does not scale.

---

## 2. Goals and Non-Goals

### Goals

- Give the Slack bot broad read access to all Supabase data via a single parametric query tool (`supabase_query`) — no per-question code changes required
- Add a Ringba live-API fallback (`ringba_live_query`) for data not yet synced to Supabase or for fields the sync worker doesn't promote
- Add a live-API passthrough for Meta (`meta_query`) since Meta is not synced to Supabase
- Add schema introspection (`describe_schema`) so Claude stops hallucinating column names
- Preserve existing tools (`get_ringba_revenue`, `list_instances`, etc.) — additive release, no breakage
- Log every data-tool invocation to an audit table so we can see what the bot is touching
- Enforce row + execution caps per query to protect the DB and keep Slack responses snappy; prompt user to confirm expansion when a query returns >2000 rows
- Support image input from Slack so users can paste screenshots (dashboards, error messages, spreadsheets) alongside their questions
- **Give the bot persistent memory** so it can learn user preferences, team-specific terminology, and recurring facts across conversations without blowing the token budget
- **Make the bot automatically aware of new integrations** (ClickUp, Google Ads, TikTok, etc.) via a manifest-based registry — adding an integration shouldn't require editing the bot
- Keep the tool surface thin and composable: Claude builds the query shape, we build the SELECT

### Non-Goals

- Raw-SQL input from Claude (too wide a blast radius; inject/write risk even under a read-only role)
- PII masking — ElevarusOS is internal-only, no external-facing surfaces consume these responses
- Write tools (approving jobs, creating tasks, posting to Slack channels from Q&A) — deferred until per-user auth
- A separate read-only Postgres role in Phase 1 — server-side whitelisting is the primary defense; a read-only role is a Phase 2 defense-in-depth add
- Dashboards, charts, or rendered HTML — text responses only
- Caching a Meta Insights mirror in Supabase — scoped to a future `meta-sync` PRD
- Per-user authorization or ACLs (Slack user → row-level access)
- Generating images back to Slack (we only receive them, we don't render charts)
- Embedding-based semantic memory search (pgvector) in Phase 1 — keyword + type filter is enough initially; revisit if memory count exceeds ~500 entries
- Cross-workspace / cross-org memory — single Slack workspace, single memory namespace

---

## 3. User Stories

### Slack user asking ad-hoc questions

| ID | Story | Acceptance Criteria |
|---|---|---|
| UQ-01 | As a Slack user, I ask "what's WTD revenue for CHP and CLARO publishers across all campaigns?" and get an answer. | Claude calls `supabase_query` against `ringba_calls` with publisher filter + date range + `sum(payout_amount)`; returns rows + total. |
| UQ-02 | As a Slack user, I ask a follow-up filtered by date or campaign without changing instance context. | Same tool accepts new filters; the bot does not require an instance. |
| UQ-03 | As a Slack user, I ask "which publishers drove the most revenue last week?" | `supabase_query` with `groupBy: publisher_name`, `aggregations: [sum(payout_amount)]`, ordered DESC, limit 20. |
| UQ-04 | As a Slack user, I ask "what columns does ringba_calls have?" | `describe_schema` returns column names + types; no hardcoded knowledge needed. |
| UQ-05 | As a Slack user, I ask a Meta spend question that doesn't match a wired instance (e.g. breakdown by adset). | `meta_query` accepts adAccountId + level + breakdowns + date range and returns the Graph API response. |
| UQ-06 | As a Slack user, I ask a Ringba question that needs a field not in `ringba_calls` (e.g. raw tag values or a call not yet synced). | Claude falls back to `ringba_live_query`, which hits the Ringba API and returns the raw records. |
| UQ-07 | As a Slack user, I paste a screenshot of a dashboard and ask "why is this number off?" | Slack sends a `files` array with the event; the bot downloads the image with the bot token and passes it to Claude as an image content block. Claude responds referencing the screenshot. |
| UQ-08 | As a Slack user, my query returns more than 2000 rows. | Bot replies with a truncated result, the total row count, and a prompt to narrow or confirm expansion ("reply `expand` to fetch up to 10,000 rows"). |
| UQ-09 | As a Slack user, I tell the bot "remember that WTD means Monday through today in our ops" and the bot uses that convention next week without me repeating it. | `save_memory` tool records `{type: fact, name: 'wtd_definition', content: 'WTD = Monday 00:00 America/New_York through current time'}`. On future turns the system prompt injects the memory; Claude uses it. |
| UQ-10 | As a Slack user, I say "forget what I said about daily standups being on Tuesday" and the bot never brings that memory up again. | `forget_memory` deletes the matched entry; audit row kept. |
| UQ-11 | As a Slack user, I ask "what integrations do you have access to?" after we add Google Ads. | `list_integrations` pulls from the registry and includes Google Ads without any bot code change. |

### Platform operator

| ID | Story | Acceptance Criteria |
|---|---|---|
| OP-01 | As Shane, I audit what the bot has been touching. | `SELECT * FROM ask_elevarus_queries ORDER BY created_at DESC` shows one row per tool call: tool name, params JSONB, row count, duration ms, slack user, channel. |
| OP-02 | As Shane, I can see a query that timed out or was capped. | Audit row has `status IN ('ok', 'capped', 'error')` + `error_message` column. |
| OP-03 | As Shane, I can trace which queries came from which Slack user/channel. | `ask_elevarus_queries` has `slack_user_id` and `slack_channel_id` columns populated on every row. |
| OP-04 | As Shane, I can review and edit what the bot has remembered. | Admin endpoint `GET /api/memories` lists all entries; `DELETE /api/memories/:id` removes one; `list_memories` tool surfaces the same data in Slack. |
| OP-05 | As Shane, when I add a new integration (e.g. Google Ads) to `src/integrations/google-ads/`, the bot picks it up on next restart. | `integration-registry.ts` scans `src/integrations/*/manifest.ts` at boot, merges new tables into the `supabase_query` whitelist, new live-query tools into the tool set, and new descriptions into the system prompt. |

---

## 4. Tool Specifications

### 4.1 `supabase_query` — the workhorse

**Input schema (JSON):**

```json
{
  "table":          "ringba_calls",
  "select":         ["publisher_name", "campaign_name", "payout_amount", "call_dt"],
  "filters":        [
    { "column": "publisher_name", "op": "in", "value": ["CHP PRIVATE HEALTH INSURANCE", "CLARO PRIVATE HEALTH INSURANCE"] },
    { "column": "call_dt",        "op": "gte", "value": "2026-04-13" },
    { "column": "call_dt",        "op": "lt",  "value": "2026-04-20" },
    { "column": "has_payout",     "op": "eq",  "value": true },
    { "column": "is_duplicate",   "op": "eq",  "value": false }
  ],
  "groupBy":        ["publisher_name"],
  "aggregations":   [
    { "fn": "sum",   "column": "payout_amount", "alias": "revenue" },
    { "fn": "count", "column": "*",             "alias": "call_count" }
  ],
  "orderBy":        [{ "column": "revenue", "direction": "desc" }],
  "limit":          2000
}
```

**Whitelisted tables/views (Phase 1):**

```
ringba_calls, ringba_campaigns, ringba_sync_state,
lp_leads, lp_campaigns, lp_sync_state,
jobs, instances, job_stages_view, instance_job_summary
```

**Whitelisted ops per filter:**
`eq, neq, gt, gte, lt, lte, in, not_in, like, ilike, is_null, not_null`

**Whitelisted aggregations:**
`sum, count, avg, min, max`

**Returned shape:**

```json
{
  "rows":            [ ... ],
  "row_count":       N,
  "total_available": M,
  "truncated":       false,
  "expand_token":    null,
  "elapsed_ms":      120
}
```

**Server-side guarantees:**
- Query is composed via the Supabase JS client (parametric filters). **No string concatenation; no raw SQL accepted.**
- Default row cap: **2000**. A `COUNT(*)` companion query determines the full size.
  - If `total_available <= 2000`: return all rows, `truncated: false`.
  - If `total_available > 2000`: return the first 2000, `truncated: true`, and an `expand_token` (UUID referencing the stored query). Claude surfaces this to the user as: *"That query matches N rows — I'm showing the first 2000. Reply `expand` to fetch up to 10,000, or narrow the filter."* A follow-up `expand` triggers a re-run with the cap raised to 10,000 (hard ceiling). Beyond that, tool refuses — the user must narrow the query.
- Execution timeout: 30s.
- `select`, `groupBy`, `orderBy` columns validated against the live column list from `information_schema.columns` filtered to the whitelisted tables. Unknown columns → tool error with close-match suggestions.
- Every invocation inserted into `ask_elevarus_queries`.

### 4.2 `ringba_live_query` — Ringba API fallback

For questions that need data the sync worker doesn't yet have: calls from the last few minutes (sync runs every 15 min), raw tag values not promoted to a column, or detailed routing-attempt fields. Thin passthrough over `RingbaHttpClient`.

**Input schema:**

```json
{
  "campaigns":    ["O&O_SOMQ_FINAL_EXPENSE"],
  "publishers":   ["CHP PRIVATE HEALTH INSURANCE", "CLARO PRIVATE HEALTH INSURANCE"],
  "targets":      [],
  "buyers":       [],
  "startDate":    "2026-04-13",
  "endDate":      "2026-04-18",
  "groupBy":      "publisher",
  "fields":       ["callCount", "connectedCount", "conversionCount", "payoutAmount", "revenue"]
}
```

**Guardrails:**
- 2000-row cap (same overflow flow as §4.1)
- 60s timeout (Ringba API is slower than Supabase; needs the extra budget)
- Audit row written
- Claude should prefer `supabase_query` by default; the system prompt directs it to use `ringba_live_query` only when a column is missing from `ringba_calls` OR when the user explicitly asks for "fresh/live" data

### 4.3 `meta_query` — live Meta Graph passthrough

Meta is not synced to Supabase. Until a `meta-sync` worker exists, this is a thin passthrough over `MetaAdsClient`.

**Input schema:**

```json
{
  "adAccountId":  "999576488...",
  "level":        "campaign",
  "campaignIds":  ["123", "456"],
  "breakdowns":   ["age", "gender"],
  "since":        "2026-04-13",
  "until":        "2026-04-20",
  "fields":       ["spend", "impressions", "clicks", "ctr", "cpc"]
}
```

**Guardrails:**
- `adAccountId` must appear in at least one instance's `meta.adAccountId` OR in an `ALLOWED_META_AD_ACCOUNTS` env var — prevents the bot from hitting arbitrary accounts.
- Response capped to 2000 rows (same overflow flow as §4.1).
- 30s timeout.
- Audit row written.

### 4.4 `describe_schema` — introspection

**Input:**

```json
{ "tables": ["ringba_calls", "lp_leads"] }   // optional; omit for full whitelist
```

**Output:** column name, data type, is_nullable, short human description (pulled from a `data/schema-annotations.json` file maintained by us — gives Claude hints like "publisher_name: the traffic source / affiliate that generated the call").

### 4.5 Helper tools (thin wrappers for discoverability)

- `list_ringba_publishers` — `SELECT DISTINCT publisher_name FROM ringba_calls WHERE publisher_name IS NOT NULL`, last-90-days window, cached 5min
- `list_ringba_campaigns` — `SELECT id, name FROM ringba_campaigns WHERE enabled = TRUE`
- `list_lp_campaigns`      — `SELECT id, name FROM lp_campaigns`

These exist so the bot can resolve ambiguous user inputs ("the CHP publisher", "the U65 campaign") without Claude having to guess exact strings.

### 4.6 Memory tools — learning across conversations

The goal: the bot should remember useful things between conversations (user preferences, team terminology, recurring facts) without dragging a full transcript into every prompt. The design mirrors the auto-memory pattern that Claude Code uses internally — structured types, small always-loaded summary, on-demand recall.

**Memory types** (enum, enforced server-side):

| Type | Purpose | Load strategy |
|---|---|---|
| `user` | User profile, preferences, role (e.g. *"Shane = CEO, prefers terse answers"*) | Always loaded for the active Slack user |
| `feedback` | Explicit corrections or confirmations (*"don't include prior-month comparisons unless asked"*) | Always loaded (user-scoped + team-scoped) |
| `fact` | Named business facts (*"WTD = Monday 00:00 ET through now"*, *"Bluejay refers to CHP + CLARO publishers"*) | On-demand via `recall_memory` |
| `project` | Current initiatives, stakeholders, deadlines (decays fast — auto-demoted after 30d no access) | On-demand via `recall_memory` |
| `reference` | Pointers to external systems (*"escalations go to #ops-urgent"*, *"Linear project ELV for roadmap"*) | On-demand via `recall_memory` |

**Memory scope**:
- `user` — tied to a specific `slack_user_id`. Only loaded when that user is speaking.
- `team` — `slack_user_id` null. Visible to all users. Used for shared terminology and business facts.
- `channel` — tied to a `slack_channel_id`. Rare; useful for dedicated channels (e.g. a reporting-specific channel has its own conventions).

#### `save_memory`

**Input:**

```json
{
  "type":        "fact",
  "name":        "wtd_definition",
  "description": "How we define week-to-date in ops reports",
  "content":     "WTD = Monday 00:00 America/New_York through the current timestamp. Applies to Ringba revenue, LP leads, Meta spend unless the user specifies otherwise.",
  "scope":       "team"
}
```

Output: memory id + a terse confirmation string the bot can paraphrase to the user ("Got it — I'll remember that WTD starts Monday ET.").

**When Claude should call it** (enforced via system-prompt guidance, not code). The bot must actively listen for save-worthy signals, not wait for an explicit "remember this." Save triggers, in order of strength:

- **Explicit**: user says *"remember that..."*, *"from now on..."*, *"always..."* — save immediately.
- **Implicit corrections** (strong): user corrects the bot ("no, don't do X", "that's not how we measure it") — save as `feedback`.
- **Implicit confirmations** (quieter but important): user accepts a non-obvious judgment call without pushback, or explicitly thanks the bot for an unusual approach. Save as `feedback` so the bot keeps doing it.
- **Contextual detection** (the one that matters most): during normal conversation the user reveals a definition, convention, or preference the bot didn't know — e.g. *"for Bluejay we only count CHP and CLARO"*, *"our fiscal week is Mon–Sun"*, *"the Ops team hates when we post in threads"*. The bot should recognize these as business facts/preferences and save them without waiting for the user to say "remember this."

When Claude saves implicitly, it should **briefly surface the save** in its reply ("Noted — I'll treat Bluejay as CHP + CLARO going forward.") so the user can correct or override. Never save silently.

**Never save:** ephemeral conversation state, Git info, code patterns, data already in the schema (query results, row counts), or anything inferable from the codebase / `describe_schema`. The system prompt carries an explicit negative list identical to Claude Code's *"What NOT to save"* rules.

#### `recall_memory`

**Input:**

```json
{
  "query":  "how do we define WTD?",       // optional — if omitted, returns by type/scope
  "type":   "fact",                         // optional
  "scope":  "team",                         // optional
  "limit":  10
}
```

**Retrieval strategy (Phase 1, no embeddings):**
- Rank by (keyword match in name/description/content) × (recency-weighted access count)
- Return top N with `id`, `name`, `description`, `content`, `last_accessed_at`
- Update `access_count` and `last_accessed_at` on every hit (used for pruning)

**Phase 2 (if memory volume grows):** add a pgvector column, embed memories on save via Claude's `/embeddings`-compatible endpoint or a small local model, use cosine similarity for retrieval.

#### `forget_memory`

**Input:** `{ "id": "..." }` or `{ "name": "..." }`

- Soft-delete (sets `forgotten_at`) — keeps the audit trail intact
- System prompt excludes `forgotten_at IS NOT NULL` rows

#### `list_memories`

Admin-style; returns current memory set filtered by type/scope. Also exposed via `GET /api/memories` for an eventual admin UI.

#### Token budget

System prompt injects, every turn:

```
## Memory
### About this user (Shane, slack_user_id=U...)
- Role: CEO, founder. Prefers terse answers.
- Feedback: do not use emojis; lead with numbers.
[...]

### Team conventions
- WTD = Monday 00:00 ET through now. (fact, last used 2026-04-17)
- Reporting bots run on weekday 9a-5p ET cadence. (fact)
[...]
```

**Hard cap: 1500 tokens** for the combined memory block. Exceeding the cap triggers one of two compactions:
1. Drop the lowest-ranked memories (by access recency) from the auto-inject block — they remain retrievable via `recall_memory`
2. If the **user** block alone exceeds 500 tokens, auto-summarize older `feedback` entries into a single rolled-up "prior feedback summary" memory (keeps total body small, keeps the learning)

---

## 5. Data Model

### 5.1 New table: `ask_elevarus_queries`

New migration: `supabase/migrations/YYYYMMDDHHMMSS_ask_elevarus_audit.sql`

```sql
CREATE TABLE IF NOT EXISTS ask_elevarus_queries (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name        TEXT         NOT NULL,
  params           JSONB        NOT NULL,
  status           TEXT         NOT NULL CHECK (status IN ('ok','capped','error')),
  row_count        INTEGER,
  elapsed_ms       INTEGER,
  error_message    TEXT,
  slack_user_id    TEXT,
  slack_channel_id TEXT,
  trace_id         TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX ask_elevarus_queries_created_at_idx ON ask_elevarus_queries (created_at DESC);
CREATE INDEX ask_elevarus_queries_tool_name_idx  ON ask_elevarus_queries (tool_name);
CREATE INDEX ask_elevarus_queries_slack_user_idx ON ask_elevarus_queries (slack_user_id);
```

### 5.2 New table: `ask_elevarus_memories`

Same migration or a separate one — both land in Phase 1:

```sql
CREATE TABLE IF NOT EXISTS ask_elevarus_memories (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  type             TEXT         NOT NULL CHECK (type IN ('user','feedback','fact','project','reference')),
  scope            TEXT         NOT NULL CHECK (scope IN ('user','team','channel')) DEFAULT 'team',
  name             TEXT         NOT NULL,
  description      TEXT         NOT NULL,
  content          TEXT         NOT NULL,
  slack_user_id    TEXT,                     -- populated when scope='user'
  slack_channel_id TEXT,                     -- populated when scope='channel'
  access_count     INTEGER      NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMPTZ,
  forgotten_at     TIMESTAMPTZ,              -- soft delete
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Unique name within a scope (prevent duplicate memories)
CREATE UNIQUE INDEX ask_elevarus_memories_scope_name_idx
  ON ask_elevarus_memories (scope, COALESCE(slack_user_id, ''), COALESCE(slack_channel_id, ''), name)
  WHERE forgotten_at IS NULL;

CREATE INDEX ask_elevarus_memories_type_scope_idx
  ON ask_elevarus_memories (type, scope)
  WHERE forgotten_at IS NULL;

CREATE INDEX ask_elevarus_memories_user_idx
  ON ask_elevarus_memories (slack_user_id)
  WHERE slack_user_id IS NOT NULL AND forgotten_at IS NULL;

-- Full-text search on name/description/content (Phase 1 retrieval)
CREATE INDEX ask_elevarus_memories_fts_idx
  ON ask_elevarus_memories
  USING GIN (to_tsvector('english', name || ' ' || description || ' ' || content));

DROP TRIGGER IF EXISTS ask_elevarus_memories_set_updated_at ON ask_elevarus_memories;
CREATE TRIGGER ask_elevarus_memories_set_updated_at
  BEFORE UPDATE ON ask_elevarus_memories
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
```

**Pruning (all types):** a weekly cron (reuse existing scheduler) soft-deletes any memory with `last_accessed_at < NOW() - INTERVAL '30 days'` AND `created_at < NOW() - INTERVAL '30 days'` (grace period so brand-new memories aren't culled before they're used). `user` memories have the highest bar for pruning — they're unlikely to be re-read every month but still useful, so the `user` type pruning requires `created_at < NOW() - INTERVAL '90 days'` before the 30d rule applies. Separately, `feedback` memories per user auto-summarize into a rolled-up "prior feedback summary" when count exceeds 20 (keeps working memory small without losing the lesson).

### 5.3 Schema annotations file

`data/schema-annotations.json` — manually maintained, checked in. Maps whitelisted tables/columns to human descriptions. Used by `describe_schema` and seeded into the Q&A system prompt so Claude picks the right column. Skipped columns are dropped from introspection output entirely.

**Extension pattern:** integrations can contribute their own annotation fragments via the manifest (see §9). The bot merges `data/schema-annotations.json` with all integration-contributed fragments at boot.

Example entry:

```json
{
  "ringba_calls": {
    "description": "One row per inbound call to a Ringba campaign. Winning routing attempt promoted to top-level columns.",
    "columns": {
      "publisher_name": "Traffic source / affiliate that generated the call.",
      "payout_amount":  "Dollar amount paid to us by the winning buyer. Use with has_payout=true and is_duplicate=false for revenue reports.",
      "call_dt":        "Timestamp of the call (UTC).",
      "phone_normalized": "Digits-only phone — the reconciliation join key to lp_leads.phone_normalized."
    }
  }
}
```

---

## 6. Security and Guardrails

### Defense in depth — Phase 1

1. **No raw SQL input.** The tool surface accepts a parametric structure. The query builder constructs a SELECT via the Supabase client. Claude cannot pass SQL.
2. **Whitelisted tables + columns.** Any column not in the annotations file (minus explicitly excluded ones) is rejected.
3. **Whitelisted ops + aggregations.** Fixed enum — no user-provided operators.
4. **Row + time caps.** 2000 rows default, 30s timeout. Overflow prompts a user confirm-to-expand flow (up to 10,000 hard ceiling).
5. **Audit every call.** Every tool invocation writes to `ask_elevarus_queries` before returning. Failed queries are audited too (`status='error'`).
6. **No secrets in responses.** `env`, `config`, `api_keys` tables (if they ever exist) are not whitelisted. `raw` JSONB columns that may contain API keys are dropped from `select`.

PII masking is explicitly **not** implemented — ElevarusOS is an internal tool and the lead phone/email data is already accessible to the same operators via Supabase directly.

### Phase 2 defense (not blocking v1 ship)

- Read-only Postgres role (`ask_elevarus_reader`). Generate a new key. Reroute the data tools through that role. Raw-SQL is still rejected at the tool layer, but now even a bug can't escalate to writes.
- Per-user authorization (when Slack→user identity is wired into the job store).
- Rate limiting per Slack user (N queries / minute).

### What could still go wrong

- **Large JSONB columns** (`raw`, `routing_attempts`, `lead_data`, `buyers`) can balloon response size. Mitigation: these columns excluded from `select` by default; opt-in via explicit `select` list with a size-check on returned payload.
- **Expensive group-bys** over millions of rows. Mitigation: 30s timeout + `EXPLAIN`-gate in Phase 2. For Phase 1 we rely on existing indexes (we already index `call_dt`, `publisher_name`, `lead_date`, etc.).
- **Hallucinated column names.** Mitigation: `describe_schema` + annotations in the system prompt. On unknown column, return an error with the closest matches so Claude can self-correct.

### 6.5 Multimodal input — Slack screenshots → Claude image blocks

**Confirmed supported.** Slack's Events API delivers file attachments as a `files` array on `message` / `app_mention` events; Claude's Messages API accepts images as content blocks on the user turn. End-to-end flow:

```
Slack user pastes screenshot + @Ask Elevarus
   → Events API payload includes files[] with { id, mimetype, url_private, size }
   → image-ingest.ts filters to image/png|jpeg|gif|webp, ≤ N MB
   → GET url_private with Authorization: Bearer $SLACK_BOT_TOKEN
   → base64-encode the bytes
   → claudeConverseWithTools() receives user content as a mixed array:
       [ { type: "text",  text: "<user message>" },
         { type: "image", source: { type: "base64", media_type, data } },
         ... ]
   → Claude answers, optionally calling data tools with image-informed params
```

**Required:**
- Add `files:read` to the Slack app manifest (bot scope).
- Extend `handleSlackEvent()` in `src/adapters/slack/events.ts` to pass `event.files` through.
- New module `src/adapters/slack/image-ingest.ts`:
  - Download via fetch with the bot token
  - Reject non-image mimetypes
  - Reject files > 5 MB (configurable; Claude has its own 5MB-per-image / 20MB-total limits)
  - Cap at 5 images per message (configurable)
- Update `claude-converse.ts` to accept a `ContentBlock[]` user message shape in addition to the current `string` form.

**Guardrails:**
- Only images attached to messages the bot is allowed to read (app_mentions in channels it's in, or DMs). No channel scanning.
- Log image count + total bytes to the audit row.
- No outbound image generation — the bot reads images, it doesn't produce them.

**Out of scope for this PRD:**
- OCR of long documents / PDFs (Claude handles PDFs natively but adds cost; defer until asked)
- Persisting screenshots to Supabase (no use case yet)

---

## 7. Phased Rollout

### Phase 1 — Data access + Integration registry (target: 1–1.5 weeks)

1. Migration: `ask_elevarus_queries` table
2. `src/core/integration-registry.ts` + `manifest.ts` for `ringba`, `leadsprosper`, `meta` (retrofit existing integrations)
3. `data/schema-annotations.json` seeded with entries for every whitelisted table (includes `job_stages_view`); registry merges in integration-contributed fragments
4. `src/core/query-builder.ts` — parametric SELECT builder + validator + count-then-fetch for 2000/10,000 overflow
5. `src/adapters/slack/data-tools.ts` — `supabase_query`, `ringba_live_query`, `describe_schema`, helper lookups
6. Wire into `QA_TOOLS` (keep existing tools alongside — additive). `list_integrations` now reads from the registry, not `knowledge-catalog.ts`
7. System prompt extension: annotations summary + "available integrations" block (auto-generated from registry) + tool-selection guidance
8. Integration test: reproduce the Bluejay query end-to-end

### Phase 2 — Memory system + Multimodal + Meta passthrough (target: +1 week)

1. Migration: `ask_elevarus_memories` table
2. `src/core/memory-store.ts` — CRUD + keyword-search retrieval + system-prompt block builder with 1500-token cap
3. `src/adapters/slack/data-tools.ts` — add `recall_memory`, `save_memory`, `forget_memory`, `list_memories`
4. System prompt rules for when to save / recall (mirror Claude Code's auto-memory guidance)
5. Admin endpoints: `GET /api/memories`, `DELETE /api/memories/:id`
6. `src/adapters/slack/image-ingest.ts` — Slack `files` → Claude image content blocks
7. Add `files:read` to the Slack app manifest
8. `meta_query` tool + `ALLOWED_META_AD_ACCOUNTS` env var

### Phase 3 — Polish (target: +1 week)

1. Memory pruning cron (weekly)
2. `save_query` tool: promote recurring questions into named views (`data/named-queries.json`)
3. Read-only Postgres role (`ask_elevarus_reader`)
4. Per-tool rate limits per Slack user
5. Overflow UX: on >2000 rows, auto-suggest tighter filters / `save_query` view

### Phase 4 — Scale (separate PRDs as needed)

- **Meta Supabase sync** — spin up `meta-sync` worker when Graph API volume or rate limits warrant. `meta_query` becomes a supabase passthrough.
- **Memory embeddings** — pgvector column + embedding generation on save when memory count exceeds ~500 entries; semantic `recall_memory` replaces/augments keyword search.
- **New integrations** — ClickUp (already has its own PRD), Google Ads, TikTok Ads, etc. each ship a `manifest.ts` and the bot picks them up.

---

## 8. Implementation Notes

### Directory layout

```
src/
  adapters/slack/
    data-tools.ts             ← new; registers supabase_query, meta_query, memory tools, etc.
    image-ingest.ts           ← new (Phase 2); Slack files → Claude image blocks
    events.ts                 ← existing
  core/
    qa-tools.ts               ← existing; channel-agnostic (CLI also uses)
    query-builder.ts          ← new; parametric SELECT builder
    schema-annotations.ts     ← new; loads data/schema-annotations.json + merges registry fragments
    memory-store.ts           ← new (Phase 2); CRUD + retrieval + prompt-block builder
    integration-registry.ts   ← new; scans src/integrations/*/manifest.ts at boot
  integrations/
    ringba/manifest.ts        ← new; retrofit
    leadsprosper/manifest.ts  ← new; retrofit
    meta/manifest.ts          ← new; retrofit
    <future>/manifest.ts      ← ClickUp, Google Ads, etc. — drop-in
data/
  schema-annotations.json     ← new
  named-queries.json          ← new (Phase 3)
supabase/migrations/
  YYYYMMDDHHMMSS_ask_elevarus_audit.sql
  YYYYMMDDHHMMSS_ask_elevarus_memories.sql
```

**Open question:** whether `qa-tools.ts` moves to `src/adapters/slack/qa-tools.ts` now. Argument for: bot cohesion. Argument against: `scripts/ask.ts` CLI also uses it, so it's channel-agnostic. Recommendation: leave in `core/` for now; revisit if we add a second channel.

### Why not a read-only DB role in Phase 1?

Main argument for delaying it: the tool layer never accepts SQL, so the blast radius is already constrained to whitelisted SELECTs. Adding a role now costs a migration, a new key, env changes, and a second Supabase client — deferred to Phase 2 where it becomes pure defense in depth.

If the team disagrees, the role add is a half-day delta — not a structural change.

### Backward compatibility

- `get_ringba_revenue`, `get_meta_spend`, `list_instances`, `query_jobs`, etc. all stay
- The system prompt is updated to steer Claude toward the new tools for ad-hoc questions and leave the wrapper tools for simple instance-bound questions

---

## 9. Integration Registry — Future-Proofing for ClickUp, Google Ads, and beyond

The current `list_integrations` tool reads a static list baked into `src/core/knowledge-catalog.ts`. Every time we add a new integration, someone has to remember to update that file and the Q&A tool wiring. That doesn't scale and it's the same footgun the feedback raised about `get_ringba_revenue` being locked to one campaign.

The fix: move integration metadata to a **manifest** colocated with each integration. The bot loads them at boot; everything downstream (tool list, schema whitelist, system prompt, `list_integrations` output) is derived.

### 9.1 Manifest shape

Each integration ships a `manifest.ts` next to its `client.ts`:

```ts
// src/integrations/google-ads/manifest.ts
import type { IntegrationManifest } from "../../core/integration-registry";
import { GoogleAdsClient } from "./client";

export const manifest: IntegrationManifest = {
  id:          "google-ads",
  name:        "Google Ads",
  description: "Google Ads reporting — campaign spend, clicks, conversions.",
  status:      () => new GoogleAdsClient().enabled ? "configured" : "unconfigured",

  // Supabase tables this integration owns — auto-added to supabase_query whitelist
  supabaseTables: [
    {
      name:        "google_ads_campaigns",
      description: "Reference list of all Google Ads campaigns.",
      columns: {
        id:              "Google Ads campaign ID.",
        name:            "Human-readable campaign name.",
        status:          "ENABLED | PAUSED | REMOVED.",
      },
    },
    {
      name:        "google_ads_insights",
      description: "Daily campaign-level spend + performance metrics.",
      columns: {
        campaign_id:     "FK to google_ads_campaigns.id.",
        date:            "Report date (UTC).",
        spend:           "Dollar amount spent on the day.",
        clicks:          "Click count.",
        conversions:     "Conversion count per Google Ads conversion tracking.",
      },
    },
  ],

  // Live-API tools this integration wants exposed to the bot
  liveTools: [
    {
      name:        "google_ads_live_query",
      description: "Query Google Ads Reporting API directly for fields/fresher data not in Supabase.",
      inputSchema: { /* JSON schema */ },
      execute:     (input, ctx) => { /* call GoogleAdsClient */ },
    },
  ],

  // Short paragraph for the system prompt
  systemPromptBlurb:
    "Google Ads data is synced nightly into google_ads_campaigns and google_ads_insights. " +
    "For same-day spend or breakdowns not in the schema, use google_ads_live_query.",

  // Example questions for few-shot hints
  exampleQuestions: [
    "What was our Google Ads spend WTD across all campaigns?",
    "Which Google Ads campaign had the highest CPA last week?",
  ],
};
```

### 9.2 Registry loader

New module `src/core/integration-registry.ts`:

- At boot, globs `src/integrations/*/manifest.ts`
- Validates each manifest against the `IntegrationManifest` type
- Builds in-memory objects:
  - **Whitelist merge** — `supabase_query` table list = core whitelist + every manifest's `supabaseTables[].name`
  - **Annotations merge** — `data/schema-annotations.json` + every manifest's `supabaseTables[].columns`
  - **Tool set merge** — `QA_TOOLS` = existing tools + every manifest's `liveTools[]`
  - **System prompt section** — auto-generated "## Available Integrations" block from every manifest's `systemPromptBlurb` + current `status()` (configured / unconfigured)
  - **`list_integrations` output** — reads from the registry instead of the static catalog

### 9.3 What this means for new integrations

Adding ClickUp or Google Ads becomes:

1. Create `src/integrations/<name>/` directory with `client.ts`, optional `sync.ts` / `repository.ts`, and `manifest.ts`
2. (If syncing to Supabase) add the migration for the new tables
3. Register the sync worker in `src/index.ts` (as we already do for Ringba/LP)
4. Restart ElevarusOS

The Q&A bot now knows about the integration — it appears in `list_integrations`, its tables are queryable via `supabase_query`, its live tools are callable, and Claude has the blurb + example questions in its system prompt. Zero edits to `adapters/slack/` or the Q&A tool set.

### 9.4 Retrofit plan

Migrate the existing integrations to the manifest pattern as part of Phase 1:

- `src/integrations/ringba/manifest.ts` — tables: `ringba_calls`, `ringba_campaigns`, `ringba_sync_state`. Live tool: `ringba_live_query`.
- `src/integrations/leadsprosper/manifest.ts` — tables: `lp_leads`, `lp_campaigns`, `lp_sync_state`. Live tool deferred (Phase 3).
- `src/integrations/meta/manifest.ts` — no tables (not synced). Live tool: `meta_query` (Phase 2).

Once retrofit is done, `src/core/knowledge-catalog.ts` loses the hardcoded integration list and becomes a thin passthrough over the registry.

---

## 10. Resolved Decisions

All design questions are closed. Implementation can proceed from this document.

| # | Question | Decision |
|---|---|---|
| 1 | PII masking for lead email/phone? | **No masking** — internal tool, same data already accessible via Supabase. |
| 2 | Expose `job_stages_view` (may surface stage errors)? | **Yes** — internal use, debugging value outweighs leak risk. |
| 3 | Default row cap? | **2000.** Warn user on overflow and offer expand (10,000 hard ceiling). |
| 4 | Ringba live-API fallback? | **Yes** — add `ringba_live_query` as a fallback when Supabase is missing data or the user needs fresher-than-15-min results. |
| 5 | Annotations file location? | `data/schema-annotations.json` — runtime data, loaded at boot. |
| 6 | Screenshot / image input from Slack? | **Yes** — via Slack `files:read` + Claude image content blocks. Phase 2. See §6.5. |
| 7 | Persistent memory across conversations? | **Yes** — 5 structured types in `ask_elevarus_memories`, always-loaded summary capped at 1500 tokens, deeper recall on demand. See §4.6 + §5.2. |
| 8 | Future-integration discoverability? | **Yes** — manifest-based registry (§9). New integrations drop a `manifest.ts`; bot picks them up at boot. |
| 9 | Who can write memories? | **Any Slack user.** ElevarusOS is internal-only; misuse is low-risk and audited via `ask_elevarus_queries`. Revisit if abuse appears. |
| 10 | Memory pruning? | **30 days of no access → soft-delete** (default for all types, not just `project`). Weekly cron. Auto-summarize `feedback` per user when count > 20. |
| 11 | Explicit vs. contextual save? | **Contextual by default.** Bot actively detects save-worthy signals (definitions, corrections, preferences) during normal conversation and saves without requiring "remember this." Briefly acknowledges each save so the user can override. See §4.6 save-triggers list. |
| 12 | Retrofit existing integrations to the registry in Phase 1? | **Full retrofit.** Still in development — no reason to carry legacy `knowledge-catalog.ts` as a fallback. Ringba / LP / Meta all ship manifests in Phase 1. |
